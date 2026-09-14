import { LlmError, type CompletionRequest,
  type CompletionResult, type LlmProvider } from '../llm.types.js';

/**
 * Local models via Ollama. Free, unlimited, private, and the recommended
 * development target. Rewrite quality is below a frontier API but paraphrase
 * under style constraints is an easy task, and the score loop can afford far
 * more iterations when each one costs nothing.
 */
export class OllamaProvider implements LlmProvider {
  readonly name = 'ollama';

  constructor(
    private readonly baseUrl: string,
    readonly model: string,
  ) {}

  isConfigured(): boolean {
    return Boolean(this.baseUrl);
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(120_000),
        body: JSON.stringify({
          model: this.model,
          stream: false,
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: request.user },
          ],
          options: {
            // Higher than a normal task on purpose. Low temperature produces
            // exactly the flat, predictable phrasing the detector penalises.
            temperature: request.temperature ?? 0.9,
            top_p: 0.95,
            num_predict: request.maxTokens ?? 2048,
            // Discourages the model from falling into its own house style.
            repeat_penalty: 1.15,
          },
        }),
      });
    } catch (cause) {
      throw new LlmError(
        `Cannot reach Ollama at ${this.baseUrl}. Is it running? (ollama serve)`,
        this.name,
        true,
      );
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      if (response.status === 404) {
        throw new LlmError(
          `Model "${this.model}" is not pulled. Run: ollama pull ${this.model}`,
          this.name,
        );
      }
      throw new LlmError(
        `Ollama returned ${response.status}: ${detail.slice(0, 200)}`,
        this.name,
        response.status >= 500,
      );
    }

    const payload = (await response.json()) as {
      message?: { content?: string };
      prompt_eval_count?: number;
      eval_count?: number;
    };
    const content = payload.message?.content?.trim();
    if (!content) throw new LlmError('Ollama returned an empty message', this.name, true);
    // Local inference has no dollar cost, but the token counts are still
    // useful for sizing prompts, so they are reported when present.
    return {
      text: content,
      usage: {
        inputTokens: payload.prompt_eval_count ?? 0,
        outputTokens: payload.eval_count ?? 0,
      },
    };
  }
}
