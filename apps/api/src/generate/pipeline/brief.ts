import type { BriefDto } from '../dto/generate.dto.js';

/**
 * Render the brief into the block every generation prompt shares.
 *
 * One renderer rather than per-prompt formatting, because the brief is also
 * the factual boundary. If the outline prompt and the draft prompt described
 * the brand differently, the strict facts guard would be checking against a
 * moving target.
 */
export function renderBrief(brief: BriefDto): string {
  const lines: string[] = [
    `TOPIC: ${brief.topic}`,
    `BRAND: ${brief.brandName}`,
    `WHAT THE BRAND DOES: ${brief.brandDescription}`,
    `PRIMARY KEYWORD: ${brief.primaryKeyword}`,
  ];

  if (brief.secondaryKeywords?.length) {
    lines.push(`SECONDARY KEYWORDS: ${brief.secondaryKeywords.join(', ')}`);
  }

  if ((brief.keywordMode ?? 'natural') === 'natural') {
    lines.push(
      'HOW TO USE THE KEYWORDS. Use the primary keyword EXACTLY as written in ' +
        'four places only: the title, the H1, the first paragraph, and one ' +
        'subheading. Everywhere else, vary it the way a person would. Break ' +
        'it up, reorder it, swap a word for a synonym, or use a pronoun once ' +
        'the subject is established. "niche perfumes in Dubai" becomes "these ' +
        'perfumes", "niche fragrance here", "buying niche in the UAE".\n' +
        '  Repeating a keyword phrase verbatim through a page is the single ' +
        'most recognisable mark of copy written for a density target. It reads ' +
        'badly to a person and it is what detectors and search engines both ' +
        'penalise. Secondary keywords should each appear once, in their ' +
        'natural form, and never be forced into a sentence that resists them.',
    );
  } else {
    lines.push(
      'KEYWORD MODE: exact. Use the keyword phrases verbatim. Note that this ' +
        'reads as machine-written and is rarely the right choice.',
    );
  }
  if (brief.lsiKeywords?.length) {
    lines.push(
      'RELATED TERMS to work in naturally. Use each ONCE where it genuinely ' +
        'fits. Do not repeat them, do not force one into a sentence that does ' +
        'not want it, and never list them together: a paragraph that reads as ' +
        'a keyword list defeats the purpose and reads as machine-written. ' +
        'Missing a few is better than stuffing all of them:\n  ' +
        brief.lsiKeywords.join(', '),
    );
  }
  if (brief.experienceNotes?.trim()) {
    lines.push(
      "FIRST-HAND EXPERIENCE. These are the brand's own observations, and the " +
        'only genuine experience available to this article. Work them in where ' +
        'they support a point, and attribute them plainly in the first person ' +
        'plural: "we have found", "in our experience", "customers tell us". ' +
        'Do NOT invent further experience, testing, timeframes or customer ' +
        'anecdotes beyond what is written here:\n  ' +
        brief.experienceNotes.trim(),
    );
  }
  if (brief.audience) lines.push(`AUDIENCE: ${brief.audience}`);
  if (brief.region) lines.push(`REGION: ${brief.region}`);
  if (brief.wordCount) lines.push(`TARGET LENGTH: about ${brief.wordCount} words`);

  if (brief.avoidTerms?.length) {
    lines.push(
      `NEVER MENTION (hard exclusion, checked): ${brief.avoidTerms.join(', ')}`,
    );
  }
  if (brief.drawbacks?.length) {
    lines.push(
      'HONEST DRAWBACKS TO INCLUDE (do not bury these, a balanced piece reads ' +
        `as human and a purely promotional one does not): ${brief.drawbacks.join('; ')}`,
    );
  }
  if (brief.negativeKeywords?.length) {
    lines.push(
      'KEEP OUT OF HEADINGS, TITLE AND META (negative keywords): ' +
        brief.negativeKeywords.join(', '),
    );
  }
  if (brief.authorName || brief.authorBio) {
    lines.push(
      'AUTHOR. Open the article with a single byline line, exactly in this ' +
        'form and nothing more:\n' +
        `  *By ${brief.authorName ?? brief.brandName}` +
        `${brief.authorRole ? `, ${brief.authorRole}` : ''}*\n` +
        (brief.authorBio
          ? '  Then, as the LAST section, add a short "About the author" ' +
            'paragraph built only from this: ' +
            brief.authorBio
          : '') +
        '\n  Do not invent credentials, years of experience or qualifications ' +
        'beyond what is written here.',
    );
  }

  if (brief.callToAction) {
    lines.push(
      `CALL TO ACTION: ${brief.callToAction}` +
        (brief.ctaUrl ? ` -> ${brief.ctaUrl}` : '') +
        '\n  Close the article with it, and make it specific. Name what the ' +
        'reader should do and why it follows from what they have just read. ' +
        '"Explore the collection" is a weak ending; "If you have been reaching ' +
        'for the same bottle since 2019, start with something in the opposite ' +
        'direction" earns the click. One or two sentences, no hard sell, and ' +
        'link it where a URL is given.',
    );
  }
  // Product pages ARE internal links. Treating them as a separate category
  // meant an article could "use all internal links" while leaving every
  // product unlinked, and the two compete for the same anchor text anyway.
  const internal = [
    ...(brief.internalLinks ?? []),
    ...(brief.products ?? []).map((product) => product.url).filter(Boolean),
  ] as string[];

  if (internal.length) {
    lines.push(
      `INTERNAL LINKS TO WORK IN (${internal.length}, product pages included): ` +
        internal.join(', ') +
        '\n  Spread them through the article rather than clustering them in one ' +
        'section. Link words that already belong in the sentence, never "click ' +
        'here". No paragraph should carry more than one link.',
    );
  }

  if (brief.products?.length) {
    lines.push(
      'PRODUCTS TO FEATURE. Work each one in where it genuinely fits the ' +
        'argument, not as a block of promotion. Link the product name as ' +
        'markdown, [Name](url), the first time it appears and not every time. ' +
        'The note after each product is everything you are allowed to say ' +
        'about it:\n' +
        brief.products
          .map((product) => {
            const parts: string[] = [];
            if (product.note) parts.push(product.note);
            if (product.price) parts.push(`price ${product.price}`);
            if (product.size) parts.push(`size ${product.size}`);
            if (product.attributes?.length) {
              parts.push(product.attributes.join('; '));
            }
            if (product.bestFor) parts.push(`suits: ${product.bestFor}`);

            const link = product.url
              ? ` -> ${product.url}`
              : ' (no URL supplied, do not invent one)';
            const facts = parts.length
              ? `\n      FACTS, and the limit of what may be said: ${parts.join('. ')}.`
              : '\n      No details supplied, so name it and describe nothing specific.';
            return `  - ${product.name}${link}${facts}`;
          })
          .join('\n') +
        '\n  Use the concrete facts. A product paragraph that names a price, ' +
        'a size or an actual attribute reads as though someone has handled the ' +
        'thing. One that says "a bold, distinctive scent" reads as filler and ' +
        'could describe anything.',
    );
  }

  if (brief.includeFaq !== false) {
    lines.push(
      'FAQ. Finish the article with a section headed "Frequently asked ' +
        'questions" holding three or four questions a reader would actually ' +
        'search for. Each question is an H3. Each answer is 40 to 60 words and ' +
        'draws only on what the article already establishes. Do not repeat a ' +
        'point the body has already made in full.',
    );
  }

  return lines.join('\n');
}

