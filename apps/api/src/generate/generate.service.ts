import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { CONFIG, type AppConfig } from '../config/configuration.js';
import { DetectorService } from '../detectors/detector.service.js';
import { HumanizeService } from '../humanize/humanize.service.js';
import { ProgressService } from './progress.service.js';
import { LlmService } from '../llm/llm.service.js';
import { summariseUsage, type Usage } from '../llm/pricing.js';
import { ScorerService } from '../scorer/scorer.service.js';
import type {
  BriefDto,
  VoiceProfileDto,
  DraftAttempt,
  DraftResponse,
  GateResult,
  KeywordResponse,
  KeywordSuggestion,
  OutlineDto,
  OutlineResponse,
  SeoPackage,
} from './dto/generate.dto.js';
import { checkCompliance } from './pipeline/compliance.js';
import { cleanUrl, linkProducts } from './pipeline/products.js';
import {
  buildExtractPrompt,
  EXTRACT_SYSTEM,
  fetchPageText,
  type ExtractedProduct,
} from './pipeline/fetch-product.js';
import { checkEeat, findCitationSuggestions } from './pipeline/eeat.js';
import { buildScorecard, type Scorecard } from './pipeline/scorecard.js';
import { estimateCost, planForBudget } from './pipeline/cost-model.js';
import { findFactFlags, unsupportedFacts } from './pipeline/facts.js';
import {
  buildOutlinePrompt,
  buildRevisePrompt,
  buildSeoPrompt,
  buildDraftSystem,
  buildIntroPrompt,
  buildKeywordsPrompt,
  buildVoicePrompt,
  buildSectionPrompt,
  KEYWORDS_SYSTEM,
  VOICE_SYSTEM,
  OUTLINE_SYSTEM,
  REVISE_SYSTEM,
  SEO_SYSTEM,
} from './pipeline/prompts.js';
import {
  assembleMarkdown,
  buildSchema,
  keywordUsage,
  toSlug,
  trimTo,
} from './pipeline/seo.js';

/**
 * How much detection the revision pass may give up to fix a compliance issue,
 * on the RAW local scale.
 *
 * This was 2, which reads like a small allowance and is not. The calibration
 * maps one raw point to roughly nine ZeroGPT points, so a tolerance of 2 let
 * the revision make the article about eighteen ZeroGPT points more detectable
 * in exchange for clearing a single warning. It did exactly that on a measured
 * run: the humanize loop took an article from 9.1 to 6.2, and the revision
 * handed back 6.2 to 8.1 to fix one readability check.
 *
 * At 0.5 the revision may still win ties and still fix real compliance
 * failures, but it can no longer undo the loop's work to do it.
 */
const DETECTION_TOLERANCE = 0.5;

