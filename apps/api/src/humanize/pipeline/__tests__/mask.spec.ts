import { describe, expect, it } from 'vitest';
import { mask, missingTokens, unmask } from '../mask.js';

describe('mask', () => {
  it('protects the spans a paraphrase would corrupt', () => {
    const source =
      'Revenue rose 47.3% to $1,200,000 in 2023, per (Smith et al., 2021) ' +
      'and the filing at https://example.com/report [4].';
    const { masked, tokens } = mask(source);

    for (const fragment of ['47.3', '$1,200,000', '2023', 'Smith', 'https://', '[4]']) {
      expect(masked).not.toContain(fragment);
    }
    expect(unmask(masked, tokens)).toBe(source);
  });

  it('leaves bare small integers alone so the text stays rewritable', () => {
    // Masking every digit would make natural rephrasing impossible.
    const { masked } = mask('We ran 3 trials across 12 sites.');
    expect(masked).toContain('3');
    expect(masked).toContain('12');
  });

  it('freezes quotations of four words or more', () => {
    const source = 'She called it "a complete waste of public money" at the hearing.';
    const { masked, tokens } = mask(source);
    expect(masked).not.toContain('waste of public money');
    expect(unmask(masked, tokens)).toBe(source);
  });

  it('does not freeze short scare quotes', () => {
    const { masked } = mask('The so-called "reform" achieved nothing.');
    expect(masked).toContain('"reform"');
  });

  it('recovers placeholders the model spaced out', () => {
    const { tokens } = mask('The figure was $4,500 last year.');
    const token = [...tokens.keys()][0];
    const mangled = `The figure was ${token.replace('__', '_ _')} last year.`;
    expect(unmask(mangled, tokens)).toContain('$4,500');
  });

  it('reports placeholders the model dropped entirely', () => {
    const { tokens } = mask('Revenue was $1,200,000 in 2019.');
    expect(missingTokens('Revenue was high.', tokens).length).toBe(tokens.size);
  });

  it('protects fenced code before anything can match inside it', () => {
    const source = 'Run this:\n\n```js\nconst x = 1.5;\n```\n\nThen deploy.';
    const { masked, tokens } = mask(source);
    expect(masked).not.toContain('const x');
    expect(unmask(masked, tokens)).toBe(source);
  });
});

describe('markdown structure', () => {
  it('protects headings so page structure cannot be rewritten away', () => {
    // A real run dropped every heading in an SEO page, taking its subheading
    // distribution from a 128-word gap to 752.
    const source = '# Title\n\nSome body text here.\n\n## A Subheading\n\nMore body.';
    const { masked, tokens } = mask(source);
    expect(masked).not.toContain('# Title');
    expect(masked).not.toContain('## A Subheading');
    expect(unmask(masked, tokens)).toBe(source);
  });

  it('protects emphasis spans, which carry SEO keywords', () => {
    const source = 'Looking for *best perfumes in Dubai* today? We have **bold** picks.';
    const { masked, tokens } = mask(source);
    expect(masked).not.toContain('best perfumes in Dubai');
    expect(unmask(masked, tokens)).toBe(source);
  });

  it('protects markdown links whole', () => {
    const source = 'Read the [full report](https://example.com/report) first.';
    const { masked, tokens } = mask(source);
    expect(masked).not.toContain('full report');
    expect(unmask(masked, tokens)).toBe(source);
  });

  it('does not treat a lone asterisk as emphasis', () => {
    const source = 'Multiply 3 * 4 to get the total.';
    const { masked } = mask(source);
    expect(masked).toContain('*');
  });
});
