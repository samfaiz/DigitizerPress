'use client';

import { useCallback, useState } from 'react';
import { TagInput } from '@/components/tag-input';
import { Button } from '@/components/ui/button';
import { ApiError, suggestKeywords } from '@/lib/api';
import type { Brief, KeywordSuggestion } from '@/lib/types';

/**
 * Related terms, with suggestion.
 *
 * Typing fifteen of these by hand is the tedious part, and doing it badly is
 * worse than not doing it: a list of close variants of the primary keyword
 * adds nothing. So the suggestions arrive with a reason each, and are added
 * one at a time by default. The list is meant to be judged, not pasted.
 */
export function LsiKeywords({
  brief,
  value,
  onChange,
}: {
  brief: Brief;
  value: string[];
  onChange: (value: string[]) => void;
}) {
  const [suggestions, setSuggestions] = useState<KeywordSuggestion[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = brief.topic.trim().length > 2 && brief.primaryKeyword.trim().length > 1;

  const suggest = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await suggestKeywords(brief);
      setSuggestions(result.lsiKeywords);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Could not suggest terms.');
    } finally {
      setBusy(false);
    }
  }, [brief]);

  const add = (term: string) => {
    if (value.some((entry) => entry.toLowerCase() === term.toLowerCase())) return;
    onChange([...value, term]);
  };

  const pending = (suggestions ?? []).filter(
    (entry) => !value.some((term) => term.toLowerCase() === entry.term.toLowerCase()),
  );

  return (
    <div className="space-y-2">
      <TagInput
        value={value}
        onChange={onChange}
        placeholder="sillage, fragrance layering, skin chemistry"
        max={30}
      />

      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" disabled={!ready || busy} onClick={suggest}>
          {busy ? 'Thinking…' : suggestions ? 'Suggest more' : 'Suggest terms'}
        </Button>
        <p className="text-xs text-muted-foreground">
          {ready
            ? 'Costs about a cent. Needs a topic and primary keyword.'
            : 'Fill in the topic and primary keyword first.'}
        </p>
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      {pending.length > 0 && (
        <div className="space-y-1.5 rounded-md border p-2">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium">{pending.length} suggested</p>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onChange([...value, ...pending.map((entry) => entry.term)])}
            >
              Add all
            </Button>
          </div>
          {pending.map((entry) => (
            <button
              key={entry.term}
              type="button"
              onClick={() => add(entry.term)}
              className="flex w-full items-baseline gap-2 rounded px-1 py-0.5 text-left hover:bg-muted"
            >
              <span className="text-sm">{entry.term}</span>
              <span className="text-xs text-muted-foreground">{entry.reason}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
