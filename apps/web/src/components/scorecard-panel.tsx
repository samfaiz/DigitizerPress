'use client';

import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import type { DraftResponse } from '@/lib/types';
import { cn } from '@/lib/utils';

const BAND_TONE: Record<string, string> = {
  exceptional: 'text-emerald-600 dark:text-emerald-400',
  strong: 'text-emerald-600 dark:text-emerald-400',
  acceptable: 'text-amber-600 dark:text-amber-400',
  below: 'text-amber-600 dark:text-amber-400',
  rewrite: 'text-destructive',
};

/**
 * The delivery contract's verdict.
 *
 * Structured to answer the only question that matters first: did this pass?
 * V1 reported compliance, readability, E-E-A-T and detection in four separate
 * places and left the reader to decide. A contract that does not lead with a
 * verdict is just another dashboard.
 */
export function ScorecardPanel({ result }: { result: DraftResponse }) {
  const { scorecard, gates, attempts, delivered } = result;
  const ratio = (earned: number, max: number) => (max ? earned / max : 0);

  return (
    <div className="space-y-5">
      <div
        className={cn(
          'flex items-baseline gap-3 rounded-md border p-3',
          delivered
            ? 'border-emerald-500/40 bg-emerald-500/5'
            : 'border-destructive/40 bg-destructive/5',
        )}
      >
        <span className={cn('text-3xl font-semibold tabular-nums', BAND_TONE[scorecard.band])}>
          {scorecard.total}
        </span>
        <span className="text-sm text-muted-foreground">/ 100</span>
        <div className="ml-auto text-right">
          <p className={cn('text-sm font-medium', BAND_TONE[scorecard.band])}>
            {delivered ? 'Delivered' : 'Not delivered'}
          </p>
          <p className="text-xs text-muted-foreground">{scorecard.band}</p>
        </div>
      </div>

      {scorecard.critical.length > 0 && (
        <div className="space-y-1 rounded-md border border-destructive/40 p-3">
          <p className="text-xs font-medium text-destructive">
            Critical, blocks delivery whatever the total says
          </p>
          <ul className="list-disc space-y-0.5 pl-4 text-xs">
            {scorecard.critical.map((entry) => (
              <li key={entry}>{entry}</li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <p className="pb-2 text-xs font-medium">Gates</p>
        {gates.map((gate) => (
          <div key={gate.gate} className="flex items-baseline gap-2 pb-1">
            <span
              className={cn(
                'mt-1.5 size-1.5 shrink-0 rounded-full',
                gate.passed ? 'bg-emerald-500' : 'bg-destructive',
              )}
            />
            <div className="min-w-0">
              <p className="text-sm">{gate.gate}</p>
              <p className="text-xs text-muted-foreground">{gate.detail}</p>
            </div>
          </div>
        ))}
      </div>

      <Separator />

      {scorecard.categories.map((category) => (
        <div key={category.id} className="space-y-1">
          <div className="flex items-baseline justify-between">
            <span className="text-sm font-medium">{category.label}</span>
            <span
              className={cn(
                'text-sm tabular-nums',
                ratio(category.earned, category.max) >= 0.85
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : ratio(category.earned, category.max) >= 0.6
                    ? 'text-amber-600 dark:text-amber-400'
                    : 'text-destructive',
              )}
            >
              {category.earned}/{category.max}
            </span>
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full bg-foreground/70"
              style={{ width: `${ratio(category.earned, category.max) * 100}%` }}
            />
          </div>
          {category.lines.map((line) => (
            <div key={line.label} className="flex items-baseline gap-2 pl-2 text-xs">
              <span className="w-10 shrink-0 tabular-nums text-muted-foreground">
                {line.earned}/{line.max}
              </span>
              <span>{line.label}</span>
              <span className="truncate text-muted-foreground">{line.detail}</span>
            </div>
          ))}
        </div>
      ))}

      {attempts.length > 1 && (
        <>
          <Separator />
          <div>
            <p className="pb-2 text-xs font-medium">Attempts</p>
            {attempts.map((attempt) => (
              <div key={attempt.attempt} className="flex items-baseline gap-2 pb-1 text-sm">
                <Badge variant={attempt.passed ? 'default' : 'secondary'}>
                  #{attempt.attempt}
                </Badge>
                <span className="tabular-nums">{attempt.total}/100</span>
                <span className="text-xs text-muted-foreground">
                  {attempt.blockedBy[0] ?? 'passed'}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
