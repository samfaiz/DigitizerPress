'use client';

import { useMemo } from 'react';
import type { ComplianceCheck, ScoreResult, UsageSummary } from '@/lib/types';

/**
 * What to change by hand, instead of paying for another rewrite pass.
 *
 * Every tip here is derived from measurements the app already took: the
 * readability checks, the per-sentence scores, the feature metrics, the
 * compliance results. Nothing on this panel costs a model call, which is the
 * entire point of it.
 *
 * The economics are the argument. A rewrite pass over a 2,000-word article
 * costs roughly a third of what drafting cost, it regenerates the whole
 * article, and on measured runs the second, third and fourth passes were
 * accepted three times out of fifteen for gains under one point. Editing four
 * sentences by hand is free and lands every time.
 *
 * Two rules kept this panel honest:
 *
 *  - A tip names the actual sentence to change. "Vary your sentence length"
 *    is advice; "this 41-word sentence is the longest in the article" is a
 *    task, and only the second one gets done.
 *  - A tip says what it is worth. Some of these move the detection score and
 *    some only move an SEO check, and blurring that leads people to spend an
 *    hour on something that changes nothing they care about.
 */

export interface Tip {
  id: string;
  /** What to do, as an instruction. */
  action: string;
  /** Why it matters, in one line. */
  why: string;
  /** The exact text to find, when there is one. */
  target?: string;
  impact: 'detection' | 'readability' | 'seo';
  /** Rough ordering weight. Higher shows first. */
  weight: number;
}

const IMPACT_LABEL: Record<Tip['impact'], string> = {
  detection: 'Lowers detection',
  readability: 'Readability',
  seo: 'SEO',
};

const IMPACT_TONE: Record<Tip['impact'], string> = {
  detection: 'border-primary/50 text-primary',
  readability: 'border-emerald-500/50 text-emerald-500',
  seo: 'border-sky-500/50 text-sky-500',
};

