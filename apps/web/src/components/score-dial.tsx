'use client';

import { scoreTone } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * Round to a whole number, except where that would print 0 or 100.
 * Those two readings claim certainty the model does not have, and at the top
 * of the range they also flatten a real improvement into no visible change.
 */
function format(score: number): string {
  const rounded = Math.round(score);
  return rounded === 0 || rounded === 100 ? score.toFixed(1) : String(rounded);
}

interface ScoreDialProps {
  score: number;
  label: string;
  /** Previous score, drawn as a ghost arc so the change is visible at a glance. */
  compareTo?: number;
  size?: number;
}

/**
 * The headline number.
 *
 * An arc rather than a bar because the reading is a proportion, and the ghost
 * arc for the previous score is what makes a before/after pair legible without
 * asking the reader to hold two numbers in their head.
 */
export function ScoreDial({ score, label, compareTo, size = 148 }: ScoreDialProps) {
  const tone = scoreTone(score);
  const radius = size / 2 - 12;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - score / 100);
  const ghostOffset =
    compareTo === undefined ? undefined : circumference * (1 - compareTo / 100);

  return (
    <div className="flex flex-col items-center gap-2">
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="-rotate-90">
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            strokeWidth={10}
            className="stroke-muted"
          />
          {ghostOffset !== undefined && (
            <circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              strokeWidth={10}
              strokeDasharray={circumference}
              strokeDashoffset={ghostOffset}
              strokeLinecap="round"
              className="stroke-muted-foreground/25"
            />
          )}
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            strokeWidth={10}
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            strokeLinecap="round"
            className={cn(tone.stroke, 'transition-[stroke-dashoffset] duration-700')}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span
            className={cn(
              'font-semibold tabular-nums',
              tone.text,
              format(score).length > 3 ? 'text-3xl' : 'text-4xl',
            )}
          >
            {format(score)}
          </span>
          <span className="text-xs text-muted-foreground">% AI</span>
        </div>
      </div>
      <div className="text-center">
        <p className="text-sm font-medium">{label}</p>
        <p className={cn('text-xs', tone.text)}>{tone.label}</p>
      </div>
    </div>
  );
}
