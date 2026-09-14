/**
 * Rewrite prompts, one per style profile.
 *
 * These target the mechanics the detector actually measures rather than
 * asking for "human-sounding" text, which models interpret as "add more
 * adjectives" and which moves the score barely at all. The instructions that
 * matter are the ones about rhythm: uneven sentence lengths are what produce
 * burstiness, and burstiness is the second strongest feature in the model.
 */

import type { StyleId } from './deterministic.js';

export interface StyleProfile {
  id: StyleId;
  label: string;
  description: string;
  system: string;
  temperature: number;
}

const SHARED_RULES = `
Hard rules, in priority order:
1. Preserve meaning exactly. Every claim, number, name and conclusion in the
   source must survive unchanged. Never add a fact that is not already there.
2. Tokens of the form __PH12__ are protected spans. Copy them through
   character for character. Never translate, renumber, reword or drop one.
3. Keep the paragraph structure. One paragraph in, one paragraph out.
4. Vary sentence length hard. Put a four-word sentence next to a thirty-word
   one. Uniform rhythm is the single clearest sign of machine writing.
5. Cut these openers entirely: Moreover, Furthermore, Additionally, Notably,
   In conclusion, It is important to note, Overall, Ultimately.
6. Avoid: delve, tapestry, realm, myriad, pivotal, robust, seamless, holistic,
   multifaceted, comprehensive, underscore, leverage, facilitate, testament,
   landscape, navigate, foster, embark, unlock.
7. Prefer concrete verbs to nominalisations. "We decided" beats "a decision
   was made". Use the active voice unless the passive carries real meaning.
8. No em dashes. Use a comma, a full stop, or restructure.

Readability targets. These are SEO readability rules, and they happen to pull
in the same direction as sounding human, so hit them:
9.  Keep most sentences under 20 words. No more than a quarter may go over.
    This is also the strongest single thing you can do for rhythm.
10. Use short, common words. "use" over "utilise", "help" over "facilitate",
    "start" over "commence". Plain words read faster and sound less machined.
11. Active voice. At most one sentence in ten may be passive. "The team chose"
    beats "a choice was made by the team".
12. Open roughly a third of sentences with a plain connective: But, So, And,
    Still, Then, Yet, For example, In fact, That said. This is the one place
    where the two goals disagree, and this is the resolution: readability
    tools want connectives, detectors punish the FORMAL ones. Plain ones
    satisfy both. Never use: Moreover, Furthermore, Additionally, Consequently,
    Nevertheless, In conclusion.
13. Never open more than two sentences in a row with the same word.

Worked examples. These show the four moves that matter most. They are
illustrations of TECHNIQUE only: never copy their subject matter, wording or
facts into your answer.

1. Uniform rhythm into varied rhythm.
   Before: The product offers excellent longevity and provides consistent
   performance throughout the day, and it maintains its character well in
   warm conditions.
   After: Longevity is the strong point. It holds its character through a
   warm day, right down to the last hour, and it does not turn thin the way
   lighter blends do.

2. Formal connective into a plain one.
   Before: Furthermore, the concentration significantly impacts the overall
   projection of the fragrance.
   After: So concentration matters here. It decides how far the scent travels.

3. Nominalisation into a concrete verb.
   Before: An evaluation of the available options was conducted by the team
   prior to the finalisation of the selection.
   After: The team tried every option before choosing.

4. Hedged padding into a direct claim.
   Before: It is important to note that this particular approach may
   potentially offer certain benefits in some circumstances.
   After: This works, with one catch. It only helps if you apply it to dry
   skin.

Notice what changed in each: sentence lengths stopped matching, the openers
became ordinary words, the verbs got concrete, and nothing was added. Meaning
survived every time. Do the same to the passage you are given.

Return only the rewritten passage. No preamble, no commentary, no quotes
around it, no explanation of what you changed.`;

export const STYLES: Record<StyleId, StyleProfile> = {
  standard: {
    id: 'standard',
    label: 'Standard',
    description: 'Clear everyday prose. The safe default for most text.',
    system: `You are an editor who rewrites text so it reads as though a careful
person wrote it in one sitting. Plain, direct, unfussy. Contractions where they
fall naturally. Some sentences short. Occasional mild asymmetry, because real
writing is not evenly weighted.
${SHARED_RULES}`,
    temperature: 0.9,
  },
  academic: {
    id: 'academic',
    label: 'Academic',
    description: 'Formal register, kept precise. No contractions.',
    system: `You are an editor working on scholarly prose. Keep the formal
register and the technical vocabulary of the field. Do not use contractions.
Precision outranks readability here, and hedged claims must stay hedged.

Vary sentence length anyway. Formal does not mean metronomic, and real academic
writing swings between a terse assertion and a long qualified one.
${SHARED_RULES}`,
    temperature: 0.8,
  },
  casual: {
    id: 'casual',
    label: 'Casual',
    description: 'Conversational and loose. Good for blogs and email.',
    system: `You are an editor rewriting text to sound like someone talking to a
colleague they like. Contractions throughout. Start a sentence with And or But
where it helps. Let a fragment through now and then. Drop the throat-clearing
and get to the point.

Do not add jokes, do not add personality that was not in the source, and do not
address the reader as "you" unless the original already did.
${SHARED_RULES}`,
    temperature: 1.0,
  },
  simple: {
    id: 'simple',
    label: 'Simple',
    description: 'Short sentences and common words. Aimed at plain English.',
    system: `You are an editor rewriting text into plain English. Common words
over rare ones. Break long sentences into shorter ones. Explain nothing extra,
just say the same thing more directly.

Do not make every sentence the same short length. That is its own kind of
machine rhythm. Mix a very short sentence with a medium one.
${SHARED_RULES}`,
    temperature: 0.85,
  },
};

