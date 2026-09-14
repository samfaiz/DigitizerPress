import { describe, expect, it } from 'vitest';
import { linkProducts } from '../products.js';

const product = { name: 'Stone Age Ember', url: 'https://example.com/ember' };

describe('linkProducts', () => {
  it('links the first plain mention', () => {
    const result = linkProducts('Try Stone Age Ember today.', [product]);
    expect(result).toBe('Try [Stone Age Ember](https://example.com/ember) today.');
  });

  it('links only once, because linking every mention reads as spam', () => {
    const result = linkProducts(
      'Stone Age Ember is warm. Stone Age Ember lasts.',
      [product],
    );
    expect(result.match(/\]\(https:\/\/example\.com\/ember\)/g)?.length).toBe(1);
  });

  it('leaves an already-linked product alone', () => {
    const source = 'See [Stone Age Ember](https://example.com/ember) for details.';
    expect(linkProducts(source, [product])).toBe(source);
  });

  it('never links inside a heading, which would break the outline', () => {
    const source = '## Stone Age Ember\n\nA warm scent.';
    expect(linkProducts(source, [product])).toBe(source);
  });

  it('links in the body even when the name also appears as a heading', () => {
    const result = linkProducts('## Stone Age Ember\n\nStone Age Ember is warm.', [product]);
    expect(result).toContain('## Stone Age Ember\n');
    expect(result).toContain('[Stone Age Ember](https://example.com/ember) is warm');
  });

  it('cannot invent a URL for a product that has none', () => {
    // The whole point of the guard: a product with no page must not acquire one.
    const source = 'Stone Age Tide is fresh.';
    expect(linkProducts(source, [{ name: 'Stone Age Tide' }])).toBe(source);
  });

  it('does not nest a link inside another link', () => {
    const source = 'Read [about Stone Age Ember here](https://example.com/guide).';
    expect(linkProducts(source, [product])).toBe(source);
  });
});
