import type { ScorerService } from '../../scorer/scorer.service.js';
import type { Detector, DetectionResult, DetectorName } from '../detector.types.js';

/**
 * The in-house scorer, wrapped so the loop can treat it like any other
 * detector. Free and fast, which is why it stays the default, but it is a
 * proxy: it cannot tell you what a commercial detector will say.
 */
export class LocalDetector implements Detector {
  readonly name: DetectorName = 'local';
  readonly costPerCall = 0;

  constructor(private readonly scorer: ScorerService) {}

  isConfigured(): boolean {
    return true;
  }

  async detect(text: string): Promise<DetectionResult> {
    const result = await this.scorer.score(text, false);
    return { detector: this.name, score: result.ai_score, raw: result.metrics };
  }
}
