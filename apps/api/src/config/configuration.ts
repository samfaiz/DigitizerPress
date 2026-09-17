/**
 * Central env parsing. Every default here is chosen so that `npm run dev`
 * works on a clean clone with no .env file and no API keys.
 */

const int = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const float = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseFloat(value ?? '');
  return Number.isFinite(parsed) ? parsed : fallback;
};

export type ProviderName = 'anthropic' | 'ollama' | 'groq' | 'gemini' | 'echo';
export type DetectorName = 'local' | 'gptzero' | 'originality' | 'zerogpt';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface AppConfig {
  port: number;
  corsOrigin: string;
  scorerUrl: string;
  /**
   * How long to wait for one /score call.
   *
   * The old hardcoded 20s was measured on a Mac, where the model runs on the
   * GPU. A CPU-only VPS is several times slower on the same article, and the
   * timeout presented as "scoring service is unavailable" even though the
   * service was running normally. Generous by default; the loop still fails
   * rather than hanging forever.
   */
  scorerTimeoutMs: number;
  detectors: {
    /** Drives the loop. Make it the detector you are actually judged by. */
    primary: DetectorName;
    /** Second opinion on the input and final output only. */
    verify: DetectorName[];
    gptzeroKey?: string;
    originalityKey?: string;
    zerogptKey?: string;
    zerogptUrl?: string;
  };
  redisUrl?: string;
  /**
   * One password for the whole app. Unset means no password at all.
   *
   * Optional on purpose: blank is the default and leaves everything open,
   * which is right on your own machine. Set it the moment the server is
   * reachable by anyone but you, because the article library stores real work
   * on disk and there is no per-user login, so an open port is an open
   * filing cabinet.
   *
   * Distinct from the vendor API keys elsewhere in this file. Those are
   * machine credentials this app sends OUT to Anthropic and the detectors;
   * this is a word a person types IN.
   */
  accessPassword?: string;
  maxWords: number;
  rateLimitPerHour: number;
  rateLimitBurst: number;
  provider: ProviderName;
  anthropic: {
    apiKey?: string;
    model: string;
    effort: Effort;
    judgeModel: string;
    /**
     * Thinking during drafting. Disabling it roughly halves the bill, and the
     * claim that it costs no quality was validated against the local scorer,
     * which has since been shown not to track real detectors. Default is back
     * to on until that is measured properly.
     */
    thinking: 'adaptive' | 'disabled';
  };
  ollama: { url: string; model: string };
  groq: { apiKey?: string; model: string };
  gemini: { apiKey?: string; model: string };
  loop: {
    targetScore: number;
    maxIterations: number;
    chunkWords: number;
    /** Floor for the topical screen. Low on purpose: it is a screen. */
    minTopicalSimilarity: number;
    /** Run the semantic judge. The only layer that catches meaning reversal. */
    useJudge: boolean;
    /**
     * Points added to the objective per failing readability check. Set to 0
     * to optimise detection only.
     *
     * Read this against the scale it is added to. The objective is detection
     * plus this weight per failure, and detection here is the RAW local score,
     * which in practice moves inside a band of about four points: measured
     * document scores across a session sat at 5.3, 5.8, 6.2, 8.6 and 9.0.
     *
     * The old default of 5 therefore priced one failing readability check
     * above the entire detection range. Through the calibration mapping that
     * is roughly 44 ZeroGPT points per check, and it showed: a pass that made
     * detection WORSE, 8.6 to 9.0, was accepted because it cleared two
     * readability checks. At 0.5 a failing check is worth about four ZeroGPT
     * points, which still breaks ties toward readable copy without letting it
     * overrule the thing the tool exists to minimise.
     */
    readabilityWeight: number;
    /**
     * Fraction of chunks a follow-up pass rewrites, worst-scoring first.
     *
     * Pass one always rewrites the whole document: it is what establishes the
     * style, and the measurements are unambiguous that it carries most of the
     * gain. Passes after it are cumulative refinements on the accepted text,
     * so they can afford to be selective. At 0.34 a four-pass run costs about
     * half a four-pass run that rewrote everything every time.
     *
     * Set to 1 to restore the old behaviour of rewriting every chunk on every
     * pass.
     */
    targetShare: number;
    /** Bounded revision rounds on the generation path. */
    maxRevisions: number;
    /** Revise when over the detection target. Off: it measurably hurts. */
    reviseOnScore: boolean;
    /**
     * Run the full humanize loop over generated articles.
     *
     * This was removed once as a cost saving, on the evidence that it "added
     * little". That evidence came from the local scorer, which reads a
     * ZeroGPT 34 as a 6 and so could not see the loop working. A real
     * measurement afterwards put the same pipeline at 7 with the loop and 34
     * without it. It is the single most valuable component in the pipeline
     * and it is on by default.
     */
    humanizeGenerated: boolean;
    /**
     * Humanize each section as it is written, instead of the whole article
     * afterwards.
     *
     * An experiment, off by default. The theory is appealing: rewrite while
     * the text is still small and skip the expensive document-level loop. The
     * evidence against it is that the loop's gain comes from iterating against
     * a score measured on the ASSEMBLED article, and the two features that
     * score carries most about, burstiness and sentence-length variance, do
     * not exist inside a 200-word section. A section can be perfectly varied
     * on its own while ten of them in a row share the same rhythm.
     *
     * Turning this on REPLACES the document loop rather than adding to it, so
     * the two can be measured against each other at comparable cost.
     */
    inlineHumanize: boolean;
    /**
     * Send each humanize pass's chunk rewrites through the Batch API.
     *
     * Half the per-token price. The catch is latency: Anthropic commits to 24
     * hours and usually returns in minutes, and nothing the caller does
     * changes that. So this is off by default, because someone waiting on a
     * single article in the browser should not be handed an unbounded wait to
     * save four cents.
     *
     * It is the bulk path that wants this, and the bulk endpoint turns it on
     * per job regardless of this setting.
     *
     * Only the chunk rewrites can batch. They are the one phase whose calls
     * do not depend on each other. Drafting is sequential because each
     * section is given the tail of the one before, and the judge has nothing
     * to read until the rewrite it judges exists.
     */
    useBatch: boolean;
    /** How long runBatch waits before cancelling and giving up. */
    batchMaxWaitMs: number;
    /**
     * Flush the shared batch queue once this many requests are waiting.
     *
     * Bigger batches are cheaper per request in wall-clock terms, but a batch
     * cannot start until it is sent, so an oversized target just makes every
     * article wait for stragglers. The queue also flushes whenever every
     * article in flight is parked, which is the common case and makes this
     * mostly an upper bound.
     */
    batchQueueSize: number;
    /** Safety-net flush interval for the shared queue. */
    batchQueueWaitMs: number;
    /**
     * Hard ceiling on model spend for one article, in USD.
     *
     * Enforced two ways. Before generating, the pass count is planned down to
     * fit. During generating, the running total is checked between rewrite
     * passes and the loop stops rather than crossing the line. An article that
     * stops early is returned with a warning: spending more than agreed is a
     * worse failure than shipping a slightly weaker article.
     */
    maxCostPerArticle: number;
    /**
     * What happens when an article cannot be produced for the budget.
     *
     * 'strict' refuses before spending anything, naming the real minimum.
     * 'advisory' warns and runs the cheapest configuration anyway, which is
     * what this did before and is why a $0.10 cap was reliably producing
     * $0.18 articles.
     */
    budgetEnforcement: 'strict' | 'advisory';
  };
  library: {
    /** Where saved brands and their articles are written. */
    dir: string;
  };
  bulk: {
    /**
     * How many articles run at once in a bulk job.
     *
     * This is the dial that decides whether batching pays. Each article can
     * only offer the queue one call at a time for most of its life, so the
     * batch size is roughly the concurrency. Too low and every batch is tiny,
     * which costs the same as not batching but adds minutes of latency. Too
     * high and a single job floods the provider's rate limits and holds a lot
     * of half-finished articles in memory.
     */
    concurrency: number;
    /** Refuse jobs larger than this. A thousand articles is real money. */
    maxJobSize: number;
    /** Where job records and finished articles are written. */
    stateDir: string;
  };
}

