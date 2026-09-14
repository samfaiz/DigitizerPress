import { splitParagraphs, splitSentences, wordCount } from './text.js';

/**
 * Split a document into rewrite units.
 *
 * Chunking exists for two reasons. Long inputs blow past a small model's
 * usable context, and quality degrades well before the hard limit. Splitting
 * on paragraph boundaries keeps each unit self-contained, so the model never
 * has to guess what a dangling clause was attached to.
 */
export interface Chunk {
  index: number;
  text: string;
  words: number;
  /** True when a single paragraph had to be broken across units. */
  split: boolean;
  /**
   * Where this chunk sits in the source string.
   *
   * Carried through so per-sentence scores, which the scorer reports as
   * character offsets, can be attributed back to the chunk they came from.
   * Without this the loop can only rewrite everything or nothing.
   */
  start: number;
  end: number;
}

interface Piece {
  text: string;
  split: boolean;
  start: number;
  end: number;
}

export function chunkText(text: string, targetWords: number): Chunk[] {
  const units: Piece[] = [];

  // Pass one: break any paragraph that is too big on its own.
  //
  // Offsets are recovered by walking a cursor forward through the source.
  // splitParagraphs trims, so a paragraph is always a literal substring of
  // the source and always appears after the previous one.
  const pieces: Piece[] = [];
  let cursor = 0;
  for (const paragraph of splitParagraphs(text)) {
    const at = text.indexOf(paragraph, cursor);
    // A negative result would mean the splitter changed the text rather than
    // cutting it. Falling back to the cursor keeps offsets monotonic instead
    // of poisoning every later chunk with a -1.
    const paragraphStart = at >= 0 ? at : cursor;
    cursor = paragraphStart + paragraph.length;

    if (wordCount(paragraph) <= targetWords) {
      pieces.push({
        text: paragraph,
        split: false,
        start: paragraphStart,
        end: cursor,
      });
      continue;
    }

    // Oversized paragraph: fall back to sentence boundaries, never mid-sentence.
    let buffer: string[] = [];
    let running = 0;
    let bufferStart = paragraphStart;
    let inner = 0;
    const flush = (endOffset: number) => {
      pieces.push({
        text: buffer.join(' '),
        split: true,
        start: bufferStart,
        end: endOffset,
      });
    };
    for (const sentence of splitSentences(paragraph)) {
      const found = paragraph.indexOf(sentence, inner);
      const sentenceStart = paragraphStart + (found >= 0 ? found : inner);
      inner = (found >= 0 ? found : inner) + sentence.length;

      const length = wordCount(sentence);
      if (running + length > targetWords && buffer.length > 0) {
        flush(sentenceStart);
        buffer = [];
        running = 0;
        bufferStart = sentenceStart;
      }
      buffer.push(sentence);
      running += length;
    }
    if (buffer.length > 0) flush(cursor);
  }

  // Pass two: pack consecutive pieces up to the target.
  //
  // CHUNK_WORDS is a cost/quality dial, not a performance setting, and the
  // relationship is the opposite of what it looks like.
  //
  // Measured on one 2,570-word article, four rewrite passes on Opus:
  //   ~50-word chunks   51 chunks  204 calls  $2.06  ZeroGPT ~7
  //   ~330-word chunks   8 chunks   36 calls  $0.90  ZeroGPT ~22
  //
  // Small chunks cost far more and score far better. Rewriting fifty words
  // forces the model to genuinely rework every sentence; rewriting three
  // hundred gets a lighter touch spread thinner. Packing was originally added
  // to fix what looked like a chunking bug, on the assumption that larger
  // chunks would give more room to vary rhythm. They do not.
  //
  // So lower CHUNK_WORDS to buy score, raise it to buy budget.
  let current: Piece | null = null;
  for (const piece of pieces) {
    if (!current) {
      current = { ...piece };
      continue;
    }
    const combined = wordCount(current.text) + wordCount(piece.text);
    if (combined <= targetWords) {
      // Paragraph breaks are preserved, so packing changes what one call sees
      // without changing the document.
      current.text = `${current.text}\n\n${piece.text}`;
      current.split = current.split || piece.split;
      current.end = piece.end;
    } else {
      units.push(current);
      current = { ...piece };
    }
  }
  if (current) units.push(current);

  // Fold a trailing runt into the previous unit. A four-word chunk sent to the
  // model alone has no context and comes back worse than it went in.
  const merged: Piece[] = [];
  for (const unit of units) {
    const previous = merged[merged.length - 1];
    if (
      previous &&
      wordCount(unit.text) < 25 &&
      wordCount(previous.text) + wordCount(unit.text) <= targetWords * 1.4
    ) {
      previous.text = `${previous.text}\n\n${unit.text}`;
      previous.split = previous.split || unit.split;
      previous.end = unit.end;
      continue;
    }
    merged.push({ ...unit });
  }

  return merged.map((unit, index) => ({
    index,
    text: unit.text,
    words: wordCount(unit.text),
    split: unit.split,
    start: unit.start,
    end: unit.end,
  }));
}

