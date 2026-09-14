import Anthropic from '@anthropic-ai/sdk';
import { Logger } from '@nestjs/common';
import {
  LlmError,
  type BatchOutcome,
  type BatchProgress,
  type BatchRequest,
  type CompletionRequest,
  type CompletionResult,
  type LlmProvider,
} from '../llm.types.js';

/**
 * Shortest system block the API will actually cache, per model family.
 *
 * A shorter block is not an error. `cache_control` is accepted, the request
 * succeeds, and the caching simply does not happen, which is the worst
 * possible failure mode: it costs money and reports nothing.
 *
 * This bit. The chunk rewriter set cacheSystem on all forty calls per pass
 * while its system block measured 916 tokens, so not one of them cached.
 * Measured on a 2,000-word article, the humanize phase added 47,623 UNCACHED
 * input tokens and zero cache reads, roughly $0.09 an article that should
 * have been $0.01.
 */
const MIN_CACHEABLE_TOKENS: Array<[RegExp, number]> = [
  [/haiku/, 2048],
  [/./, 1024],
];

/**
 * Rough token estimate, used only to decide whether to warn.
 *
 * Calibrated against a counted prompt rather than the usual chars/4 rule of
 * thumb: the rewrite system block measures 3,988 characters and 1,385 tokens
 * on Sonnet 5, so 2.88 characters per token. Instructional prose full of
 * short words and punctuation tokenises denser than running text. The first
 * version of this guard used 3.6 and cried wolf on a prompt that was well
 * over the limit.
 */
const approximateTokens = (text: string): number => Math.ceil(text.length / 2.9);

/**
 * Claude via the Anthropic API. The production rewriter.
 *
 * Three things differ from the other providers, and all three matter here.
 *
 * 1. No sampling controls on the current models. `temperature`, `top_p` and
 *    `top_k` were removed on Opus 5, Sonnet 5 and the 4.6+ family, and sending
 *    one returns a 400. Temperature was doing real work in this pipeline,
 *    because low-temperature output is exactly the flat, predictable phrasing
 *    the detector scores as machine-written. That load now sits on the rhythm
 *    instructions in the prompt and on the deterministic pass. Haiku 4.5 still
 *    accepts sampling, so the parameter is sent only when the configured model
 *    supports it.
 *
 * 2. Thinking is on by default and its tokens count against `max_tokens`.
 *    A cap sized for the prose alone would truncate the rewrite mid-sentence.
 *
 * 3. A request can come back refused rather than throwing. `stop_reason` has
 *    to be checked before the content is read.
 */
