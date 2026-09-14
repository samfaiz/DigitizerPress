import type { BriefDto, OutlineDto, OutlineSectionDto } from '../dto/generate.dto.js';
import { FACTS_RULE, renderBrief, WRITING_RULES } from './brief.js';

export const OUTLINE_SYSTEM = `You are an SEO content strategist. You plan the
structure of an article before a word of it is written. You reply with a single
JSON object and nothing else.`;

/**
 * Outline first, draft second.
 *
 * Asking for a whole article in one call produces a worse article than asking
 * for a plan and then filling it in, and it costs more to correct. A bad
 * outline is cheap to regenerate; a bad 1500-word draft is not.
 */
export function buildOutlinePrompt(brief: BriefDto): string {
  const target = brief.wordCount ?? 1200;
  // Roughly 150-250 words per section reads well and keeps each section
  // narrow enough that the drafting model stays on topic.
  const sections = Math.max(3, Math.min(9, Math.round(target / 200)));

  return `Plan an article from this brief.

${renderBrief(brief)}
${FACTS_RULE}

STRUCTURE RULES.
- Write one H1. It must contain the primary keyword and read like a title a
  person would click, not a keyword stuffed into a sentence.
- Plan about ${sections} H2 sections. Add an H3 only where a section genuinely
  splits into parts.
- Every heading must be specific. "Benefits" is useless; "What changes in the
  first month" is a heading.
- Work the primary keyword into at least one H2, naturally. Do not force it
  into all of them.
- Give each section a target word count. They should sum to roughly ${target}.
- Include one section that covers the honest drawbacks if the brief lists any.
- If the brief lists products, plan a section where featuring them is natural.
  Do not plan a section that is purely a product list.
- If the brief lists internal links, plan sections where each one is a genuine
  next step for the reader, not an aside. A link works when the sentence around
  it would be worse without it.
- If the brief asks for an FAQ, do NOT plan it as a section. It is appended
  after everything else.
- If the brief names an author, do NOT plan an "About the author" section. It
  is appended too.
- Do not plan a "Conclusion" section. Plan a section that actually says
  something and carries the call to action.

Reply with only this JSON:
{"h1": "...", "sections": [{"heading": "...", "level": "h2", "intent": "one line on what this section argues", "targetWords": 200}]}`;
}

/**
 * The system block for section drafting.
 *
 * Everything identical across the ten section calls lives here: the brief, the
 * factual boundary, the writing rules and the full outline. That is what makes
 * it cacheable. Prompt caching matches on a prefix, so shared content sitting
 * in the user turn, after the section-specific part, would never cache.
 */
export function buildDraftSystem(brief: BriefDto, outline: OutlineDto): string {
  // The voice profile goes above the generic rules deliberately. Demonstrated
  // style beats described style, and where they disagree the brand's own
  // habits should win rather than my description of good prose.
  const voice = brief.voiceProfile
    ? `\n${renderVoiceProfile(brief.voiceProfile)}\n`
    : '';

  return `You write article sections that read as though a sharp, plain-spoken
person wrote them in one sitting. You return only the prose for the section you
were asked for, with no heading and no commentary. Never include internal or
system XML tags in your response.

${renderBrief(brief)}
${voice}${FACTS_RULE}
${WRITING_RULES}

ARTICLE TITLE: ${outline.h1}

FULL OUTLINE. You will be asked for one section at a time. Never write another
section's content, and never duplicate a point that belongs elsewhere:
${outline.sections.map((s, i) => `${i + 1}. ${s.heading} — ${s.intent}`).join('\n')}`;
}

/** Kept for callers that do not have a brief to hand. */
/**
 * The opening paragraphs, which sit between the H1 and the first H2.
 *
 * Without this an article runs title, subheading, body, which reads as a
 * template rather than a piece of writing. A reader landing on a heading
 * stacked directly under another heading has been told nothing yet.
 */
export function buildIntroPrompt(outline: OutlineDto, brief: BriefDto): string {
  return `Write the opening of an article titled "${outline.h1}".

No heading. Two short paragraphs, 70 to 110 words in total.

The first sentence must engage the subject directly. No "In today's fast-paced
world", no "When it comes to", no restating the title back at the reader.

Say what the piece is about and why it is worth the next three minutes. Give
the reader one concrete detail or claim early so they know this is written by
someone who knows the subject, not assembled from a template.

It leads into this first section, so set it up without covering its ground:
  ${outline.sections[0]?.heading ?? ''} — ${outline.sections[0]?.intent ?? ''}

${brief.primaryKeyword ? `Use "${brief.primaryKeyword}" once, naturally, in the first paragraph.` : ''}

Return only the prose.`;
}

