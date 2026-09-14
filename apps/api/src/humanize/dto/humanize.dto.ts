import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import type { StyleId } from '../pipeline/deterministic.js';
import type { ScoreResult } from '../../scorer/scorer.types.js';
import type { FidelityReport } from '../pipeline/fidelity.js';
import type { DetectorName, DetectorReading } from '../../detectors/detector.types.js';

export const STYLE_IDS = ['standard', 'academic', 'casual', 'simple'] as const;

export class HumanizeDto {
  @IsString()
  @MinLength(40, { message: 'Text must be at least 40 characters to score meaningfully.' })
  @MaxLength(60_000)
  text!: string;

  @IsOptional()
  @IsIn(STYLE_IDS)
  style?: StyleId;

  /**
   * Skip the LLM and run only the deterministic pass. Free, instant, and a
   * useful comparison point for judging what the model is actually adding.
   */
  @IsOptional()
  @IsBoolean()
  deterministicOnly?: boolean;
}

/**
 * Rewrite one sentence of a document, addressed by character offsets.
 *
 * Offsets rather than the sentence text, because the same sentence can appear
 * twice and the caller means a specific one. They come straight from the
 * scorer's per-sentence output, which is what the heat map is drawn from.
 */
export class RephraseSpanDto {
  @IsString()
  @MinLength(40)
  @MaxLength(60_000)
  text!: string;

  @IsInt()
  @Min(0)
  start!: number;

  @IsInt()
  @Min(1)
  end!: number;

  @IsOptional()
  @IsIn(STYLE_IDS)
  style?: StyleId;
}

export class ScoreDto {
  @IsString()
  @MinLength(1)
  @MaxLength(60_000)
  text!: string;
}

/** One rewrite pass, kept so the UI can show the loop's work. */
export interface IterationTrace {
  pass: number;
  score: number;
  /** Topical overlap for this candidate, 0 when the screen did not run. */
  fidelity: number;
  accepted: boolean;
  note: string;
}

/**
 * Second opinions from external detectors, on the input and the final output.
 *
 * This is the panel that answers the question the local score cannot: did the
 * rewrite move the number you are actually judged by?
 */
export interface Verification {
  primary: DetectorName;
  before: DetectorReading[];
  after: DetectorReading[];
  /** Rough USD spent on detector calls for this request. */
  estimatedCost: number;
}

/** Tokens and dollars spent on model calls for this one request. */
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
  /** False when the rewrite ran without a real model behind it. */
  llmActive: boolean;
  deterministicRules: string[];
  elapsedMs: number;
  warnings: string[];
  /** Null when no verify detectors are configured. */
  verification: Verification | null;
  usage: UsageSummary;
}

/** One sentence rewritten in place, with the document rescored around it. */
export interface SpanRephraseResponse {
  /** False when the fidelity guard rejected the rewrite. Nothing changed. */
  applied: boolean;
  sentence: string;
  replacement: string;
  /** The whole document, with the replacement spliced in when applied. */
  text: string;
  score: ScoreResult;
  /** Why it was rejected. Null when applied. */
  reason: string | null;
  usage: UsageSummary;
}
