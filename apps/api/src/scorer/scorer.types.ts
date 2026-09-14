/**
 * Wire format of services/scorer. Keep in sync with app/schemas.py.
 */

export type Verdict = 'human' | 'mixed' | 'ai';

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
  /** Example sentences failing this check, for targeted retry guidance. */
  offenders: string[];
}

export interface Readability {
  word_count: number;
  sentence_count: number;
  checks: ReadabilityCheck[];
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
  /**
   * The score projected onto a commercial detector's scale. Compare THIS with
   * what a user sees on ZeroGPT: `ai_score` is the raw internal number and
   * sits on a much narrower scale, where a 6 corresponds to roughly a 35.
   */
  estimated_external: number;
  estimated_external_target: string;
  estimated_external_confidence: string;
  readability: Readability;
  elapsed_ms: number;
}

/**
 * Rarity-weighted lexical overlap. A screen for wholesale topic replacement,
 * not a judgement about meaning. See services/scorer/app/similarity.py.
 */
export interface SimilarityResult {
  cosine: number;
  anchor_retention: number;
  anchors_lost: string[];
  weighted: boolean;
}
