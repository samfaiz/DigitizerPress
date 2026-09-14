'use client';

import { Separator } from '@/components/ui/separator';
import type { Readability } from '@/lib/types';
import { cn } from '@/lib/utils';

const DOT: Record<string, string> = {
  good: 'bg-emerald-500',
  warn: 'bg-amber-500',
  bad: 'bg-rose-500',
};

/**
 * SEO readability, in the shape Yoast reports it.
 *
 * Shown next to the detection score because the two are different axes and
 * conflating them is the mistake worth designing against. Most of these checks
 * pull the same way as lowering a detection score. One does not, and the
 * transition-word row says so in its own detail line.
 */
export function ReadabilityPanel({
  before,
  after,
}: {
  before: Readability;
  after?: Readability;
}) {
  const source = after ?? before;
  const failing = source.checks.filter((check) => check.status !== 'good').length;

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        {failing === 0
          ? 'Every readability check passes.'
          : `${failing} of ${source.checks.length} checks need attention.`}
        {after && ' Values are for the rewritten text.'}
      </p>
      <Separator />

      {source.checks.map((check) => {
        const previous = after
          ? before.checks.find((entry) => entry.id === check.id)
          : undefined;
        const moved =
          previous && Math.abs(previous.value - check.value) > 0.05
            ? previous.value
            : null;

        return (
          <div key={check.id} className="space-y-0.5">
            <div className="flex items-baseline gap-2">
              <span
                className={cn('mt-1.5 size-1.5 shrink-0 rounded-full', DOT[check.status])}
              />
              <span className="text-sm">{check.label}</span>
              <span className="ml-auto shrink-0 text-sm tabular-nums">
                {moved !== null && (
                  <span className="mr-1.5 text-xs text-muted-foreground line-through">
                    {moved.toFixed(1)}
                  </span>
                )}
                {check.value.toFixed(1)}
              </span>
            </div>
            <p className="pl-3.5 text-xs text-muted-foreground">
              {check.detail} Target: {check.target}.
            </p>
          </div>
        );
      })}
    </div>
  );
}