@Injectable()
export class GenerateService {
  private readonly logger = new Logger(GenerateService.name);

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly llm: LlmService,
    private readonly humanize: HumanizeService,
    private readonly progress: ProgressService,
    private readonly scorer: ScorerService,
    private readonly detectors: DetectorService,
  ) {}

  /** Parse a JSON reply that may arrive wrapped in prose or a code fence. */
  private parseJson<T>(reply: string, what: string): T {
    const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(reply);
    const candidate = fence ? fence[1] : reply;
    const match = /\{[\s\S]*\}/.exec(candidate);
    if (!match) {
      throw new BadRequestException(`The model returned no JSON for the ${what}.`);
    }
    try {
      return JSON.parse(match[0]) as T;
    } catch {
      throw new BadRequestException(`The model returned malformed JSON for the ${what}.`);
    }
  }

  private requireLlm(): void {
    if (!this.llm.isLive) {
      throw new BadRequestException(
        'Generation needs a real model. Set LLM_PROVIDER and its API key.',
      );
    }
  }

  /**
   * Apply chosen fixes to an article the user already has.
   *
   * Separate from the generation loop on purpose. The loop decides for itself
   * what to fix and when to stop; this does what it is told, once, and hands
   * the result back for comparison. A suggestion the user cannot act on is
   * just a complaint.
   */
  async applyFixes(
    brief: BriefDto,
    outline: OutlineDto,
    markdown: string,
    instructions: string[],
  ): Promise<{
    markdown: string;
    score: Awaited<ReturnType<ScorerService['score']>>;
    compliance: ReturnType<typeof checkCompliance>;
    seo: SeoPackage;
    applied: boolean;
    reason: string;
    usage: ReturnType<typeof summariseUsage>;
  }> {
    this.requireLlm();
    if (instructions.length === 0) {
      throw new BadRequestException('No fixes were selected.');
    }

    const usage: Usage[] = [];
    const before = await this.scorer.score(markdown);
    const beforeSeo = await this.buildSeo(brief, outline, markdown, usage);
    const beforeCompliance = checkCompliance(brief, outline, markdown, beforeSeo);

    const revised = this.stripFence(
      await this.llm.complete(
        {
          system: REVISE_SYSTEM,
          user: buildRevisePrompt(brief, markdown, instructions),
          maxTokens: 16000,
          thinking: this.config.anthropic.thinking,
        },
        usage,
      ),
    );

    const candidate = brief.products?.length
      ? linkProducts(revised, brief.products)
      : revised;
    const score = await this.scorer.score(candidate);
    const seo = await this.buildSeo(brief, outline, candidate, usage);
    const compliance = checkCompliance(brief, outline, candidate, seo);

    const wasFailing = beforeCompliance.filter((c) => c.status !== 'good').length;
    const nowFailing = compliance.filter((c) => c.status !== 'good').length;
    // A fix that trades two compliance wins for a worse detection score is
    // not a fix. The user asked for this one, so the bar is lower than the
    // loop's, but it is not zero.
    const applied = nowFailing <= wasFailing && score.ai_score <= before.ai_score + 5;

    return {
      markdown: applied ? candidate : markdown,
      score: applied ? score : before,
      compliance: applied ? compliance : beforeCompliance,
      seo: applied ? seo : beforeSeo,
      applied,
      reason: applied
        ? `Fixed. ${wasFailing} issue(s) to ${nowFailing}, detection ${before.ai_score} to ${score.ai_score}.`
        : `Rejected: it would have gone from ${wasFailing} to ${nowFailing} issue(s) ` +
          `and detection ${before.ai_score} to ${score.ai_score}. Your article is unchanged.`,
      usage: summariseUsage(usage),
    };
  }

  /**
   * Derive a voice profile from real human writing.
   *
   * Run once per brand, not per article: the profile is saved with the brand
   * and reused. That is also why it can afford to be thorough.
   *
   * The excerpts it returns are quoted verbatim from the samples and become
   * few-shot examples in every draft prompt, which is where most of the value
   * sits. Describing a voice and demonstrating one are not the same thing.
   */
  async extractVoice(samples: string[]): Promise<{
    profile: VoiceProfileDto;
    sampleCount: number;
    usage: ReturnType<typeof summariseUsage>;
    warnings: string[];
  }> {
    this.requireLlm();
    const usage: Usage[] = [];
    const warnings: string[] = [];

    const usable = samples
      .map((sample) => sample.trim())
      .filter((sample) => sample.split(/\s+/).length >= 25);

    if (usable.length === 0) {
      throw new BadRequestException(
        'No usable samples. Each needs at least 25 words: a couple of sentences ' +
          'is not enough to show a voice.',
      );
    }
    if (usable.length < 5) {
      warnings.push(
        `Only ${usable.length} usable sample(s). The research this is based on ` +
          'uses around 40. Fewer than about 10 tends to produce a profile that ' +
          'describes one article rather than a house style.',
      );
    }
    if (usable.length < samples.length) {
      warnings.push(`${samples.length - usable.length} sample(s) were too short and skipped.`);
    }

    const reply = await this.llm.complete(
      {
        system: VOICE_SYSTEM,
        user: buildVoicePrompt(usable),
        maxTokens: 3000,
        thinking: 'adaptive',
      },
      usage,
    );

    const parsed = this.parseJson<Partial<VoiceProfileDto>>(reply, 'voice profile');
    const list = (value: unknown, cap: number): string[] =>
      Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).slice(0, cap)
        : [];

    const profile: VoiceProfileDto = {
      features: list(parsed.features, 12),
      excerpts: list(parsed.excerpts, 6),
      cadence: typeof parsed.cadence === 'string' ? parsed.cadence : undefined,
      vocabulary: typeof parsed.vocabulary === 'string' ? parsed.vocabulary : undefined,
      quirks: list(parsed.quirks, 10),
    };

    if (profile.features.length === 0) {
      throw new BadRequestException(
        'The model returned no usable features from those samples.',
      );
    }
    // An excerpt that is not actually in the samples is a fabrication, and it
    // would then be shown to the writer as an example of the brand's voice.
    const corpus = usable.join(' ').replace(/\s+/g, ' ').toLowerCase();
    const invented = profile.excerpts.filter(
      (excerpt) => !corpus.includes(excerpt.trim().replace(/\s+/g, ' ').toLowerCase()),
    );
    if (invented.length > 0) {
      profile.excerpts = profile.excerpts.filter((excerpt) => !invented.includes(excerpt));
      warnings.push(
        `${invented.length} excerpt(s) were not found verbatim in your samples and ` +
          'were dropped. Excerpts must be real quotes, not paraphrases.',
      );
    }

    return {
      profile,
      sampleCount: usable.length,
      usage: summariseUsage(usage),
      warnings,
    };
  }

  /**
   * Read a product page and extract factual details for review.
   *
   * The result is a SUGGESTION. It is returned for the user to check and
   * accept in the form, never applied on their behalf, because the page is
   * third-party content that may contain text shaped like instructions. The
   * human confirmation step is the real defence; the prompt hardening is a
   * second layer.
   */
  async fetchProductDetails(url: string): Promise<{
    product: ExtractedProduct;
    sourceUrl: string;
    usage: ReturnType<typeof summariseUsage>;
    caution: string;
  }> {
    this.requireLlm();
    const usage: Usage[] = [];
    const clean = cleanUrl(url);

    let pageText: string;
    try {
      pageText = await fetchPageText(clean);
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : 'Could not fetch that page.',
      );
    }

    const reply = await this.llm.complete(
      {
        system: EXTRACT_SYSTEM,
        user: buildExtractPrompt(pageText, clean),
        maxTokens: 1200,
        thinking: 'disabled',
      },
      usage,
    );

    const parsed = this.parseJson<ExtractedProduct>(reply, 'product details');
    const attributes = Array.isArray(parsed.attributes)
      ? parsed.attributes.filter((entry) => typeof entry === 'string').slice(0, 12)
      : [];

    return {
      product: { ...parsed, attributes },
      sourceUrl: clean,
      usage: summariseUsage(usage),
      caution:
        'Extracted from a third-party page. Check every field before using it: ' +
        'anything wrong here becomes a factual claim in your article.',
    };
  }

  /**
   * Suggest semantically related terms.
   *
   * Deliberately the cheapest call in the pipeline: small prompt, small reply,
   * no thinking. It runs before the outline so a poor list costs pennies to
   * regenerate, and the reasons come back with the terms so the list can be
   * judged rather than pasted in blind.
   */
  async suggestKeywords(brief: BriefDto): Promise<KeywordResponse> {
    this.requireLlm();
    const usage: Usage[] = [];

    const reply = await this.llm.complete(
      {
        system: KEYWORDS_SYSTEM,
        user: buildKeywordsPrompt(brief),
        maxTokens: 1500,
        thinking: 'disabled',
      },
      usage,
    );

    const parsed = this.parseJson<{ lsiKeywords?: KeywordSuggestion[] }>(
      reply,
      'keyword suggestions',
    );

    const seen = new Set(
      [
        brief.primaryKeyword,
        ...(brief.secondaryKeywords ?? []),
        ...(brief.lsiKeywords ?? []),
      ].map((term) => term.toLowerCase().trim()),
    );

    const lsiKeywords = (parsed.lsiKeywords ?? [])
      .filter((entry) => typeof entry?.term === 'string' && entry.term.trim())
      .map((entry) => ({
        term: entry.term.trim(),
        reason: typeof entry.reason === 'string' ? entry.reason.trim() : '',
      }))
      // Models re-suggest what they were told to skip often enough to matter.
      .filter((entry) => {
        const key = entry.term.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 20);

    return { lsiKeywords, usage: summariseUsage(usage) };
  }

  /**
   * Step one. Cheap, and the point at which a bad plan can be corrected before
   * paying for a full draft.
   */
  async outline(brief: BriefDto): Promise<OutlineResponse> {
    this.requireLlm();
    const usage: Usage[] = [];
    const warnings: string[] = [];

    const reply = await this.llm.complete(
      {
        system: OUTLINE_SYSTEM,
        user: buildOutlinePrompt(brief),
        maxTokens: 4000,
        thinking: this.config.anthropic.thinking,
      },
      usage,
    );

    const parsed = this.parseJson<OutlineDto>(reply, 'outline');
    if (!parsed.h1 || !Array.isArray(parsed.sections) || parsed.sections.length === 0) {
      throw new BadRequestException('The model returned an outline with no sections.');
    }

    // Normalise rather than reject. A missing level or word count is trivially
    // repairable and failing the request over it would be needless friction.
    const outline: OutlineDto = {
      h1: parsed.h1.trim(),
      sections: parsed.sections.slice(0, 20).map((section) => ({
        heading: String(section.heading ?? '').trim(),
        level: section.level === 'h3' ? 'h3' : 'h2',
        intent: String(section.intent ?? '').trim(),
        targetWords: Math.max(40, Math.min(600, Number(section.targetWords) || 200)),
      })),
    };

    const estimatedWords = outline.sections.reduce(
      (total, section) => total + (section.targetWords ?? 200),
      0,
    );

    if (!outline.h1.toLowerCase().includes(brief.primaryKeyword.toLowerCase())) {
      warnings.push(
        `The H1 does not contain "${brief.primaryKeyword}". Edit it before drafting, ` +
          'or the finished page will miss its strongest on-page signal.',
      );
    }
    if (brief.wordCount && Math.abs(estimatedWords - brief.wordCount) > brief.wordCount * 0.3) {
      warnings.push(
        `The plan totals about ${estimatedWords} words against your ${brief.wordCount} target.`,
      );
    }

    return { outline, estimatedWords, usage: summariseUsage(usage), warnings };
  }

  /**
   * Step two. Draft each section, assemble, then run the same scoring and
   * humanizing machinery the rewrite path uses.
   *
   * Sections are drafted one call at a time rather than all at once. A single
   * call for a long article drifts: later sections lose the brief, repeat
   * earlier points and settle into the model's house style.
   */
  /**
   * One generation attempt: draft, humanize, revise, build metadata.
   *
   * Private because an ungraded article should never leave this service. The
   * public entry point below wraps this in the delivery contract.
   */
  private async generateOnce(
    brief: BriefDto,
    outline: OutlineDto,
  ): Promise<Omit<DraftResponse, 'scorecard' | 'gates' | 'attempts' | 'delivered'>> {
    this.requireLlm();

    // Normalise every URL once, up front. Tracking parameters copied in from
    // an analytics dashboard should never reach a published article, and a
    // link that differs only by a trailing slash defeats the "is it linked?"
    // compliance check.
    brief = {
      ...brief,
      ctaUrl: brief.ctaUrl ? cleanUrl(brief.ctaUrl) : undefined,
      internalLinks: brief.internalLinks?.map(cleanUrl),
      products: brief.products?.map((product) => ({
        ...product,
        url: product.url ? cleanUrl(product.url) : undefined,
      })),
    };
    const started = Date.now();
    const usage: Usage[] = [];
    const warnings: string[] = [];

    const revisions: DraftResponse['humanizePasses'] = [];

    // Plan to fit before spending. The estimate uses the same coefficients the
    // cost planner does, so what the UI quotes and what the loop allows itself
    // are the same number.
    const budget = this.config.loop.maxCostPerArticle;
    const plannedWords =
      brief.wordCount ??
      outline.sections.reduce((total, s) => total + (s.targetWords ?? 200), 0);
    const plan = planForBudget(plannedWords, budget, {
      model: this.config.anthropic.model,
      judgeModel: this.config.anthropic.judgeModel,
    });
    const passBudget = plan.fits ? plan.settings.humanizePasses : 1;

    // Refuse before spending, rather than warn after.
    //
    // The old behaviour ran the cheapest configuration anyway and pushed a
    // warning, so a $0.10 cap reliably produced $0.18 articles and the cap
    // was decoration. A budget nobody enforces is worse than no budget: it
    // reads like a guarantee.
    //
    // The message names every way out, because "cannot be done" without a
    // remedy is not useful. Bulk is on that list because it genuinely is the
    // route to the number: every phase batches there, at half price.
    if (!plan.fits && this.config.loop.budgetEnforcement === 'strict') {
      throw new BadRequestException(
        `A ${plannedWords}-word article cannot be produced for ` +
          `$${budget.toFixed(2)}. The cheapest configuration that still ` +
          `rewrites costs about $${plan.estimate.perArticle.toFixed(3)}. ` +
          'Options: raise MAX_COST_PER_ARTICLE to that figure, ask for a ' +
          'shorter article, use the bulk endpoint which batches every phase ' +
          'at half price, or set BUDGET_ENFORCEMENT=advisory to overspend ' +
          'deliberately.',
      );
    }
    if (!plan.fits) {
      warnings.push(
        `A ${plannedWords}-word article cannot be produced for $${budget.toFixed(2)}. ` +
          `The cheapest configuration that still rewrites is ` +
          `$${plan.estimate.perArticle.toFixed(3)}. BUDGET_ENFORCEMENT is ` +
          'advisory, so this ran anyway with one rewrite pass.',
      );
    } else if (passBudget < this.config.loop.maxIterations) {
      warnings.push(
        `Rewrite passes reduced from ${this.config.loop.maxIterations} to ` +
          `${passBudget} to stay inside the $${budget.toFixed(2)} budget.`,
      );
    }

    const draftSystem = buildDraftSystem(brief, outline);
    const drafted: string[] = [];
    let previousTail = '';

    // The opening, written first so its closing lines can lead into section one.
    this.progress.step(brief, 'Writing the opening');
    const intro = this.stripFence(
      await this.llm.complete(
        {
          system: draftSystem,
          user: buildIntroPrompt(outline, brief),
          maxTokens: 900,
          thinking: this.config.anthropic.thinking,
          cacheSystem: true,
        },
        usage,
      ),
    );
    previousTail = intro.split(/(?<=[.!?])\s+/).slice(-2).join(' ').slice(-400);

    for (const [index, section] of outline.sections.entries()) {
      const prose = await this.llm.complete(
        {
          system: draftSystem,
          user: buildSectionPrompt(section, index, previousTail),
          maxTokens: Math.ceil((section.targetWords ?? 200) * 4) + 500,
          // Configurable, not hardcoded. Disabling thinking roughly halves
          // the bill, and the evidence that it costs no quality came from the
          // local scorer, which has since been shown not to track the
          // detectors users are actually judged by. ANTHROPIC_THINKING=disabled
          // restores the cheap path once that is measured properly.
          thinking: this.config.anthropic.thinking,
          cacheSystem: true,
        },
        usage,
      );

      let cleaned = this.stripHeading(prose, section.heading);

      // Inline humanization: rewrite this section now, while it is small,
      // instead of the whole article later. Off by default and measured
      // against the document loop rather than assumed to be equivalent.
      //
      // Run at one pass, because a section is too short for the score being
      // optimised to mean much: burstiness and sentence-length variance are
      // properties of the assembled article, and iterating a 200-word block
      // against them optimises noise.
      if (this.config.loop.inlineHumanize && this.llm.isLive) {
        try {
          const inline = await this.humanize.humanize(
            cleaned,
            brief.style ?? 'standard',
            false,
            true,
            undefined,
            { maxPasses: 1 },
          );
          // Rolled up as one entry carrying the real input/output split and
          // the real dollar figure. The per-model breakdown only reports a
          // combined token count, and recording a combined count in either
          // column is how a cost report ends up claiming six times more
          // output tokens than the model could have produced.
          usage.push({
            model: this.llm.model,
            inputTokens: inline.usage.inputTokens,
            outputTokens: inline.usage.outputTokens,
            cacheReadTokens: inline.usage.cacheReadTokens,
            cacheWriteTokens: inline.usage.cacheWriteTokens,
            costUsd: inline.usage.costUsd,
          });
          if (inline.humanized.trim()) cleaned = inline.humanized;
        } catch (cause) {
          // A section that fails to rewrite is kept as drafted. Losing the
          // section would cost far more than leaving it un-humanized.
          this.logger.warn(
            `inline humanize failed on section ${index + 1}: ` +
              (cause instanceof Error ? cause.message : String(cause)),
          );
        }
      }

      drafted.push(cleaned);
      // Only the tail is carried forward. Passing the whole draft would blow
      // up cost quadratically and add little the outline does not already give.
      previousTail = cleaned.split(/(?<=[.!?])\s+/).slice(-2).join(' ').slice(-400);

      this.progress.step(
        brief,
        `Section ${index + 1} of ${outline.sections.length}: ${section.heading}`,
      );
      this.logger.log(
        `section ${index + 1}/${outline.sections.length}: ${section.heading}`,
      );
    }

    let markdown = assembleMarkdown(outline, drafted, intro);

    // Guarantee the product links the brief asked for. Free and exact, where
    // the alternative was regenerating the whole article to add brackets.
    if (brief.products?.length) {
      markdown = linkProducts(markdown, brief.products);
    }

    // The writing rules were applied at generation, so the draft should already
    // be close. Score it before spending anything on rewriting.
    let score = await this.scorer.score(markdown);

    // The humanize loop, over the assembled article.
    //
    // Applying the writing rules while drafting gets the text close. It does
    // not get it where a real detector wants it: the same pipeline measured 34
    // on ZeroGPT without this step and 7 with it. Drafting and rewriting are
    // not the same operation, and the rewriting is where the score moves.
    this.progress.step(brief, 'Scoring the draft');

    // What drafting actually cost, against what it was allowed to cost.
    //
    // This check did not exist, and it was the second half of why the cap
    // never held. Planning happened before any spending and the only runtime
    // check sat between rewrite passes, so drafting could consume the entire
    // budget and the loop would still start, having measured nothing.
    //
    // Drafting is not optional: a half-written article is worth nothing, so
    // there is no version of this that stops mid-draft. What it can do is
    // refuse to begin the optional work that follows.
    const spentOnDraft = summariseUsage(usage).costUsd;
    const remaining = budget - spentOnDraft;
    // One rewrite pass needs roughly a third of what drafting cost. Starting a
    // pass that cannot finish spends money for an article that gets discarded.
    const passCost = spentOnDraft / 3;
    const canAffordAPass = remaining > passCost;

    if (!canAffordAPass) {
      warnings.push(
        `Drafting alone cost $${spentOnDraft.toFixed(3)} of the ` +
          `$${budget.toFixed(2)} budget, leaving too little for a rewrite ` +
          'pass. The article is returned as drafted. Detection scores are ' +
          'materially worse without the rewrite: measured 34 on ZeroGPT ' +
          'against 7 with it.',
      );
    }

    if (
      this.config.loop.humanizeGenerated &&
      // Inline humanization replaces this rather than stacking with it, so the
      // two can be compared at comparable spend.
      !this.config.loop.inlineHumanize &&
      canAffordAPass &&
      score.ai_score > this.config.loop.targetScore
    ) {
      this.progress.step(brief, 'Rewriting to lower the detection score');
      const before = score.ai_score;
      const result = await this.humanize.humanize(
        markdown,
        brief.style ?? 'casual',
        false,
        true, // internal: the word cap guards user input, not our own output
        (label) => this.progress.step(brief, label),
        {
          maxPasses: passBudget,
          // Checked between passes, not mid-pass: abandoning a half-rewritten
          // article would leave it worse than not having started.
          stopWhenSpent: Math.max(0, remaining - 0.01),
        },
      );
      if (result.fidelity.passed && result.after.ai_score < score.ai_score) {
        markdown = brief.products?.length
          ? linkProducts(result.humanized, brief.products)
          : result.humanized;
        score = result.after;
      }
      revisions.push(
        ...result.iterations.map((entry) => ({
          pass: entry.pass,
          score: entry.score,
          accepted: entry.accepted,
          note: `humanize: ${entry.note}`,
        })),
      );
      warnings.push(...result.warnings.filter((entry) => !entry.includes('prior weights')));
      // Carry the sub-run's real split. Recording its TOTAL tokens as output
      // made every cost report wrong: output looked six times larger than the
      // article could justify, which sent me looking for a runaway loop that
      // did not exist.
      usage.push({
        model: this.config.anthropic.model,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        // Carried, not zeroed. Zeroing it here hid the fact that the rewrite
        // chunks were not caching at all, because the cost report showed no
        // cache reads either way. The dollar figure was right and the one
        // number that would have explained it was being thrown away.
        cacheReadTokens: result.usage.cacheReadTokens,
        cacheWriteTokens: result.usage.cacheWriteTokens,
        costUsd: result.usage.costUsd,
        // Carried so the cost readout can say how much of the run was billed
        // at the batch rate. Without it a batched article reports zero
        // batched calls and looks like the discount never applied.
        batched: result.usage.batchedCalls > 0,
      });
      this.logger.log(`humanize loop: ${before} -> ${score.ai_score}`);
    }

    this.progress.step(brief, 'Writing title, meta and schema');
    let seo = await this.buildSeo(brief, outline, markdown, usage);
    let compliance = checkCompliance(brief, outline, markdown, seo);

    // One revision pass against whatever is still missing. The draft is
    // usually strong but short of two or three countable targets, and naming
    // them is far cheaper than regenerating the article.
    // Revision loop.
    //
    // This replaces a full humanize pass, which used to run here and was by
    // far the largest cost in the whole pipeline: on a 1,333-word article it
    // produced 62,000 output tokens, 47 per word, by rewriting every chunk
    // four times over and running a judge on each attempt. It was also
    // redundant. The writing rules are already applied while drafting, so a
    // second system re-deriving them from scratch bought very little.
    //
    // A targeted revision names the specific misses instead, costs one call,
    // and keeps whichever version is actually better.
    const maxRevisions = this.config.loop.maxRevisions;
    for (let round = 1; round <= maxRevisions; round += 1) {
      // A revision regenerates the whole article, so it costs roughly what
      // drafting did. Optional work stops at the cap rather than crossing it.
      const spentNow = summariseUsage(usage).costUsd;
      if (spentNow + spentOnDraft > budget) {
        warnings.push(
          `Skipped revision: $${spentNow.toFixed(3)} of the ` +
            `$${budget.toFixed(2)} budget is spent and a revision regenerates ` +
            'the whole article.',
        );
        break;
      }

      const problems = this.collectProblems(compliance, score);
      const hardFailures = compliance.filter((c) => c.status === 'bad').length;
      const overTarget = score.ai_score > this.config.loop.targetScore;

      // Only a hard compliance failure justifies regenerating the article.
      //
      // Being over the detection target used to qualify too. Measurement
      // killed that: across runs the revision consistently moved the score
      // the WRONG way (4.3 to 4.9, then 6.3 to 6.5) while fixing a compliance
      // warning. It is a good tool for "the brief was not followed" and a bad
      // one for "this reads slightly machine-written", because the writing
      // rules were already applied at draft time and restating them adds
      // nothing. Set REVISE_ON_SCORE=true to restore the old behaviour.
      const worthRevising =
        hardFailures > 0 || (overTarget && this.config.loop.reviseOnScore);

      if (problems.length === 0 && !overTarget) break;
      if (!worthRevising) {
        warnings.push(
          `Skipped revision: ${problems.length} minor issue(s) did not justify ` +
            'regenerating the article. See the Checks tab.',
        );
        break;
      }

      if (overTarget) {
        problems.push(
          `Detection score is ${score.ai_score}, above the target of ` +
            `${this.config.loop.targetScore}. Vary sentence length harder and ` +
            'cut any phrasing that reads as generic.',
        );
      }

      const revised = await this.llm.complete(
        {
          system: REVISE_SYSTEM,
          user: buildRevisePrompt(brief, markdown, problems),
          maxTokens: 16000,
          thinking: this.config.anthropic.thinking,
        },
        usage,
      );

      const candidate = this.stripFence(revised);
      const candidateScore = await this.scorer.score(candidate);
      // Compliance is judged against the EXISTING metadata rather than newly
      // generated metadata. Regenerating it for a candidate that may lose is
      // a wasted model call, and none of the body-level checks depend on it.
      const candidateCompliance = checkCompliance(brief, outline, candidate, seo);

      const before = compliance.filter((c) => c.status !== 'good').length;
      const after = candidateCompliance.filter((c) => c.status !== 'good').length;
      // Accept on either axis improving, provided the other did not collapse.
      const complianceBetter = after <= before;
      const scoreBetter =
        candidateScore.ai_score <= score.ai_score + DETECTION_TOLERANCE;
      const accepted = complianceBetter && scoreBetter && (after < before || candidateScore.ai_score < score.ai_score);

      revisions.push({
        pass: round,
        score: candidateScore.ai_score,
        accepted,
        note: accepted
          ? `accepted, ${before} to ${after} issues, AI ${score.ai_score} to ${candidateScore.ai_score}`
          : `rejected, ${before} to ${after} issues, AI ${candidateScore.ai_score}`,
      });

      this.logger.log(`revision ${round}: ${revisions[revisions.length - 1].note}`);

      if (!accepted) break;
      markdown = brief.products?.length
        ? linkProducts(candidate, brief.products)
        : candidate;
      score = candidateScore;
      compliance = candidateCompliance;
      // The winner earns fresh metadata, written from the text that shipped.
      seo = await this.buildSeo(brief, outline, markdown, usage);
      compliance = checkCompliance(brief, outline, markdown, seo);
    }

    const factFlags = findFactFlags(brief, markdown);
    const citations = findCitationSuggestions(brief, markdown);
    const unsupported = unsupportedFacts(factFlags);
    const eeat = checkEeat(brief, markdown, citations, unsupported.length);

    const eeatFailures = eeat.filter((check) => check.status === 'bad');
    if (eeatFailures.length > 0) {
      warnings.push(
        `E-E-A-T: ${eeatFailures.length} signal(s) missing. ` +
          eeatFailures.map((check) => check.label).join(', ') + '.',
      );
    }
    const health = citations.filter((entry) => entry.kind === 'health');
    if (health.length > 0) {
      warnings.push(
        `${health.length} health or safety claim(s) are unsourced. These carry ` +
          'the highest cost if wrong. See the Sources tab.',
      );
    }
    if (unsupported.length > 0) {
      warnings.push(
        `${unsupported.length} claim(s) in the draft are not traceable to your ` +
          'brief. Check the Facts tab before publishing. These are the ones that ' +
          'become a correction on a live page.',
      );
    }
    for (const check of compliance.filter((entry) => entry.status === 'bad')) {
      warnings.push(`${check.label}: ${check.detail}`);
    }

    const verification =
      this.detectors.verifyNames.length > 0
        ? {
            primary: this.detectors.primaryName,
            before: [],
            after: await this.detectors.verify(markdown),
            estimatedCost: this.detectors.estimateCost(1),
          }
        : null;

    return {
      markdown,
      seo,
      score,
      compliance,
      factFlags,
      citations,
      eeat,
      humanizePasses: revisions,
      verification,
      usage: summariseUsage(usage),
      warnings,
      elapsedMs: Date.now() - started,
    };
  }

  /**
   * Turn failing checks into instructions a writer can act on.
   *
   * A percentage is not actionable. "Use the primary keyword three more times"
   * is. Only countable, fixable misses are included: outline coverage and
   * excluded terms are handled at generation and would need a different fix.
   */
  private collectProblems(
    compliance: ReturnType<typeof checkCompliance>,
    score: Awaited<ReturnType<ScorerService['score']>>,
  ): string[] {
    const problems: string[] = [];

    for (const check of compliance) {
      if (check.status === 'good') continue;
      switch (check.id) {
        case 'keyword_density':
        case 'keyword_placement':
        case 'secondary_keywords':
        case 'drawbacks':
        case 'cta':
        case 'length':
          problems.push(`${check.label}: ${check.detail}`);
          break;
        default:
          break;
      }
    }

    const transitions = score.readability.checks.find((c) => c.id === 'transitions');
    if (transitions && transitions.status !== 'good') {
      problems.push(
        `Transition words: ${transitions.detail} Open more sentences with a plain ` +
          'connective (But, So, And, Still, Then, For example).',
      );
    }
    const passive = score.readability.checks.find((c) => c.id === 'passive');
    if (passive && passive.status === 'bad') {
      problems.push(`Passive voice: ${passive.detail} Rewrite those in the active voice.`);
    }

    return problems;
  }

  private stripFence(text: string): string {
    const fence = /^```(?:markdown|md)?\n([\s\S]*?)\n```$/.exec(text.trim());
    return (fence ? fence[1] : text).trim();
  }

  /** Metadata is written from the finished article, never from the brief. */
  private async buildSeo(
    brief: BriefDto,
    outline: OutlineDto,
    markdown: string,
    usage: Usage[],
  ): Promise<SeoPackage> {
    const reply = await this.llm.complete(
      {
        system: SEO_SYSTEM,
        user: buildSeoPrompt(brief, markdown),
        maxTokens: 2000,
        thinking: 'disabled',
      },
      usage,
    );

    const parsed = this.parseJson<{
      titleTag?: string;
      metaDescription?: string;
      imageAlt?: string[];
      faq?: Array<{ question?: string; answer?: string }>;
    }>(reply, 'metadata');

    // Trimmed in code, not trusted to the model. Models overshoot character
    // limits routinely, and a truncated title in search results is a real cost.
    const titleTag = trimTo(parsed.titleTag ?? outline.h1, 60);
    const metaDescription = trimTo(parsed.metaDescription ?? '', 155);

    const base = {
      titleTag,
      metaDescription,
      slug: toSlug(titleTag || outline.h1),
      h1: outline.h1,
      imageAlt: (parsed.imageAlt ?? []).slice(0, 5).map((alt) => trimTo(alt, 125)),
      faq: (parsed.faq ?? [])
        .filter((entry) => entry.question && entry.answer)
        .slice(0, 6)
        .map((entry) => ({
          question: entry.question!.trim(),
          answer: entry.answer!.trim(),
        })),
    };

    return {
      ...base,
      schema: buildSchema(brief, outline, base),
      keywordUsage: keywordUsage(brief, markdown),
    };
  }

  /** Models re-emit the heading despite being told not to. */
  private stripHeading(text: string, heading: string): string {
    let cleaned = text.trim();
    const fence = /^```[a-z]*\n([\s\S]*?)\n```$/.exec(cleaned);
    if (fence) cleaned = fence[1].trim();
    cleaned = cleaned.replace(/^#{1,6}\s+.*\n+/, '');
    if (cleaned.toLowerCase().startsWith(heading.toLowerCase())) {
      cleaned = cleaned.slice(heading.length).replace(/^[\s:.-]+/, '');
    }
    return cleaned.trim();
  }

  /**
   * Generate an article behind a delivery contract.
   *
   * The gate structure and the 90-point threshold are adapted from the
   * MIT-licensed claude-blog project (github.com/AgriciDaniel/claude-blog).
   * The gates themselves are rewritten for what this pipeline can actually
   * verify: their visual gate screenshots a rendered page at three viewports,
   * which has no meaning for a text API, so that budget went to the artefacts
   * this tool does produce.
   *
   * The point of a contract is that it BLOCKS. Measuring compliance,
   * readability, E-E-A-T and detection separately, then returning an article
   * that failed all four looking finished, is not quality control. This
   * refuses to call that delivered.
   *
   * There was briefly a second, ungraded entry point beside this one. It was
   * removed rather than kept as an option, because the cheaper ungraded path
   * is the one that gets used and a gate nobody runs is decoration.
   */
  async draft(
    brief: BriefDto,
    outline: OutlineDto,
    threshold = 90,
    maxAttempts = 2,
  ): Promise<DraftResponse> {
    this.requireLlm();

    const attempts: DraftAttempt[] = [];
    type Attempt = Omit<
      DraftResponse,
      'scorecard' | 'gates' | 'attempts' | 'delivered'
    >;
    let best: { draft: Attempt; card: Scorecard } | null = null;
    /** Running total across attempts, for the retry budget check below. */
    let spentAcrossAttempts = 0;

    // Size the bar for the whole run, including the humanize loop. Sizing it
    // for the sections alone left the bar sitting still through the longest
    // phase, which reads as a hang.
    const estimatedWords =
      brief.wordCount ??
      outline.sections.reduce((total, section) => total + (section.targetWords ?? 200), 0);
    const chunksPerPass = Math.max(1, Math.ceil(estimatedWords / this.config.loop.chunkWords));
    const humanizeSteps = this.config.loop.humanizeGenerated
      ? this.config.loop.maxIterations * (chunksPerPass + 1)
      : 0;
    this.progress.start(
      brief,
      (outline.sections.length + humanizeSteps) * maxAttempts,
    );

    // Gate 1, capability. Checked once and up front, because discovering a
    // dead scorer after paying for nine section calls helps nobody.
    const scorerHealth = await this.scorer.health();
    const capability: GateResult = {
      gate: 'Capability',
      passed: scorerHealth.ok && this.llm.isLive,
      detail: scorerHealth.ok
        ? `Model ${this.llm.model}, scorer up.`
        : 'The scoring service is unreachable, so nothing can be graded.',
    };
    if (!capability.passed) {
      throw new BadRequestException(capability.detail);
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      this.progress.step(brief, `Attempt ${attempt} of ${maxAttempts}`);
      const draft = await this.generateOnce(brief, outline);
      const card = buildScorecard({
        score: draft.score,
        compliance: draft.compliance,
        eeat: draft.eeat,
        citations: draft.citations,
        factFlags: draft.factFlags,
        seo: draft.seo,
        markdown: draft.markdown,
      });

      const blockedBy = [
        ...card.critical,
        ...(card.total < threshold
          ? [`Scored ${card.total}/100, below the ${threshold} threshold.`]
          : []),
      ];

      attempts.push({
        attempt,
        total: card.total,
        band: card.band,
        passed: blockedBy.length === 0,
        blockedBy,
      });

      this.logger.log(
        `v2 attempt ${attempt}: ${card.total}/100 (${card.band}), ` +
          `${blockedBy.length} blocker(s)`,
      );

      // Selection rule.
      //
      // Detection is a CONSTRAINT here, not one weighted term among many. It
      // is worth 12 of 100 points on the scorecard, so selecting purely by
      // total let a slightly more detectable article win on SEO points. That
      // is backwards for a tool whose purpose is lowering detection, and it
      // was measured happening: the attempt this kept scored best on the
      // local scorer and worst on a real detector.
      //
      // So an attempt only wins if it does not make detection meaningfully
      // worse. Only when detection is comparable does the scorecard decide.
      if (!best) {
        best = { draft, card };
      } else {
        const detectionDelta = draft.score.ai_score - best.draft.score.ai_score;
        const clearlyWorse = detectionDelta > 3;
        const clearlyBetter = detectionDelta < -3;
        if (clearlyBetter || (!clearlyWorse && card.total > best.card.total)) {
          best = { draft, card };
        }
      }
      if (blockedBy.length === 0) break;

      // Each attempt regenerates the entire article, so a second one roughly
      // doubles the bill. This was the largest remaining way to overspend,
      // because a failing scorecard is exactly the moment it wants to retry.
      spentAcrossAttempts += draft.usage.costUsd;
      const cap = this.config.loop.maxCostPerArticle;
      if (
        attempt < maxAttempts &&
        this.config.loop.budgetEnforcement === 'strict' &&
        // The next attempt will cost about what this one did.
        spentAcrossAttempts + draft.usage.costUsd > cap
      ) {
        this.logger.warn(
          `stopping after attempt ${attempt}: $${spentAcrossAttempts.toFixed(3)} ` +
            `spent and another attempt would pass the $${cap.toFixed(2)} cap`,
        );
        break;
      }
    }

    const { draft, card } = best!;
    const delivered = attempts.some((entry) => entry.passed);

    const gates: GateResult[] = [
      capability,
      {
        gate: 'Completeness',
        passed: Boolean(
          draft.markdown.trim() &&
            draft.seo.titleTag &&
            draft.seo.metaDescription &&
            draft.seo.slug &&
            draft.seo.schema,
        ),
        detail: 'Body, title, meta description, slug and JSON-LD all present.',
      },
      {
        gate: 'Content review',
        passed: card.total >= threshold,
        detail: `Scored ${card.total}/100 (${card.band}), threshold ${threshold}.`,
      },
      {
        gate: 'Integrity',
        passed: card.critical.length === 0,
        detail: card.critical.length === 0
          ? 'No critical issues.'
          : card.critical.join(' '),
      },
    ];

    const warnings = [...draft.warnings];
    if (!delivered) {
      warnings.unshift(
        `NOT DELIVERED. Best of ${attempts.length} attempt(s) scored ` +
          `${card.total}/100 against a ${threshold} threshold. The article is ` +
          'returned so you can see it and decide, but it did not pass.',
      );
    }

    this.progress.finish(brief, delivered ? 'Delivered' : 'Finished below threshold');
    return { ...draft, warnings, scorecard: card, gates, attempts, delivered };
  }
}

