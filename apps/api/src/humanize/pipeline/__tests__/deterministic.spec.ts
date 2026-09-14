import { describe, expect, it } from 'vitest';
import { applyDeterministic } from '../deterministic.js';
import { splitSentences, wordCount } from '../text.js';

const run = (text: string, style: 'standard' | 'academic' = 'standard', split = false) =>
  applyDeterministic(text, { style, breakLongSentences: split });

describe('applyDeterministic', () => {
  it('swaps a formal marker for a natural connective', () => {
    // Substituted rather than deleted. Deleting every connective drove SEO
    // transition density to 5% against a 30% target on real output.
    const { text } = run('The plan failed. Moreover, the budget was gone.');
    expect(text).toBe('The plan failed. And the budget was gone.');
  });

  it('rotates replacements so openings do not repeat', () => {
    // Four identical openings in a row would trip the consecutive-openings
    // readability check, trading one problem for another.
    const { text } = run(
      'Sales rose. Furthermore, costs fell. Additionally, morale improved. Moreover, churn dropped.',
    );
    const openings = text.split(/(?<=[.!?])\s+/).map((s) => s.split(' ')[0]);
    expect(new Set(openings).size).toBeGreaterThan(1);
  });

  it('maps consequence markers to a plain connective', () => {
    expect(run('It rained. Therefore, we stayed in.').text).toBe(
      'It rained. So we stayed in.',
    );
  });

  it('deletes markers that have no natural equivalent', () => {
    // "In conclusion" adds nothing a reader needs, so it goes entirely.
    expect(run('The data is clear. In conclusion, we should act.').text).toBe(
      'The data is clear. We should act.',
    );
  });

  it('replaces formal filler with plain words', () => {
    const { text } = run('We utilized the tool to facilitate a myriad of tasks.');
    expect(text).toBe('We used the tool to help many tasks.');
    expect(text).toContain('used');
    expect(text).toContain('help');
    expect(text).toContain('many');
  });

  it('removes em dashes without losing the clause', () => {
    const { text } = run('The result — surprising to everyone — was clear.');
    expect(text).not.toContain('—');
    expect(text).toContain('surprising to everyone');
  });

  it('never strands a reduced verb at the end of a clause', () => {
    // "part of who you are." must not become "part of who you're." This
    // showed up in real output: a contraction cannot end a clause.
    expect(run('Your scent becomes part of who you are.').text).toContain('who you are.');
    expect(run('I know what it is.').text).toContain('what it is.');
    expect(run('Take whatever we have.').text).toContain('we have.');
    expect(run('Tell them where they are, please.').text).toContain('they are,');
  });

  it('still contracts when a word follows', () => {
    expect(run('You are going to like it.').text).toContain("You're going");
    expect(run('It is working now.').text).toContain("It's working");
    expect(run('They are not ready.').text).toContain("They're not");
  });

  it('leaves negative contractions unguarded, since they can end a clause', () => {
    expect(run('I hoped it would but it did not.').text).toContain("didn't.");
  });

  it('applies contractions in standard style but not academic', () => {
    // "It's not working" rather than "It isn't working": the subject
    // contraction fires first and is the more natural of the two.
    expect(run('It is not working.').text).toBe("It's not working.");
    expect(run('It is not working.', 'academic').text).toBe('It is not working.');
  });

  it('reports which rules fired', () => {
    const { applied } = run('Moreover, we utilized it — carefully.');
    expect(applied).toContain('discourse-markers');
    expect(applied).toContain('vocabulary');
    expect(applied).toContain('typography');
  });

  it('leaves clean prose essentially alone', () => {
    const clean = 'The bus came late. I waited.';
    expect(run(clean).text).toBe(clean);
  });

  it('splits an over-long sentence into two viable ones', () => {
    const long =
      'The committee reviewed every submission that arrived before the deadline ' +
      'in a process that took several weeks of careful work, and the final report ' +
      'was published on the department website for anyone who wanted to read it.';
    const { text } = run(long, 'standard', true);
    expect(splitSentences(text).length).toBeGreaterThan(splitSentences(long).length);
  });

  it('does not split where a half would be left too short', () => {
    const long =
      'The committee reviewed every single submission that had arrived before ' +
      'the published deadline in a long process that took several weeks, so yes.';
    const { text } = run(long, 'standard', true);
    expect(splitSentences(text).length).toBe(1);
  });

  it('never invents or drops content words', () => {
    const source = 'Moreover, the team utilized a robust framework to facilitate delivery.';
    const { text } = run(source);
    expect(wordCount(text)).toBeLessThanOrEqual(wordCount(source));
    expect(text).toContain('framework');
    expect(text).toContain('delivery');
  });
});

describe('document structure', () => {
  const longSentence =
    'The committee reviewed every submission that arrived before the deadline ' +
    'in a process that took several weeks of careful work, and the final report ' +
    'was published on the department website for anyone who wanted to read it.';

  it('preserves headings and blank lines when splitting sentences', () => {
    // An earlier version rejoined the whole document with a single space,
    // flattening every heading into the body. One style lost five of six.
    const source = `# Title\n\n${longSentence}\n\n## Section\n\nShort line here.`;
    const { text } = run(source, 'standard', true);
    expect(text).toContain('# Title');
    expect(text).toContain('## Section');
    expect(text.split('\n\n').length).toBeGreaterThanOrEqual(4);
  });

  it('leaves a masked placeholder on its own line alone', () => {
    const source = `__PH0__\n\n${longSentence}`;
    const { text } = run(source, 'standard', true);
    expect(text.split('\n')[0]).toBe('__PH0__');
  });

  it('does not merge list items into a paragraph', () => {
    const source = `${longSentence}\n\n- first item\n- second item`;
    const { text } = run(source, 'standard', true);
    expect(text).toContain('- first item');
    expect(text).toContain('- second item');
  });
});

describe('varied substitutions', () => {
  it('rotates alternatives instead of always using the same word', () => {
    // A fixed mapping is itself a fingerprint: if every article turns
    // "robust" into "strong", the consistency is the signal.
    const { text } = run('A robust plan, a robust team, and a robust process.');
    const words = text.match(/\b(strong|solid|dependable)\b/g) ?? [];
    expect(words.length).toBe(3);
    expect(new Set(words).size).toBeGreaterThan(1);
  });

  it('consumes multi-word phrases before single words', () => {
    // Ordering bug this covers: the word rule for "myriad" fired before the
    // phrase rule for "a myriad of", producing "a many of tasks".
    expect(run('We faced a myriad of tasks.').text).toBe('We faced many tasks.');
  });

  it('preserves capitalisation on a rotated replacement', () => {
    expect(run('Robust systems matter.').text).toMatch(/^(Strong|Solid|Dependable) systems/);
  });

  it('is deterministic, so the cache stays meaningful', () => {
    const source = 'A robust plan and a robust outcome.';
    expect(run(source).text).toBe(run(source).text);
  });
});