export const loadConfig = (): AppConfig => ({
  port: int(process.env.API_PORT, 4000),
  corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:3000',
  scorerUrl: process.env.SCORER_URL ?? 'http://localhost:8000',
  scorerTimeoutMs: int(process.env.SCORER_TIMEOUT_MS, 120_000),
  detectors: {
    // Local by default so a clean clone costs nothing. Change it the moment
    // you know which detector you are actually being checked against.
    primary: (process.env.DETECTOR_PRIMARY as DetectorName) ?? 'local',
    verify: (process.env.DETECTOR_VERIFY ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean) as DetectorName[],
    gptzeroKey: process.env.GPTZERO_API_KEY,
    originalityKey: process.env.ORIGINALITY_API_KEY,
    zerogptKey: process.env.ZEROGPT_API_KEY,
    zerogptUrl: process.env.ZEROGPT_URL,
  },
  redisUrl: process.env.REDIS_URL,
  accessPassword: process.env.ACCESS_PASSWORD?.trim() || undefined,
  maxWords: int(process.env.MAX_WORDS, 1500),
  rateLimitPerHour: int(process.env.RATE_LIMIT_PER_HOUR, 20),
  rateLimitBurst: int(process.env.RATE_LIMIT_BURST, 5),
  // Default to echo, not a real provider: a clean clone has no key and no
  // Ollama running, and a pipeline that visibly does the deterministic pass
  // beats one that 500s on every request.
  provider: (process.env.LLM_PROVIDER as ProviderName) ?? 'echo',
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5',
    // Paraphrase is not a hard reasoning task, so low is the right default
    // here. It is the main cost dial short of changing model.
    effort: (process.env.ANTHROPIC_EFFORT as Effort) ?? 'low',
    // Pinned to the same model as the rewriter. A smaller judge would be
    // cheaper, but this deployment is deliberately single-model, so the
    // fallback must not reach a different one when the variable is unset.
    judgeModel: process.env.ANTHROPIC_JUDGE_MODEL ?? 'claude-sonnet-5',
    thinking:
      (process.env.ANTHROPIC_THINKING ?? 'adaptive') === 'disabled'
        ? 'disabled'
        : 'adaptive',
  },
  ollama: {
    url: process.env.OLLAMA_URL ?? 'http://localhost:11434',
    model: process.env.OLLAMA_MODEL ?? 'qwen2.5:7b-instruct',
  },
  groq: {
    apiKey: process.env.GROQ_API_KEY,
    model: process.env.GROQ_MODEL ?? 'llama-3.3-70b-versatile',
  },
  gemini: {
    apiKey: process.env.GEMINI_API_KEY,
    model: process.env.GEMINI_MODEL ?? 'gemini-2.0-flash',
  },
  loop: {
    targetScore: float(process.env.TARGET_SCORE, 30),
    maxIterations: int(process.env.MAX_ITERATIONS, 3),
    chunkWords: int(process.env.CHUNK_WORDS, 350),
    minTopicalSimilarity: float(process.env.MIN_TOPICAL_SIMILARITY, 0.1),
    useJudge: (process.env.FIDELITY_JUDGE ?? 'true').toLowerCase() !== 'false',
    // Each failing readability check costs this much in the objective, so a
    // rewrite that is two points worse on detection but fixes passive voice
    // wins. Without it the loop stops the moment detection hits target and
    // never spends a pass on readability at all.
    readabilityWeight: float(process.env.READABILITY_WEIGHT, 0.5),
    targetShare: Math.min(1, Math.max(0.1, float(process.env.TARGET_SHARE, 0.34))),
    maxRevisions: int(process.env.MAX_REVISIONS, 1),
    reviseOnScore: (process.env.REVISE_ON_SCORE ?? 'false').toLowerCase() === 'true',
    humanizeGenerated:
      (process.env.HUMANIZE_GENERATED ?? 'true').toLowerCase() !== 'false',
    inlineHumanize:
      (process.env.INLINE_HUMANIZE ?? 'false').toLowerCase() === 'true',
    useBatch: (process.env.USE_BATCH_API ?? 'false').toLowerCase() === 'true',
    batchMaxWaitMs: int(process.env.BATCH_MAX_WAIT_MS, 45 * 60 * 1000),
    batchQueueSize: int(process.env.BATCH_QUEUE_SIZE, 400),
    batchQueueWaitMs: int(process.env.BATCH_QUEUE_WAIT_MS, 20_000),
    maxCostPerArticle: float(process.env.MAX_COST_PER_ARTICLE, 0.1),
    budgetEnforcement:
      (process.env.BUDGET_ENFORCEMENT ?? 'strict').toLowerCase() === 'advisory'
        ? 'advisory'
        : 'strict',
  },
  library: {
    dir: process.env.LIBRARY_DIR ?? '.data',
  },
  bulk: {
    concurrency: int(process.env.BULK_CONCURRENCY, 25),
    maxJobSize: int(process.env.BULK_MAX_JOB_SIZE, 1000),
    stateDir: process.env.BULK_STATE_DIR ?? '.bulk',
  },
});

export const CONFIG = Symbol('APP_CONFIG');
