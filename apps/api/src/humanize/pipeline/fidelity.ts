/**
 * Does the rewrite still say what the original said?
 *
 * This is the guard that makes the rest of the system honest. Without it the
 * loop optimises a single number, and the cheapest way to drive a detection
 * score down is to stop saying the same thing.
 *
 * Three layers, cheapest first.
 *
 *   1. Hard constraints. Free, deterministic, always run. Numbers, protected
 *      spans, length. These catch the most damaging failures outright.
 *   2. Topical screen. One call to the scoring service for a rarity-weighted
 *      lexical similarity. Catches wholesale topic replacement. Deliberately
 *      set to a low floor, because it is a screen and not a verdict.
 *   3. Semantic judge. One small model call asking whether the two passages
 *      assert the same things. This is the only layer that can catch a fluent
 *      rewrite that reverses a claim.
 *
 * The obvious cheap approach, content-word overlap, was tried and removed. It
 * is actively wrong for this product: a good paraphrase replaces most of its
 * content words on purpose, so real Claude rewrites scored 23-44% against a
 * 55% floor and every one of them was rejected. Rarity weighting narrowed the
 * gap but did not close it, and a meaning-reversed control scored *higher*
 * than a genuine paraphrase, because reversal keeps the vocabulary. No purely
 * lexical measure separates these classes. Hence the judge.
 */

import { words } from './text.js';

/**
 * Small integers written as words. A rewrite that turns "14 participants"
 * into "fourteen participants" has preserved the value exactly, and failing
 * it was rejecting good rewrites over pure typography. The pipeline
 * deliberately leaves bare small integers unmasked so the prose stays
 * rewritable, so the check has to compare values rather than glyphs.
 */
const NUMBER_WORDS: Record<string, string> = {
  '0': 'zero', '1': 'one', '2': 'two', '3': 'three', '4': 'four',
  '5': 'five', '6': 'six', '7': 'seven', '8': 'eight', '9': 'nine',
  '10': 'ten', '11': 'eleven', '12': 'twelve', '13': 'thirteen',
  '14': 'fourteen', '15': 'fifteen', '16': 'sixteen', '17': 'seventeen',
  '18': 'eighteen', '19': 'nineteen', '20': 'twenty', '30': 'thirty',
  '40': 'forty', '50': 'fifty', '60': 'sixty', '70': 'seventy',
  '80': 'eighty', '90': 'ninety', '100': 'hundred', '1000': 'thousand',
};

export type JudgeVerdict = 'same' | 'drifted' | 'unknown';

export interface JudgeResult {
  verdict: JudgeVerdict;
  reason: string;
}

export interface FidelityReport {
  passed: boolean;
  reasons: string[];
  lengthRatio: number;
  missingNumbers: string[];
  unrestoredPlaceholders: string[];
  /** Rarity-weighted lexical similarity, or null when the screen did not run. */
  topicalSimilarity: number | null;
  /** Null when no judge was available. Never treat null as a pass. */
  judge: JudgeResult | null;
}

/**
 * A placeholder that survived into the final text is one the model mangled
 * past what unmask could recover, so the protected value is simply gone.
 */
function findUnrestoredPlaceholders(text: string): string[] {
  return [...new Set(text.match(/__PH\d+__/g) ?? [])];
}

/** Numbers from the original whose value does not appear in the rewrite. */
function findMissingNumbers(original: string, rewritten: string): string[] {
  const found = original.match(/\b\d[\d,.]*\b/g) ?? [];
  const lowered = rewritten.toLowerCase();

  return [...new Set(found)].filter((number) => {
    if (rewritten.includes(number)) return false;
    // Accept the spelled-out form, and accept a thousands separator being
    // added or dropped ("1200000" vs "1,200,000").
    const bare = number.replace(/,/g, '');
    if (bare !== number && rewritten.includes(bare)) return false;
    const word = NUMBER_WORDS[bare];
    return !(word && new RegExp(`\\b${word}\\b`).test(lowered));
  });
}

export interface ConstraintOptions {
  /** Reject a rewrite that lost this much of its length. */
  minLengthRatio?: number;
  maxLengthRatio?: number;
}

export interface ConstraintReport {
  lengthRatio: number;
  missingNumbers: string[];
  unrestoredPlaceholders: string[];
  reasons: string[];
  passed: boolean;
}

/**
 * Layer one. Pure, synchronous and free, so it runs on every candidate before
 * anything is spent on the layers above it.
 */
export function checkConstraints(
  original: string,
  rewritten: string,
  options: ConstraintOptions = {},
): ConstraintReport {
  const minRatio = options.minLengthRatio ?? 0.6;
  const maxRatio = options.maxLengthRatio ?? 1.7;

  const originalWords = words(original).length;
  const lengthRatio =
    originalWords === 0 ? 1 : words(rewritten).length / originalWords;
  const missingNumbers = findMissingNumbers(original, rewritten);
  const unrestoredPlaceholders = findUnrestoredPlaceholders(rewritten);

  const reasons: string[] = [];
  // A rewrite that loses a third of its length has dropped a clause, and one
  // that gains most of one again has invented material.
  if (lengthRatio < minRatio) reasons.push('rewrite is much shorter than the original');
  if (lengthRatio > maxRatio) reasons.push('rewrite is much longer than the original');
  if (missingNumbers.length > 0) {
    reasons.push(`numbers altered or dropped: ${missingNumbers.slice(0, 5).join(', ')}`);
  }
  if (unrestoredPlaceholders.length > 0) {
    reasons.push(
      `${unrestoredPlaceholders.length} protected span(s) came back corrupted`,
    );
  }

  return {
    lengthRatio: Number(lengthRatio.toFixed(4)),
    missingNumbers,
    unrestoredPlaceholders,
    reasons,
    passed: reasons.length === 0,
  };
}