/**
 * The factual boundary, stated as a rule.
 *
 * Ask a model for a blog post and it will invent statistics, studies and
 * product claims without hesitation. On brand copy that is a legal and
 * reputational exposure, not merely a quality problem, so the constraint is
 * stated in every prompt rather than trusted to good behaviour.
 */
export const FACTS_RULE = `
FACTUAL BOUNDARY. This is not negotiable and it outranks every other
instruction, including keyword targets and word count.

- Do NOT invent statistics, percentages, survey results, study findings,
  award wins, customer numbers, founding dates or prices.
- Do NOT assert anything about the brand beyond WHAT THE BRAND DOES above.
- Do NOT assert anything about a featured product beyond its note above. No
  invented prices, sizes, ingredients, notes, ratings or awards.
- Do NOT invent a product URL. If one was not supplied, mention the product
  without linking it.
- Do NOT invent first-hand experience. No claims of having tested, trialled,
  measured or surveyed anything unless FIRST-HAND EXPERIENCE says so.
- Where a claim is general knowledge rather than something you were given,
  write it plainly and without a fake source. Hedge honestly if it is
  contested: "usually", "in most cases", "tends to".
- Do NOT name real people, publications or studies as sources.
- Do NOT write "studies show", "research suggests", "experts agree" or any
  similar appeal to an authority you cannot name.
- Where a specific number would be natural but you have not been given one,
  write the sentence without it. A vaguer true sentence beats a precise
  invented one every time.`;

/**
 * The writing constraints, applied at generation rather than bolted on after.
 *
 * Generating machine-flavoured prose and then paying a second time to strip it
 * out is the obvious approach and the wrong one. These are the same rules the
 * rewriter enforces, moved to the front of the pipeline so the first draft is
 * already close.
 */
export const WRITING_RULES = `
HOW TO WRITE IT.

Rhythm, which matters more than anything else here:
- Vary sentence length hard. Put a four-word sentence next to a thirty-word
  one. Uniform rhythm is the clearest sign of machine writing.
- Keep most sentences under 20 words. No more than a quarter may go over.
- Never open more than two sentences in a row with the same word.

Word choice:
- Short, common words. "use" not "utilise", "help" not "facilitate".
- Active voice. At most one sentence in ten may be passive.
- Never use: delve, tapestry, realm, myriad, pivotal, robust, seamless,
  holistic, multifaceted, comprehensive, underscore, leverage, facilitate,
  testament, landscape, navigate, foster, embark, unlock.

Connectives:
- Open roughly a third of sentences with a plain connective: But, So, And,
  Still, Then, Yet, For example, In fact, That said.
- Never open with: Moreover, Furthermore, Additionally, Consequently,
  Nevertheless, Notably, In conclusion, Overall, Ultimately.

Formatting:
- No em dashes. Use a comma, a full stop, or restructure.
- Plain prose paragraphs. No bullet lists unless the content is genuinely a
  list of parallel items.`;
