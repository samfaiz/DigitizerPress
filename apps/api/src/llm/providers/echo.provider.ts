import type {
  CompletionRequest,
  CompletionResult,
  LlmProvider,
} from '../llm.types.js';

/**
 * Returns the input unchanged.
 *
 * This exists so a clean clone runs the entire pipeline with no model, no key
 * and no download. The masking, chunking, deterministic rewrite, scoring and
 * fidelity stages all still execute and can be developed against. Only the
 * LLM paraphrase is a no-op, and the score barely moves, which is the correct
 * and visible outcome rather than a silent one.
 */
export class EchoProvider implements LlmProvider {
  readonly name = 'echo';
  readonly model = 'passthrough';

  isConfigured(): boolean {
    return true;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    // The user message ends with the passage after a fixed marker. Returning
    // it verbatim keeps the downstream contract identical to a real provider.
    const marker = request.user.lastIndexOf('---\n');
    return {
      text: marker === -1 ? request.user : request.user.slice(marker + 4).trim(),
    };
  }
}
