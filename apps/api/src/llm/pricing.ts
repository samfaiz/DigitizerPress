/**
 * Per-million-token prices in USD, for the spend readout.
 *
 * Anthropic first-party rates. These change, and they differ on Bedrock and
 * Vertex, so treat the figure the UI shows as an estimate rather than a bill.
 * An unknown model reports zero cost rather than guessing, because a wrong
 * number here is worse than no number.
 */
export interface ModelPrice {
  inputPerMillion: number;
  outputPerMillion: number;
}

const PRICES: Array<[RegExp, ModelPrice]> = [
  [/fable-5|mythos-5/, { inputPerMillion: 10, outputPerMillion: 50 }],
  [/opus-5|opus-4-8|opus-4-7|opus-4-6/, { inputPerMillion: 5, outputPerMillion: 25 }],
  [/sonnet-5/, { inputPerMillion: 2, outputPerMillion: 10 }],
  [/sonnet-4-6/, { inputPerMillion: 3, outputPerMillion: 15 }],
  [/haiku-4-5/, { inputPerMillion: 1, outputPerMillion: 5 }],
];

export function priceFor(model: string): ModelPrice | null {
  return PRICES.find(([pattern]) => pattern.test(model))?.[1] ?? null;
}

export interface Usage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /**
   * Tokens written into the prompt cache, billed once at 1.25x input.
   *
   * Reported because it is not small. On a measured eight-article bulk job
   * cache writes were about 30% of the gross bill: every article carries its
   * own brief, so every article writes its own cache entry and only reads it
   * back a handful of times. Leaving it out of the summary made the totals
   * impossible to reconcile against the dollar figure.
   */
  cacheWriteTokens: number;
  costUsd: number;
  /** True when this call was billed at the Batch API's half rate. */
  batched?: boolean;
}

/**
 * The Message Batches discount. Applies to input, output and cached reads
 * alike, so it multiplies the whole line rather than any one term.
 */
export const BATCH_RATE = 0.5;

export function computeCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
  batched = false,
): Usage {
  const price = priceFor(model);
  if (!price) {
    return {
      model,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      costUsd: 0,
      batched,
    };
  }
  // Anthropic reports cached reads separately from input_tokens, so they are
  // priced separately here: reads at a tenth of input, writes at 1.25x once.
  const discount = batched ? BATCH_RATE : 1;
  const costUsd =
    ((inputTokens * price.inputPerMillion +
      cacheReadTokens * price.inputPerMillion * 0.1 +
      cacheWriteTokens * price.inputPerMillion * 1.25 +
      outputTokens * price.outputPerMillion) *
      discount) /
    1_000_000;
  return {
    model,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    costUsd,
    batched,
  };
}

/** Roll several calls into one line for the response. */
export function summariseUsage(entries: Usage[]): {
  calls: number;
  /** How many of those calls were billed at the batch rate. */
  batchedCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number;
  byModel: Array<{ model: string; calls: number; tokens: number; costUsd: number }>;
} {
  const byModel = new Map<string, { calls: number; tokens: number; costUsd: number }>();
  for (const entry of entries) {
    const row = byModel.get(entry.model) ?? { calls: 0, tokens: 0, costUsd: 0 };
    row.calls += 1;
    row.tokens += entry.inputTokens + entry.outputTokens;
    row.costUsd += entry.costUsd;
    byModel.set(entry.model, row);
  }

  const inputTokens = entries.reduce((total, e) => total + e.inputTokens, 0);
  const outputTokens = entries.reduce((total, e) => total + e.outputTokens, 0);
  const cacheReadTokens = entries.reduce((total, e) => total + (e.cacheReadTokens ?? 0), 0);
  const cacheWriteTokens = entries.reduce((total, e) => total + (e.cacheWriteTokens ?? 0), 0);
  const batchedCalls = entries.reduce((total, e) => total + (e.batched ? 1 : 0), 0);

  return {
    calls: entries.length,
    batchedCalls,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
    costUsd: Number(entries.reduce((total, e) => total + e.costUsd, 0).toFixed(6)),
    byModel: [...byModel].map(([model, row]) => ({
      model,
      calls: row.calls,
      tokens: row.tokens,
      costUsd: Number(row.costUsd.toFixed(6)),
    })),
  };
}
