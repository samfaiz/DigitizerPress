import {
  DetectorError,
  pickNumber,
  toPercent,
  type Detector,
  type DetectionResult,
  type DetectorName,
} from '../detector.types.js';

/**
 * ZeroGPT.
 *
 * The one this project was originally modelled on, and the least certain of
 * the three to integrate. ZeroGPT ships several different APIs across several
 * domains (zerogpt.com, zerogpt.net, api.zerogpt.org, plus a RapidAPI listing)
 * with different paths, different auth headers and different field names.
 *
 * The endpoint and header are therefore configurable rather than hardcoded.
 * If the default does not match the plan you bought, set ZEROGPT_URL rather
 * than editing this file. The parser tries the field names used across the
 * variants and reports what it actually received when none match.
 */
export class ZeroGptDetector implements Detector {
  readonly name: DetectorName = 'zerogpt';
  readonly costPerCall = 0.001;

  constructor(
    private readonly apiKey?: string,
    private readonly url = 'https://api.zerogpt.com/api/detect/detectText',
  ) {}

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  async detect(text: string): Promise<DetectionResult> {
    if (!this.apiKey) throw new DetectorError('ZEROGPT_API_KEY is not set', this.name);

    let response: Response;
    try {
      response = await fetch(this.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ApiKey: this.apiKey,
        },
        signal: AbortSignal.timeout(30_000),
        // Variants disagree on the field name, so both are sent. Extra keys
        // are ignored by every JSON API I know of.
        body: JSON.stringify({ input_text: text, text }),
      });
    } catch {
      throw new DetectorError(`ZeroGPT unreachable at ${this.url}`, this.name, true);
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new DetectorError(
        `ZeroGPT returned ${response.status}: ${detail.slice(0, 200)}`,
        this.name,
        response.status === 429 || response.status >= 500,
      );
    }

    const payload = (await response.json()) as Record<string, unknown>;

    const ai = pickNumber(payload, [
      'data.fakePercentage',
      'fakePercentage',
      'data.isGPTGenerated',
      'is_gpt_generated',
      'gpt_generated_percentage',
    ]);
    const human = pickNumber(payload, ['data.humanPercentage', 'is_human_written']);

    if (!ai && !human) {
      throw new DetectorError(
        'ZeroGPT response had no recognised score field. Top-level keys: ' +
          `${Object.keys(payload).join(', ')}. ` +
          'Set ZEROGPT_URL if your plan uses a different endpoint.',
        this.name,
      );
    }

    const score = ai
      ? toPercent(ai.value)
      : 100 - toPercent((human as { value: number }).value);

    return {
      detector: this.name,
      score: Number(score.toFixed(1)),
      raw: payload,
    };
  }
}
