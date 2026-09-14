import type { ProductDto } from '../dto/generate.dto.js';

/**
 * Link each product on its first plain-text mention.
 *
 * The model is told to link products and usually does, but "usually" is not
 * good enough for the thing the article exists to sell: a real run mentioned
 * three products and linked two. The alternative was making the missing link
 * a hard compliance failure, which would trigger a full article regeneration
 * to insert one pair of brackets.
 *
 * This is deterministic, free and exact, so the model's inconsistency stops
 * mattering. It only ever ADDS a link that the brief already specified; it
 * cannot invent a URL, because it only uses URLs supplied in the brief.
 */
/**
 * Strip tracking noise from a URL before it is published.
 *
 * A link carrying utm_source or fbclid into an article is a link that leaks
 * someone's session into your analytics and looks untidy in the markup. These
 * parameters are added by whatever tool the URL was copied from and are never
 * meant to survive into content.
 */
export function cleanUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  try {
    const url = new URL(trimmed);
    const junk = [
      /^utm_/i,
      /^fbclid$/i,
      /^gclid$/i,
      /^msclkid$/i,
      /^mc_(cid|eid)$/i,
      /^_ga$/i,
      /^ref$/i,
      /^variant$/i,
    ];
    for (const key of [...url.searchParams.keys()]) {
      if (junk.some((pattern) => pattern.test(key))) url.searchParams.delete(key);
    }
    url.hash = '';
    // A trailing slash on a path is a duplicate-content risk; the bare root
    // keeps its slash because "https://example.com" alone is not a path.
    if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
      url.pathname = url.pathname.replace(/\/+$/, '');
    }
    return url.toString();
  } catch {
    // Not a parseable URL. Returned untouched rather than dropped, so a
    // relative internal path like /collections/foo still works.
    return trimmed;
  }
}

export function linkProducts(markdown: string, products: ProductDto[]): string {
  let result = markdown;

  for (const product of products) {
    if (!product.url || !product.name.trim()) continue;
    const href = cleanUrl(product.url);
    // Already linked somewhere. Linking every mention reads as spam and hurts
    // both the reader and the page.
    if (result.includes(`](${href})`)) continue;

    const escaped = product.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(escaped, 'g');

    let replaced = false;
    result = result.replace(pattern, (match, offset: number) => {
      if (replaced) return match;

      const lineStart = result.lastIndexOf('\n', offset) + 1;
      const line = result.slice(lineStart, result.indexOf('\n', offset) === -1
        ? result.length
        : result.indexOf('\n', offset));

      // Never inside a heading: a linked heading breaks the document outline
      // that the SEO checks and the editor both depend on.
      if (/^\s{0,3}#{1,6}\s/.test(line)) return match;

      // Never inside an existing markdown link, which would nest brackets and
      // corrupt both links.
      const before = result.slice(Math.max(0, offset - 200), offset);
      const openBracket = before.lastIndexOf('[');
      if (openBracket !== -1 && !before.slice(openBracket).includes(')')) return match;

      replaced = true;
      return `[${match}](${href})`;
    });
  }

  return result;
}