type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';

  private readonly logger = new Logger(AnthropicProvider.name);
  private readonly client?: Anthropic;
  /** Warned already for this prompt. One line per prompt, not per call. */
  private readonly cacheWarned = new Set<string>();

  constructor(
    private readonly apiKey: string | undefined,
    readonly model: string,
    private readonly effort: Effort,
    private readonly defaultThinking: 'adaptive' | 'disabled' = 'adaptive',
  ) {
    if (apiKey) this.client = new Anthropic({ apiKey });
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  /** Models that still accept temperature. Everything current does not. */
  private supportsSampling(): boolean {
    return /haiku-4-5|sonnet-4-5|claude-3/.test(this.model);
  }

  /**
   * Effort is not universal. Haiku 4.5 and Sonnet 4.5 reject it outright with
   * a 400, which is how the judge silently stopped running the first time this
   * shipped: the judge defaults to Haiku, and every call 400'd.
   *
   * An allowlist rather than a denylist, so an unrecognised model simply goes
   * without effort instead of failing every request.
   */
  private effortParam(): { effort: Effort } | null {
    if (!/opus-5|opus-4-[5-8]|sonnet-5|sonnet-4-6|fable-5|mythos-5/.test(this.model)) {
      return null;
    }
    // Opus 4.5 predates the top two levels and 400s on them.
    if (/opus-4-5/.test(this.model) && /xhigh|max/.test(this.effort)) {
      return { effort: 'high' };
    }
    return { effort: this.effort };
  }

  /**
   * Server-side refusal fallbacks are only meaningful on the frontier models
   * that can decline. On a policy decline the API reruns the same request on a
   * fallback model inside the same call, and an unbilled decline becomes a
   * useful answer instead of a failed pass.
   */
  private supportsFallbacks(): boolean {
    return /opus-5|fable-5/.test(this.model);
  }

  /**
   * Say so when a caller asks for caching it will not get.
   *
   * The estimate is deliberately crude, and the threshold is checked with a
   * margin, because the point is to catch a prompt that has drifted under the
   * limit rather than to predict the tokeniser exactly. A false alarm costs a
   * log line; a missed one costs roughly a third of the bill.
   */
  private warnIfUncacheable(system: string): void {
    const minimum =
      MIN_CACHEABLE_TOKENS.find(([pattern]) => pattern.test(this.model))?.[1] ?? 1024;
    const estimate = approximateTokens(system);
    // No inflated margin now the estimator is calibrated. A block within 5%
    // of the limit is close enough that a warning is worth more than silence.
    if (estimate >= minimum * 0.95) return;

    const key = `${system.length}:${minimum}`;
    if (this.cacheWarned.has(key)) return;
    this.cacheWarned.add(key);

    this.logger.warn(
      `Prompt caching requested but the system block is about ${estimate} tokens, ` +
        `under the ${minimum}-token minimum for ${this.model}. The API will ` +
        'accept cache_control and silently not cache, so every call pays full ' +
        'input price. Lengthen the system block or stop asking to cache it.',
    );
  }

  /**
   * Turn a CompletionRequest into Messages API parameters.
   *
   * Shared by the synchronous path and the batch path on purpose. A batch is
   * only useful if it produces the same output as the call it replaces, and
   * the surest way to break that is to build the request twice. Everything
   * model-specific lives here: effort, thinking, sampling support, caching.
   */
  private buildParams(request: CompletionRequest): {
    body: Record<string, unknown>;
    betas: string[];
  } {
    const useFallbacks = this.supportsFallbacks();
    const effort = this.effortParam();
    const thinking = request.thinking ?? this.defaultThinking;

    // Disabling thinking is rejected on Opus 5 above effort "high", so the
    // request is only shaped that way where the model actually accepts it.
    const canDisable =
      /sonnet-5|sonnet-4-6|opus-4-8|opus-4-7/.test(this.model) ||
      (/opus-5/.test(this.model) && !/xhigh|max/.test(this.effort));
    const disableThinking = thinking === 'disabled' && canDisable;

    // A system block is only worth caching when it will be sent repeatedly,
    // and the minimum cacheable prefix is model dependent, so a short block
    // silently will not cache. Sending it as a content array costs nothing
    // when the flag is off.
    if (request.cacheSystem) this.warnIfUncacheable(request.system);

    const system = request.cacheSystem
      ? [
          {
            type: 'text' as const,
            text: request.system,
            cache_control: { type: 'ephemeral' as const },
          },
        ]
      : request.system;

    return {
      betas: useFallbacks ? ['server-side-fallback-2026-07-01'] : [],
      body: {
        model: this.model,
        // Generous on purpose. Thinking tokens are billed as output and count
        // against this cap, so a limit sized for the prose alone truncates.
        // A cap is not a spend: you pay only for what is actually generated.
        max_tokens: 16000,
        system,
        messages: [{ role: 'user' as const, content: request.user }],
        ...(effort ? { output_config: effort } : {}),
        ...(disableThinking ? { thinking: { type: 'disabled' as const } } : {}),
        ...(this.supportsSampling()
          ? { temperature: request.temperature ?? 0.9 }
          : {}),
        ...(useFallbacks ? { fallbacks: 'default' as const } : {}),
      },
    };
  }

  /**
   * Read one Messages response into a CompletionResult.
   *
   * Also shared between the two paths, for the same reason: a refusal arrives
   * as a normal response on both, and a batch that skipped the check would
   * quietly write an empty string into the middle of an article.
   */
  private readResponse(response: Anthropic.Beta.BetaMessage): CompletionResult {
    if (response.stop_reason === 'refusal') {
      const category = response.stop_details?.category ?? 'unspecified';
      throw new LlmError(
        `Claude declined this passage (${category}). The original text was kept.`,
        this.name,
      );
    }

    const text = response.content
      .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();

    if (!text) throw new LlmError('Claude returned no text content', this.name, true);

    return {
      text,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
      },
    };
  }


  /**
   * The Message Batches API. Half price, asynchronous, up to 24 hours.
   *
   * The trade is latency for money and it is only worth taking on requests
   * that do not depend on each other. Inside this pipeline that means the
   * chunk rewrites of one humanize pass, which are forty independent calls,
   * and the same phase across many articles. It does NOT mean the section
   * drafting calls, which each depend on the tail of the one before, and it
   * does not mean the judge, which cannot run until the rewrite it judges
   * exists.
   *
   * One caveat worth knowing before reading the savings as a straight 50%.
   * Prompt caching still applies to batched requests, but the requests are
   * processed independently and may not hit a warm cache the way forty
   * sequential calls do. On a prompt where caching is working, the discount
   * and the cache pull against each other, so the honest thing is to measure
   * it rather than to add the two savings together.
   */
  supportsBatch(): boolean {
    return this.client !== undefined;
  }

  async submitBatch(requests: BatchRequest[]): Promise<string> {
    if (!this.client) throw new LlmError('ANTHROPIC_API_KEY is not set', this.name);
    if (requests.length === 0) {
      throw new LlmError('Cannot submit an empty batch', this.name);
    }

    // Duplicate ids make results unmatchable, and the API rejects them, but
    // it is worth failing here with a message that names the problem.
    const seen = new Set<string>();
    for (const entry of requests) {
      if (seen.has(entry.id)) {
        throw new LlmError(`Duplicate batch request id: ${entry.id}`, this.name);
      }
      seen.add(entry.id);
    }

    const betas = new Set<string>();
    const items = requests.map((entry) => {
      const { body, betas: requestBetas } = this.buildParams(entry.request);
      for (const beta of requestBetas) betas.add(beta);
      return {
        custom_id: entry.id,
        params: body as never,
      };
    });

    const batch = await this.client.beta.messages.batches.create({
      requests: items,
      ...(betas.size > 0 ? { betas: [...betas] as never } : {}),
    });
    this.logger.log(`batch ${batch.id} submitted with ${requests.length} request(s)`);
    return batch.id;
  }

  async pollBatch(batchId: string): Promise<BatchProgress> {
    if (!this.client) throw new LlmError('ANTHROPIC_API_KEY is not set', this.name);
    const batch = await this.client.beta.messages.batches.retrieve(batchId);
    const counts = batch.request_counts;
    return {
      status: batch.processing_status,
      succeeded: counts.succeeded,
      errored: counts.errored,
      expired: counts.expired,
      canceled: counts.canceled,
      processing: counts.processing,
    };
  }

  async collectBatch(batchId: string): Promise<BatchOutcome[]> {
    if (!this.client) throw new LlmError('ANTHROPIC_API_KEY is not set', this.name);

    const outcomes: BatchOutcome[] = [];
    const stream = await this.client.beta.messages.batches.results(batchId);
    for await (const entry of stream) {
      if (entry.result.type === 'succeeded') {
        try {
          outcomes.push({ id: entry.custom_id, result: this.readResponse(entry.result.message) });
        } catch (error) {
          // A refusal or an empty body. Recorded as a failed entry rather
          // than thrown, so one bad passage does not discard the other
          // thirty-nine results in the same batch.
          outcomes.push({
            id: entry.custom_id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        continue;
      }

      outcomes.push({
        id: entry.custom_id,
        error:
          entry.result.type === 'errored'
            ? `Batch request errored: ${JSON.stringify(entry.result.error?.error ?? {})}`
            : `Batch request ${entry.result.type}.`,
      });
    }
    return outcomes;
  }

  async cancelBatch(batchId: string): Promise<void> {
    if (!this.client) throw new LlmError('ANTHROPIC_API_KEY is not set', this.name);
    await this.client.beta.messages.batches.cancel(batchId);
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    if (!this.client) throw new LlmError('ANTHROPIC_API_KEY is not set', this.name);

    const useFallbacks = this.supportsFallbacks();
    const effort = this.effortParam();
    const thinking = request.thinking ?? this.defaultThinking;

    // Disabling thinking is rejected on Opus 5 above effort "high", so the
    // request is only shaped that way where the model actually accepts it.
    const canDisable =
      /sonnet-5|sonnet-4-6|opus-4-8|opus-4-7/.test(this.model) ||
      (/opus-5/.test(this.model) && !/xhigh|max/.test(this.effort));
    const disableThinking = thinking === 'disabled' && canDisable;

    if (request.cacheSystem) this.warnIfUncacheable(request.system);

    const system = request.cacheSystem
      ? [
          {
            type: 'text' as const,
            text: request.system,
            cache_control: { type: 'ephemeral' as const },
          },
        ]
      : request.system;

    try {
      const response = await this.client.beta.messages.create({
        model: this.model,
        // Generous on purpose. Thinking tokens are billed as output and count
        // against this cap, so a limit sized for the prose alone truncates.
        // A cap is not a spend: you pay only for what is actually generated.
        max_tokens: 16000,
        system,
        messages: [{ role: 'user', content: request.user }],
        // Paraphrase under style constraints is not a hard reasoning problem,
        // so low effort is the right default. Raise it with ANTHROPIC_EFFORT
        // if rewrite quality matters more than cost on your traffic. Omitted
        // entirely on models that do not accept it.
        ...(effort ? { output_config: effort } : {}),
        ...(disableThinking ? { thinking: { type: 'disabled' as const } } : {}),
        ...(this.supportsSampling()
          ? { temperature: request.temperature ?? 0.9 }
          : {}),
        ...(useFallbacks
          ? {
              betas: ['server-side-fallback-2026-07-01'],
              fallbacks: 'default' as const,
            }
          : {}),
      });

      // A refusal arrives as HTTP 200, not an exception. Reading content
      // without this check would silently return an empty rewrite.
      if (response.stop_reason === 'refusal') {
        const category = response.stop_details?.category ?? 'unspecified';
        throw new LlmError(
          `Claude declined this passage (${category}). The original text was kept.`,
          this.name,
        );
      }

      const text = response.content
        .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('')
        .trim();

      if (!text) throw new LlmError('Claude returned no text content', this.name, true);

      // Thinking tokens are billed as output and are included here by the
      // API, which is why the output count can exceed the visible prose.
      return {
        text,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
        },
      };
    } catch (error) {
      if (error instanceof LlmError) throw error;

      if (error instanceof Anthropic.AuthenticationError) {
        throw new LlmError('ANTHROPIC_API_KEY was rejected', this.name);
      }
      if (error instanceof Anthropic.RateLimitError) {
        throw new LlmError('Anthropic rate limit reached', this.name, true);
      }
      if (error instanceof Anthropic.APIError) {
        throw new LlmError(
          `Anthropic returned ${error.status}: ${error.message}`,
          this.name,
          error.status !== undefined && error.status >= 500,
        );
      }
      throw new LlmError(
        error instanceof Error ? error.message : 'Unknown Anthropic failure',
        this.name,
        true,
      );
    }
  }
}
