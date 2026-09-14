import { describe, expect, it } from 'vitest';
import { chunkText, joinChunks } from '../chunk.js';
import { wordCount } from '../text.js';

const paragraph = (words: number, word = 'word') =>
  `${Array.from({ length: words }, () => word).join(' ')}.`;

describe('chunkText', () => {
  it('keeps a short document as a single unit', () => {
    expect(chunkText(paragraph(50), 350).length).toBe(1);
  });

  it('splits on paragraph boundaries rather than mid-paragraph', () => {
    const text = [paragraph(200, 'alpha'), paragraph(200, 'beta')].join('\n\n');
    const chunks = chunkText(text, 250);
    expect(chunks.length).toBe(2);
    expect(chunks.every((chunk) => !chunk.split)).toBe(true);
  });

  it('falls back to sentence boundaries for an oversized paragraph', () => {
    const sentences = Array.from({ length: 12 }, () => paragraph(40)).join(' ');
    const chunks = chunkText(sentences, 100);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.some((chunk) => chunk.split)).toBe(true);
  });

  it('merges a runt paragraph rather than sending it alone', () => {
    const text = [paragraph(300, 'alpha'), 'Yes.'].join('\n\n');
    const chunks = chunkText(text, 350);
    expect(chunks.length).toBe(1);
  });

  it('loses no words when chunking then rejoining', () => {
    const text = [paragraph(200, 'alpha'), paragraph(200, 'beta')].join('\n\n');
    const chunks = chunkText(text, 150);
    expect(wordCount(joinChunks(chunks.map((chunk) => chunk.text)))).toBe(wordCount(text));
  });
});
1
describe('packing', () => {
  it('combines small paragraphs up to the target', () => {
    // The bug this covers: the chunker split oversized paragraphs but never
    // packed small ones, so every paragraph became its own model call. A real
    // article produced 51 chunks of ~50 words instead of 8 of ~300, costing
    // six times what it should and giving the model no room to vary rhythm.
    const text = Array.from({ length: 20 }, () => paragraph(40, 'alpha')).join('\n\n');
    const chunks = chunkText(text, 350);
    expect(chunks.length).toBeLessThanOrEqual(4);
    expect(chunks.every((chunk) => chunk.words <= 350)).toBe(true);
  });

  it('never exceeds the target while packing', () => {
    const text = Array.from({ length: 12 }, (_, i) =>
      paragraph(100 + i * 10, 'beta'),
    ).join('\n\n');
    for (const chunk of chunkText(text, 300)) {
      expect(chunk.words).toBeLessThanOrEqual(300);
    }
  });

  it('preserves paragraph breaks inside a packed chunk', () => {
    const text = [paragraph(30, 'alpha'), paragraph(30, 'beta')].join('\n\n');
    const chunks = chunkText(text, 350);
    expect(chunks.length).toBe(1);
    expect(chunks[0].text).toContain('\n\n');
  });
});
