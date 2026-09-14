'use client';

import { useCallback, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { cn } from '@/lib/utils';

interface TagInputProps {
  value: string[];
  onChange: (value: string[]) => void;
  placeholder?: string;
  /** Guard against a paste of an entire keyword export. */
  max?: number;
}

/**
 * Comma-separated entry that actually lets you type a comma.
 *
 * The obvious implementation is a text input bound to `list.join(', ')` that
 * splits on every keystroke. It is also broken: typing "seo," parses to
 * ["seo"], re-renders as "seo", and the comma vanishes under the cursor. The
 * field becomes impossible to use for the one thing it exists for.
 *
 * So the draft text lives in its own state and is only committed to a tag on a
 * comma, Enter, Tab or blur. Committed tags render as chips, which also gives
 * the user something the plain input never did: visible confirmation of how
 * their input was actually parsed.
 */
export function TagInput({ value, onChange, placeholder, max = 40 }: TagInputProps) {
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const commit = useCallback(
    (raw: string) => {
      const additions = raw
        .split(/[,\n\t]/)
        .map((entry) => entry.trim())
        .filter(Boolean)
        // Case-insensitive dedupe: "SEO" and "seo" are the same keyword and
        // counting both would distort the density report downstream.
        .filter(
          (entry) =>
            !value.some((existing) => existing.toLowerCase() === entry.toLowerCase()),
        );

      if (additions.length > 0) {
        onChange([...value, ...additions].slice(0, max));
      }
      setDraft('');
    },
    [value, onChange, max],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === ',' || event.key === 'Enter' || event.key === 'Tab') {
      if (draft.trim()) {
        // Tab still moves focus when the field is empty, so only swallow the
        // key when there is something to commit.
        event.preventDefault();
        commit(draft);
      }
      return;
    }
    // Backspace on an empty draft removes the last chip, which is what every
    // tag field does and what fingers expect.
    if (event.key === 'Backspace' && draft === '' && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData('text');
    if (!/[,\n\t]/.test(text)) return;
    event.preventDefault();
    commit(text);
  };

  return (
    <div
      className={cn(
        'flex min-h-9 w-full flex-wrap items-center gap-1.5 rounded-md border',
        'bg-transparent px-2 py-1.5 text-sm',
        'focus-within:ring-[3px] focus-within:ring-ring/50',
      )}
      onClick={() => inputRef.current?.focus()}
    >
      {value.map((tag) => (
        <span
          key={tag}
          className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs"
        >
          {tag}
          <button
            type="button"
            aria-label={`Remove ${tag}`}
            className="text-muted-foreground hover:text-foreground"
            onClick={(event) => {
              event.stopPropagation();
              onChange(value.filter((entry) => entry !== tag));
            }}
          >
            ×
          </button>
        </span>
      ))}

      <input
        ref={inputRef}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        // Committing on blur means a half-typed entry is not silently lost
        // when the user tabs away or clicks Generate.
        onBlur={() => draft.trim() && commit(draft)}
        placeholder={value.length === 0 ? placeholder : ''}
        className="min-w-24 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
      />
    </div>
  );
}