export const DRAFT_SYSTEM = `You write article sections that read as though a
sharp, plain-spoken person wrote them in one sitting. You return only the prose
for the section you were asked for, with no heading and no commentary.`;

/**
 * One call per section rather than one call per article.
 *
 * A single call for a long piece drifts: later sections lose the brief, repeat
 * earlier points and flatten into the model's house style. Per-section calls
 * keep each one short, on-brief and individually checkable.
 */
export function buildSectionPrompt(
  section: OutlineSectionDto,
  index: number,
  previousTail: string,
): string {
  return `Write section ${index + 1}: ${section.heading}

WHAT IT MUST ARGUE: ${section.intent}
LENGTH: about ${section.targetWords ?? 200} words

${
  previousTail
    ? `The previous section ended with this. Continue from it naturally, and do
not repeat its point:
"${previousTail}"`
    : 'This is the opening section. Start on the subject immediately. No throat-clearing.'
}

Return only the prose.`;
}

export const SEO_SYSTEM = `You write search metadata. You respect character
limits exactly, because search engines truncate anything longer. You reply with
a single JSON object and nothing else.`;

/**
 * Metadata is generated from the finished article, not from the brief.
 *
 * Writing the meta description before the article means describing a piece
 * that does not exist yet, and it usually promises something the draft never
 * delivers.
 */
export function buildSeoPrompt(brief: BriefDto, article: string): string {
  const excerpt = article.slice(0, 4000);
  const negatives = brief.negativeKeywords?.length
    ? `\nThese terms must NOT appear in the title or meta description: ${brief.negativeKeywords.join(', ')}.`
    : '';

  return `Write the search metadata for this finished article.

PRIMARY KEYWORD: ${brief.primaryKeyword}
BRAND: ${brief.brandName}${negatives}

HARD LIMITS. Count the characters.
- titleTag: at most 60 characters, contains the primary keyword, reads like a
  title rather than a keyword string.
- metaDescription: at most 155 characters, contains the primary keyword, and
  says what the reader gets. Not a summary of the summary.
- imageAlt: three alt texts describing images that would suit this article.
  Each under 125 characters, descriptive, not keyword stuffed.
- faq: three or four questions a reader would actually search for, each with a
  40 to 55 word answer drawn ONLY from the article below. Do not answer with
  anything the article does not say.

ARTICLE:
${excerpt}

Reply with only this JSON:
{"titleTag": "...", "metaDescription": "...", "imageAlt": ["...", "...", "..."], "faq": [{"question": "...", "answer": "..."}]}`;
}


export const REVISE_SYSTEM = `You revise an article to fix specific, listed
problems without rewriting what it says. You return only the revised article in
markdown, with no commentary.`;

/**
 * Targeted revision.
 *
 * The draft usually comes back strong but misses two or three countable
 * targets: a keyword short of density, a drawback never worked in, transition
 * density low. Regenerating the whole piece to fix those would be wasteful and
 * would risk losing what already works. This names the misses instead.
 */
export function buildRevisePrompt(
  brief: BriefDto,
  markdown: string,
  problems: string[],
): string {
  return `Revise the article below. Fix ONLY the problems listed. Leave
everything else exactly as it is, including all headings and their wording.

${renderBrief(brief)}
${FACTS_RULE}

PROBLEMS TO FIX:
${problems.map((problem, index) => `${index + 1}. ${problem}`).join('\n')}

Rules while fixing:
- Keep every markdown heading unchanged, in the same order.
- Do not pad. If you need more keyword uses, work them into sentences that
  already exist rather than adding filler ones.
- Keep sentences short and varied. Open about a third with a plain connective:
  But, So, And, Still, Then, Yet, For example, In fact, That said. Never use
  Moreover, Furthermore, Additionally, Consequently or In conclusion.
- Do not introduce any fact not already in the article or the brief.

ARTICLE:
${markdown}`;
}

export const KEYWORDS_SYSTEM = `You are an SEO researcher. You propose
semantically related terms for a topic. You reply with a single JSON object and
nothing else.`;

/**
 * Suggest related terms from the topic and primary keyword.
 *
 * Cheap by design: a small prompt, a small reply and no thinking. It runs
 * before the outline, so a bad list costs pennies to regenerate.
 */
