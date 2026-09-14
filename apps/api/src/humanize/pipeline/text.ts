/**
 * Small text utilities shared across the pipeline.
 *
 * The sentence splitter here mirrors services/scorer/app/segment.py but is
 * used only for chunking and fidelity checks. Every offset the UI renders
 * comes from the Python side, so the two never have to agree exactly.
 */

const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc', 'inc',
  'ltd', 'co', 'e.g', 'i.e', 'al', 'fig', 'no', 'approx', 'ca', 'u.s', 'u.k',
]);

const WORD_RE = /[A-Za-zÀ-ɏ'’]+/g;

export function words(text: string): string[] {
  return text.match(WORD_RE) ?? [];
}

export function wordCount(text: string): number {
  return words(text).length;
}

export function splitSentences(text: string): string[] {
  const out: string[] = [];
  const terminator = /[.!?]["'”’)\]]*(?=\s|$)/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = terminator.exec(text)) !== null) {
    const head = text.slice(0, match.index + 1);
    const trailing = /([A-Za-z.]+)\.$/.exec(head);
    if (trailing) {
      const token = trailing[1].toLowerCase().replace(/\.$/, '');
      // Known abbreviation, or a single-letter initial such as "J. Smith".
      if (ABBREVIATIONS.has(token) || (token.length === 1 && /[a-z]/.test(token))) {
        continue;
      }
    }
    const chunk = text.slice(cursor, match.index + match[0].length).trim();
    if (chunk) out.push(chunk);
    cursor = match.index + match[0].length;
  }

  const tail = text.slice(cursor).trim();
  if (tail) out.push(tail);
  return out;
}

export function splitParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

/**
 * Strip the invisible characters that some generators embed and that a naive
 * detector would otherwise read as a signal all on their own.
 */
export function normalise(text: string): string {
  return text
    .normalize('NFC')
    .replace(/[​-‍﻿⁠]/g, '')
    .replace(/ /g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
