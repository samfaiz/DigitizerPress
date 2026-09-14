import { words } from '../../humanize/pipeline/text.js';
import type { BriefDto, OutlineDto, SeoPackage } from '../dto/generate.dto.js';

/** URL slug from a title. Kept deterministic so it never surprises anyone. */
export function toSlug(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .slice(0, 12)
    .join('-');
}

/** Hard-trim to a character limit at a word boundary. */
export function trimTo(text: string, limit: number): string {
  const clean = text.trim().replace(/\s+/g, ' ');
  if (clean.length <= limit) return clean;
  const cut = clean.slice(0, limit);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > limit * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[,;:.\s]+$/, '');
}

function countKeyword(markdown: string, keyword: string): number {
  if (!keyword.trim()) return 0;
  const escaped = keyword.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return (markdown.match(new RegExp(`\\b${escaped}\\b`, 'gi')) ?? []).length;
}

export function keywordUsage(
  brief: BriefDto,
  markdown: string,
): SeoPackage['keywordUsage'] {
  const total = words(markdown).length || 1;
  return [brief.primaryKeyword, ...(brief.secondaryKeywords ?? [])].map((keyword) => {
    const count = countKeyword(markdown, keyword);
    return { keyword, count, density: Number(((count / total) * 100).toFixed(2)) };
  });
}

/**
 * JSON-LD for Article and FAQPage.
 *
 * Two objects in a @graph rather than two script tags, which is what Google's
 * own documentation shows and what most CMS templates expect.
 */
export function buildSchema(
  brief: BriefDto,
  outline: OutlineDto,
  seo: Omit<SeoPackage, 'schema' | 'keywordUsage'>,
): string {
  // Organization authorship. Weaker than a named expert for E-E-A-T, but
  // honest, and `sameAs` is what ties the byline to an identity a search
  // engine already recognises.
  const organisation: Record<string, unknown> = {
    '@type': 'Organization',
    name: brief.brandName,
  };
  if (brief.brandUrl) organisation.url = brief.brandUrl;
  if (brief.brandLinks?.length) organisation.sameAs = brief.brandLinks;

  // A named author is a stronger E-E-A-T signal than an organisation, so it
  // is used as the author when supplied. The organisation stays the publisher
  // either way, which is what it actually is.
  const author: Record<string, unknown> = brief.authorName
    ? {
        '@type': 'Person',
        name: brief.authorName,
        ...(brief.authorRole ? { jobTitle: brief.authorRole } : {}),
        ...(brief.authorBio ? { description: brief.authorBio } : {}),
        worksFor: organisation,
      }
    : organisation;

  const graph: unknown[] = [
    {
      '@type': 'Article',
      headline: trimTo(outline.h1, 110),
      description: seo.metaDescription,
      author,
      publisher: organisation,
      // datePublished and dateModified are deliberately absent. They are the
      // CMS's to set, and a date invented here would be fabricated data in
      // exactly the place a search engine trusts most.
      mainEntityOfPage: { '@type': 'WebPage', '@id': `/${seo.slug}` },
    },
  ];

  if (seo.faq.length > 0) {
    graph.push({
      '@type': 'FAQPage',
      mainEntity: seo.faq.map((entry) => ({
        '@type': 'Question',
        name: entry.question,
        acceptedAnswer: { '@type': 'Answer', text: entry.answer },
      })),
    });
  }

  return JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }, null, 2);
}

/** Assemble the outline and drafted sections into the final markdown. */
export function assembleMarkdown(
  outline: OutlineDto,
  sections: string[],
  intro?: string,
): string {
  // Title, then prose, then the first subheading. A heading stacked directly
  // under another heading reads as a template, and tells the reader nothing
  // before asking them to navigate.
  const parts: string[] = [`# ${outline.h1}`];
  if (intro?.trim()) parts.push(intro.trim());
  outline.sections.forEach((section, index) => {
    const body = (sections[index] ?? '').trim();
    if (!body) return;
    parts.push(`${section.level === 'h3' ? '###' : '##'} ${section.heading}`);
    parts.push(body);
  });
  return parts.join('\n\n');
}
