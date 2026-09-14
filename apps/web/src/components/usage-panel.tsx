'use client';

import type { UsageSummary } from '@/lib/types';

/**
 * What this request cost.
 *
 * Shown per request rather than as a running total, because the useful
 * question when tuning is "what did this one cost me", and that is what tells
 * you whether another pass or a bigger model is worth it.
 */
export function UsagePanel({ usage }: { usage: UsageSummary }) {
  if (usage.calls === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No metered model calls. The provider in use reports no token usage.
      </p>
    );
  }

  const format = (value: number) =>
    value >= 0.01 ? `$${value.toFixed(3)}` : `$${value.toFixed(5)}`;

  return (
    <div className="space-y-3">
      <div className="flex items-end justify-between gap-4">
        <div>
          <p className="text-2xl font-semibold tabular-nums">{format(usage.costUsd)}</p>
          <p className="text-xs text-muted-foreground">this request</p>
        </div>
        <div className="text-right text-xs text-muted-foreground">
          <p className="tabular-nums">{usage.totalTokens.toLocaleString()} tokens</p>
          <p className="tabular-nums">
            {usage.inputTokens.toLocaleString()} in / {usage.outputTokens.toLocaleString()} out
          </p>
        </div>
      </div>

      <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-3 text-xs text-muted-foreground">
        <span>Model</span>
        <span className="w-10 text-right">Calls</span>
        <span className="w-16 text-right">Tokens</span>
        <span className="w-16 text-right">Cost</span>
      </div>

      {usage.byModel.map((row) => (
        <div
          key={row.model}
          className="grid grid-cols-[1fr_auto_auto_auto] gap-x-3 text-sm"
        >
          <span className="truncate">{row.model}</span>
          <span className="w-10 text-right tabular-nums">{row.calls}</span>
          <span className="w-16 text-right tabular-nums">
            {row.tokens.toLocaleString()}
          </span>
          <span className="w-16 text-right tabular-nums">{format(row.costUsd)}</span>
        </div>
      ))}

      <p className="text-xs text-muted-foreground">
        Estimated from published per-token rates. Output includes thinking
        tokens, which are billed but never shown.
      </p>
    </div>
  );
}
