import type { BriefDto, FactFlag } from '../dto/generate.dto.js';

/**
 * Find assertions that read as verifiable fact.
 *
 * Ask a model for a blog post and it will invent statistics, studies, award
 * wins and founding dates without hesitation, in fluent prose that gives no
 * signal it is doing so. On brand copy that is a legal and reputational
 * exposure, not a quality preference.
 *
 * The prompt forbids it. This checks whether the prompt was obeyed, because on
 * something with this much downside, trusting the instruction is not enough.
 *
 * Deliberately over-inclusive. A false flag costs the user a glance; a missed
 * invented statistic costs them a correction on a live page.
 */

interface Pattern {
  kind: FactFlag['kind'];
  pattern: RegExp;
}

const PATTERNS: Pattern[] = [
  // Any percentage, and any number with a magnitude word or a decimal.
  { kind: 'statistic', pattern: /\b\d+(?:\.\d+)?\s?%/g },
  {
    kind: 'statistic',
    pattern: /\b\d[\d,]*(?:\.\d+)?\s?(?:million|billion|thousand|percent|users|customers|people|brands|products|stores|countries|times)\b/gi,
  },
  { kind: 'statistic', pattern: /\b(?:over|under|more than|less than|up to|nearly|almost|around)\s+\d[\d,]*(?:\.\d+)?\b/gi },
  // Currency figures.
  { kind: 'statistic', pattern: /[$£€¥]\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:bn|m|k|billion|million))?/gi },
  // Years, which usually appear as founding dates or study dates.
  { kind: 'date', pattern: /\b(?:since|in|from|by|established|founded)\s+(?:1[89]\d{2}|20\d{2})\b/gi },
  // Appeals to unnamed authority, which the prompt bans outright.
  {
    kind: 'named-entity',
    pattern: /\b(?:studies show|research (?:shows|suggests|indicates)|experts agree|according to (?:a )?(?:study|research|report|survey)|scientists (?:say|found)|data (?:shows|suggests))\b/gi,
  },
  // Superlatives that function as competitive claims.
  {
    kind: 'superlative',
    pattern: /\b(?:the (?:best|largest|leading|first|only|fastest|most popular|number one|#1)|world(?:'s|s)? (?:best|leading|first)|award[- ]winning|industry[- ]leading|market leader)\b/gi,
  },
];

/** Everything the model was actually given. The boundary of what it may assert. */
function briefCorpus(brief: BriefDto): string {
  return [
    brief.topic,
    brief.brandName,
    brief.brandDescription,
    brief.audience,
    brief.region,
    brief.callToAction,
    ...(brief.secondaryKeywords ?? []),
    ...(brief.lsiKeywords ?? []),
    ...(brief.drawbacks ?? []),
    // Products are supplied by the user, so their names and notes are inside
    // the factual boundary. Anything the model adds about them is not.
    ...(brief.products ?? []).flatMap((product) => [
      product.name,
      product.note ?? '',
      product.url ?? '',
    ]),
    brief.primaryKeyword,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

export function findFactFlags(brief: BriefDto, markdown: string): FactFlag[] {
  const corpus = briefCorpus(brief);
  const seen = new Set<string>();
  const flags: FactFlag[] = [];

  for (const { kind, pattern } of PATTERNS) {
    for (const match of markdown.matchAll(pattern)) {
      const text = match[0].trim();
      const key = `${kind}:${text.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // An appeal to unnamed authority is never acceptable, even if the words
      // happen to appear in the brief.
      const inBrief =
        kind === 'named-entity' ? false : corpus.includes(text.toLowerCase());

      flags.push({ text, kind, inBrief });
    }
  }

  // Unsupported claims first: those are the ones that need action.
  return flags.sort((a, b) => Number(a.inBrief) - Number(b.inBrief)).slice(0, 40);
}

/** Flags the user actually has to deal with. */
export function unsupportedFacts(flags: FactFlag[]): FactFlag[] {
  return flags.filter((flag) => !flag.inBrief);
}
