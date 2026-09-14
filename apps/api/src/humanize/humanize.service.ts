import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { CONFIG, type AppConfig } from '../config/configuration.js';
import { DetectorService } from '../detectors/detector.service.js';
import type { DetectorReading } from '../detectors/detector.types.js';
import { LlmService } from '../llm/llm.service.js';
import { summariseUsage, type Usage } from '../llm/pricing.js';
import { ScorerService } from '../scorer/scorer.service.js';
import type { ScoreResult } from '../scorer/scorer.types.js';
import type {
  HumanizeResponse,
  IterationTrace,
  SpanRephraseResponse,
  Verification,
} from './dto/humanize.dto.js';
import { isQueued } from '../llm/batch-context.js';
import { chunkText, joinChunks, selectChunks } from './pipeline/chunk.js';
import { applyDeterministic, type StyleId } from './pipeline/deterministic.js';
import {
  assembleFidelity,
  buildJudgePrompt,
  checkConstraints,
  JUDGE_SYSTEM,
  parseJudgeVerdict,
  type FidelityReport,
  type JudgeResult,
} from './pipeline/fidelity.js';
import { mask, unmask } from './pipeline/mask.js';
import {
  buildSpanPrompt,
  buildUserPrompt,
  scopeGuidance,
  SPAN_SYSTEM,
  STYLES,
  type RetryGuidance,
} from './pipeline/prompts.js';
import { normalise, wordCount } from './pipeline/text.js';

/**
 * Readability checks the rewriter can actually influence. Text length and
 * subheading structure are the author's decisions, so counting them would
 * penalise every rewrite for something it must not change.
 */
const REWRITER_CONTROLLED = new Set([
  'flesch',
  'long_sentences',
  'paragraphs',
  'transitions',
  'passive',
  'consecutive_starts',
]);

function readabilityFailures(score: ScoreResult): number {
  return score.readability.checks.filter(
    (check) => check.status !== 'good' && REWRITER_CONTROLLED.has(check.id),
  ).length;
}

interface Candidate {
  text: string;
  /** Local analysis: heat map and feature metrics for the UI. Always present. */
  score: ScoreResult;
  /**
   * The detection reading. Equals the local score when the primary detector is
   * local, and the external detector's number otherwise.
   */
  decisionScore: number;
  /**
   * What the loop actually minimises: detection score plus a penalty per
   * failing readability check. Reported separately from decisionScore so the
   * UI can still show the real detection number.
   */
  objective: number;
  fidelity: FidelityReport;
  rules: string[];
  /** Chunks the provider refused or errored on, left as written. */
  skipped: string[];
}

