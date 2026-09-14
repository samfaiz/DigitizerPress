/**
 * External AI detectors.
 *
 * The local scorer is a proxy. It is calibrated against a handful of documents
 * and cannot tell you what GPTZero or Originality will say about your text.
 * If you are judged by one of those, the loop has to optimise against that one
 * directly, which is what this module is for.
 *
 * A note on trust in these implementations. The endpoint shapes below come
 * from vendor documentation, not from a live call: this code was written
 * without keys for any of the three, so none of the parsing has been exercised
 * against a real response. GPTZero's shape is well documented and is the one I
 * would trust first. The other two are assembled from vendor docs and
 * third-party write-ups, and ZeroGPT in particular ships several different
 * APIs across its domains with different field names.
 *
 * Every parser therefore tries a list of known field paths and throws a loud,
 * specific error naming what actually came back if none of them match. That is
 * deliberate: a detector that silently returns a wrong number is worse than one
 * that fails, because the loop would optimise against noise.
 */

export type DetectorName = 'local' | 'gptzero' | 'originality' | 'zerogpt';

export interface DetectorSentence {
  text: string;
  /** 0-100, where 100 means most machine-like. */
  score: number;
}

export interface DetectionResult {
  detector: DetectorName;
  /** 0-100 percent AI. Normalised across vendors, who each use their own scale. */
  score: number;
  sentences?: DetectorSentence[];
  /** Vendor payload, kept so a mis-parse can be diagnosed from the response. */
  raw?: unknown;
}

/** One detector's opinion, including the case where it could not be reached. */
export interface DetectorReading {
  detector: DetectorName;
  score: number | null;
  error?: string;
}

export interface Detector {
  readonly name: DetectorName;
  isConfigured(): boolean;
  /** Cost per call in USD, for the response's spend estimate. 0 for local. */
  readonly costPerCall: number;
  detect(text: string): Promise<DetectionResult>;
}

export class DetectorError extends Error {
  constructor(
    message: string,
    readonly detector: DetectorName,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'DetectorError';
  }
}

/**
 * Pull a number out of a vendor payload by trying known paths in order.
 *
 * Vendors rename fields between API versions and this code cannot be tested
 * against a live response, so a single hardcoded path would be a silent
 * failure waiting to happen.
 */
export function pickNumber(
  payload: unknown,
  paths: string[],
): { value: number; path: string } | null {
  for (const path of paths) {
    let cursor: unknown = payload;
    for (const segment of path.split('.')) {
      if (cursor === null || typeof cursor !== 'object') {
        cursor = undefined;
        break;
      }
      const index = Number(segment);
      cursor = Number.isInteger(index)
        ? (cursor as unknown[])[index]
        : (cursor as Record<string, unknown>)[segment];
    }
    if (typeof cursor === 'number' && Number.isFinite(cursor)) {
      return { value: cursor, path };
    }
  }
  return null;
}

/**
 * Normalise a vendor score to 0-100.
 *
 * Some return a probability in 0-1, some a percentage in 0-100. Guessing from
 * the magnitude is the only option without a live response, and it has one
 * genuine ambiguity: a value of exactly 1 could be 1% or 100%. Treated as 100%,
 * because a probability of 1.0 is far more common in these payloads than a
 * percentage of 1.
 */
export function toPercent(value: number): number {
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value <= 1 ? value * 100 : value;
}
