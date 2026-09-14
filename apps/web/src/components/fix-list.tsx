'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import type { ComplianceCheck } from '@/lib/types';
import { cn } from '@/lib/utils';

const DOT: Record<string, string> = {
  good: 'bg-emerald-500',
  warn: 'bg-amber-500',
  bad: 'bg-destructive',
};

/**
 * Checks, with the failing ones actionable.
 *
 * A report that says "2 of 3 secondary keywords used" leaves the reader to
 * work out what to do. Selecting failures and applying them in one revision
 * pass is both cheaper and better than fixing them one at a time: each pass
 * costs a full model call, and a single call that addresses four problems
 * usually lands better than four calls that each address one.
 */
export function FixList({
  checks,
  onApply,
  busy,
}: {
  checks: ComplianceCheck[];
  onApply: (instructions: string[]) => void;
  busy: boolean;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const fixable = checks.filter((check) => check.fix && check.fix.kind !== 'manual');
  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const chosen = fixable
    .filter((check) => selected.has(check.id))
    .map((check) => check.fix!.instruction);

  return (
    <div className="space-y-3">
      {checks.map((check) => (
        <div key={check.id} className="flex items-baseline gap-2">
          <span className={cn('mt-1.5 size-1.5 shrink-0', DOT[check.status])} />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-3">
              <p className="text-sm">{check.label}</p>
              {check.fix && check.fix.kind !== 'manual' && (
                <button
                  type="button"
                  onClick={() => toggle(check.id)}
                  className={cn(
                    'shrink-0 border px-2 py-0.5 text-xs transition-colors',
                    selected.has(check.id)
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-border text-muted-foreground hover:text-foreground',
                  )}
                >
                  {selected.has(check.id) ? 'Selected' : check.fix.label}
                </button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">{check.detail}</p>
            {check.fix?.kind === 'manual' && (
              <p className="text-xs text-amber-500">{check.fix.instruction}</p>
            )}
          </div>
        </div>
      ))}

      {fixable.length > 0 && (
        <div className="flex items-center gap-3 border-t pt-3">
          <Button
            size="sm"
            disabled={chosen.length === 0 || busy}
            onClick={() => onApply(chosen)}
          >
            {busy
              ? 'Applying…'
              : `Apply ${chosen.length || ''} fix${chosen.length === 1 ? '' : 'es'}`}
          </Button>
          <p className="text-xs text-muted-foreground">
            One revision pass, roughly a few cents. Kept only if it improves more
            than it breaks.
          </p>
        </div>
      )}
    </div>
  );
}
