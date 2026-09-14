import { Inject, Injectable, Logger } from '@nestjs/common';
import { CONFIG, type AppConfig } from '../config/configuration.js';
import { ScorerService } from '../scorer/scorer.service.js';
import { GptZeroDetector } from './providers/gptzero.detector.js';
import { LocalDetector } from './providers/local.detector.js';
import { OriginalityDetector } from './providers/originality.detector.js';
import { ZeroGptDetector } from './providers/zerogpt.detector.js';
import type {
  DetectionResult,
  Detector,
  DetectorName,
  DetectorReading,
} from './detector.types.js';

/**
 * Chooses which detector the loop optimises against, and which ones give a
 * second opinion at the end.
 *
 * The split exists for cost. The primary detector runs on every candidate of
 * every pass, so with three passes that is three calls. The verify set runs
 * exactly twice per request, once on the input and once on the final output.
 * Pointing all three at the primary slot would triple your detection bill for
 * no extra signal, because the loop can only optimise one number.
 *
 * Which one to make primary is a real decision. Make it the detector you are
 * actually judged by. Optimising against `local` and then checking the result
 * on Originality is the exact mismatch this module exists to remove.
 */
@Injectable()
export class DetectorService {
  private readonly logger = new Logger(DetectorService.name);
  private readonly available = new Map<DetectorName, Detector>();

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly scorer: ScorerService,
  ) {
    const { detectors } = this.config;
    const candidates: Detector[] = [
      new LocalDetector(this.scorer),
      new GptZeroDetector(detectors.gptzeroKey),
      new OriginalityDetector(detectors.originalityKey),
      new ZeroGptDetector(detectors.zerogptKey, detectors.zerogptUrl),
    ];

    for (const detector of candidates) {
      if (detector.isConfigured()) this.available.set(detector.name, detector);
    }

    const primary = this.primaryName;
    if (primary !== 'local' && !this.available.has(primary)) {
      this.logger.warn(
        `Primary detector "${primary}" has no API key, falling back to local. ` +
          'The loop will optimise a proxy, not the detector you are judged by.',
      );
    }
    this.logger.log(
      `Detectors: primary=${this.primaryName}, ` +
        `verify=[${this.verifyNames.join(', ') || 'none'}]`,
    );
  }

  /** The detector the loop optimises against. Falls back to local. */
  get primaryName(): DetectorName {
    const requested = this.config.detectors.primary;
    return this.available.has(requested) ? requested : 'local';
  }

  /** Detectors that give a second opinion on the input and final output. */
  get verifyNames(): DetectorName[] {
    return this.config.detectors.verify.filter((name) => this.available.has(name));
  }

  /** Estimated USD spend for one humanize request at the given pass count. */
  estimateCost(passes: number): number {
    const primary = this.available.get(this.primaryName);
    const perPass = (primary?.costPerCall ?? 0) * passes;
    const verify = this.verifyNames.reduce(
      (total, name) => total + (this.available.get(name)?.costPerCall ?? 0) * 2,
      0,
    );
    return Number((perPass + verify).toFixed(4));
  }

  async detectPrimary(text: string): Promise<DetectionResult> {
    const detector = this.available.get(this.primaryName);
    if (!detector) {
      // Only reachable if the local scorer itself was removed from the map.
      throw new Error('No detector is available');
    }
    return detector.detect(text);
  }

  /**
   * Run the verify set. Never throws: a detector that is down or misparses
   * must degrade this panel, not fail the user's whole request. Each failure
   * is reported in place so the cause is visible rather than silently absent.
   */
  async verify(text: string): Promise<DetectorReading[]> {
    const names = this.verifyNames;
    if (names.length === 0) return [];

    return Promise.all(
      names.map(async (name): Promise<DetectorReading> => {
        try {
          const result = await this.available.get(name)!.detect(text);
          return { detector: name, score: result.score };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.warn(`verify via ${name} failed: ${message}`);
          return { detector: name, score: null, error: message };
        }
      }),
    );
  }

  /**
   * Send a short known sample to every configured detector and report what
   * came back.
   *
   * Worth its own endpoint because the alternative is discovering a bad key,
   * a wrong endpoint or an unparseable response only after paying for a full
   * generation run. The sample is deliberately obvious machine text, so a
   * working detector should return a high number: a detector that answers 200
   * with a score near zero here is misconfigured, not lenient.
   */
  async selfTest(): Promise<
    Array<{
      detector: DetectorName;
      ok: boolean;
      score: number | null;
      ms: number;
      error?: string;
    }>
  > {
    const sample =
      'Artificial intelligence has become a pivotal technology in the modern ' +
      'business landscape. Moreover, organizations increasingly leverage robust ' +
      'machine learning frameworks to facilitate data-driven decision making. ' +
      'Furthermore, this comprehensive approach underscores the multifaceted ' +
      'nature of digital transformation across every sector of the economy. ' +
      'In conclusion, companies that embark on this journey will unlock value.';

    const names = [...this.available.keys()].filter((name) => name !== 'local');
    if (names.length === 0) return [];

    return Promise.all(
      names.map(async (name) => {
        const started = Date.now();
        try {
          const result = await this.available.get(name)!.detect(sample);
          return {
            detector: name,
            ok: true,
            score: result.score,
            ms: Date.now() - started,
          };
        } catch (error) {
          return {
            detector: name,
            ok: false,
            score: null,
            ms: Date.now() - started,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );
  }

  /** Which detectors are usable, for the frontend to report honestly. */
  status(): Array<{ name: DetectorName; configured: boolean; role: string }> {
    const all: DetectorName[] = ['local', 'gptzero', 'originality', 'zerogpt'];
    return all.map((name) => ({
      name,
      configured: this.available.has(name),
      role:
        name === this.primaryName
          ? 'primary'
          : this.verifyNames.includes(name)
            ? 'verify'
            : 'unused',
    }));
  }
}