export function buildKeywordsPrompt(brief: BriefDto): string {
  const existing = [
    brief.primaryKeyword,
    ...(brief.secondaryKeywords ?? []),
    ...(brief.lsiKeywords ?? []),
  ].filter(Boolean);

  const negatives = brief.negativeKeywords?.length
    ? `\nNever suggest these or anything close to them: ${brief.negativeKeywords.join(', ')}.`
    : '';
  const avoid = brief.avoidTerms?.length
    ? `\nNever suggest these excluded terms: ${brief.avoidTerms.join(', ')}.`
    : '';

  return `Propose 12 to 16 semantically related terms for this article.

TOPIC: ${brief.topic}
PRIMARY KEYWORD: ${brief.primaryKeyword}
${brief.audience ? `AUDIENCE: ${brief.audience}` : ''}
${brief.region ? `REGION: ${brief.region}` : ''}

Already covered, so do not repeat any of these: ${existing.join(', ')}.${negatives}${avoid}

What makes a good term here:
- It is vocabulary a genuine expert would use writing about this topic, not a
  keyword variant. "sillage" and "top notes" beat "buy perfume online".
- It is specific enough to signal depth. "fragrance" is useless; "eau de
  parfum concentration" is not.
- Mix categories: technical terms, adjacent concepts, common questions,
  and things the reader would search next.
- It must be usable in a sentence without contortion.

Do NOT suggest close variants of the primary keyword. Those are secondary
keywords and they are a different job.

Reply with only this JSON:
{"lsiKeywords": [{"term": "...", "reason": "four to eight words on why it fits"}]}`;
}

export const VOICE_SYSTEM = `You analyse writing samples and describe what
makes them recognisably themselves. You are precise and concrete. You reply
with a single JSON object and nothing else.`;

/**
 * Extract a voice profile from real human writing.
 *
 * This is SICO's first step (arxiv 2305.10847): rather than asserting what
 * human writing looks like, derive it from examples. The comparison framing
 * matters. Asking "describe this writing" produces flattery; asking "what
 * separates this from generic AI prose" produces the features that actually
 * distinguish it, which is what a detector is looking at too.
 */
export function buildVoicePrompt(samples: string[]): string {
  // Trimmed per sample and capped overall. Twenty short samples teach more
  // about range than three long ones, and a whole blog archive would cost
  // more while extracting no better.
  const corpus = samples
    .map((sample, index) => `--- SAMPLE ${index + 1} ---\n${sample.trim().slice(0, 1200)}`)
    .join('\n\n')
    .slice(0, 24000);

  return `Below are samples of writing by a real person for one brand.

Work out what makes this writing recognisably THEIRS, as opposed to competent
generic prose or the default register of a language model.

Be concrete and observational. "Engaging and informative" is useless. "Opens
about a third of sentences with And, But or So" is useful. "Runs a two-word
sentence after a long one for emphasis" is useful. "Uses trade terms without
explaining them" is useful.

Look specifically at:
- Sentence rhythm. Length range, where the short ones land, how clauses join.
- Vocabulary. Plain or technical, concrete or abstract, recurring words.
- Openings and closings. How paragraphs start, how the writer gets into a point.
- Punctuation habits. Commas, colons, fragments, parentheses, questions.
- Person and stance. First person, direct address, hedged or blunt.
- Anything idiosyncratic enough that you could spot it in a lineup.

Then pick 3 short excerpts, 25 to 50 words each, quoted EXACTLY from the
samples, that best demonstrate the voice. They will be shown to a writer as
examples to match, so choose ones that are typical rather than unusual.

${corpus}

Reply with only this JSON:
{"features": ["..."], "cadence": "...", "vocabulary": "...", "quirks": ["..."], "excerpts": ["..."]}`;
}

/**
 * The voice block for the draft system prompt.
 *
 * Placed BEFORE the generic writing rules so it takes precedence: where the
 * two conflict, the brand's actual habits win. The rules describe good writing
 * in general; this describes how these people write.
 */
export function renderVoiceProfile(profile: {
  features: string[];
  excerpts: string[];
  cadence?: string;
  vocabulary?: string;
  quirks?: string[];
}): string {
  const lines: string[] = [
    'HOUSE VOICE. Written by the brand, observed from their real published',
    'writing. Where this conflicts with the general rules further down, this',
    'wins. Match it. Do not describe it, do not exaggerate it into a parody of',
    'itself, and do not copy the excerpts verbatim.',
    '',
  ];

  if (profile.cadence) lines.push(`Rhythm: ${profile.cadence}`);
  if (profile.vocabulary) lines.push(`Vocabulary: ${profile.vocabulary}`);
  if (profile.features.length) {
    lines.push('Characteristics:');
    lines.push(...profile.features.map((feature) => `  - ${feature}`));
  }
  if (profile.quirks?.length) {
    lines.push('Habits:');
    lines.push(...profile.quirks.map((quirk) => `  - ${quirk}`));
  }
  if (profile.excerpts.length) {
    lines.push('', 'Examples of the voice, to match in rhythm and register:');
    lines.push(...profile.excerpts.map((excerpt) => `  "${excerpt.trim()}"`));
  }

  return lines.join('\n');
}