/**
 * Layer three. The prompt is deliberately narrow: the judge rules on claims,
 * not on style, because every difference in style is the point of the rewrite
 * and a judge that scores those would reject everything.
 */
export function buildJudgePrompt(original: string, rewritten: string): string {
  return `Compare two versions of a passage. Version B is a deliberate stylistic
rewrite of version A, so differences in wording, rhythm, formality and sentence
structure are EXPECTED and are never problems. Replacing a technical term with
a plainer one is also expected and is not a problem.

Judge one thing only: does B carry the same claims as A?

Work through it in this order and fill in the three lists.

1. missing: claims A makes that B does not make AT ALL. A claim expressed in
   different words is NOT missing. "modern aesthetics" becoming "modern
   design", or "suitable for a fast-paced lifestyle" becoming "suits a fast
   pace", is rewording, which is the entire purpose of B. Do not list those.
   List a claim only when a reader of B would come away not knowing something
   a reader of A would know. A dropped mechanism, cause, qualification,
   statistic or consequence belongs here. A synonym never does.
2. contradicted: claims where B states something A denies, denies something A
   states, or gives a different number, name, date or direction.
3. added: claims B makes that are not supported anywhere in A. A vivid
   rephrasing of something A already says is not an addition.

If you are unsure whether a difference is rewording or a real change, it is
rewording. B is supposed to read differently.

Then set verdict to "drifted" if ANY of the three lists has an entry, and
"same" only if all three are empty.

Reply with only a JSON object, no other text:
{"missing": [], "contradicted": [], "added": [], "verdict": "same" | "drifted", "reason": "<one short sentence>"}

--- VERSION A ---
${original}

--- VERSION B ---
${rewritten}`;
}

export const JUDGE_SYSTEM =
  'You compare two passages and judge whether they assert the same things. ' +
  'You reply with a single JSON object and nothing else.';

/**
 * Parse the judge's reply defensively.
 *
 * Returns "unknown" rather than guessing when the reply cannot be read. An
 * unreadable judge must not silently become a pass, and it must not become a
 * rejection either, or one malformed reply would discard a good rewrite.
 */
export function parseJudgeVerdict(reply: string): JudgeResult {
  const jsonMatch = /\{[\s\S]*\}/.exec(reply);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as {
        verdict?: unknown;
        reason?: unknown;
        missing?: unknown;
        contradicted?: unknown;
        added?: unknown;
      };

      const list = (value: unknown): string[] =>
        Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

      const problems = [
        ...list(parsed.missing).map((entry) => `dropped: ${entry}`),
        ...list(parsed.contradicted).map((entry) => `contradicted: ${entry}`),
        ...list(parsed.added).map((entry) => `invented: ${entry}`),
      ];

      // The lists outrank the stated verdict. Models reliably notice an
      // omission and then vote "same" anyway, describing it as a detail; a
      // populated list is the more trustworthy signal.
      if (problems.length > 0) {
        return { verdict: 'drifted', reason: problems.slice(0, 3).join('; ') };
      }
      if (parsed.verdict === 'same' || parsed.verdict === 'drifted') {
        return {
          verdict: parsed.verdict,
          reason: typeof parsed.reason === 'string' ? parsed.reason : '',
        };
      }
    } catch {
      // Fall through to the text heuristic below.
    }
  }

  // Some models ignore the format instruction but still answer plainly.
  const lowered = reply.toLowerCase();
  if (lowered.includes('"drifted"') || /\bdrifted\b/.test(lowered)) {
    return { verdict: 'drifted', reason: 'judge reported drift' };
  }
  if (lowered.includes('"same"') || /\bsame\b/.test(lowered)) {
    return { verdict: 'same', reason: 'judge reported no drift' };
  }
  return { verdict: 'unknown', reason: 'judge reply could not be parsed' };
}

export interface AssembleOptions {
  constraints: ConstraintReport;
  topicalSimilarity: number | null;
  /** Floor for the topical screen. Low on purpose: this is a screen. */
  minTopicalSimilarity: number;
  judge: JudgeResult | null;
}

/** Combine the three layers into one verdict. */
export function assembleFidelity(options: AssembleOptions): FidelityReport {
  const { constraints, topicalSimilarity, minTopicalSimilarity, judge } = options;
  const reasons = [...constraints.reasons];

  if (
    topicalSimilarity !== null &&
    topicalSimilarity < minTopicalSimilarity
  ) {
    reasons.push(
      `topical overlap ${topicalSimilarity.toFixed(2)} is below the ` +
        `${minTopicalSimilarity.toFixed(2)} floor, so the rewrite is about something else`,
    );
  }

  // "unknown" is not a failure. The judge is one layer of three, and a
  // parse failure should not discard a rewrite the other two accepted.
  if (judge?.verdict === 'drifted') {
    reasons.push(`meaning changed: ${judge.reason}`);
  }

  return {
    passed: reasons.length === 0,
    reasons,
    lengthRatio: constraints.lengthRatio,
    missingNumbers: constraints.missingNumbers,
    unrestoredPlaceholders: constraints.unrestoredPlaceholders,
    topicalSimilarity,
    judge,
  };
}