@Injectable()
export class HumanizeService {
  private readonly logger = new Logger(HumanizeService.name);

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly llm: LlmService,
    private readonly scorer: ScorerService,
    private readonly detectors: DetectorService,
  ) {}

  /**
   * The humanize loop.
   *
   * Rewrite, score, keep the best candidate that still says the same thing,
   * and stop as soon as the target is met. The important property is that
   * winning is not the same as scoring well: a candidate that fails the
   * fidelity check is discarded no matter how good its number is. Without
   * that rule the loop learns that the cheapest way to beat a detector is to
   * stop saying what the source said.
   *
   * Passes are CUMULATIVE. Pass one rewrites every chunk of the input; each
   * later pass re-chunks whatever was last accepted and rewrites only its
   * worst-scoring chunks. The old behaviour, where every pass started again
   * from the untouched input, threw away the previous pass's gains and then
   * had to win the whole document back on one attempt, which is why later
   * passes were so often rejected outright.
   *
   * Fidelity is still checked against the ORIGINAL on every pass, never
   * against the previous pass. Paraphrasing a paraphrase drifts, and the
   * comparison that catches drift is the one against the text the user gave.
   */
  async humanize(
    input: string,
    style: StyleId = 'standard',
    deterministicOnly = false,
    /**
     * Skip the word cap. The cap is an abuse guard on anonymous USER input,
     * and applying it to text this application just generated is a category
     * error: a 2,500-word article the generator was asked for was rejected by
     * the rewriter for being 2,500 words.
     */
    internal = false,
    /**
     * Called as each chunk and pass completes.
     *
     * This loop is the longest phase in the whole pipeline: four passes over
     * eight chunks plus a judge call each is roughly forty model calls and
     * several minutes. Without a way to report from inside it, the progress
     * bar froze at whatever it last showed and the run looked hung when it
     * was working normally.
     */
    onStep?: (label: string) => void,
    /**
     * Spend controls for a run with a budget.
     *
     * `stopWhenSpent` is checked BETWEEN passes rather than mid-pass, because
     * a half-rewritten article is worse than an un-rewritten one: some chunks
     * would carry the new style and some the old, which reads worse than
     * either and scores worse than both.
     */
    limits?: {
      maxPasses?: number;
      stopWhenSpent?: number;
      /**
       * Send each pass's chunk rewrites through the Batch API instead of
       * calling them one at a time. Half the token price, at the cost of
       * latency nobody controls, so it defaults to the configured value and
       * an interactive request should leave it off.
       */
      batch?: boolean;
    },
  ): Promise<HumanizeResponse> {
    const started = Date.now();
    const warnings: string[] = [];
    // One array per request. The service is a singleton, so anything stored
    // on it would pool concurrent requests into a meaningless total.
    const usage: Usage[] = [];
    const original = normalise(input);

    const totalWords = wordCount(original);
    if (!internal && totalWords > this.config.maxWords) {
      throw new BadRequestException(
        `Text is ${totalWords} words. The anonymous limit is ${this.config.maxWords}.`,
      );
    }

    const before = await this.scorer.score(original);

    // The local scorer always runs: it supplies the heat map and the feature
    // breakdown. The primary detector supplies the number the loop optimises,
    // and the two are the same object only when primary is local.
    const primaryName = this.detectors.primaryName;
    const beforeDecision =
      primaryName === 'local'
        ? before.ai_score
        : (await this.detectors.detectPrimary(original)).score;

    if (primaryName === 'local' && this.detectors.verifyNames.length > 0) {
      warnings.push(
        'The loop is optimising the local scorer while ' +
          `${this.detectors.verifyNames.join(' and ')} only check the result. ` +
          'Set DETECTOR_PRIMARY to the detector you are judged by, or the ' +
          'score you improve will not be the score you are measured on.',
      );
    }
    if (!before.calibrated) {
      warnings.push(
        'The detector is running on prior weights, not weights fitted to a ' +
          'labelled corpus. Treat the percentage as a relative signal.',
      );
    }
    if (before.backend === 'heuristic') {
      warnings.push(
        'The scorer is on its heuristic backend, which approximates ' +
          'perplexity from word frequency. Set SCORER_BACKEND=transformer for real scoring.',
      );
    }
    if (!this.llm.isLive && !deterministicOnly) {
      warnings.push(
        'No LLM provider is configured, so only the deterministic pass ran. ' +
          'Set LLM_PROVIDER and its credentials to enable rewriting.',
      );
    }

    const iterations: IterationTrace[] = [];

    // The untouched input is the fallback candidate. If every rewrite fails
    // fidelity, returning the original is the correct outcome.
    let best: Candidate = {
      text: original,
      score: before,
      decisionScore: beforeDecision,
      objective:
        beforeDecision +
        readabilityFailures(before) * this.config.loop.readabilityWeight,
      // The untouched original trivially satisfies every layer, so it is
      // assembled directly rather than paying for a judge call to confirm it.
      fidelity: assembleFidelity({
        constraints: checkConstraints(original, original),
        topicalSimilarity: 1,
        minTopicalSimilarity: this.config.loop.minTopicalSimilarity,
        judge: { verdict: 'same', reason: 'unchanged' },
      }),
      rules: [],
      skipped: [],
    };

    const useLlm = this.llm.isLive && !deterministicOnly;
    const maxPasses = useLlm
      ? Math.max(1, Math.min(this.config.loop.maxIterations, limits?.maxPasses ?? Infinity))
      : 1;
    // Feedback carried into the next pass: what the detector disliked, and
    // which readability checks failed. Both are needed. Optimising detection
    // alone let passive voice and transition density drift badly out of range
    // on real copy, because nothing in the loop was watching them.
    let guidance: RetryGuidance = { weakSentences: [], readability: [] };

    // What the next pass rewrites. Starts as the input and advances to each
    // accepted candidate, so a rejected pass simply retries the same base
    // with different guidance and a higher temperature.
    let source = original;
    let sourceScore = before;
    let spentBefore = 0;
    const batch = (limits?.batch ?? this.config.loop.useBatch) && this.llm.canBatch;
    if ((limits?.batch ?? this.config.loop.useBatch) && !this.llm.canBatch) {
      warnings.push(
        `Batch pricing was requested but ${this.llm.name} has no batch ` +
          'endpoint, so every rewrite ran at the normal rate.',
      );
    }

    for (let pass = 1; pass <= maxPasses; pass += 1) {
      const chunks = chunkText(source, this.config.loop.chunkWords);
      // Pass one always rewrites everything: it sets the style, and there is
      // nothing yet to be selective about. Later passes spend only on the
      // chunks the scorer rates worst.
      const targets =
        pass === 1
          ? chunks.map((chunk) => chunk.index)
          : selectChunks(chunks, sourceScore.sentences, this.config.loop.targetShare);

      let candidate: Candidate;
      try {
        candidate = await this.runPass(
          original,
          chunks,
          targets,
          style,
          pass,
          guidance,
          useLlm,
          batch,
          usage,
          onStep && ((label) => onStep(`Pass ${pass}: ${label}`)),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`pass ${pass} failed: ${message}`);
        warnings.push(`Rewrite pass ${pass} failed: ${message}`);
        iterations.push({
          pass,
          score: best.score.ai_score,
          fidelity: 0,
          accepted: false,
          note: message,
        });
        break;
      }

      const improved = candidate.objective < best.objective;
      const accepted = candidate.fidelity.passed && improved;

      iterations.push({
        pass,
        score: candidate.decisionScore,
        fidelity: candidate.fidelity.topicalSimilarity ?? 0,
        accepted,
        note: accepted
          ? `accepted, ${best.decisionScore} to ${candidate.decisionScore} AI, ` +
            `${readabilityFailures(best.score)} to ${readabilityFailures(candidate.score)} SEO issues`
          : candidate.fidelity.passed
            ? 'rejected, did not improve the score'
            : `rejected, ${candidate.fidelity.reasons[0]}`,
      });

      this.logger.log(
        `pass ${pass} [${primaryName}]: ${targets.length}/${chunks.length} chunks, ` +
          `ai ${candidate.decisionScore}, ` +
          `seo-fails ${readabilityFailures(candidate.score)}, obj ${candidate.objective.toFixed(1)}, ` +
          `fidelity ${candidate.fidelity.passed ? 'ok' : 'FAILED'}, ` +
          `${accepted ? 'ACCEPTED' : 'rejected'} (${iterations[iterations.length - 1].note})`,
      );

      if (candidate.skipped.length > 0) {
        warnings.push(
          `Pass ${pass}: ${candidate.skipped.length} passage(s) were left as ` +
            `written because the model would not rewrite them. ${candidate.skipped[0]}`,
        );
      }

      if (accepted) {
        best = candidate;
        // The next pass refines this text rather than starting over.
        source = candidate.text;
        sourceScore = candidate.score;
      }

      // Stop on the composite, not on detection alone. Stopping on detection
      // meant a first pass that hit target ended the run with readability
      // still failing, and the feedback prepared for pass two never ran.
      if (best.objective <= this.config.loop.targetScore) break;

      // Budget check, between passes. Stopping here leaves a coherent article
      // at whatever quality the spend bought.
      if (limits?.stopWhenSpent !== undefined) {
        const spent = summariseUsage(usage).costUsd;
        // Estimated from the pass that just ran, not from the average. Pass
        // one rewrites every chunk and later passes rewrite a third, so an
        // average over both predicts neither.
        const nextPassEstimate = spent - spentBefore;
        spentBefore = spent;
        if (spent + nextPassEstimate > limits.stopWhenSpent) {
          warnings.push(
            `Stopped after ${pass} pass(es) at $${spent.toFixed(3)}: another pass ` +
              `would have exceeded the budget. Score is ${best.decisionScore}.`,
          );
          break;
        }
      }

      // Feed the LAST ATTEMPT's problems into the next pass, not the
      // incumbent's. When nothing is accepted the incumbent never changes, so
      // using it sent byte-identical feedback on every later pass and the
      // model simply retried the same rewrite.
      guidance = {
        weakSentences: [...candidate.score.sentences]
          .filter((sentence) => sentence.scored)
          .sort((a, b) => b.ai_score - a.ai_score)
          .slice(0, 6)
          .map((sentence) => sentence.text),
        readability: candidate.score.readability.checks
          .filter((check) => check.status !== 'good')
          // Length and subheading structure are the author's decisions, not
          // the rewriter's, so asking a paraphrase to fix them is noise.
          .filter((check) => !['word_count', 'subheadings'].includes(check.id))
          .map((check) => ({
            label: check.label,
            detail: check.detail,
            offenders: check.offenders ?? [],
          })),
      };
    }

    const nothingAccepted =
      iterations.length > 0 && iterations.every((entry) => !entry.accepted);

    if (nothingAccepted) {
      // The output equals the input. Saying only "stopped at 76.9" leaves the
      // user looking at an unchanged document with no idea why.
      const reasons = [...new Set(iterations.map((entry) => entry.note))];
      warnings.push(
        `Your text was returned unchanged. ${iterations.length} rewrite ` +
          `attempt(s) ran and none was kept: ${reasons.join('; ')}.`,
      );
      if (iterations.every((entry) => entry.note.includes('did not improve'))) {
        warnings.push(
          'Every rewrite scored at or above the original. That usually means ' +
            'the text is already varied enough that this detector cannot ' +
            'separate it further, or the passage is a genre that scores high ' +
            'regardless of who wrote it.',
        );
      }
    } else if (best.objective > this.config.loop.targetScore) {
      const fails = readabilityFailures(best.score);
      if (fails > 0) {
        warnings.push(
          `${fails} readability check(s) still fail. See the SEO tab. Some copy ` +
            'cannot satisfy every check without changing what it says, which the ' +
            'fidelity guard will not allow.',
        );
      }
      warnings.push(
        `Stopped at ${best.decisionScore} without reaching the target of ` +
          `${this.config.loop.targetScore}. More passes rarely help beyond this point.`,
      );
    }

    // Second opinions, run once on the input and once on the final output.
    // Both are needed: a single reading on the output tells you nothing about
    // whether the rewrite helped.
    let verification: Verification | null = null;
    if (this.detectors.verifyNames.length > 0) {
      const changed = best.text !== original;
      const [beforeReadings, afterReadings] = await Promise.all([
        this.detectors.verify(original),
        changed ? this.detectors.verify(best.text) : Promise.resolve(null),
      ]);
      verification = {
        primary: primaryName,
        before: beforeReadings,
        // Nothing changed, so the output reading is the input reading. Paying
        // a second time for an identical string would be pure waste.
        after: afterReadings ?? beforeReadings,
        estimatedCost: this.detectors.estimateCost(iterations.length),
      };

      for (const reading of verification.after) {
        if (reading.score !== null && reading.score > 50) {
          warnings.push(
            `${reading.detector} still reads the output at ${reading.score}% AI. ` +
              (primaryName === reading.detector
                ? 'The loop could not get it lower.'
                : `The loop optimised ${primaryName}, not this one.`),
          );
        }
      }
    }

    return {
      original,
      humanized: best.text,
      before,
      after: best.score,
      fidelity: best.fidelity,
      iterations,
      style,
      provider: this.llm.name,
      model: this.llm.model,
      llmActive: useLlm,
      deterministicRules: best.rules,
      elapsedMs: Date.now() - started,
      warnings,
      verification,
      usage: summariseUsage(usage),
    };
  }


  /**
   * Rewrite one sentence where it sits, and rescore the document.
   *
   * Backs the heat map's per-sentence button. What it is for: a sentence the
   * user reads badly and wants changed, on an article they are otherwise
   * happy with.
   *
   * What it is NOT for, and the UI says so: pushing the document score down.
   * Measured on a 2,000-word article, 3 of 140 sentences scored above 60
   * while the document estimated at 44 on ZeroGPT's scale. The score is
   * spread across the whole text, so replacing the reddest sentence moves it
   * by a fraction of a point and promotes a new sentence into first place.
   * The loop is what moves the document number.
   *
   * Constraints are checked on the SENTENCE, not the document. A numeric
   * change inside one sentence disappears into a 2,000-word diff, so checking
   * the document here would let exactly the error this guard exists for slip
   * through.
   */
  async rephraseSpan(
    text: string,
    start: number,
    end: number,
    style: StyleId = 'standard',
  ): Promise<SpanRephraseResponse> {
    const document = normalise(text);

    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      end > document.length ||
      end - start < 10
    ) {
      throw new BadRequestException(
        'The selected span is outside the text or too short to rewrite.',
      );
    }

    const sentence = document.slice(start, end);
    if (!this.llm.isLive) {
      throw new BadRequestException(
        'No LLM provider is configured, so a single sentence cannot be rewritten.',
      );
    }

    // The paragraph the sentence sits in, as read-only context. Paragraph
    // rather than a fixed character window: a window cuts mid-sentence and
    // the model then tries to complete the fragment it was shown.
    const before = document.lastIndexOf('\n\n', start);
    const after = document.indexOf('\n\n', end);
    const paraStart = before === -1 ? 0 : before + 2;
    const paraEnd = after === -1 ? document.length : after;
    const paragraph = document.slice(paraStart, paraEnd);

    // Mask the whole paragraph so protected spans keep one numbering across
    // the context and the target. Masking only the sentence would leave a
    // bare URL in the context and a token in the target.
    const { masked, tokens } = mask(paragraph);
    // Offsets move when masking rewrites spans, so the target is relocated by
    // its masked text rather than reused from the original coordinates.
    const maskedSentence = mask(sentence).masked;
    const localStart = masked.indexOf(maskedSentence);
    if (localStart === -1) {
      throw new BadRequestException(
        'Could not locate that sentence after protecting its links and numbers.',
      );
    }

    const usage: Usage[] = [];
    const reply = await this.llm.complete(
      {
        cacheSystem: true,
        system: SPAN_SYSTEM,
        user: buildSpanPrompt(masked, localStart, localStart + maskedSentence.length),
        temperature: STYLES[style].temperature,
        maxTokens: Math.ceil(wordCount(sentence) * 3) + 200,
      },
      usage,
    );

    const replacement = unmask(
      this.stripPreamble(reply).replace(/^«+|»+$/g, '').trim(),
      tokens,
    );

    const constraints = checkConstraints(sentence, replacement);
    const rewritten =
      document.slice(0, start) + replacement + document.slice(end);

    // Rescored either way. When the guard rejects the rewrite the caller gets
    // the unchanged document and its unchanged score, so the UI never shows a
    // score that belongs to text it is not displaying.
    const applied = constraints.passed && replacement.length > 0;
    const score = await this.scorer.score(applied ? rewritten : document);

    return {
      applied,
      sentence,
      replacement,
      text: applied ? rewritten : document,
      score,
      reason: applied ? null : (constraints.reasons[0] ?? 'The rewrite was empty.'),
      usage: summariseUsage(usage),
    };
  }

  /**
   * One pass over the targeted chunks: mask, rewrite, restore, then the
   * deterministic surface edits. Scored once at the end on the whole document,
   * because burstiness and paragraph variance are document-level features and
   * scoring per chunk would measure something else.
   *
   * `original` is the user's input and is only used for the fidelity check.
   * The chunks come from whatever the loop last accepted. Untargeted chunks
   * are carried through verbatim, so every chunk in the output has been
   * through at least the first pass and the document never mixes rewritten
   * and untouched prose.
   */
  private async runPass(
    original: string,
    chunks: ReturnType<typeof chunkText>,
    targets: number[],
    style: StyleId,
    pass: number,
    guidance: RetryGuidance,
    useLlm: boolean,
    batch: boolean,
    usage: Usage[],
    onStep?: (label: string) => void,
  ): Promise<Candidate> {
    const profile = STYLES[style];
    const targeted = new Set(targets);
    const failures: string[] = [];

    // Build every rewrite request before sending any of them.
    //
    // The chunk rewrites of one pass are independent: each one sees only its
    // own sixty words, and none of them reads another's output. That is
    // precisely the shape the Batch API wants, and it is the only phase of
    // this pipeline that has it. Section drafting cannot batch because each
    // section is handed the tail of the one before, and the judge cannot
    // batch because it has nothing to read until the rewrite exists.
    const jobs = chunks
      .filter((chunk) => targeted.has(chunk.index))
      .map((chunk) => {
        const { masked, tokens } = mask(chunk.text);
        return {
          chunk,
          masked,
          tokens,
          request: {
            // The style prompt is identical for every chunk in every pass, and
            // at small chunk sizes it dwarfs the text it is rewriting: measured
            // at 1,414 input tokens per call to rewrite about 80 tokens of
            // content, so 94% of the input was the same instructions re-sent.
            //
            // It must also stay above 1,024 tokens or the API accepts the
            // cache instruction and silently ignores it. See
            // REWRITE_SYSTEM_TOKENS in the cost model.
            cacheSystem: true,
            // Thinking stays ON here, which is not the obvious choice.
            //
            // It looks like pure overhead: forty calls per pass each paying a
            // thinking tax to paraphrase eighty tokens. It was measured on the
            // same brief and disabling it saved 4% of the bill while the
            // estimated ZeroGPT score went from 31 to 45. Paraphrase turns out
            // not to be as mechanical as it looks, and this is the one place
            // where thinking earns its cost.
            system: profile.system,
            // Scoped to this chunk. See scopeGuidance: document-wide
            // guidance handed to a sixty-word chunk gets written into it.
            user: buildUserPrompt(masked, scopeGuidance(guidance, chunk.text)),
            // Nudge the temperature up on later passes. Repeating a pass at the
            // same setting mostly reproduces the same output.
            temperature: Math.min(1.15, profile.temperature + (pass - 1) * 0.1),
            maxTokens: Math.ceil(chunk.words * 2.2) + 200,
          },
        };
      });

    // index -> rewritten text. Only the targeted chunks appear.
    const produced = new Map<number, string>();

    // Inside a bulk job the shared queue is already pooling calls across
    // articles, and a batch of its own here would compete with it. The
    // requests are fired together instead, so all forty enter the queue at
    // once rather than one per round trip.
    const pooled = useLlm && isQueued();

    if (pooled) {
      onStep?.(`queueing ${jobs.length} parts`);
      const settled = await Promise.allSettled(
        jobs.map((job) => this.llm.complete(job.request, usage)),
      );
      settled.forEach((outcome, index) => {
        const job = jobs[index];
        if (outcome.status === 'fulfilled') {
          produced.set(job.chunk.index, this.stripPreamble(outcome.value));
        } else {
          failures.push(
            outcome.reason instanceof Error
              ? outcome.reason.message
              : String(outcome.reason),
          );
        }
      });
    } else if (useLlm && batch && jobs.length > 1 && this.llm.canBatch) {
      onStep?.(`rewriting ${jobs.length} parts in one batch`);
      const outcomes = await this.llm.runBatch(
        jobs.map((job) => ({ id: `c${job.chunk.index}`, request: job.request })),
        usage,
        {
          maxWaitMs: this.config.loop.batchMaxWaitMs,
          onProgress: (progress) =>
            onStep?.(
              `batch: ${progress.succeeded + progress.errored} of ${jobs.length} done`,
            ),
        },
      );

      // Matched by id, never by position. The API returns results in
      // arbitrary order, so reading them positionally would paste one
      // paragraph's rewrite over another's.
      outcomes.forEach((outcome, index) => {
        const job = jobs[index];
        if (outcome.result) {
          produced.set(job.chunk.index, this.stripPreamble(outcome.result.text));
        } else {
          failures.push(outcome.error ?? 'Batch request failed.');
        }
      });
    } else {
      let done = 0;
      for (const job of jobs) {
        done += 1;
        onStep?.(`rewriting part ${done} of ${jobs.length}`);
        if (!useLlm) continue;
        try {
          const text = await this.llm.complete(job.request, usage);
          produced.set(job.chunk.index, this.stripPreamble(text));
        } catch (error) {
          // One chunk failing must not cost the whole pass.
          //
          // This was found the hard way: an article carrying an author bio
          // drew a refusal on the one chunk containing it, the exception
          // unwound the entire pass, and a 2,000-word article came back with
          // no rewriting at all after paying for thirteen calls. Refusals are
          // per-passage and unrelated to the other thirty-nine chunks.
          //
          // The failed chunk is carried through as written, which is the same
          // outcome the user would have had for that passage anyway.
          failures.push(error instanceof Error ? error.message : String(error));
        }
      }
    }

    // Reassemble in document order. A chunk with no rewrite, because it was
    // not targeted or because its request failed, contributes its own text.
    const byIndex = new Map(jobs.map((job) => [job.chunk.index, job]));
    const rewritten = chunks.map((chunk) => {
      const text = produced.get(chunk.index);
      if (text === undefined) return chunk.text;
      return unmask(text, byIndex.get(chunk.index)!.tokens);
    });

    // Every single chunk failed, so this is not one awkward passage: the
    // provider is down, the key is wrong, or the whole document trips a
    // filter. That is worth surfacing as a failed pass rather than silently
    // returning the input and calling it a rewrite.
    if (failures.length > 0 && failures.length === targets.length) {
      throw new Error(failures[0]);
    }
    if (failures.length > 0) {
      this.logger.warn(
        `pass ${pass}: ${failures.length} of ${targets.length} chunks kept as ` +
          `written after a provider error. First: ${failures[0]}`,
      );
    }

    const assembled = joinChunks(rewritten);

    // Sentence breaking is held back until the second pass. On pass one the
    // model has usually already varied the rhythm, and doing both at once
    // over-fragments the text.
    const surface = applyDeterministic(assembled, {
      style,
      breakLongSentences: pass >= 2 || !useLlm,
    });

    // Fidelity first. It is far cheaper than a paid detector call, and a
    // candidate that changed the meaning is discarded regardless of its
    // score, so scoring it externally would be money spent on a reject.
    onStep?.('checking the meaning held');
    const fidelity = await this.checkFidelity(original, surface.text, usage);
    const score = await this.scorer.score(surface.text);

    const primaryName = this.detectors.primaryName;
    let decisionScore = score.ai_score;
    if (primaryName !== 'local' && fidelity.passed) {
      decisionScore = (await this.detectors.detectPrimary(surface.text)).score;
    } else if (primaryName !== 'local') {
      // Never accepted anyway, so it does not need a real reading. Using the
      // local score keeps the trace readable without paying for it.
      decisionScore = score.ai_score;
    }

    return {
      text: surface.text,
      score,
      decisionScore,
      objective:
        decisionScore +
        readabilityFailures(score) * this.config.loop.readabilityWeight,
      fidelity,
      rules: surface.applied,
      skipped: failures,
    };
  }

  /**
   * Run the three fidelity layers, cheapest first.
   *
   * The hard constraints are free and deterministic, so they always run and
   * they short-circuit: there is no point paying a model to judge a rewrite
   * that already mangled a number. The topical screen is one cheap local
   * call. The judge costs real money, so it runs last and only on candidates
   * that survived the first two.
   */
  private async checkFidelity(
    original: string,
    rewritten: string,
    usage?: Usage[],
  ): Promise<FidelityReport> {
    const constraints = checkConstraints(original, rewritten);
    const minTopicalSimilarity = this.config.loop.minTopicalSimilarity;

    if (!constraints.passed) {
      return assembleFidelity({
        constraints,
        topicalSimilarity: null,
        minTopicalSimilarity,
        judge: null,
      });
    }

    const similarity = await this.scorer.similarity(original, rewritten);
    const topicalSimilarity = similarity?.cosine ?? null;

    if (topicalSimilarity !== null && topicalSimilarity < minTopicalSimilarity) {
      return assembleFidelity({
        constraints,
        topicalSimilarity,
        minTopicalSimilarity,
        judge: null,
      });
    }

    let judge: JudgeResult | null = null;
    if (this.config.loop.useJudge && this.llm.isLive) {
      const reply = await this.llm.judge(
        JUDGE_SYSTEM,
        buildJudgePrompt(original, rewritten),
        usage,
      );
      if (reply !== null) judge = parseJudgeVerdict(reply);
    }

    return assembleFidelity({
      constraints,
      topicalSimilarity,
      minTopicalSimilarity,
      judge,
    });
  }

  /**
   * Models ignore "return only the passage" often enough to need this.
   * Strips a leading "Here is the rewritten..." line and any wrapping fence.
   */
  private stripPreamble(text: string): string {
    let cleaned = text.trim();

    const fence = /^```[a-z]*\n([\s\S]*?)\n```$/.exec(cleaned);
    if (fence) cleaned = fence[1].trim();

    const preamble =
      /^(here(?:'s| is)|sure|certainly|of course)[^\n]{0,120}:\s*\n+/i;
    cleaned = cleaned.replace(preamble, '');

    // A wrapping pair of quotes the model added around the whole passage.
    if (/^"[\s\S]+"$/.test(cleaned) && !cleaned.slice(1, -1).includes('"')) {
      cleaned = cleaned.slice(1, -1);
    }

    return cleaned.trim();
  }
}