const words = (text: string): number => (text.match(/[A-Za-z'’-]+/g) ?? []).length;

function truncate(text: string, limit = 120): string {
  return text.length <= limit ? text : `${text.slice(0, limit).trimEnd()}…`;
}

export function buildTips(
  score: ScoreResult,
  compliance: ComplianceCheck[],
): Tip[] {
  const tips: Tip[] = [];
  const scored = score.sentences.filter((sentence) => sentence.scored);

  // --- Rhythm. The single strongest lever the reader controls.
  //
  // Sentence-length variation is what the detector reads as burstiness, and
  // unlike vocabulary it is something a person can fix in a minute without
  // knowing anything about how the scoring works.
  const lengths = scored.map((sentence) => sentence.words);
  if (lengths.length > 4) {
    const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
    const sd = Math.sqrt(
      lengths.reduce((total, n) => total + (n - mean) ** 2, 0) / lengths.length,
    );
    const cv = sd / Math.max(1, mean);
    if (cv < 0.55) {
      tips.push({
        id: 'rhythm',
        action:
          'Break two or three of the longest sentences in half, and let one ' +
          'of the halves stand alone as a very short sentence.',
        why:
          `Sentence lengths here vary by ${(cv * 100).toFixed(0)}% around a mean of ` +
          `${mean.toFixed(0)} words. Even rhythm is the clearest signal of machine ` +
          'writing, and it is the one you can change fastest.',
        impact: 'detection',
        weight: 100,
      });
    }
  }

  // The longest sentence, named. Generic advice about long sentences gets
  // nodded at; a specific 41-word sentence gets edited.
  const longest = [...scored].sort((a, b) => b.words - a.words)[0];
  if (longest && longest.words >= 28) {
    tips.push({
      id: 'longest',
      action: `Split this ${longest.words}-word sentence into two.`,
      why: 'It is the longest in the article. Long sentences hurt the readability score and flatten the rhythm at the same time.',
      target: longest.text,
      impact: 'detection',
      weight: 95,
    });
  }

  // --- The sentences the scorer liked least.
  //
  // Capped at three deliberately. The heat map is a WITHIN-document ranking,
  // so there is always a worst sentence no matter how good the article is,
  // and listing ten of them turns a useful nudge into busywork.
  const worst = [...scored].sort((a, b) => b.ai_score - a.ai_score).slice(0, 3);
  for (const [index, sentence] of worst.entries()) {
    if (sentence.ai_score < 45) break;
    tips.push({
      id: `weak-${sentence.index}`,
      action:
        'Rewrite this sentence in your own words. Change how it opens and how ' +
        'long it is, not just which adjectives it uses.',
      why: `The scorer rates it the ${index === 0 ? 'most' : 'next most'} machine-like line in the article.`,
      target: sentence.text,
      impact: 'detection',
      weight: 90 - index,
    });
  }

  // --- Tell words. Free to fix, and the fix is a find-and-replace.
  //
  // The metric is ALREADY per thousand words, not a fraction. Treating it as
  // a fraction and multiplying showed "257576 per thousand words" on screen,
  // which is the kind of number that makes a reader stop trusting the panel.
  // Threshold is 1 because the pipeline's own output measures 0 across every
  // article checked, so any occurrence at all is worth naming.
  if (score.metrics.tell_word_rate >= 1) {
    tips.push({
      id: 'tells',
      action:
        'Search the article for: delve, tapestry, realm, myriad, pivotal, ' +
        'robust, seamless, holistic, comprehensive, underscore, leverage, ' +
        'landscape, navigate, foster, testament. Replace each with the plainest ' +
        'word that fits.',
      why:
        `These appear at ${score.metrics.tell_word_rate.toFixed(1)} per thousand ` +
        'words here. They are the vocabulary detectors were trained on, ' +
        'and no rewrite pass removes them as reliably as a find-and-replace.',
      impact: 'detection',
      weight: 85,
    });
  }

  // --- Openings. Cheap to fix and visible to a human reader too.
  const openers = new Map<string, number>();
  for (const sentence of scored) {
    const first = sentence.text.trim().split(/\s+/)[0]?.toLowerCase().replace(/[^a-z]/g, '');
    if (!first) continue;
    openers.set(first, (openers.get(first) ?? 0) + 1);
  }
  const repeated = [...openers.entries()]
    .filter(([word, count]) => count >= 4 && word.length > 2)
    .sort((a, b) => b[1] - a[1])[0];
  if (repeated) {
    tips.push({
      id: 'openers',
      action: `Change how some sentences start. "${repeated[0]}" opens ${repeated[1]} of them.`,
      why: 'Repeated openings read as templated to a person and as low variance to a detector.',
      impact: 'detection',
      weight: 80,
    });
  }

  // --- Readability checks, with their own offending sentences attached.
  for (const check of score.readability.checks) {
    if (check.status === 'good' || check.id === 'word_count') continue;
    const offender = check.offenders?.[0];
    tips.push({
      id: `read-${check.id}`,
      action: `${check.label}: ${check.detail}`,
      why: 'A Yoast-style readability check. It does not move the detection score on its own, but it pulls in the same direction.',
      target: offender,
      impact: 'readability',
      weight: check.status === 'bad' ? 60 : 50,
    });
  }

  // --- Compliance. These are brief-following misses, not writing problems.
  for (const check of compliance) {
    if (check.status === 'good') continue;
    tips.push({
      id: `comp-${check.id}`,
      action: `${check.label}: ${check.detail}`,
      why: 'Your brief asked for this and the draft did not fully deliver it. Fixing it by hand is exact; asking the model again is not.',
      impact: 'seo',
      weight: check.status === 'bad' ? 70 : 40,
    });
  }

  return tips.sort((a, b) => b.weight - a.weight);
}

interface ImproveTipsProps {
  score: ScoreResult;
  compliance: ComplianceCheck[];
  /** What this article has already cost, for the saving estimate. */
  usage?: UsageSummary;
}

export function ImproveTips({ score, compliance, usage }: ImproveTipsProps) {
  const tips = useMemo(() => buildTips(score, compliance), [score, compliance]);

  // A pass regenerates the whole article and costs roughly a third of what
  // the run has spent so far. Quoted as "about" because it varies with how
  // many chunks the article splits into.
  const passCost = usage ? usage.costUsd / 3 : null;

  if (tips.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Nothing worth flagging. Every readability and compliance check passes and
        no sentence stands out as unusually machine-like.
      </p>
    );
  }

  const detection = tips.filter((tip) => tip.impact === 'detection');

  return (
    <div className="space-y-4">
      <div className="border border-border bg-muted/30 p-3">
        <p className="text-sm">
          {detection.length > 0
            ? `${detection.length} of these change the detection score. `
            : 'None of these change the detection score directly. '}
          Doing them by hand costs nothing.
          {passCost !== null && (
            <>
              {' '}
              Another rewrite pass costs about{' '}
              <span className="font-medium tabular-nums">
                ${passCost.toFixed(3)}
              </span>{' '}
              and is not guaranteed to help: across measured runs, passes after
              the first were kept three times out of fifteen.
            </>
          )}
        </p>
      </div>

      <ol className="space-y-3">
        {tips.map((tip, index) => (
          <li key={tip.id} className="border-l-2 border-border pl-3">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="text-xs tabular-nums text-muted-foreground">
                {index + 1}
              </span>
              <span
                className={`border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${IMPACT_TONE[tip.impact]}`}
              >
                {IMPACT_LABEL[tip.impact]}
              </span>
            </div>
            <p className="mt-1 text-sm">{tip.action}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{tip.why}</p>
            {tip.target && (
              <p className="mt-1.5 border-l border-border/60 pl-2 text-xs italic text-muted-foreground">
                “{truncate(tip.target)}”
                <span className="not-italic"> ({words(tip.target)} words)</span>
              </p>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
