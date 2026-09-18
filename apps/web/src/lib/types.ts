/** Mirrors apps/api/src/scorer/scorer.types.ts and the humanize DTO. */

export type Verdict = 'human' | 'mixed' | 'ai';
export type StyleId = 'standard' | 'academic' | 'casual' | 'simple';

export interface SentenceScore {
  index: number;
  text: string;
  start: number;
  end: number;
  words: number;
  perplexity: number;
  ai_score: number;
  scored: boolean;
}

export interface ScoreMetrics {
  perplexity: number;
  log_perplexity: number;
  burstiness: number;
  sentence_length_cv: number;
  mean_sentence_words: number;
  type_token_ratio: number;
  repeated_trigram_rate: number;
  tell_word_rate: number;
  em_dash_rate: number;
  punctuation_variety: number;
  paragraph_length_cv: number;
  mean_word_length: number;
}

export interface ReadabilityCheck {
  id: string;
  label: string;
  value: number;
  target: string;
  status: 'good' | 'warn' | 'bad';
  detail: string;
  /**
   * Sentences failing this check. The scoring service has always sent these
   * and this type simply did not declare them, so the UI could not name the
   * sentence a reader is meant to fix.
   */
  offenders?: string[];
}

export interface Readability {
  word_count: number;
  sentence_count: number;
  checks: ReadabilityCheck[];
}

export interface UsageSummary {
  calls: number;
  /** How many of those calls were billed at the Batch API half rate. */
  batchedCalls: number;
  inputTokens: number;
  outputTokens: number;
  /** Tokens served from the prompt cache, billed at a tenth of input. */
  cacheReadTokens: number;
  /** Tokens written into the cache, billed once at 1.25x input. */
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number;
  byModel: Array<{ model: string; calls: number; tokens: number; costUsd: number }>;
}

export interface ScoreResult {
  ai_score: number;
  verdict: Verdict;
  confidence: number;
  metrics: ScoreMetrics;
  sentences: SentenceScore[];
  word_count: number;
  backend: string;
  model: string;
  calibrated: boolean;
  /** Projected onto a commercial detector's scale. The number that matters. */
  estimated_external: number;
  estimated_external_target: string;
  estimated_external_confidence: string;
  readability: Readability;
  elapsed_ms: number;
}

export interface JudgeResult {
  verdict: 'same' | 'drifted' | 'unknown';
  reason: string;
}

export interface FidelityReport {
  passed: boolean;
  reasons: string[];
  lengthRatio: number;
  missingNumbers: string[];
  unrestoredPlaceholders: string[];
  /** Rarity-weighted topical overlap, or null when the screen did not run. */
  topicalSimilarity: number | null;
  /** Null when no judge ran. Never render null as a pass. */
  judge: JudgeResult | null;
}

export interface IterationTrace {
  pass: number;
  score: number;
  fidelity: number;
  accepted: boolean;
  note: string;
}

export type DetectorName = 'local' | 'gptzero' | 'originality' | 'zerogpt';

export interface DetectorReading {
  detector: DetectorName;
  score: number | null;
  error?: string;
}

export interface Verification {
  primary: DetectorName;
  before: DetectorReading[];
  after: DetectorReading[];
  estimatedCost: number;
}

export interface HumanizeResponse {
  original: string;
  humanized: string;
  before: ScoreResult;
  after: ScoreResult;
  fidelity: FidelityReport;
  iterations: IterationTrace[];
  style: StyleId;
  provider: string;
  model: string;
  llmActive: boolean;
  deterministicRules: string[];
  elapsedMs: number;
  warnings: string[];
  verification: Verification | null;
  usage: UsageSummary;
}

export interface PublicConfig {
  /** True when the server expects a shared password on every other route. */
  passwordRequired?: boolean;
  maxWords: number;
  rateLimitPerHour: number;
  targetScore: number;
  styles: Array<{ id: StyleId; label: string; description: string }>;
  provider: { name: string; model: string; live: boolean };
  scorer: { ok: boolean; detail?: { backend: string; model: string; calibrated: boolean } };
  detectors: {
    primary: DetectorName;
    verify: DetectorName[];
    available: Array<{ name: DetectorName; configured: boolean; role: string }>;
  };
}


// --- Content generation ---

export interface Product {
  name: string;
  url?: string;
  /** The factual boundary for this product. Nothing outside it is claimed. */
  note?: string;
}

