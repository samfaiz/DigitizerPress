'use client';

import { useCallback, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ApiError, rephraseSpan } from '@/lib/api';
import type { ScoreResult, SentenceScore, StyleId } from '@/lib/types';
import { cn } from '@/lib/utils';

/**
 * The heat map, with a rewrite button on every sentence.
 *
 * Read the honesty note before judging what this is for. Measured on a
 * 2,000-word generated article: 3 of 140 sentences scored above 60 while the
 * document as a whole estimated at 44 on ZeroGPT's scale. Detection is spread
 * across the text, not concentrated in a handful of sentences, so replacing
 * the reddest one moves the document score by a fraction of a point and
 * promotes a different sentence into first place.
 *
 * That makes this a polish tool: a way to fix a sentence that reads badly to
 * a human, on an article you are otherwise happy with. The panel says so,
 * because a red highlight next to a rewrite button implies a promise about
 * the score that the measurements do not support.
 *
 * The colours are also relative, not absolute. The scorer ranks sentences
 * WITHIN this document, so the reddest sentence in a good article and the
 * reddest in a bad one both look the same shade.
 */

interface HeatMapEditorProps {
  text: string;
  score: ScoreResult;
  style: StyleId;
  /** Called when a rewrite is kept. Hands back the whole document. */
  onChange: (text: string, score: ScoreResult) => void;
}

function toneFor(score: number, scored: boolean): string {
  if (!scored) return 'bg-transparent';
  if (score >= 80) return 'bg-rose-500/25 hover:bg-rose-500/40';
  if (score >= 60) return 'bg-orange-500/20 hover:bg-orange-500/35';
  if (score >= 40) return 'bg-amber-500/15 hover:bg-amber-500/30';
  if (score >= 20) return 'bg-emerald-500/10 hover:bg-emerald-500/25';
  return 'bg-emerald-500/20 hover:bg-emerald-500/35';
}

export function HeatMapEditor({ text, score, style, onChange }: HeatMapEditorProps) {
  const [selected, setSelected] = useState<SentenceScore | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  /**
   * A rewrite the server produced and scored, held until the user keeps it.
   *
   * The whole document and its new score are kept alongside the sentence, so
   * "Keep it" costs nothing: the server already scored the spliced text when
   * it produced the replacement. Re-requesting on keep would both spend again
   * and hand back a different sentence than the one on screen.
   */
  const [pending, setPending] = useState<
    { replacement: string; text: string; score: ScoreResult } | null
  >(null);

  const sentences = score.sentences;

  const stats = useMemo(() => {
    const scored = sentences.filter((sentence) => sentence.scored);
    if (scored.length === 0) return null;
    const total = scored.reduce((sum, sentence) => sum + sentence.ai_score, 0);
    return {
      count: scored.length,
      mean: total / scored.length,
      hot: scored.filter((sentence) => sentence.ai_score >= 60).length,
    };
  }, [sentences]);

  // Every rewrite is a fresh call against the CURRENT document, so keeping one
  // and then rewriting another sentence works on the updated text rather than
  // on a stale copy with stale offsets.
  const rewrite = useCallback(
    async (sentence: SentenceScore) => {
      setBusy(true);
      setNote(null);
      setPending(null);
      try {
        const result = await rephraseSpan(text, sentence.start, sentence.end, style);
        if (result.applied) {
          // Held, not applied. Replacing the text under the user's cursor
          // without asking is how you lose a sentence someone liked.
          setPending({
            replacement: result.replacement,
            text: result.text,
            score: result.score,
          });
        } else {
          setNote(result.reason ?? 'The rewrite was rejected.');
        }
      } catch (error) {
        setNote(
          error instanceof ApiError
            ? error.message
            : 'Could not rewrite that sentence.',
        );
      } finally {
        setBusy(false);
      }
    },
    [text, style],
  );

  const keep = useCallback(() => {
    if (!pending) return;
    onChange(pending.text, pending.score);
    // Offsets belong to the old text, so the selection is dropped rather than
    // left pointing at a span that has moved.
    setSelected(null);
    setPending(null);
  }, [pending, onChange]);

  const nodes: React.ReactNode[] = [];
  let cursor = 0;

  for (const sentence of sentences) {
    if (sentence.start > cursor) {
      nodes.push(
        <span key={`gap-${sentence.index}`}>{text.slice(cursor, sentence.start)}</span>,
      );
    }

    const isSelected = selected?.index === sentence.index;
    nodes.push(
      <mark
        key={`s-${sentence.index}`}
        role={sentence.scored ? 'button' : undefined}
        tabIndex={sentence.scored ? 0 : undefined}
        onClick={() => {
          if (!sentence.scored) return;
          setPending(null);
          setNote(null);
          setSelected(isSelected ? null : sentence);
        }}
        onKeyDown={(event) => {
          if (!sentence.scored) return;
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setPending(null);
            setNote(null);
            setSelected(isSelected ? null : sentence);
          }
        }}
        className={cn(
          'rounded-sm px-0.5 text-foreground transition-colors',
          toneFor(sentence.ai_score, sentence.scored),
          sentence.scored && 'cursor-pointer',
          isSelected && 'ring-2 ring-primary',
        )}
      >
        {text.slice(sentence.start, sentence.end)}
      </mark>,
    );

    cursor = sentence.end;
  }

  if (cursor < text.length) nodes.push(<span key="tail">{text.slice(cursor)}</span>);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>Click a sentence to rewrite it.</span>
        {stats && (
          <>
            <span>
              Average <span className="tabular-nums text-foreground">{stats.mean.toFixed(0)}</span>{' '}
              across {stats.count} sentences
            </span>
            <span>
              <span className="tabular-nums text-foreground">{stats.hot}</span> above 60
            </span>
          </>
        )}
      </div>

      <p className="whitespace-pre-wrap text-sm leading-7">{nodes}</p>

      <p className="text-xs text-muted-foreground">
        Shading is relative to this article: the reddest sentence here is the most
        machine-like one in this text, not a verdict on its own. Rewriting single
        sentences is for prose you do not like reading. It will barely move the
        document score, which comes from the rhythm of the whole piece. Run another
        humanize pass for that.
      </p>

      {selected && (
        <div className="space-y-3 rounded border bg-muted/30 p-3">
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-xs font-medium">
              {Math.round(selected.ai_score)}% machine-like, {selected.words} words
            </p>
            <button
              type="button"
              className="text-xs text-muted-foreground hover:text-foreground"
              onClick={() => {
                setSelected(null);
                setPending(null);
                setNote(null);
              }}
            >
              Close
            </button>
          </div>

          <p className="text-sm leading-6">{selected.text}</p>

          {pending && (
            <div className="space-y-1 rounded border border-primary/40 bg-background p-2">
              <p className="text-xs font-medium text-muted-foreground">
                Replacement. Document score would be{' '}
                <span className="tabular-nums text-foreground">
                  {pending.score.ai_score}
                </span>
                , from {score.ai_score}.
              </p>
              <p className="text-sm leading-6">{pending.replacement}</p>
            </div>
          )}

          {note && <p className="text-xs text-destructive">{note}</p>}

          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={busy} onClick={() => rewrite(selected)}>
              {busy ? 'Rewriting…' : pending ? 'Try again' : 'Rewrite'}
            </Button>
            {pending && (
              <Button size="sm" variant="outline" disabled={busy} onClick={keep}>
                Keep it
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
