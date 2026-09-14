import { describe, expect, it } from 'vitest';
import {
  assembleFidelity,
  buildJudgePrompt,
  checkConstraints,
  parseJudgeVerdict,
} from '../fidelity.js';

const ORIGINAL =
  'The committee reviewed the housing proposal, considered objections from ' +
  'residents, and approved the revised funding request of 14 million dollars.';

const GOOD_REWRITE =
  'The committee looked at the housing proposal. It weighed what residents ' +
  'objected to, then signed off on the reworked 14 million dollar request.';

describe('checkConstraints', () => {
  it('passes a genuine paraphrase that replaced most of its words', () => {
    // This is the case the old content-overlap check got wrong. A good
    // paraphrase shares almost no vocabulary with its source by design.
    expect(checkConstraints(ORIGINAL, GOOD_REWRITE).passed).toBe(true);
  });

  it('catches an altered number, which is the failure that matters most', () => {
    const report = checkConstraints(
      'Revenue grew to 1,200,000 dollars across the reporting year.',
      'Revenue grew to roughly a million dollars across the reporting year.',
    );
    expect(report.passed).toBe(false);
    expect(report.missingNumbers).toContain('1,200,000');
  });

  it('accepts a number spelled out as a word', () => {
    // "14 participants" becoming "fourteen participants" preserves the value
    // exactly. Failing it rejected good rewrites over pure typography.
    const report = checkConstraints(
      '14 participants were lost to follow-up.',
      'Fourteen participants dropped out before the end.',
    );
    expect(report.missingNumbers).toEqual([]);
    expect(report.passed).toBe(true);
  });

  it('accepts a thousands separator being dropped', () => {
    const report = checkConstraints(
      'The figure reached 1,200,000 units.',
      'The figure reached 1200000 units.',
    );
    expect(report.missingNumbers).toEqual([]);
  });

  it('catches a protected span that came back corrupted', () => {
    const report = checkConstraints(
      'The reported value was 1,450 units last quarter.',
      'The reported value was __PH0__ units last quarter.',
    );
    expect(report.passed).toBe(false);
    expect(report.unrestoredPlaceholders).toEqual(['__PH0__']);
  });

  it('rejects a rewrite that lost most of its length', () => {
    expect(checkConstraints(ORIGINAL, 'They approved it.').passed).toBe(false);
  });

  it('rejects a rewrite that invented a lot of new material', () => {
    const padded = `${GOOD_REWRITE} ${GOOD_REWRITE} ${GOOD_REWRITE}`;
    expect(checkConstraints(ORIGINAL, padded).passed).toBe(false);
  });
});

describe('parseJudgeVerdict', () => {
  it('reads a clean JSON reply', () => {
    const result = parseJudgeVerdict(
      '{"missing":[],"contradicted":[],"added":[],"verdict":"same","reason":"claims match"}',
    );
    expect(result.verdict).toBe('same');
    expect(result.reason).toBe('claims match');
  });

  it('trusts a populated list over a contradicting verdict', () => {
    // Models reliably notice an omission, describe it as a mere detail, and
    // then vote "same" anyway. The enumerated list is the better signal.
    const result = parseJudgeVerdict(
      '{"missing":["the mechanism"],"contradicted":[],"added":[],"verdict":"same","reason":"minor omission"}',
    );
    expect(result.verdict).toBe('drifted');
    expect(result.reason).toContain('the mechanism');
  });

  it('accepts a verdict of same only when all three lists are empty', () => {
    const result = parseJudgeVerdict(
      '{"missing":[],"contradicted":[],"added":["a new fact"],"verdict":"same"}',
    );
    expect(result.verdict).toBe('drifted');
  });

  it('reads JSON wrapped in prose or a code fence', () => {
    const reply = 'Here is my answer:\n```json\n{"verdict":"drifted","reason":"number changed"}\n```';
    expect(parseJudgeVerdict(reply).verdict).toBe('drifted');
  });

  it('falls back to reading a plain-text answer', () => {
    expect(parseJudgeVerdict('The two passages are the same.').verdict).toBe('same');
  });

  it('returns unknown rather than guessing on an unreadable reply', () => {
    // Unknown must not become a pass, and must not become a rejection either,
    // or one malformed reply would discard a perfectly good rewrite.
    expect(parseJudgeVerdict('').verdict).toBe('unknown');
    expect(parseJudgeVerdict('%%%').verdict).toBe('unknown');
  });

  it('ignores an out-of-range verdict value', () => {
    expect(parseJudgeVerdict('{"verdict":"maybe"}').verdict).toBe('unknown');
  });
});

describe('buildJudgePrompt', () => {
  it('tells the judge that style differences are expected', () => {
    const prompt = buildJudgePrompt(ORIGINAL, GOOD_REWRITE);
    expect(prompt).toContain('EXPECTED');
    expect(prompt).toContain(ORIGINAL);
    expect(prompt).toContain(GOOD_REWRITE);
  });
});

describe('assembleFidelity', () => {
  const passing = checkConstraints(ORIGINAL, GOOD_REWRITE);

  it('passes when every layer is satisfied', () => {
    const report = assembleFidelity({
      constraints: passing,
      topicalSimilarity: 0.4,
      minTopicalSimilarity: 0.1,
      judge: { verdict: 'same', reason: '' },
    });
    expect(report.passed).toBe(true);
  });

  it('fails when the judge reports drift, even with constraints satisfied', () => {
    // The judge is the only layer that can catch a fluent reversal, because
    // reversal keeps the vocabulary and so survives every lexical check.
    const report = assembleFidelity({
      constraints: passing,
      topicalSimilarity: 0.45,
      minTopicalSimilarity: 0.1,
      judge: { verdict: 'drifted', reason: 'the claim was negated' },
    });
    expect(report.passed).toBe(false);
    expect(report.reasons[0]).toContain('the claim was negated');
  });

  it('does not fail on an unknown judge verdict', () => {
    const report = assembleFidelity({
      constraints: passing,
      topicalSimilarity: 0.4,
      minTopicalSimilarity: 0.1,
      judge: { verdict: 'unknown', reason: 'unparseable' },
    });
    expect(report.passed).toBe(true);
  });

  it('does not fail when no judge ran at all', () => {
    const report = assembleFidelity({
      constraints: passing,
      topicalSimilarity: 0.4,
      minTopicalSimilarity: 0.1,
      judge: null,
    });
    expect(report.passed).toBe(true);
    expect(report.judge).toBeNull();
  });

  it('fails when the rewrite is about a different subject', () => {
    const report = assembleFidelity({
      constraints: passing,
      topicalSimilarity: 0.02,
      minTopicalSimilarity: 0.1,
      judge: null,
    });
    expect(report.passed).toBe(false);
    expect(report.reasons[0]).toContain('about something else');
  });

  it('does not gate on the screen when it could not run', () => {
    const report = assembleFidelity({
      constraints: passing,
      topicalSimilarity: null,
      minTopicalSimilarity: 0.1,
      judge: null,
    });
    expect(report.passed).toBe(true);
  });
});
