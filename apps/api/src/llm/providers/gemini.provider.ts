import { LlmError, type CompletionRequest,
  type CompletionResult, type LlmProvider } from '../llm.types.js';

/**
 * Google Gemini. The most generous free tier of the hosted options at time of
 * writing, but quotas move, so verify the current limits yourself.
 */
export class GeminiProvider implements LlmProvider {
  readonly name = 'gemini';

  constructor(
    private readonly apiKey: string | undefined,
    readonly model: string,
  ) {}

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    if (!this.apiKey) throw new LlmError('GEMINI_API_KEY is not set', this.name);

    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/` +
      `${this.model}:generateContent`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Header rather than a query parameter, so the key never lands in a
        // proxy access log.
        'x-goog-api-key': this.apiKey,
      },
      signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: request.system }] },
        contents: [{ role: 'user', parts: [{ text: request.user }] }],
        generationConfig: {
          temperature: request.temperature ?? 0.9,
          topP: 0.95,
          maxOutputTokens: request.maxTokens ?? 2048,
        },
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new LlmError(
        `Gemini returned ${response.status}: ${detail.slice(0, 200)}`,
        this.name,
        response.status === 429 || response.status >= 500,
      );
    }

    const payload = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };
    const content = payload.candidates?.[0]?.content?.parts
      ?.map((part) => part.text ?? '')
      .join('')
      .trim();
    if (!content) throw new LlmError('Gemini returned no candidates', this.name, true);
    return {
      text: content,
      usage: {
        inputTokens: payload.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: payload.usageMetadata?.candidatesTokenCount ?? 0,
      },
    };
  }
}