/**
 * Rank chunks by how machine-written the scorer finds them, worst first.
 *
 * Each chunk is scored as the word-weighted mean of its sentences, so a long
 * flat paragraph is not outranked by a two-word heading that happened to
 * score high. Chunks the scorer skipped entirely are excluded rather than
 * ranked at zero: "no sentence long enough to score" is not evidence of
 * being human-written.
 */
export function rankChunks(
  chunks: Chunk[],
  sentences: Array<{ start: number; ai_score: number; words: number; scored: boolean }>,
): Array<{ index: number; meanScore: number; sentences: number }> {
  const ranked = chunks.map((chunk) => {
    let weighted = 0;
    let weight = 0;
    let counted = 0;
    for (const sentence of sentences) {
      if (!sentence.scored) continue;
      // Attributed by start offset alone. A sentence that straddles a chunk
      // boundary belongs to the chunk it begins in, which is the chunk whose
      // rewrite would actually change it.
      if (sentence.start < chunk.start || sentence.start >= chunk.end) continue;
      weighted += sentence.ai_score * sentence.words;
      weight += sentence.words;
      counted += 1;
    }
    return {
      index: chunk.index,
      meanScore: weight > 0 ? weighted / weight : Number.NaN,
      sentences: counted,
    };
  });

  return ranked
    .filter((entry) => Number.isFinite(entry.meanScore))
    .sort((a, b) => b.meanScore - a.meanScore);
}

/**
 * The chunks worth spending a rewrite pass on.
 *
 * The reason this exists: on a measured 2,000-word article only 3 of 140
 * sentences scored above 60 while the document as a whole estimated at 44 on
 * ZeroGPT's scale. Detection is distributed, not concentrated, so rewriting
 * the handful of worst SENTENCES changes almost nothing. Chunks are the
 * smallest unit where a rewrite can still alter rhythm and sentence-length
 * variance, which is what the document-level score actually reads.
 *
 * Returns every index when the ranking is too thin to be meaningful, because
 * a bad selection is worse than no selection.
 */
export function selectChunks(
  chunks: Chunk[],
  sentences: Array<{ start: number; ai_score: number; words: number; scored: boolean }>,
  share: number,
): number[] {
  const all = chunks.map((chunk) => chunk.index);
  if (share >= 1 || chunks.length <= 2) return all;

  const ranked = rankChunks(chunks, sentences);
  // Fewer than half the chunks carried a scoreable sentence, so the ranking
  // is mostly missing data rather than a signal.
  if (ranked.length < Math.ceil(chunks.length / 2)) return all;

  const take = Math.max(1, Math.round(ranked.length * share));
  const chosen = new Set(ranked.slice(0, take).map((entry) => entry.index));
  // Restored to document order. The rewrite loop walks chunks in sequence and
  // reads better in the logs when the targets do too.
  return all.filter((index) => chosen.has(index));
}

/** Reassemble rewritten chunks. Paragraph structure is preserved by design. */
export function joinChunks(chunks: string[]): string {
  return chunks.map((chunk) => chunk.trim()).filter(Boolean).join('\n\n');
}
