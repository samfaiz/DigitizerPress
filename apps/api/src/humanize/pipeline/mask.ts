/**
 * Protect spans the rewriter must not touch.
 *
 * This is the step that stops the most damaging failure mode. Ask a model to
 * paraphrase a passage and it will cheerfully round 47.3% to "roughly half",
 * rewrite a direct quotation, renumber a citation, or reword a URL. Any of
 * those turns a style edit into a fabrication.
 *
 * So the protected spans are swapped for opaque placeholders before the model
 * sees the text, and restored afterwards. A placeholder that fails to come
 * back is treated as a fidelity failure, not silently patched over.
 */

export interface MaskResult {
  masked: string;
  /** Placeholder token to the exact original span it stands for. */
  tokens: Map<string, string>;
}

// ASCII with underscores on both sides. Chosen over bracket or unicode forms
// because models copy it verbatim instead of "helpfully" reformatting it.
const TOKEN = (index: number) => `__PH${index}__`;

/**
 * Order matters. Code fences must be pulled before anything can match inside
 * them, and URLs before the number rule can chew on a port or a version.
 */
const RULES: Array<{
  name: string;
  pattern: RegExp;
  /** Extra condition the match must meet to be worth protecting. */
  accept?: (match: string) => boolean;
}> = [
  { name: 'fenced-code', pattern: /```[\s\S]*?```/g },
  // Markdown headings, whole line. Rewriting a heading is almost never wanted:
  // it carries the page structure and, in SEO copy, the target keyword. A real
  // run dropped every heading in a document and took its subheading
  // distribution from a 128-word gap to 752, so this is structural, not
  // cosmetic.
  { name: 'heading', pattern: /^[ \t]{0,3}#{1,6}[ \t]+.+$/gm },
  // Emphasis spans. In SEO copy these are the keyword phrases the page exists
  // to rank for, and losing one silently defeats the point of the rewrite.
  // Bounded lengths here are insurance, not a fix for a known bug: a single
  // lazy quantifier is linear. A cap keeps a pathological line cheap anyway.
  { name: 'emphasis', pattern: /(\*\*|__)(?=\S)[^*_\n]{1,200}?\1/g },
  { name: 'emphasis-single', pattern: /(?<![*\w])\*(?=\S)[^*\n]{1,200}?\*(?![*\w])/g },
  // Markdown links: the visible text and the target both have to survive.
  { name: 'link', pattern: /\[[^\]\n]*\]\([^)\n]*\)/g },
  { name: 'inline-code', pattern: /`[^`\n]+`/g },
  { name: 'url', pattern: /https?:\/\/[^\s<>()[\]]+/g },
  { name: 'email', pattern: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g },
  // (Smith, 2020) / (Smith et al., 2020) / (Smith & Jones, 2020)
  {
    name: 'citation-parenthetical',
    pattern:
      /\([A-Z][A-Za-z'’-]+(?:\s+et al\.?)?(?:\s*(?:&|and)\s*[A-Z][A-Za-z'’-]+)?,\s*\d{4}[a-z]?\)/g,
  },
  // [1] / [12, 15] / [3-7]
  { name: 'citation-numeric', pattern: /\[\d+(?:\s*[,–-]\s*\d+)*\]/g },
  // Direct quotations of four words or more. Shorter runs in quotes are
  // usually scare quotes, and freezing those makes the rewrite stilted.
  //
  // The word count is checked in `accept` rather than in the pattern, and
  // that split is not stylistic. The previous pattern expressed it directly:
  //
  //     /"(?:[^"\n]*?\s){3,}[^"\n]*?"/g
  //
  // A lazy quantifier inside a repeated group, followed by another lazy
  // quantifier, is the textbook shape for catastrophic backtracking. Given a
  // paragraph with an opening quote and no closing quote on the same line,
  // the engine explores exponentially many ways to split the text into three
  // or more groups and never returns. It pinned a production process at 100%
  // CPU for six hours, taking a bulk job and every other request with it,
  // and a 670-character line was enough to trigger it.
  //
  // The pattern below has one bounded quantifier and no nesting, so it is
  // linear. The 300-character bound also means an unmatched quote can only
  // scan that far before failing.
  {
    name: 'quotation',
    pattern: /"[^"\n]{1,300}"/g,
    accept: (match) => (match.match(/\s+/g)?.length ?? 0) >= 3,
  },
  { name: 'currency', pattern: /[$£€¥]\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:bn|m|k|billion|million|thousand))?/gi },
  { name: 'percentage', pattern: /\b\d+(?:\.\d+)?\s?%/g },
  // A number with a unit, or any number carrying a decimal or thousands
  // separator. Bare small integers are left alone: masking "three" or "5"
  // everywhere makes the text impossible to rewrite naturally.
  { name: 'measurement', pattern: /\b\d+(?:\.\d+)?\s?(?:kg|km|cm|mm|mg|ml|lb|oz|ft|in|hrs?|hours?|mins?|minutes?|secs?|seconds?|days?|weeks?|months?|years?|GB|MB|KB|TB|Hz|MHz|GHz)\b/gi },
  { name: 'precise-number', pattern: /\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b|\b\d+\.\d+\b/g },
  { name: 'year', pattern: /\b(?:1[89]\d{2}|20\d{2})\b/g },
];

export function mask(text: string): MaskResult {
  const tokens = new Map<string, string>();
  let masked = text;
  let counter = 0;

  for (const rule of RULES) {
    masked = masked.replace(rule.pattern, (match) => {
      // Never mask something that is already a placeholder.
      if (/^__PH\d+__$/.test(match)) return match;
      if (rule.accept && !rule.accept(match)) return match;
      const token = TOKEN(counter++);
      tokens.set(token, match);
      return token;
    });
  }

  return { masked, tokens };
}

export function unmask(text: string, tokens: Map<string, string>): string {
  let restored = text;
  for (const [token, original] of tokens) {
    const index = /\d+/.exec(token)?.[0];
    if (index === undefined) continue;
    // Models occasionally emit "__PH3 __" or "_ _PH3__". Tolerating stray
    // whitespace INSIDE the delimiters recovers those. Note the pattern must
    // not end in \s*, or restoring a placeholder eats the space after it and
    // welds two words together.
    const forgiving = new RegExp(`_\\s*_\\s*PH\\s*${index}\\s*_\\s*_`, 'g');
    restored = restored.replace(forgiving, () => original);
  }
  return restored;
}

/** Placeholders the model dropped or mangled beyond recovery. */
export function missingTokens(text: string, tokens: Map<string, string>): string[] {
  return [...tokens.keys()].filter((token) => !text.includes(token));
}
