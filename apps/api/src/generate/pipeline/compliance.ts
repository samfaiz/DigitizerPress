import { words } from '../../humanize/pipeline/text.js';
import type {
  BriefDto,
  ComplianceCheck,
  OutlineDto,
  SeoPackage,
} from '../dto/generate.dto.js';

/**
 * Does the draft do what the brief asked?
 *
 * The humanize pipeline's fidelity guard compares output against a source, and
 * generated content has no source to compare to. This replaces it. Without a
 * gate of some kind, generation has no quality bar at all: it would return
 * whatever the model produced and call it done.
 *
 * Everything here is deterministic. Keyword presence, exclusions, outline
 * coverage and character limits are all countable, and counting beats asking a
 * model whether it followed instructions.
 */

const occurrences = (haystack: string, needle: string): number => {
  if (!needle.trim()) return 0;
  const escaped = needle.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return (haystack.match(new RegExp(`\\b${escaped}\\b`, 'gi')) ?? []).length;
};

export function checkCompliance(
  brief: BriefDto,
  outline: OutlineDto,
  markdown: string,
  seo: SeoPackage,
): ComplianceCheck[] {
  const checks: ComplianceCheck[] = [];
  const body = markdown.replace(/^#{1,6}\s.*$/gm, '');
  const wordTotal = words(markdown).length;
  const firstParagraph = body.trim().split(/\n\s*\n/)[0] ?? '';

  const push = (
    id: string,
    label: string,
    ok: boolean,
    detail: string,
    near = false,
    fix?: ComplianceCheck['fix'],
  ) =>
    checks.push({
      id,
      label,
      status: ok ? 'good' : near ? 'warn' : 'bad',
      detail,
      // A fix is only attached to a check that failed. Offering to fix
      // something that passed is noise.
      ...(ok ? {} : { fix }),
    });

  // --- Primary keyword placement. These four positions carry most of the
  // on-page weight, and missing one is the commonest avoidable SEO error.
  const inTitle = occurrences(seo.titleTag, brief.primaryKeyword) > 0;
  const inH1 = occurrences(outline.h1, brief.primaryKeyword) > 0;
  const inFirst = occurrences(firstParagraph, brief.primaryKeyword) > 0;
  const inHeadings = outline.sections.some(
    (section) => occurrences(section.heading, brief.primaryKeyword) > 0,
  );
  const placed = [inTitle, inH1, inFirst, inHeadings].filter(Boolean).length;
  push(
    'keyword_placement',
    'Primary keyword placement',
    placed >= 3,
    `Found in ${placed} of 4 key positions (title, H1, first paragraph, a subheading).`,
    placed === 2,
    {
          label: 'Add the keyword to the missing positions',
          kind: 'revise',
          instruction:
            "Work the primary keyword into whichever of the title, H1, first paragraph or a subheading is missing it. Do not add it anywhere else.",
        },
      );

  // --- Repetition, not density.
  //
  // This used to require 0.5% to 2% density of the EXACT phrase, and that
  // requirement was itself the cause of the copy reading as machine-written:
  // the only way to satisfy it is to repeat the phrase verbatim throughout.
  // The four placements above already carry the ranking weight. What matters
  // beyond them is that the phrase is NOT hammered.
  const primaryCount = occurrences(markdown, brief.primaryKeyword);
  const density = wordTotal ? (primaryCount / wordTotal) * 100 : 0;
  const exactMode = (brief.keywordMode ?? 'natural') === 'exact';
  push(
    'keyword_repetition',
    'Keyword repetition',
    exactMode ? density <= 2.5 : primaryCount >= 1 && density <= 1.2,
    `The exact phrase appears ${primaryCount} time(s) in ${wordTotal} words ` +
      `(${density.toFixed(2)}%). Above about 1.2% reads as stuffing; the four ` +
      'key placements already carry the weight.',
    density <= 2,
    {
          label: 'Vary the repeated phrasing',
          kind: 'revise',
          instruction:
            "The exact keyword phrase is used too often. Keep it in the title, H1, first paragraph and one subheading, and replace every other occurrence with a natural variation.",
        },
      );

  // --- Secondary keywords.
  if (brief.secondaryKeywords?.length) {
    const used = brief.secondaryKeywords.filter(
      (keyword) => occurrences(markdown, keyword) > 0,
    );
    const overused = brief.secondaryKeywords.filter(
      (keyword) => occurrences(markdown, keyword) > 3,
    );
    if (overused.length > 0) {
      push(
        'secondary_repetition',
        'Secondary keyword repetition',
        false,
        `Used more than three times each: ${overused.join(', ')}. Vary the wording.`,
        true,
      );
    }
    push(
      'secondary_keywords',
      'Secondary keywords',
      used.length >= Math.ceil(brief.secondaryKeywords.length * 0.5),
      `${used.length} of ${brief.secondaryKeywords.length} used.` +
        (used.length < brief.secondaryKeywords.length
          ? ` Missing: ${brief.secondaryKeywords.filter((k) => !used.includes(k)).join(', ')}.`
          : ''),
      used.length > 0,
      {
          label: 'Work in the missing terms',
          kind: 'revise',
          instruction:
            "Use each missing secondary keyword once, in a sentence where it genuinely fits. Do not force any of them.",
        },
      );
  }

  // --- Hard exclusions. A single hit is a failure, never a warning: the user
  // named these specifically and a competitor mention is not a near miss.
  if (brief.avoidTerms?.length) {
    const breached = brief.avoidTerms.filter(
      (term) => occurrences(markdown, term) > 0 || occurrences(seo.titleTag, term) > 0,
    );
    push(
      'exclusions',
      'Excluded terms',
      breached.length === 0,
      breached.length === 0
        ? 'No excluded term appears.'
        : `Excluded terms present: ${breached.join(', ')}.`,
      false,
      {
          label: 'Remove the excluded terms',
          kind: 'revise',
          instruction:
            "Remove every excluded term and rewrite the surrounding sentence so it still reads naturally.",
        },
      );
  }

  // --- Negative keywords must stay out of the ranking signals specifically,
  // not out of the body. They are about what the page ranks for.
  if (brief.negativeKeywords?.length) {
    const surfaces = [seo.titleTag, seo.metaDescription, outline.h1, ...outline.sections.map((s) => s.heading)].join(' ');
    const breached = brief.negativeKeywords.filter(
      (keyword) => occurrences(surfaces, keyword) > 0,
    );
    push(
      'negative_keywords',
      'Negative keywords',
      breached.length === 0,
      breached.length === 0
        ? 'None appear in the title, meta or headings.'
        : `Present in ranking signals: ${breached.join(', ')}.`,
      false,
      {
          label: 'Remove from ranking signals',
          kind: 'revise',
          instruction:
            "Remove the negative keywords from the title, meta description and all headings. They may remain in the body.",
        },
      );
  }

  // --- Drawbacks. Requested balance that never made it into the draft is a
  // silent failure, and a purely promotional piece also reads less human.
  if (brief.drawbacks?.length) {
    const covered = brief.drawbacks.filter((drawback) => {
      const terms = words(drawback).filter((word) => word.length > 4);
      if (terms.length === 0) return false;
      const hits = terms.filter((term) => occurrences(markdown, term) > 0).length;
      return hits / terms.length >= 0.5;
    });
    push(
      'drawbacks',
      'Honest drawbacks',
      covered.length === brief.drawbacks.length,
      `${covered.length} of ${brief.drawbacks.length} covered.`,
      covered.length > 0,
      {
          label: 'Cover the missing drawback',
          kind: 'revise',
          instruction:
            "Work the uncovered drawback into the article honestly, in the section where it is most relevant.",
        },
      );
  }

  // --- Related terms. Checked for PRESENCE only, never density: repeating
  // them is stuffing, and the target is deliberately partial because forcing
  // every term in produces exactly the keyword-list prose this tool exists to
  // avoid.
  if (brief.lsiKeywords?.length) {
    const used = brief.lsiKeywords.filter(
      (keyword) => occurrences(markdown, keyword) > 0,
    );
    const share = used.length / brief.lsiKeywords.length;
    push(
      'lsi_keywords',
      'Related terms',
      share >= 0.6,
      `${used.length} of ${brief.lsiKeywords.length} used at least once ` +
        `(${Math.round(share * 100)}%). Aim for 60% or more; hitting 100% ` +
        'usually means the prose was bent to fit.',
      share >= 0.4,
      {
          label: 'Work in the missing related terms',
          kind: 'revise',
          instruction:
            "Use more of the supplied related terms, once each, only where they fit naturally. Missing a few is better than forcing them.",
        },
      );
  }

  // --- Featured products. A product named in the brief but absent from the
  // article is a silent failure: the piece exists partly to sell it.
  if (brief.products?.length) {
    const mentioned = brief.products.filter(
      (product) => occurrences(markdown, product.name) > 0,
    );
    const withUrl = brief.products.filter((product) => product.url);
    const linked = withUrl.filter((product) =>
      markdown.includes(`(${product.url})`),
    );

    const missing = brief.products
      .filter((product) => !mentioned.includes(product))
      .map((product) => product.name);

    push(
      'products',
      'Featured products',
      missing.length === 0,
      missing.length === 0
        ? `All ${brief.products.length} product(s) appear.`
        : `Not mentioned: ${missing.join(', ')}.`,
      mentioned.length > 0,
      {
          label: 'Mention the missing products',
          kind: 'revise',
          instruction:
            "Feature every product from the brief, using only the facts supplied for each.",
        },
      );

    if (withUrl.length > 0) {
      push(
        'product_links',
        'Product links',
        linked.length === withUrl.length,
        `${linked.length} of ${withUrl.length} product URL(s) linked in the body.` +
          (linked.length < withUrl.length
            ? ` Missing: ${withUrl.filter((p) => !linked.includes(p)).map((p) => p.name).join(', ')}.`
            : ''),
        linked.length > 0,
        {
          label: 'Link the unlinked products',
          kind: 'auto',
          instruction:
            "Link each product's first plain-text mention to its URL.",
        },
      );
    }
  }

  // --- Internal links. Supplied but unused is a silent miss: they were given
  // precisely so the article would link them.
  if (brief.internalLinks?.length) {
    const used = brief.internalLinks.filter((link) => markdown.includes(link));
    push(
      'internal_links',
      'Internal links',
      used.length === brief.internalLinks.length,
      `${used.length} of ${brief.internalLinks.length} linked in the body.` +
        (used.length < brief.internalLinks.length
          ? ` Missing: ${brief.internalLinks.filter((l) => !used.includes(l)).join(', ')}.`
          : ''),
      used.length > 0,
      {
          label: 'Work in the unused links',
          kind: 'revise',
          instruction:
            "Add the unused internal links on words that already belong in their sentences. One link per paragraph at most.",
        },
      );
  }

  // --- Author signal. A visible byline is an E-E-A-T signal a reader can
  // see, which structured data alone never provides.
  if (brief.authorName || brief.authorBio) {
    const byline = occurrences(markdown, brief.authorName ?? brief.brandName) > 0;
    const bio = brief.authorBio
      ? /about the author/i.test(markdown)
      : true;
    push(
      'author_signal',
      'Author signal',
      byline && bio,
      byline
        ? bio
          ? 'Byline present, with an author note.'
          : 'Byline present but the author note is missing.'
        : 'No byline in the article.',
      byline,
      {
          label: 'Add the byline and author note',
          kind: 'auto',
          instruction:
            "Add the byline under the title and the About the author line at the end.",
        },
      );
  }

  // --- FAQ in the body, distinct from the FAQ in the schema.
  if (brief.includeFaq !== false) {
    const inBody = /frequently asked questions/i.test(markdown);
    const questions = (markdown.match(/^#{2,4}\s+.*\?\s*$/gm) ?? []).length;
    push(
      'faq_section',
      'FAQ section',
      inBody && questions >= 3,
      inBody
        ? `FAQ section present with ${questions} question heading(s).`
        : 'No FAQ section in the article body.',
      inBody,
      {
          label: 'Add the FAQ section',
          kind: 'revise',
          instruction:
            "Append a 'Frequently asked questions' section with three or four H3 questions, each answered in 40 to 60 words from what the article already establishes.",
        },
      );
  }

  // --- Outline coverage.
  const missingSections = outline.sections.filter(
    (section) => !markdown.includes(section.heading),
  );
  push(
    'outline_coverage',
    'Outline coverage',
    missingSections.length === 0,
    missingSections.length === 0
      ? `All ${outline.sections.length} sections present.`
      : `Missing: ${missingSections.map((s) => s.heading).join('; ')}.`,
    false,
    {
          label: 'Write the missing sections',
          kind: 'manual',
          instruction:
            "A whole section is missing. Regenerate rather than patch: a revision cannot reliably write a section it never planned.",
        },
      );

  // --- Length.
  if (brief.wordCount) {
    const ratio = wordTotal / brief.wordCount;
    push(
      'length',
      'Length against target',
      ratio >= 0.8 && ratio <= 1.3,
      `${wordTotal} words against a ${brief.wordCount} target.`,
      ratio >= 0.65 && ratio <= 1.5,
      {
          label: 'Adjust the length',
          kind: 'revise',
          instruction:
            "Bring the article closer to the target word count without padding or cutting a claim.",
        },
      );
  }

  // --- Metadata limits. Search engines truncate, so these are hard numbers
  // rather than guidance.
  push(
    'title_length',
    'Title tag length',
    seo.titleTag.length > 0 && seo.titleTag.length <= 60,
    `${seo.titleTag.length} characters. Limit is 60.`,
    seo.titleTag.length <= 65,
    {
          label: 'Shorten the title tag',
          kind: 'auto',
          instruction:
            "Trim the title tag to 60 characters at a word boundary.",
        },
      );
  push(
    'meta_length',
    'Meta description length',
    seo.metaDescription.length >= 70 && seo.metaDescription.length <= 155,
    `${seo.metaDescription.length} characters. Aim for 120 to 155.`,
    seo.metaDescription.length <= 165,
    {
          label: 'Rewrite the meta description',
          kind: 'revise',
          instruction:
            "Rewrite the meta description to between 120 and 155 characters, including the primary keyword.",
        },
      );

  // --- Call to action.
  if (brief.callToAction) {
    const terms = words(brief.callToAction).filter((word) => word.length > 3);
    const hits = terms.filter((term) => occurrences(markdown, term) > 0).length;
    const linked = brief.ctaUrl
      ? markdown.includes(`(${brief.ctaUrl})`) ||
        markdown.includes(`(${brief.ctaUrl.replace(/\/+$/, '')})`)
      : true;
    push(
      'cta',
      'Call to action',
      terms.length > 0 && hits / terms.length >= 0.5 && linked,
      hits === 0
        ? 'The requested call to action does not appear.'
        : linked
          ? 'Present and linked.'
          : 'Present but the destination URL is not linked.',
      hits > 0,
      {
          label: 'Add the call to action',
          kind: 'revise',
          instruction:
            "Close the article with the requested call to action, linked to its URL, in one or two specific sentences.",
        },
      );
  }

  return checks;
}
