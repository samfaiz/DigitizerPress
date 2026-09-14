import { LlmError, type CompletionRequest,
  type CompletionResult, type LlmProvider } from '../llm.types.js';

/**
 * Groq's OpenAI-compatible endpoint. Free tier, very fast inference on open
 * models. Check the current rate limits and whether the tier permits your use
 * before you rely on it in production.
 */
export class GroqProvider implements LlmProvider {
  readonly name = 'groq';

  constructor(
    private readonly apiKey: string | undefined,
    readonly model: string,
  ) {}

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    if (!this.apiKey) throw new LlmError('GROQ_API_KEY is not set', this.name);

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({
        model: this.model,
        temperature: request.temperature ?? 0.9,
        top_p: 0.95,
        max_tokens: request.maxTokens ?? 2048,
        frequency_penalty: 0.3,
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: request.user },
        ],
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new LlmError(
        `Groq returned ${response.status}: ${detail.slice(0, 200)}`,
        this.name,
        response.status === 429 || response.status >= 500,
      );
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = payload.choices?.[0]?.message?.content?.trim();
    if (!content) throw new LlmError('Groq returned no choices', this.name, true);
    return {
      text: content,
      usage: {
        inputTokens: payload.usage?.prompt_tokens ?? 0,
        outputTokens: payload.usage?.completion_tokens ?? 0,
      },
    };
  }
}