export interface Brief {
  topic: string;
  primaryKeyword: string;
  secondaryKeywords?: string[];
  /**
   * Semantically related terms. Different job from secondary keywords: those
   * are terms the page tries to rank for and need density, these are
   * supporting vocabulary where one use is enough.
   */
  lsiKeywords?: string[];
  brandName: string;
  brandDescription: string;
  audience?: string;
  region?: string;
  /** Hard exclusions: competitors, banned claims, forbidden phrasing. */
  avoidTerms?: string[];
  /** Honest drawbacks to work in. Balance reads more human than promotion. */
  drawbacks?: string[];
  /** Terms kept out of the title, meta and headings. */
  negativeKeywords?: string[];
  callToAction?: string;
  internalLinks?: string[];
  products?: Product[];
  /** FAQ section in the article body. Defaults to on. */
  includeFaq?: boolean;
  authorName?: string;
  authorRole?: string;
  authorBio?: string;
  experienceNotes?: string;
  brandUrl?: string;
  brandLinks?: string[];
  ctaUrl?: string;
  keywordMode?: 'natural' | 'exact';
  voiceSamples?: string[];
  voiceProfile?: {
    features: string[];
    excerpts: string[];
    cadence?: string;
    vocabulary?: string;
    quirks?: string[];
  };
  wordCount?: number;
  style?: StyleId;
}

export interface OutlineSection {
  heading: string;
  level: 'h2' | 'h3';
  intent: string;
  targetWords?: number;
}

export interface Outline {
  h1: string;
  sections: OutlineSection[];
}

export interface KeywordSuggestion {
  term: string;
  reason: string;
}

export interface KeywordResponse {
  lsiKeywords: KeywordSuggestion[];
  usage: UsageSummary;
}

export interface OutlineResponse {
  outline: Outline;
  estimatedWords: number;
  usage: UsageSummary;
  warnings: string[];
}

export interface SeoPackage {
  titleTag: string;
  metaDescription: string;
  slug: string;
  h1: string;
  imageAlt: string[];
  faq: Array<{ question: string; answer: string }>;
  schema: string;
  keywordUsage: Array<{ keyword: string; count: number; density: number }>;
}

export interface ComplianceCheck {
  id: string;
  label: string;
  status: 'good' | 'warn' | 'bad';
  detail: string;
  /** Present only on a failing check. A suggestion you can act on. */
  fix?: { label: string; kind: 'auto' | 'revise' | 'manual'; instruction: string };
}

export interface FactFlag {
  text: string;
  kind: 'statistic' | 'date' | 'superlative' | 'named-entity';
  inBrief: boolean;
}

export interface DraftResponse {
  /**
   * Where the server filed this article, or null if it could not.
   *
   * Filing is automatic and best-effort: an article that cost money and
   * minutes should not depend on the user remembering a button, but a filing
   * problem must not fail the generation either.
   */
  saved?: { slug: string; id: string } | null;
  markdown: string;
  seo: SeoPackage;
  score: ScoreResult;
  compliance: ComplianceCheck[];
  factFlags: FactFlag[];
  humanizePasses: Array<{ pass: number; score: number; accepted: boolean; note: string }>;
  verification: Verification | null;
  usage: UsageSummary;
  warnings: string[];
  elapsedMs: number;
  // Grading is part of every draft, not a separate mode.
  scorecard: Scorecard;
  gates: GateResult[];
  attempts: DraftAttempt[];
  /** False when the article never cleared the threshold. Returned anyway. */
  delivered: boolean;
}

// --- The delivery contract ---

export interface ScoreLine {
  label: string;
  earned: number;
  max: number;
  detail: string;
}

export interface ScoreCategory {
  id: string;
  label: string;
  earned: number;
  max: number;
  lines: ScoreLine[];
}

export interface Scorecard {
  total: number;
  band: 'exceptional' | 'strong' | 'acceptable' | 'below' | 'rewrite';
  categories: ScoreCategory[];
  critical: string[];
}

export interface GateResult {
  gate: string;
  passed: boolean;
  detail: string;
}

export interface DraftAttempt {
  attempt: number;
  total: number;
  band: string;
  passed: boolean;
  blockedBy: string[];
}


/** One sentence rewritten in place. See POST /api/rephrase-span. */
export interface SpanRephraseResponse {
  applied: boolean;
  sentence: string;
  replacement: string;
  text: string;
  score: ScoreResult;
  reason: string | null;
  usage: UsageSummary;
}

/** A brand saved on the server, with how many articles are filed under it. */
export interface SavedBrand {
  slug: string;
  brandName: string;
  brandDescription: string;
  audience?: string;
  region?: string;
  avoidTerms?: string[];
  drawbacks?: string[];
  negativeKeywords?: string[];
  callToAction?: string;
  internalLinks?: string[];
  products?: Product[];
  style?: StyleId;
  wordCount?: number;
  createdAt?: number;
  updatedAt?: number;
  /** Only present on the list endpoint. */
  articles?: number;
}

/** One row of the library. Small on purpose: see SavedArticleMeta on the API. */
export interface SavedArticleMeta {
  id: string;
  slug: string;
  topic: string;
  title: string;
  words: number;
  score: number;
  estimatedExternal: number;
  scorecard: number | null;
  delivered: boolean;
  costUsd: number;
  savedAt: number;
  note?: string;
  /** Where it was published. Typed in by hand after publishing. */
  url?: string;
  /** SEO fields copied up so a listing can show them without opening files. */
  titleTag?: string;
  metaDescription?: string;
  seoSlug?: string;
}
