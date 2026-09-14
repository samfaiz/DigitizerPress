/**
 * The free half of the humanizer.
 *
 * Every transform here is plain code: no model, no cost, no latency, and
 * fully deterministic. It matters more than it looks. A large share of what
 * a detector reacts to is surface texture, and surface texture can be edited
 * directly. Running this pass means a weak or free rewriter still moves the
 * score, and it is the reason the pipeline degrades gracefully rather than
 * collapsing when the LLM is unavailable.
 *
 * Every rule is reversible in spirit: none of them change what the text says.
 */

import { splitSentences, wordCount } from './text.js';

export type StyleId = 'standard' | 'academic' | 'casual' | 'simple';

export interface DeterministicOptions {
  style: StyleId;
  /** Allow splitting over-long sentences. Off for the first pass. */
  breakLongSentences: boolean;
}

export interface DeterministicResult {
  text: string;
  applied: string[];
}

/** Formal words models overuse, mapped to what a person would write. */
/**
 * Words with several natural replacements, rotated per occurrence.
 *
 * A single fixed mapping is itself a fingerprint. If every article turns
 * "robust" into "strong" and "leverage" into "use", a detector comparing
 * pages from one site sees a consistent substitution pattern, and the
 * consistency is the signal. Rotating removes it at no cost.
 *
 * Rotation is positional rather than random, so output stays reproducible:
 * the same input always yields the same result, which keeps the cache
 * meaningful and the tests deterministic.
 */
const VARIED_SUBSTITUTIONS: Array<[RegExp, string[]]> = [
  [/\bleverage\b/gi, ['use', 'draw on', 'lean on']],
  [/\bleveraging\b/gi, ['using', 'drawing on', 'leaning on']],
  [/\bfacilitate\b/gi, ['help', 'make easier', 'support']],
  [/\bfacilitates\b/gi, ['helps', 'makes easier', 'supports']],
  [/\brobust\b/gi, ['strong', 'solid', 'dependable']],
  [/\bpivotal\b/gi, ['key', 'central', 'decisive']],
  [/\bcomprehensive\b/gi, ['thorough', 'full', 'complete']],
  [/\bmultifaceted\b/gi, ['complex', 'many-sided', 'layered']],
  [/\bnumerous\b/gi, ['many', 'plenty of', 'a lot of']],
  [/\bmyriad\b/gi, ['many', 'countless', 'no end of']],
  [/\bseamless\b/gi, ['smooth', 'clean', 'easy']],
  [/\bholistic\b/gi, ['overall', 'joined-up', 'whole']],
  [/\bnuanced\b/gi, ['subtle', 'fine-grained', 'shaded']],
  [/\bintricate\b/gi, ['complex', 'detailed', 'fiddly']],
  [/\bprofound\b/gi, ['deep', 'far-reaching', 'serious']],
  [/\bcornerstone\b/gi, ['foundation', 'bedrock', 'backbone']],
  [/\bunderscores\b/gi, ['shows', 'points to', 'makes clear']],
  [/\bunderscore\b/gi, ['show', 'point to', 'make clear']],
];

