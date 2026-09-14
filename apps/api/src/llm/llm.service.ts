import { Inject, Injectable, Logger } from '@nestjs/common';
import { CONFIG, type AppConfig } from '../config/configuration.js';
import { AnthropicProvider } from './providers/anthropic.provider.js';
import { EchoProvider } from './providers/echo.provider.js';
import { GeminiProvider } from './providers/gemini.provider.js';
import { GroqProvider } from './providers/groq.provider.js';
import { OllamaProvider } from './providers/ollama.provider.js';
import { isQueued } from './batch-context.js';
import { computeCost, summariseUsage, type Usage } from './pricing.js';
import {
  isBatchCapable,
  LlmError,
  type BatchOutcome,
  type BatchProgress,
  type BatchRequest,
  type CompletionRequest,
  type CompletionResult,
  type LlmProvider,
} from './llm.types.js';

@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);
  private readonly provider: LlmProvider;
  private readonly judgeProvider: LlmProvider;
  /**
   * Set by BatchQueueService at startup. Left as an interface rather than the
   * class to keep the dependency one-way: the queue needs this service, so
   * this service must not need the queue.
   */
  private queue?: {
    submit(request: CompletionRequest, tally?: Usage[]): Promise<CompletionResult>;
  };

  constructor(@Inject(CONFIG) private readonly config: AppConfig) {
    this.provider = this.resolve();
    this.judgeProvider = this.resolveJudge();
    this.logger.log(`LLM provider: ${this.provider.name} (${this.provider.model})`);
    if (this.judgeProvider.model !== this.provider.model) {
      this.logger.log(`Fidelity judge: ${this.judgeProvider.model}`);
    }
  }

  /**
   * The judge compares two passages and returns a one-word verdict. That is a
   * small, mechanical task, so on Anthropic it runs on a cheap model pinned
   * separately from the rewriter. Running it on the rewrite model would
   * roughly double the bill to answer a yes/no question.
   *
   * Every other provider reuses its single configured model.
   */
  private resolveJudge(): LlmProvider {
    const { provider, anthropic } = this.config;
    if (provider === 'anthropic' && anthropic.apiKey) {
      return new AnthropicProvider(
        anthropic.apiKey,
        anthropic.judgeModel,
        'low',
        // The judge answers a yes/no question; thinking adds nothing there.
        'disabled',
      );
    }
    return this.provider;
  }

  private resolve(): LlmProvider {
    const { provider, anthropic, ollama, groq, gemini } = this.config;

    const chosen: LlmProvider =
      provider === 'anthropic'
        ? new AnthropicProvider(
            anthropic.apiKey,
            anthropic.model,
            anthropic.effort,
            anthropic.thinking,
          )
        : provider === 'ollama'
          ? new OllamaProvider(ollama.url, ollama.model)
          : provider === 'groq'
            ? new GroqProvider(groq.apiKey, groq.model)
            : provider === 'gemini'
              ? new GeminiProvider(gemini.apiKey, gemini.model)
              : new EchoProvider();

    // Falling back to echo beats booting into a provider that will throw on
    // every request. The response reports which provider actually ran, so the
    // degradation is visible in the UI rather than silent.
    if (!chosen.isConfigured()) {
      this.logger.warn(
        `Provider "${chosen.name}" is not configured, falling back to echo. ` +
          `Rewrites will be a no-op until you set it up.`,
      );
      return new EchoProvider();
    }
    return chosen;
  }

  get name(): string {
    return this.provider.name;
  }

  get model(): string {
    return this.provider.model;
  }

  /** True when a real model is behind the interface. */
  get isLive(): boolean {
    return this.provider.name !== 'echo';
  }

  get judgeModel(): string {
    return this.judgeProvider.model;
  }

  /**
   * One judge call. Never retried and never allowed to throw upward: the
   * judge is one of three fidelity layers, and losing it must degrade the
   * check rather than fail the user's request.
   */
  async judge(
    system: string,
    user: string,
    tally?: Usage[],
  ): Promise<string | null> {
    if (!this.isLive) return null;
    try {
      const result = await this.judgeProvider.complete({
        system,
        user,
        temperature: 0.2,
        maxTokens: 300,
        // Not cached, deliberately. The judge's system block is about 35
        // tokens, far under the 1,024-token minimum, so cache_control here is
        // accepted and ignored. Its user prompt carries both full versions of
        // the article and differs every call, so there is nothing cacheable on
        // this request at all.
      });
      this.record(tally, this.judgeProvider.model, result);
      return result.text;
    } catch (error) {
      this.logger.warn(
        `fidelity judge unavailable: ${error instanceof Error ? error.message : error}`,
      );
      return null;
    }
  }

  /**
   * One completion, with a single retry on transient failures.
   *
   * Retries are limited to one because the humanize loop already runs several
   * passes. Retrying hard at both levels multiplies latency and, on a metered
   * provider, cost.
   */
  async complete(
    request: CompletionRequest,
    tally?: Usage[],
  ): Promise<string> {
    // Inside a bulk job every call goes to the shared queue instead, where it
    // waits for siblings from other articles and rides a half-price batch.
    // Nothing else in the pipeline knows this happened.
    if (this.queue && isQueued()) {
      const pooled = await this.queue.submit(request, tally);
      return pooled.text;
    }

    const run = async (): Promise<CompletionResult> => {
      try {
        return await this.provider.complete(request);
      } catch (error) {
        if (error instanceof LlmError && error.retryable) {
          this.logger.warn(`${error.provider} failed, retrying once: ${error.message}`);
          await new Promise((resolve) => setTimeout(resolve, 750));
          return this.provider.complete(request);
        }
        throw error;
      }
    };

    const result = await run();
    this.record(tally, this.provider.model, result);
    return result.text;
  }

  /**
   * The same call, returning the full result rather than just the text.
   *
   * The batch queue needs this: when no batch endpoint is available it falls
   * back to a normal call, and it resolves callers with a CompletionResult so
   * both paths hand back the same shape.
   */
  async completeResult(
    request: CompletionRequest,
    tally?: Usage[],
  ): Promise<CompletionResult> {
    const text = await this.complete(request, tally);
    return { text };
  }

  /** Record a result the queue obtained itself, into that caller's tally. */
  recordResult(tally: Usage[] | undefined, result: CompletionResult, batched = false) {
    this.record(tally, this.provider.model, result, batched);
  }

  /**
   * Usage is collected into a caller-supplied array rather than onto this
   * service, because the service is a singleton and concurrent requests would
   * otherwise pool their spend into one meaningless total.
   */

  /** Wired up once, by the queue itself. */
  attachQueue(queue: {
    submit(request: CompletionRequest, tally?: Usage[]): Promise<CompletionResult>;
  }): void {
    this.queue = queue;
  }

  /** True when the configured provider offers a batch endpoint. */
  get canBatch(): boolean {
    return isBatchCapable(this.provider);
  }

  /**
   * Run a set of independent requests through the Batch API and wait.
   *
   * Half the per-token price, in exchange for latency the caller cannot
   * control. Anthropic commits to 24 hours and usually finishes in minutes,
   * but "usually" is not a guarantee, so `maxWaitMs` exists and the default
   * is deliberately finite. A caller that cannot wait should not be batching.
   *
   * Two properties callers depend on:
   *
   *  - Results are returned in the SAME ORDER as the requests went in, keyed
   *    back by id. The API returns them in arbitrary order and may omit some
   *    entirely, and reading them positionally is the obvious way to corrupt
   *    an article by pasting one paragraph's rewrite over another's.
   *  - A request that errored, expired or was refused comes back as an
   *    outcome carrying `error`, not as a thrown exception. One bad passage
   *    out of forty must not discard the other thirty-nine.
   *
   * On timeout the batch is cancelled, because leaving it running would bill
   * for work nothing is going to read.
   */
  async runBatch(
    requests: BatchRequest[],
    tally?: Usage[],
    options: {
      maxWaitMs?: number;
      pollMs?: number;
      onProgress?: (progress: BatchProgress) => void;
    } = {},
  ): Promise<BatchOutcome[]> {
    if (!isBatchCapable(this.provider)) {
      throw new LlmError(
        `Provider "${this.provider.name}" has no batch endpoint.`,
        this.provider.name,
      );
    }
    if (requests.length === 0) return [];

    const provider = this.provider;
    const maxWaitMs = options.maxWaitMs ?? 30 * 60 * 1000;
    // Polling interval grows: a batch that has not finished in ten minutes is
    // not going to finish in the next second either, and a tight poll on a
    // long batch is thousands of pointless requests.
    const basePollMs = options.pollMs ?? 5_000;

    const batchId = await provider.submitBatch(requests);
    const startedAt = Date.now();

    try {
      let wait = basePollMs;
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, wait));
        const progress = await provider.pollBatch(batchId);
        options.onProgress?.(progress);

        if (progress.status === 'ended') break;

        if (Date.now() - startedAt > maxWaitMs) {
          await provider.cancelBatch(batchId).catch(() => undefined);
          throw new LlmError(
            `Batch ${batchId} did not finish within ${Math.round(maxWaitMs / 60000)} ` +
              'minute(s) and was cancelled.',
            provider.name,
          );
        }
        wait = Math.min(wait * 1.5, 60_000);
      }

      const outcomes = await provider.collectBatch(batchId);
      const byId = new Map(outcomes.map((outcome) => [outcome.id, outcome]));

      for (const outcome of outcomes) {
        if (outcome.result) this.record(tally, provider.model, outcome.result, true);
      }

      this.logger.log(
        `batch ${batchId} finished in ${Math.round((Date.now() - startedAt) / 1000)}s: ` +
          `${outcomes.filter((o) => o.result).length}/${requests.length} succeeded`,
      );

      // Reordered to match the input, and a request the API never reported on
      // becomes an explicit failure rather than a silent gap.
      return requests.map(
        (entry) =>
          byId.get(entry.id) ?? {
            id: entry.id,
            error: 'The batch returned no result for this request.',
          },
      );
    } catch (error) {
      if (error instanceof LlmError) throw error;
      throw new LlmError(
        error instanceof Error ? error.message : String(error),
        provider.name,
      );
    }
  }

  private record(
    tally: Usage[] | undefined,
    model: string,
    result: CompletionResult,
    batched = false,
  ) {
    if (!tally || !result.usage) return;
    tally.push(
      computeCost(
        model,
        result.usage.inputTokens,
        result.usage.outputTokens,
        result.usage.cacheReadTokens ?? 0,
        result.usage.cacheWriteTokens ?? 0,
        batched,
      ),
    );
  }

  static summarise = summariseUsage;
}
