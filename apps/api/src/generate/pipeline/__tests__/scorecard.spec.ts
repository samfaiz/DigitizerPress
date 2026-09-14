import { describe, expect, it } from 'vitest';
import { buildScorecard, type ScorecardInput } from '../scorecard.js';

const base = (): ScorecardInput => ({
  score: {
    ai_score: 5,
    verdict: 'human',
    confidence: 0.9,
    metrics: {} as never,
    sentences: [],
    word_count: 1000,
    backend: 'transformer',
    model: 'distilgpt2',
    calibrated: false,
    readability: {
      word_count: 1000,
      sentence_count: 60,
      checks: [
        { id: 'flesch', label: 'Flesch', value: 70, target: '', status: 'good', detail: '', offenders: [] },
        { id: 'passive', label: 'Passive', value: 5, target: '', status: 'good', detail: '', offenders: [] },
      ],
    },
    elapsed_ms: 10,
  } as never,
  compliance: [
    { id: 'keyword_placement', label: 'Keywords', status: 'good', detail: '' },
    { id: 'title_length', label: 'Title', status: 'good', detail: '' },
    { id: 'meta_length', label: 'Meta', status: 'good', detail: '' },
    { id: 'outline_coverage', label: 'Outline', status: 'good', detail: '' },
  ],
  eeat: [
    { id: 'a', axis: 'trustworthiness', label: 'Facts', status: 'good', detail: '' },
  ],
  citations: [],
  factFlags: [],
  seo: {
    titleTag: 'A title',
    metaDescription: 'A description that is long enough to be plausible here.',
    slug: 'a-title',
    h1: 'A title',
    imageAlt: ['one', 'two', 'three'],
    faq: [
      { question: 'q1', answer: 'a' },
      { question: 'q2', answer: 'a' },
      { question: 'q3', answer: 'a' },
    ],
    schema: '{"@context":"https://schema.org"}',
    keywordUsage: [],
  },
  markdown: '# Title\n\nSome body text.',
});

describe('buildScorecard', () => {
  it('scores a clean article highly', () => {
    expect(buildScorecard(base()).total).toBeGreaterThan(70);
  });

  it('bands by total', () => {
    const card = buildScorecard(base());
    expect(['exceptional', 'strong', 'acceptable']).toContain(card.band);
  });

  it('treats a fabricated claim as critical regardless of total', () => {
    // The whole point of a critical list: a high score with an invented
    // statistic in it is not a publishable article.
    const input = base();
    input.factFlags = [
      { text: '47%', kind: 'statistic', inBrief: false },
      { text: '2019', kind: 'date', inBrief: false },
      { text: 'the best', kind: 'superlative', inBrief: false },
    ];
    expect(buildScorecard(input).critical.length).toBeGreaterThan(0);
  });

  it('treats an unrestored placeholder as critical', () => {
    const input = base();
    input.markdown = '# Title\n\nThe value was __PH0__ units.';
    expect(buildScorecard(input).critical.join(' ')).toContain('protected span');
  });

  it('flags invalid JSON-LD as critical', () => {
    const input = base();
    input.seo = { ...input.seo, schema: '{not json' };
    expect(buildScorecard(input).critical.join(' ')).toContain('JSON');
  });

  it('penalises a high detection score', () => {
    const clean = buildScorecard(base()).total;
    const input = base();
    (input.score as { ai_score: number }).ai_score = 55;
    expect(buildScorecard(input).total).toBeLessThan(clean);
  });
});