const SUBSTITUTIONS: Array<[RegExp, string]> = [
  // Inflected forms are listed out rather than captured with a suffix group.
  // A group like /utilis(ed)/ -> 'use$1' produces "useed", because the stem
  // already carries the vowel the suffix assumes is missing.
  [/\butilis(?:e|ing)\b/gi, 'use'],
  [/\butiliz(?:e|ing)\b/gi, 'use'],
  [/\butilis(?:ed)\b/gi, 'used'],
  [/\butiliz(?:ed)\b/gi, 'used'],
  [/\butilis(?:es)\b/gi, 'uses'],
  [/\butiliz(?:es)\b/gi, 'uses'],
  [/\bleveraged\b/gi, 'used'],
  [/\bleverages\b/gi, 'uses'],
  [/\bfacilitating\b/gi, 'helping'],
  [/\bfacilitated\b/gi, 'helped'],
  [/\bdemonstrating\b/gi, 'showing'],
  [/\bdemonstrated\b/gi, 'showed'],
  [/\bdemonstrates\b/gi, 'shows'],
  [/\bdemonstrate\b/gi, 'show'],
  [/\bcommencing\b/gi, 'starting'],
  [/\bcommenced\b/gi, 'started'],
  [/\bcommences\b/gi, 'starts'],
  [/\bcommencement\b/gi, 'start'],
  [/\bcommence\b/gi, 'start'],
  [/\bterminating\b/gi, 'ending'],
  [/\bterminated\b/gi, 'ended'],
  [/\bterminates\b/gi, 'ends'],
  [/\bterminate\b/gi, 'end'],
  [/\bendeavou?ring\b/gi, 'trying'],
  [/\bendeavou?red\b/gi, 'tried'],
  [/\bendeavou?rs\b/gi, 'tries'],
  [/\bendeavou?r\b/gi, 'try'],
  [/\bdelving into\b/gi, 'digging into'],
  [/\bdelve into\b/gi, 'dig into'],
  [/\bdelved\b/gi, 'dug'],
  [/\bdelves\b/gi, 'digs'],
  [/\bdelving\b/gi, 'digging'],
  [/\bdelve\b/gi, 'dig'],
  [/\ba myriad of\b/gi, 'many'],
  [/\ba plethora of\b/gi, 'plenty of'],
  [/\bin order to\b/gi, 'to'],
  [/\bdue to the fact that\b/gi, 'because'],
  [/\bfor the purpose of\b/gi, 'to'],
  [/\bwith regard to\b/gi, 'about'],
  [/\bin the event that\b/gi, 'if'],
  [/\bat this point in time\b/gi, 'now'],
  [/\bprior to\b/gi, 'before'],
  [/\bsubsequent to\b/gi, 'after'],
  [/\bthe vast majority of\b/gi, 'most'],
  [/\bit is worth noting that\b/gi, ''],
  [/\bit is important to note that\b/gi, ''],
  [/\bit should be noted that\b/gi, ''],
  [/\bneedless to say,?\s*/gi, ''],

  // Adjective and noun tells. These carry most of the tell-word rate the
  // detector measures, and the verb rules above never touched them. Each
  // replacement is a near-synonym in the same register, so meaning holds.
  [/\bparamount\b/gi, 'critical'],
  [/\bseamlessly\b/gi, 'smoothly'],
  [/\bmeticulously\b/gi, 'carefully'],
  [/\bmeticulous\b/gi, 'careful'],
  [/\bunderscoring\b/gi, 'showing'],
  [/\bunderscored\b/gi, 'showed'],
  [/\bshowcasing\b/gi, 'showing'],
  [/\bshowcased\b/gi, 'showed'],
  [/\bshowcases\b/gi, 'shows'],
  [/\bshowcase\b/gi, 'show'],
  [/\bencompasses\b/gi, 'covers'],
  [/\bencompass\b/gi, 'cover'],
  [/\bfostering\b/gi, 'encouraging'],
  [/\bfostered\b/gi, 'encouraged'],
  [/\bfosters\b/gi, 'encourages'],
  [/\bfoster\b/gi, 'encourage'],
  [/\bembarking on\b/gi, 'starting'],
  [/\bembark on\b/gi, 'start'],
  [/\ba testament to\b/gi, 'a sign of'],
  [/\bever-evolving\b/gi, 'changing'],
  [/\bin the realm of\b/gi, 'in'],
  [/\bharnessing\b/gi, 'using'],
  [/\bharness\b/gi, 'use'],
];

/**
 * Sentence-opening discourse markers.
 *
 * Models front-load these far more than writers do, so removing them is the
 * highest-yield detection edit. But deleting them outright costs something
 * real: SEO readability tools want a healthy share of sentences to carry a
 * transition, and stripping every connective drives that share to near zero.
 * Measured on real output, deletion alone left transition density at 5%
 * against a 30% target.
 *
 * So formal markers are SUBSTITUTED, not deleted. A plain "So" or "Still"
 * counts as a transition for readability while reading entirely human. Only
 * the genuinely empty ones ("In conclusion", "Overall") are dropped, because
 * no natural equivalent exists and the sentence reads better without them.
 */
const MARKER_SUBSTITUTIONS: Array<{ pattern: RegExp; replacements: string[] }> = [
  // Addition. Rotating the replacement avoids opening five sentences with
  // "And", which would trip the consecutive-openings check.
  {
    pattern: /(Moreover|Furthermore|Additionally|In addition)/,
    replacements: ['And', '', 'Plus,', ''],
  },
  // Consequence.
  {
    pattern: /(Consequently|Therefore|Thus|Hence|As a result)/,
    replacements: ['So', 'That means', 'So'],
  },
  // Concession.
  {
    pattern: /(Nevertheless|Nonetheless|However)/,
    replacements: ['Still,', 'But', 'Even so,'],
  },
  { pattern: /(On the other hand)/, replacements: ['But', 'Then again,'] },
  // Genuinely empty. No natural equivalent, so these are simply removed.
  {
    pattern: /(Notably|Importantly|Indeed|Overall|Ultimately|In conclusion|In summary|In essence|First and foremost)/,
    replacements: [''],
  },
];

const OPENER_POSITION = /(^|\n|(?<=[.!?]\s))/;

