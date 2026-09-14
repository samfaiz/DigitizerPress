import { priceFor } from '../../llm/pricing.js';

/**
 * What a configuration will cost, before you run it.
 *
 * Every coefficient below is derived from runs measured in this project, not
 * from estimation. The sources are named per constant so a future change can
 * be checked against the same evidence.
 *
 * Worth stating the shape up front, because it determines which dials matter.
 * Output tokens dominate, and output cannot be cached. Each humanize pass
 * regenerates the whole article, so cost scales with passes x length, and
 * nothing about prompt engineering changes that. Input is now largely cached,
 * which is why chunk size costs far less than it used to.
 */

/** Words to tokens for English prose. Measured across the generated articles. */
const TOKENS_PER_WORD = 1.33;

/**
 * Correction from the structural model to what actually gets billed.
 *
 * The model below counts the tokens a run obviously needs: the prose, the
 * prompts, the metadata. It was measured against three real bills and came in
 * low every time.
 *
 *   draft only, 2,033 words          predicted $0.058   billed $0.112   1.91x
 *   draft + 1 pass, 2,097 words      predicted $0.118   billed $0.193   1.63x
 *   same, rewrites batched           predicted $0.117   billed $0.169   1.45x
 *
 * The dominant missing term is thinking. Thinking tokens are billed as output
 * and never appear in the response, so a model counting visible prose misses
 * them entirely: on the draft-only run the visible prose, outline and
 * metadata come to about 4,500 output tokens against 8,266 actually billed.
 * Cache writes, billed once at 1.25x input, are the second omission.
 *
 * This is set ABOVE the worst observed ratio rather than at the mean, and
 * that asymmetry is deliberate. Quoting too high costs a run that could have
 * afforded another pass. Quoting too low overspends a budget the user set,
 * and there is no way to give that money back.
 *
 * Re-measure this when the model, the thinking setting or the prompts change.
 * It is a fudge factor standing in for real accounting, and it is only honest
 * while the numbers above are still true.
 */
const BILLED_MULTIPLIER = Number.parseFloat(process.env.COST_MULTIPLIER ?? '') || 1.95;

/**
 * The instruction block sent with every rewrite call: style prompt, writing
 * rules, worked examples. Counted at 1,385 tokens on Sonnet 5.
 *
 * It has to stay above 1,024, the minimum prefix the API will cache on this
 * model family. At 916 tokens, which is what it measured before the worked
 * examples were added, `cache_control` was accepted and silently ignored on
 * every one of the forty calls a pass makes. Measured on a 2,000-word
 * article, fixing that cut the bill from $0.245 to $0.193.
 *
 * So this constant is a floor, not just a number to keep accurate. Shortening
 * the rewrite prompt below the minimum costs about a fifth of the bill and
 * reports nothing when it happens.
 */
const REWRITE_SYSTEM_TOKENS = 1_385;

/** The generation system block: brief, facts rule, writing rules, outline. */
const DRAFT_SYSTEM_TOKENS = 1_600;

/**
 * Cached reads bill at roughly a tenth of the input rate.
 *
 * This rate only applies to a block the API actually cached. See
 * REWRITE_SYSTEM_TOKENS: a block under the model's minimum is not cached and
 * bills at full input price, with no error and no field in the response to
 * say so. AnthropicProvider warns when a caller asks for caching it will not
 * get.
 */
const CACHE_RATE = 0.1;

/** The judge reads both versions of the article once per pass. */
const JUDGE_OUTPUT_TOKENS = 220;

export interface CostInputs {
  words: number;
  model: string;
  /** Model used for the fidelity judge. Often the same. */
  judgeModel?: string;
  chunkWords: number;
  humanizePasses: number;
  /** Roughly words / 200, matching how the outline is planned. */
  sections?: number;
  includeHumanize?: boolean;
  revisions?: number;
  /** Contract attempts. A failed attempt costs a whole article. */
  attempts?: number;
}

export interface CostBreakdown {
  perArticle: number;
  perThousand: number;
  lines: Array<{ label: string; cost: number; detail: string }>;
  calls: number;
  outputTokens: number;
}

