export interface CompletionRequest {
  system: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
  /**
   * Thinking tokens are billed as output and never shown. Drafting prose is
   * not a reasoning task, and on a long article the thinking bill is a large
   * share of the total, so this is the single biggest cost lever available.
   */
  thinking?: 'adaptive' | 'disabled';
  /**
   * Mark the system block cacheable. Only worth setting when the same system
   * text is sent many times in a row, which is exactly what section drafting
   * does: ten calls sharing one brief.
   */
  cacheSystem?: boolean;
}

/**
 * Every provider implements this and nothing more.
 *
 * The humanize loop is written against this interface only, so swapping a
 * free local model for a paid API is a config change rather than a refactor.
 * That matters here more than usual, because the sensible path is to develop
 * against a free provider and upgrade the rewrite quality later.
 */
/**
 * A completion, plus what it cost when the provider reports usage.
 *
 * Optional because only metered providers return token counts. Ollama and the
 * echo passthrough have no meaningful spend, and inventing a number for them
 * would make the readout dishonest.
 */
export interface CompletionResult {
  text: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    /** Billed at roughly a tenth of the input rate. */
    cacheReadTokens?: number;
    /** Billed at roughly 1.25x the input rate, once. */
    cacheWriteTokens?: number;
  };
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  /** False when the provider is missing a key or an unreachable dependency. */
  isConfigured(): boolean;
  complete(request: CompletionRequest): Promise<CompletionResult>;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

/**
 * One request inside a batch, tagged so its result can be found again.
 *
 * Batch results come back in arbitrary order and some entries may be missing
 * entirely, so every caller has to match on id rather than on position. That
 * is the single most important difference from the synchronous path and the
 * one most likely to be got wrong.
 */
export interface BatchRequest {
  id: string;
  request: CompletionRequest;
}

/**
 * What became of one batched request.
 *
 * Either `result` or `error` is set, never both. A batch can end with some
 * requests succeeded, some errored and some expired, so a failed entry is an
 * ordinary outcome to be handled, not an exception to be thrown.
 */
export interface BatchOutcome {
  id: string;
  result?: CompletionResult;
  error?: string;
}

export type BatchStatus = 'in_progress' | 'canceling' | 'ended';

export interface BatchProgress {
  status: BatchStatus;
  succeeded: number;
  errored: number;
  expired: number;
  canceled: number;
  processing: number;
}

/**
 * Asynchronous bulk completion, at half the per-token price.
 *
 * Implemented only by providers that actually offer it. Everything else keeps
 * to the synchronous interface, and callers check `supportsBatch()` rather
 * than assuming.
 */
export interface BatchCapableProvider extends LlmProvider {
  supportsBatch(): boolean;
  /** Hand the requests over. Returns the provider's batch id. */
  submitBatch(requests: BatchRequest[]): Promise<string>;
  /** Cheap status poll. Does not download results. */
  pollBatch(batchId: string): Promise<BatchProgress>;
  /** Download and decode results. Only valid once the batch has ended. */
  collectBatch(batchId: string): Promise<BatchOutcome[]>;
  cancelBatch(batchId: string): Promise<void>;
}

export function isBatchCapable(
  provider: LlmProvider,
): provider is BatchCapableProvider {
  return (
    typeof (provider as BatchCapableProvider).supportsBatch === 'function' &&
    (provider as BatchCapableProvider).supportsBatch()
  );
}