/**
 * Contractions, with one grammatical constraint baked in.
 *
 * A reduced auxiliary cannot be stranded at the end of a clause. "part of who
 * you are." must not become "part of who you're." Every positive contraction
 * below therefore requires a following word, which is what the lookahead
 * enforces. Negative forms are exempt because "I don't." is perfectly fine.
 */
const FOLLOWED_BY_WORD = String.raw`(?=\s+\w)`;

const CONTRACTIONS: Array<[RegExp, string]> = [
  // Positive forms: the verb is reduced, so it needs something after it.
  [new RegExp(String.raw`\bit is\b` + FOLLOWED_BY_WORD, 'gi'), "it's"],
  [new RegExp(String.raw`\bthat is\b` + FOLLOWED_BY_WORD, 'gi'), "that's"],
  [new RegExp(String.raw`\bthere is\b` + FOLLOWED_BY_WORD, 'gi'), "there's"],
  [new RegExp(String.raw`\bwhat is\b` + FOLLOWED_BY_WORD, 'gi'), "what's"],
  [new RegExp(String.raw`\bthey are\b` + FOLLOWED_BY_WORD, 'gi'), "they're"],
  [new RegExp(String.raw`\bwe are\b` + FOLLOWED_BY_WORD, 'gi'), "we're"],
  [new RegExp(String.raw`\byou are\b` + FOLLOWED_BY_WORD, 'gi'), "you're"],
  [new RegExp(String.raw`\bthey will\b` + FOLLOWED_BY_WORD, 'gi'), "they'll"],
  [new RegExp(String.raw`\bwe will\b` + FOLLOWED_BY_WORD, 'gi'), "we'll"],
  // "we've to go" is not idiomatic in most registers, so the infinitive is
  // excluded on top of the stranding rule.
  [new RegExp(String.raw`\bwe have\b(?!\s+to\b)` + FOLLOWED_BY_WORD, 'gi'), "we've"],
  [new RegExp(String.raw`\byou have\b(?!\s+to\b)` + FOLLOWED_BY_WORD, 'gi'), "you've"],

  // Negative forms can stand at the end of a clause, so they need no guard.
  [/\bdo not\b/gi, "don't"],
  [/\bdoes not\b/gi, "doesn't"],
  [/\bdid not\b/gi, "didn't"],
  [/\bcannot\b/gi, "can't"],
  [/\bcan not\b/gi, "can't"],
  [/\bwill not\b/gi, "won't"],
  [/\bwould not\b/gi, "wouldn't"],
  [/\bshould not\b/gi, "shouldn't"],
  [/\bis not\b/gi, "isn't"],
  [/\bare not\b/gi, "aren't"],
  [/\bwas not\b/gi, "wasn't"],
  [/\bwere not\b/gi, "weren't"],
  [/\bhas not\b/gi, "hasn't"],
  [/\bhave not\b/gi, "haven't"],
];

/**
 * A line that carries document structure rather than prose: a markdown
 * heading, a list marker, or a masked span sitting on its own line. These must
 * pass through every transform untouched.
 */
function isStructural(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed === '') return true;
  if (/^#{1,6}\s/.test(trimmed)) return true;
  if (/^__PH\d+__$/.test(trimmed)) return true;
  if (/^([-*+]|\d+\.)\s/.test(trimmed)) return true;
  return false;
}

const capitalise = (text: string): string =>
  text.length === 0 ? text : text[0].toUpperCase() + text.slice(1);

/**
 * Break a long sentence at a coordinating conjunction.
 *
 * Applied to at most half of the eligible sentences. Splitting every one of
 * them would just trade a uniform long rhythm for a uniform short one, which
 * the burstiness feature reads exactly the same way.
 */
function breakLongSentence(sentence: string): string | null {
  if (wordCount(sentence) < 34) return null;

  const conjunction = /,\s+(and|but|so|yet|which|while)\s+/g;
  let match: RegExpExecArray | null;
  let best: { index: number; length: number } | null = null;

  while ((match = conjunction.exec(sentence)) !== null) {
    const head = sentence.slice(0, match.index);
    const tail = sentence.slice(match.index + match[0].length);
    // Both halves must stand on their own as sentences.
    if (wordCount(head) < 9 || wordCount(tail) < 9) continue;
    const balance = Math.abs(wordCount(head) - wordCount(tail));
    if (!best || balance < best.length) {
      best = { index: match.index, length: balance };
    }
  }

  if (!best) return null;
  conjunction.lastIndex = 0;
  const at = conjunction.exec(sentence.slice(best.index)) as RegExpExecArray;
  const head = sentence.slice(0, best.index).trim();
  const connector = at[1];
  const tail = sentence.slice(best.index + at[0].length).trim();

  // "which" and "while" cannot open a sentence, so they are dropped rather
  // than promoted. The remaining conjunctions read naturally at the front.
  const opener = connector === 'which' || connector === 'while' ? '' : `${capitalise(connector)} `;
  return `${head}. ${opener}${opener ? tail : capitalise(tail)}`;
}

