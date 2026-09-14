import {
  DetectorError,
  pickNumber,
  toPercent,
  type Detector,
  type DetectionResult,
  type DetectorName,
  type DetectorSentence,
} from '../detector.types.js';

interface GptZeroSentence {
  sentence?: string;
  generated_prob?: number;
  perplexity?: number;
  highlight_sentence_for_ai?: boolean;
}

interface GptZeroDocument {
  completely_generated_prob?: number;
  average_generated_prob?: number;
  overall_burstiness?: number;
  sentences?: GptZeroSentence[];
  class_probabilities?: { ai?: number; human?: number; mixed?: number };
}

/**
 * GPTZero.
 *
 * The best documented of the three, and the one whose response shape I trust
 * most. It also returns a per-sentence breakdown that maps directly onto the
 * heat map the UI already renders, so its output needs no reshaping.
 *
 * Docs: https://api.gptzero.me/v2/predict/text
 */
export class GptZeroDetector implements Detector {
  readonly name: DetectorName = 'gptzero';
  // Priced per word rather than per call on most plans. This is a rough
  // per-request figure for a page of text, used only for the spend estimate.
  readonly costPerCall = 0.002;

  constructor(private readonly apiKey?: string) {}

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  async detect(text: string): Promise<DetectionResult> {
    if (!this.apiKey) throw new DetectorError('GPTZERO_API_KEY is not set', this.name);

    let response: Response;
    try {
      response = await fetch('https://api.gptzero.me/v2/predict/text', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'x-api-key': this.apiKey,
        },
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({ document: text, multilingual: false }),
      });
    } catch {
      throw new DetectorError('GPTZero unreachable', this.name, true);
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new DetectorError(
        `GPTZero returned ${response.status}: ${detail.slice(0, 200)}`,
        this.name,
        response.status === 429 || response.status >= 500,
      );
    }

    const payload = (await response.json()) as { documents?: GptZeroDocument[] };
    const document = payload.documents?.[0];

    const found = pickNumber(payload, [
      'documents.0.completely_generated_prob',
      'documents.0.class_probabilities.ai',
      'documents.0.average_generated_prob',
    ]);

    if (!found) {
      throw new DetectorError(
        'GPTZero response had no recognised score field. Payload keys: ' +
          `${Object.keys(document ?? payload).join(', ')}`,
        this.name,
      );
    }

    const sentences: DetectorSentence[] | undefined = document?.sentences
      ?.filter((entry): entry is GptZeroSentence & { sentence: string } =>
        typeof entry.sentence === 'string',
      )
      .map((entry) => ({
        text: entry.sentence,
        score: toPercent(entry.generated_prob ?? 0),
      }));

    return {
      detector: this.name,
      score: Number(toPercent(found.value).toFixed(1)),
      sentences,
      raw: payload,
    };
  }
}
