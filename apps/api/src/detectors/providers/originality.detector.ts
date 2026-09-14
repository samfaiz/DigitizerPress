import {
  DetectorError,
  pickNumber,
  toPercent,
  type Detector,
  type DetectionResult,
  type DetectorName,
  type DetectorSentence,
} from '../detector.types.js';

/**
 * Originality.ai.
 *
 * The strictest of the three and the usual choice for agencies, so it is the
 * hardest target to satisfy. Paid per scan with no free tier.
 *
 * Response shape here is assembled from vendor docs rather than a live call,
 * so the score is located by trying several known paths. Their own guidance
 * notes that accuracy drops below 100 words, which is worth respecting: a
 * short paragraph will produce an unstable reading no matter what you do to it.
 */
export class OriginalityDetector implements Detector {
  readonly name: DetectorName = 'originality';
  readonly costPerCall = 0.01;

  constructor(
    private readonly apiKey?: string,
    private readonly modelVersion = '1',
  ) {}

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  async detect(text: string): Promise<DetectionResult> {
    if (!this.apiKey) {
      throw new DetectorError('ORIGINALITY_API_KEY is not set', this.name);
    }

    let response: Response;
    try {
      response = await fetch('https://api.originality.ai/api/v1/scan/ai', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // Their docs use this exact casing. HTTP headers are case
          // insensitive, so a proxy lowercasing it is harmless.
          'X-OAI-API-KEY': this.apiKey,
        },
        signal: AbortSignal.timeout(45_000),
        body: JSON.stringify({ content: text, aiModelVersion: this.modelVersion }),
      });
    } catch {
      throw new DetectorError('Originality.ai unreachable', this.name, true);
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new DetectorError(
        `Originality.ai returned ${response.status}: ${detail.slice(0, 200)}`,
        this.name,
        response.status === 429 || response.status >= 500,
      );
    }

    const payload = (await response.json()) as Record<string, unknown>;

    // They report an AI share and an "original" share. Prefer the AI field;
    // fall back to inverting the original one.
    const ai = pickNumber(payload, [
      'score.ai',
      'ai_score',
      'score.fake',
      'result.score.ai',
    ]);
    const original = pickNumber(payload, ['score.original', 'score.real']);

    if (!ai && !original) {
      throw new DetectorError(
        'Originality.ai response had no recognised score field. Top-level keys: ' +
          `${Object.keys(payload).join(', ')}`,
        this.name,
      );
    }

    const score = ai
      ? toPercent(ai.value)
      : 100 - toPercent((original as { value: number }).value);

    const blocks = (payload.blocks ?? []) as Array<Record<string, unknown>>;
    const sentences: DetectorSentence[] | undefined = Array.isArray(blocks)
      ? blocks
          .map((block) => {
            const text = block.text;
            const found = pickNumber(block, ['result.fake', 'result.ai', 'ai_score']);
            if (typeof text !== 'string' || !found) return null;
            return { text, score: toPercent(found.value) };
          })
          .filter((entry): entry is DetectorSentence => entry !== null)
      : undefined;

    return {
      detector: this.name,
      score: Number(score.toFixed(1)),
      sentences: sentences?.length ? sentences : undefined,
      raw: payload,
    };
  }
}
