'use client';

import type { ScoreResult } from '@/lib/types';

/**
 * What the pipeline did to this article, and why that is what detectors read.
 *
 * Written against this article's own measurements rather than as static copy.
 * A generic explainer is marketing; the same explanation carrying the numbers
 * from the document in front of you is something the reader can check.
 *
 * It also states the limits. Every figure on this panel comes from a local
 * scorer that is a PROXY for a commercial detector, calibrated on four
 * hand-measured points, and saying so is not a disclaimer but the single most
 * important thing on the page. A confident-looking panel that hides its own
 * error bars is how people end up trusting a number that was never verified.
 */

interface WhyItWorksProps {
  score: ScoreResult;
  /** Detection score before the rewrite, when there was one. */
  before?: number;
}

function Row({
  label,
  value,
  reading,
}: {
  label: string;
  value: string;
  reading: string;
}) {
  return (
    <div className="grid gap-1 border-b border-border/60 py-2 sm:grid-cols-[11rem_5rem_1fr] sm:gap-3">
      <dt className="text-sm font-medium">{label}</dt>
      <dd className="text-sm tabular-nums text-primary">{value}</dd>
      <dd className="text-xs text-muted-foreground">{reading}</dd>
    </div>
  );
}

export function WhyItWorks({ score, before }: WhyItWorksProps) {
  const m = score.metrics;
  const cv = m.sentence_length_cv;

  return (
    <div className="space-y-6 text-sm leading-6">
      <section className="space-y-2">
        <h3 className="text-base font-semibold">What a detector actually measures</h3>
        <p>
          An AI detector does not recognise writing. It runs the text through a
          language model and asks, at every word, how surprised the model is to
          see that word next. Machine writing is built by repeatedly choosing a
          likely next word, so it stays unsurprising almost everywhere. Human
          writing lurches: a clumsy phrase, an odd aside, a sentence that stops
          early.
        </p>
        <p>
          Two numbers come out of that. <strong>Perplexity</strong> is the
          average surprise. <strong>Burstiness</strong> is how much the surprise
          varies from sentence to sentence. Low and flat reads as machine
          written. The whole pipeline exists to raise the second one without
          changing what the article says.
        </p>
      </section>

      <section className="space-y-2">
        <h3 className="text-base font-semibold">This article, measured</h3>
        <dl>
          <Row
            label="Perplexity"
            value={m.perplexity.toFixed(1)}
            reading="Average surprise per word. Higher is more human-looking."
          />
          <Row
            label="Burstiness"
            value={m.burstiness.toFixed(2)}
            reading="Variation in surprise between sentences."
          />
          <Row
            label="Sentence length spread"
            value={`${(cv * 100).toFixed(0)}%`}
            reading={
              cv >= 0.55
                ? 'Wide. This is the feature that separated samples most cleanly in testing.'
                : 'Narrow. Sentences are too similar in length; this is the highest-value thing left to fix.'
            }
          />
          <Row
            label="Vocabulary range"
            value={m.type_token_ratio.toFixed(2)}
            reading="Distinct words over total words."
          />
          <Row
            label="Tell words"
            value={`${m.tell_word_rate.toFixed(1)}/k`}
            reading="Per thousand words. The pipeline's own output measures 0."
          />
          <Row
            label="Repeated phrasing"
            value={`${(m.repeated_trigram_rate * 100).toFixed(1)}%`}
            reading="Three-word runs that appear more than once."
          />
        </dl>
      </section>

      <section className="space-y-2">
        <h3 className="text-base font-semibold">What the pipeline did</h3>
        <ol className="list-decimal space-y-2 pl-5">
          <li>
            <strong>Drafted section by section</strong> rather than in one call.
            A single long generation drifts: later sections forget the brief and
            repeat earlier phrasing, which shows up directly in the repeated
            phrasing figure above.
          </li>
          <li>
            <strong>Froze the parts that must not change.</strong> Numbers,
            quotations, links, headings and citations are swapped for
            placeholders before any rewriting and restored afterwards. Without
            this, a rewrite rounds 47.3% to “roughly half” and a style edit
            becomes a fabrication.
          </li>
          <li>
            <strong>Rewrote in small chunks.</strong> Chunk size is the main
            quality dial and it runs backwards from intuition. Measured on one
            article: 50-word chunks scored about 7 on ZeroGPT, 330-word chunks
            about 22. Rewriting fifty words forces every sentence to be reworked;
            rewriting three hundred gets a light touch spread thin.
          </li>
          <li>
            <strong>Scored the whole document, not the chunks.</strong>{' '}
            Burstiness only exists across a full text. A section can be perfectly
            varied on its own while ten in a row share the same rhythm.
          </li>
          <li>
            <strong>Checked the meaning survived.</strong> Three layers: exact
            checks on numbers and placeholders, a topical overlap screen, then a
            second model asked whether the rewrite still asserts the same things.
            A rewrite that scores well but changed a claim is discarded. Without
            that rule the cheapest way to beat a detector is to stop saying what
            the source said.
          </li>
        </ol>
      </section>

      {before !== undefined && before > score.ai_score && (
        <section className="border border-primary/40 bg-primary/5 p-3">
          <p>
            On this article the rewrite moved the internal score from{' '}
            <span className="tabular-nums font-medium">{before.toFixed(1)}</span>{' '}
            to{' '}
            <span className="tabular-nums font-medium">
              {score.ai_score.toFixed(1)}
            </span>
            . That step is worth more than every other setting combined: the same
            pipeline measured 34 on ZeroGPT with the rewrite skipped and 7 with
            it.
          </p>
        </section>
      )}

      <section className="space-y-2 border-t border-border pt-4">
        <h3 className="text-base font-semibold">What this does not prove</h3>
        <p>
          Every number on this page comes from a scorer running locally, not
          from the platform you will be judged by. It is a proxy fitted to four
          hand-measured ZeroGPT readings, and its scale is compressed: a
          document it rates 6 has measured 34 on ZeroGPT.
        </p>
        <p>
          The estimated figure of{' '}
          <span className="tabular-nums font-medium">
            {score.estimated_external.toFixed(0)}
          </span>{' '}
          is that proxy projected onto{' '}
          {score.estimated_external_target || 'a commercial detector'}
          {"'"}s scale, and its confidence is{' '}
          {score.estimated_external_confidence || 'low'}. Treat it as a
          direction, not a verdict. Connect a real detector key to optimise the
          number you are actually measured on.
        </p>
      </section>
    </div>
  );
}