export function applyDeterministic(
  input: string,
  options: DeterministicOptions,
): DeterministicResult {
  const applied: string[] = [];
  let text = input;

  const before = text;

  // 1. Typographic normalisation. Curly quotes, en/em dashes and the unicode
  // ellipsis are all things a word processor produces and a model emits by
  // default, so their presence is itself a weak signal.
  text = text
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/gi, "'")
    .replace(/…/g, '...')
    .replace(/\s*—\s*/g, ', ')
    .replace(/\s+–\s+/g, ', ');
  if (text !== before) applied.push('typography');

  // 2. Swap front-loaded discourse markers for natural equivalents.
  const openersBefore = text;
  for (const { pattern, replacements } of MARKER_SUBSTITUTIONS) {
    let turn = 0;
    const full = new RegExp(
      `${OPENER_POSITION.source}${pattern.source},\\s+`,
      'g',
    );
    text = text.replace(full, (_match, lead: string) => {
      const choice = replacements[turn % replacements.length];
      turn += 1;
      return choice ? `${lead}${choice} ` : lead;
    });
  }
  text = text.replace(/(^|\n|(?<=[.!?]\s))([a-z])/g, (_m, lead: string, letter: string) =>
    `${lead}${letter.toUpperCase()}`,
  );
  if (text !== openersBefore) applied.push('discourse-markers');

  // 3. Plain-word substitutions.
  const substitutionsBefore = text;

  // Phrases first, then single words. Order is load-bearing: "a myriad of"
  // must be consumed whole before the word rule sees "myriad", or the result
  // is "a many of tasks".
  for (const [pattern, replacement] of SUBSTITUTIONS) {
    text = text.replace(pattern, replacement);
  }

  // Then rotate through alternatives, so the same source word does not always
  // become the same replacement.
  for (const [pattern, replacements] of VARIED_SUBSTITUTIONS) {
    let turn = 0;
    text = text.replace(pattern, (match) => {
      const choice = replacements[turn % replacements.length];
      turn += 1;
      // Carry the original capitalisation, so a sentence-initial match does
      // not come back lowercase.
      return /^[A-Z]/.test(match)
        ? choice[0].toUpperCase() + choice.slice(1)
        : choice;
    });
  }
  if (text !== substitutionsBefore) applied.push('vocabulary');

  // 4. Contractions. Academic prose does not use them, so the style profile
  // decides rather than the rule applying unconditionally.
  if (options.style === 'casual' || options.style === 'simple' || options.style === 'standard') {
    const contractionsBefore = text;
    for (const [pattern, replacement] of CONTRACTIONS) {
      // Patterns are case-insensitive so a sentence-initial "You are" also
      // contracts. The original capitalisation is carried onto the result.
      text = text.replace(pattern, (match) =>
        /^[A-Z]/.test(match)
          ? replacement[0].toUpperCase() + replacement.slice(1)
          : replacement,
      );
    }
    if (text !== contractionsBefore) applied.push('contractions');
  }

  // 5. Rhythm. Break some over-long sentences to widen the length spread.
  //
  // Structure-preserving, and it has to be. An earlier version split the whole
  // document at once and rejoined with a single space, which flattened every
  // blank line and heading into one continuous blob. It only surfaced when a
  // sentence was actually long enough to split, so most runs looked fine and
  // one style silently lost five of its six headings.
  if (options.breakLongSentences) {
    const blocks = text.split(/\n{2,}/);
    let broken = 0;

    const proseLines = blocks
      .flatMap((block) => block.split('\n'))
      .filter((line) => !isStructural(line));
    const eligible = proseLines
      .flatMap((line) => splitSentences(line))
      .filter((sentence) => wordCount(sentence) >= 34).length;
    const budget = Math.ceil(eligible / 2);

    const rebuiltBlocks = blocks.map((block) =>
      block
        .split('\n')
        .map((line) => {
          // Headings and standalone placeholders are structure, not prose.
          if (isStructural(line)) return line;
          return splitSentences(line)
            .map((sentence) => {
              if (broken >= budget) return sentence;
              const split = breakLongSentence(sentence);
              if (split) {
                broken += 1;
                return split;
              }
              return sentence;
            })
            .join(' ');
        })
        .join('\n'),
    );

    if (broken > 0) {
      text = rebuiltBlocks.join('\n\n');
      applied.push(`sentence-splits:${broken}`);
    }
  }

  // 6. Whitespace tidy-up. Rules above can leave doubled spaces behind.
  text = text
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\n[ \t]+/g, '\n')
    .trim();

  return { text, applied };
}
