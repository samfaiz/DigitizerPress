'use client';

import { useEffect, useState } from 'react';
import { getProgress } from '@/lib/api';
import type { Brief } from '@/lib/types';

/**
 * Live progress for a run that takes minutes.
 *
 * A spinner cannot distinguish a slow job from a hung one, and after ninety
 * seconds of no feedback most people assume the second. Naming the current
 * step matters more than the bar: "Section 4 of 9" tells you it is working
 * and roughly how long is left, which a percentage alone does not.
 */
export function ProgressBar({ brief, active }: { brief: Brief; active: boolean }) {
  const [state, setState] = useState<{
    step: string;
    percent: number;
    elapsedMs: number;
  } | null>(null);

  useEffect(() => {
    if (!active) {
      setState(null);
      return;
    }
    let cancelled = false;

    const poll = async () => {
      try {
        const next = await getProgress(brief);
        if (!cancelled) setState(next);
      } catch {
        // A failed poll is not worth surfacing: the run itself reports its
        // own errors, and a progress hiccup should not look like a failure.
      }
    };

    void poll();
    const timer = setInterval(poll, 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [brief, active]);

  if (!active) return null;

  const percent = state?.percent ?? 0;
  const seconds = Math.round((state?.elapsedMs ?? 0) / 1000);

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="truncate">{state?.step ?? 'Starting'}</span>
        <span className="shrink-0 tabular-nums text-muted-foreground">
          {percent}% · {seconds}s
        </span>
      </div>
      <div className="h-1 w-full overflow-hidden bg-muted">
        <div
          className="h-full bg-primary transition-[width] duration-500 ease-out"
          // A run that has not reported yet still shows movement, so the bar
          // never sits at a dead zero while work is happening.
          style={{ width: `${Math.max(4, percent)}%` }}
        />
      </div>
    </div>
  );
}