export function estimateCost(inputs: CostInputs): CostBreakdown {
  const price = priceFor(inputs.model);
  const judgePrice = priceFor(inputs.judgeModel ?? inputs.model) ?? price;
  if (!price || !judgePrice) {
    return { perArticle: 0, perThousand: 0, lines: [], calls: 0, outputTokens: 0 };
  }

  const attempts = Math.max(1, inputs.attempts ?? 1);
  const sections = inputs.sections ?? Math.max(3, Math.round(inputs.words / 200));
  const articleTokens = inputs.words * TOKENS_PER_WORD;
  const lines: CostBreakdown['lines'] = [];
  let calls = 0;
  let outputTokens = 0;

  const money = (input: number, cached: number, output: number, p = price) =>
    (input * p.inputPerMillion +
      cached * p.inputPerMillion * CACHE_RATE +
      output * p.outputPerMillion) /
    1_000_000;

  // --- Outline. One call, small either way.
  const outlineCost = money(900, 0, 1_200);
  lines.push({ label: 'Outline', cost: outlineCost, detail: '1 call' });
  calls += 1;
  outputTokens += 1_200;

  // --- Drafting. One call per section plus the intro. The system block is
  // identical across them, so all but the first read from cache.
  const draftCalls = sections + 1;
  const draftOutput = articleTokens;
  const draftCost = money(
    DRAFT_SYSTEM_TOKENS + draftCalls * 120,
    DRAFT_SYSTEM_TOKENS * (draftCalls - 1),
    draftOutput,
  );
  lines.push({
    label: 'Drafting',
    cost: draftCost * attempts,
    detail: `${draftCalls} calls x ${attempts} attempt(s)`,
  });
  calls += draftCalls * attempts;
  outputTokens += draftOutput * attempts;

  // --- Metadata.
  const seoCost = money(1_200, 0, 600);
  lines.push({ label: 'Title, meta, FAQ, schema', cost: seoCost * attempts, detail: '1 call' });
  calls += attempts;
  outputTokens += 600 * attempts;

  // --- Humanize. The dominant line, and the reason budget and score pull
  // against each other: each pass regenerates the entire article.
  if (inputs.includeHumanize !== false && inputs.humanizePasses > 0) {
    const chunks = Math.max(1, Math.ceil(inputs.words / inputs.chunkWords));
    const rewriteCalls = chunks * inputs.humanizePasses;
    const chunkTokens = inputs.chunkWords * TOKENS_PER_WORD;

    const humanizeCost = money(
      REWRITE_SYSTEM_TOKENS + rewriteCalls * chunkTokens,
      REWRITE_SYSTEM_TOKENS * (rewriteCalls - 1),
      articleTokens * inputs.humanizePasses,
    );
    const judgeCost = money(
      articleTokens * 2,
      articleTokens * 2 * (inputs.humanizePasses - 1),
      JUDGE_OUTPUT_TOKENS * inputs.humanizePasses,
      judgePrice,
    );

    lines.push({
      label: 'Humanize',
      cost: (humanizeCost + judgeCost) * attempts,
      detail: `${inputs.humanizePasses} passes x ${chunks} chunks = ${rewriteCalls} calls`,
    });
    calls += (rewriteCalls + inputs.humanizePasses) * attempts;
    outputTokens += articleTokens * inputs.humanizePasses * attempts;
  }

  // --- Revisions. Each regenerates the whole article once.
  const revisions = inputs.revisions ?? 0;
  if (revisions > 0) {
    const revisionCost = money(articleTokens * 1.4, 0, articleTokens) * revisions;
    lines.push({ label: 'Revisions', cost: revisionCost, detail: `${revisions} pass(es)` });
    calls += revisions;
    outputTokens += articleTokens * revisions;
  }

  const perArticle =
    lines.reduce((total, line) => total + line.cost, 0) * BILLED_MULTIPLIER;
  return {
    perArticle: Number(perArticle.toFixed(4)),
    perThousand: Math.round(perArticle * 1000),
    // Line items carry the correction too, so they still sum to the total.
    // Showing uncorrected lines under a corrected total would be the kind of
    // breakdown that makes people distrust the whole readout.
    lines: lines.map((line) => ({
      ...line,
      cost: Number((line.cost * BILLED_MULTIPLIER).toFixed(4)),
    })),
    calls,
    outputTokens: Math.round(outputTokens),
  };
}

export interface BudgetPlan {
  fits: boolean;
  settings: {
    model: string;
    chunkWords: number;
    humanizePasses: number;
    attempts: number;
  };
  estimate: CostBreakdown;
  note: string;
}

/**
 * Find the strongest configuration that fits a per-article budget.
 *
 * Ordered by what the measurements say matters. Passes are given up before
 * chunk size, because chunk size is what buys the detection score and passes
 * show diminishing returns: on the one run where this was measured, the third
 * of four passes was rejected outright.
 */
export function planForBudget(
  words: number,
  budgetPerArticle: number,
  options: { model?: string; judgeModel?: string } = {},
): BudgetPlan {
  const model = options.model ?? 'claude-sonnet-5';
  const judgeModel = options.judgeModel ?? model;

  // Strongest first. The search stops at the first configuration that fits,
  // so the result is the best affordable rather than the cheapest available.
  const candidates: Array<{ chunkWords: number; humanizePasses: number; attempts: number }> = [];
  for (const attempts of [2, 1]) {
    for (const humanizePasses of [4, 3, 2, 1]) {
      for (const chunkWords of [60, 100, 150, 250, 350]) {
        candidates.push({ chunkWords, humanizePasses, attempts });
      }
    }
  }

  for (const candidate of candidates) {
    const estimate = estimateCost({
      words,
      model,
      judgeModel,
      chunkWords: candidate.chunkWords,
      humanizePasses: candidate.humanizePasses,
      attempts: candidate.attempts,
    });
    if (estimate.perArticle <= budgetPerArticle) {
      return {
        fits: true,
        settings: { model, ...candidate },
        estimate,
        note:
          candidate.chunkWords > 100
            ? 'Fits, but at this chunk size the detection score will be materially ' +
              'worse. Measured on one article: 60-word chunks scored about 7 on ' +
              'ZeroGPT, 330-word chunks about 22.'
            : 'Fits at a chunk size close to the measured-best setting.',
      };
    }
  }

  const cheapest = estimateCost({
    words,
    model,
    judgeModel,
    chunkWords: 350,
    humanizePasses: 1,
    attempts: 1,
  });
  return {
    fits: false,
    settings: { model, chunkWords: 350, humanizePasses: 1, attempts: 1 },
    estimate: cheapest,
    note:
      `Nothing fits. The cheapest configuration that still humanizes at all is ` +
      `$${cheapest.perArticle.toFixed(3)} per article. Below that you are choosing ` +
      'between shorter articles and no rewriting.',
  };
}