/**
 * The user turn. Ends with a fixed `---` marker followed by the passage, which
 * is the contract EchoProvider relies on to return the input untouched.
 */
export interface RetryGuidance {
  /** Sentences the detector scored as most machine-like. */
  weakSentences: string[];
  /** Readability checks that failed, with example offending sentences. */
  readability: Array<{ label: string; detail: string; offenders: string[] }>;
}

/**
 * Cut the guidance down to what this chunk actually contains.
 *
 * Retry guidance is collected across the WHOLE document: the six sentences
 * the detector liked least, and the offenders behind each failing readability
 * check. A chunk is sixty words. So almost every named sentence belongs to
 * some other part of the article.
 *
 * Handing that list to a chunk that does not contain any of it is actively
 * harmful, not merely useless. The prompt says "your previous attempt fell
 * short, fix each one", so the model treats the sentences as material it is
 * supposed to account for and writes them in. Measured: passes two through
 * four expanded the text enough to trip the length guard and scored 24.9,
 * 19.6 and 32.2 against pass one's 5.7.
 *
 * Matching is on a normalised prefix rather than the whole sentence, because
 * the deterministic pass edits sentences after the scorer sees them, so the
 * scored text and the chunk text differ by a contraction or a substituted
 * word often enough to matter.
 */
const fingerprint = (sentence: string): string =>
  sentence
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);

export function scopeGuidance(
  guidance: RetryGuidance,
  passage: string,
): RetryGuidance {
  const haystack = fingerprintHaystack(passage);
  const contains = (sentence: string): boolean => {
    const key = fingerprint(sentence);
    return key.length >= 12 && haystack.includes(key);
  };

  return {
    weakSentences: guidance.weakSentences.filter(contains),
    readability: guidance.readability
      .map((check) => ({ ...check, offenders: check.offenders.filter(contains) }))
      // A readability check with no offender in this passage is dropped
      // entirely. "Passive voice needs work" with no example attached sends
      // the model hunting for a problem that lives in another section.
      .filter((check) => check.offenders.length > 0),
  };
}

const fingerprintHaystack = (passage: string): string =>
  passage
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();

export function buildUserPrompt(
  passage: string,
  guidance: RetryGuidance = { weakSentences: [], readability: [] },
): string {
  const { weakSentences, readability } = guidance;

  if (weakSentences.length === 0 && readability.length === 0) {
    return `Rewrite the passage below.\n\n---\n${passage}`;
  }

  // Second and later passes. Naming the specific offending sentences is what
  // makes an extra pass worth its cost. Given only a percentage, the model
  // returns something very close to its previous attempt.
  const sections: string[] = [];

  if (weakSentences.length > 0) {
    sections.push(
      'These sentences read as the most machine-written. Change their rhythm ' +
        'and phrasing substantially, without changing what they say:\n' +
        weakSentences
          .slice(0, 6)
          .map((sentence, index) => `  ${index + 1}. ${sentence}`)
          .join('\n'),
    );
  }

  for (const check of readability) {
    const examples = check.offenders
      .slice(0, 3)
      .map((sentence) => `  - ${sentence}`)
      .join('\n');
    sections.push(
      `${check.label} needs work. ${check.detail}` +
        (examples ? `\nExamples to fix:\n${examples}` : ''),
    );
  }

  return `Rewrite the passage below. The points listed here apply to sentences
inside it. Fix each one without changing what the passage says.

Do not add sentences, examples or material of your own. The rewrite must be
about the same length as the passage you were given.

${sections.join('\n\n')}

---
${passage}`;
}

/**
 * Rewrite one sentence, in place, inside its own paragraph.
 *
 * This exists for the heat map's per-sentence button, and it is deliberately
 * a different prompt from the chunk rewriter. Handed a lone sentence with no
 * surroundings a model reliably produces something that reads well on its own
 * and badly where it sits: it repeats a noun the previous sentence just
 * introduced, or opens with the same connective as its neighbour.
 *
 * So the paragraph goes in as read-only context, and only the marked span is
 * replaced. Be honest about the ceiling: one sentence cannot move a
 * document-level score much, because burstiness and length variance are
 * measured across the whole text. This is a polish tool, not the loop.
 */
export const SPAN_SYSTEM = `You are an editor. You will be shown a paragraph with
one sentence marked between «« and »». Rewrite ONLY the marked sentence.

Rules:
1. Preserve its meaning exactly. Every claim, number and name survives.
2. Tokens like __PH12__ are protected spans. Copy them character for character.
3. Make it fit its neighbours. Do not repeat a noun or an opening word that the
   sentence before or after already uses.
4. Change its rhythm. If it is long, cut it short. If it is short and flat,
   give it a subordinate clause. Matching the length it already has defeats
   the point of rewriting it.
5. No em dashes. No "Moreover", "Furthermore", "Additionally", "Notably",
   "In conclusion", "It is important to note".
6. Plain words over formal ones. Active voice.

Return only the replacement sentence. No preamble, no quotes, no explanation,
and do not return the rest of the paragraph.`;

export function buildSpanPrompt(paragraph: string, start: number, end: number): string {
  const marked =
    paragraph.slice(0, start) +
    '««' +
    paragraph.slice(start, end) +
    '»»' +
    paragraph.slice(end);

  return `${marked}

Rewrite only the sentence between «« and »». Return that one sentence and nothing else.`;
}
