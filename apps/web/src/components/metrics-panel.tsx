'use client';

import { Separator } from '@/components/ui/separator';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import type { ScoreMetrics } from '@/lib/types';
import { cn } from '@/lib/utils';

interface MetricsPanelProps {
  before: ScoreMetrics;
  after?: ScoreMetrics;
}

/**
 * Explains the number.
 *
 * A bare percentage invites the user to argue with it. Showing which feature
 * moved, and in which direction, turns the score into something they can act
 * on: it tells them their sentences are all the same length, not merely that
 * a model disliked their writing.
 */
interface Row {
  key: keyof ScoreMetrics;
  label: string;
  explain: string;
  /** Direction that reads as more human, used to colour the delta. */
  humanIs: 'higher' | 'lower';
  format: (value: number) => string;
}

const ROWS: Row[] = [
  {
    key: 'perplexity',
    label: 'Perplexity',
    explain: 'How surprising the wording is to a language model. Machine text is predictable.',
    humanIs: 'higher',
    format: (value) => value.toFixed(1),
  },
  {
    key: 'burstiness',
    label: 'Burstiness',
    explain: 'Variation in surprisal between sentences. People swing; models hold a steady rhythm.',
    humanIs: 'higher',
    format: (value) => value.toFixed(3),
  },
  {
    key: 'sentence_length_cv',
    label: 'Length variation',
    explain: 'Spread of sentence lengths. The most fixable weakness on this list.',
    humanIs: 'higher',
    format: (value) => value.toFixed(3),
  },
  {
    key: 'tell_word_rate',
    label: 'Tell words',
    explain: 'Rate per 1000 words of vocabulary models overuse: delve, robust, pivotal, underscore.',
    humanIs: 'lower',
    format: (value) => value.toFixed(1),
  },
  {
    key: 'repeated_trigram_rate',
    label: 'Repeated phrases',
    explain: 'Share of three-word sequences that appear more than once.',
    humanIs: 'lower',
    format: (value) => `${(value * 100).toFixed(1)}%`,
  },
  {
    key: 'em_dash_rate',
    label: 'Em dashes',
    explain: 'Rate per 1000 words. A small signal on its own, and a well known one.',
    humanIs: 'lower',
    format: (value) => value.toFixed(1),
  },
  {
    key: 'punctuation_variety',
    label: 'Punctuation mix',
    explain: 'Entropy of the punctuation profile. Human writing is idiosyncratic here.',
    humanIs: 'higher',
    format: (value) => value.toFixed(3),
  },
  {
    key: 'mean_word_length',
    label: 'Word length',
    explain: 'Average characters per word. Longer means more formal, more machine-like.',
    humanIs: 'lower',
    format: (value) => value.toFixed(2),
  },
];

export function MetricsPanel({ before, after }: MetricsPanelProps) {
  return (
    <div className="space-y-1">
      <div className="grid grid-cols-[1fr_auto_auto] gap-x-4 pb-1 text-xs text-muted-foreground">
        <span>Signal</span>
        <span className="text-right tabular-nums">{after ? 'Before' : 'Value'}</span>
        <span className="w-16 text-right tabular-nums">{after ? 'After' : ''}</span>
      </div>
      <Separator />
      {ROWS.map((row) => {
        const start = before[row.key];
        const end = after?.[row.key];
        const improved =
          end === undefined
            ? null
            : row.humanIs === 'higher'
              ? end > start
              : end < start;

        return (
          <div
            key={row.key}
            className="grid grid-cols-[1fr_auto_auto] items-center gap-x-4 py-1 text-sm"
          >
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="cursor-help underline decoration-dotted underline-offset-4" />
                }
              >
                {row.label}
              </TooltipTrigger>
              <TooltipContent side="right" className="max-w-xs">
                <p className="text-xs">{row.explain}</p>
              </TooltipContent>
            </Tooltip>
            <span className="text-right tabular-nums text-muted-foreground">
              {row.format(start)}
            </span>
            <span
              className={cn(
                'w-16 text-right tabular-nums',
                improved === null && 'text-muted-foreground',
                improved === true && 'text-emerald-600 dark:text-emerald-400',
                improved === false && 'text-muted-foreground',
              )}
            >
              {end === undefined ? '' : row.format(end)}
            </span>
          </div>
        );
      })}
    </div>
  );
}
