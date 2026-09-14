'use client';

import { Badge } from '@/components/ui/badge';
import { scoreTone } from '@/lib/api';
import type { DetectorName, Verification } from '@/lib/types';
import { cn } from '@/lib/utils';

const LABELS: Record<DetectorName, string> = {
  local: 'Local scorer',
  gptzero: 'GPTZero',
  originality: 'Originality.ai',
  zerogpt: 'ZeroGPT',
};

/**
 * Second opinions from the detectors that actually judge the user.
 *
 * The point of this panel is to make the gap visible. The headline dial shows
 * the local score, which is a proxy. If a commercial detector still reads the
 * output as machine-written, that has to be shown plainly rather than buried,
 * because it is the only number the user is really measured on.
 */
export function VerificationPanel({ verification }: { verification: Verification }) {
  const rows = verification.after.map((after) => {
    const before = verification.before.find((entry) => entry.detector === after.detector);
    return { detector: after.detector, before: before?.score ?? null, after };
  });

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          The loop optimised{' '}
          <span className="font-medium text-foreground">
            {LABELS[verification.primary]}
          </span>
          . These are independent readings of your input and the final output.
        </p>
        {verification.estimatedCost > 0 && (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            ~${verification.estimatedCost.toFixed(3)}
          </span>
        )}
      </div>

      <div className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-x-3 text-xs text-muted-foreground">
        <span>Detector</span>
        <span className="w-12 text-right">Before</span>
        <span className="w-12 text-right">After</span>
        <span className="w-14 text-right">Change</span>
      </div>

      {rows.map((row) => {
        const failed = row.after.score === null;
        const delta =
          row.before !== null && row.after.score !== null
            ? row.after.score - row.before
            : null;
        const tone = row.after.score !== null ? scoreTone(row.after.score) : null;

        return (
          <div key={row.detector} className="space-y-1">
            <div className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-x-3 text-sm">
              <span className="flex items-center gap-2">
                {LABELS[row.detector]}
                {row.detector === verification.primary && (
                  <Badge variant="secondary" className="h-4 px-1 text-[10px]">
                    primary
                  </Badge>
                )}
              </span>
              <span className="w-12 text-right tabular-nums text-muted-foreground">
                {row.before === null ? '--' : row.before.toFixed(0)}
              </span>
              <span className={cn('w-12 text-right font-medium tabular-nums', tone?.text)}>
                {failed ? '--' : row.after.score!.toFixed(0)}
              </span>
              <span
                className={cn(
                  'w-14 text-right tabular-nums',
                  delta === null && 'text-muted-foreground',
                  // Down is good here: a lower AI score is the goal.
                  delta !== null && delta < 0 && 'text-emerald-600 dark:text-emerald-400',
                  delta !== null && delta >= 0 && 'text-muted-foreground',
                )}
              >
                {delta === null ? '' : `${delta > 0 ? '+' : ''}${delta.toFixed(0)}`}
              </span>
            </div>
            {failed && (
              <p className="text-xs text-destructive">{row.after.error}</p>
            )}
          </div>
        );
      })}
    </div>
  );
}
