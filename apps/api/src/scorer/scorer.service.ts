import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { CONFIG, type AppConfig } from '../config/configuration.js';
import type { ScoreResult, SimilarityResult } from './scorer.types.js';

/**
 * Thin client for the Python scoring service.
 *
 * This is the only place the gateway talks to the scorer, and it is
 * deliberately the only thing the scorer is used for. Keeping the detector
 * behind one narrow interface is what stops the humanizer from quietly
 * training against its own grader.
 */
@Injectable()
export class ScorerService {
  private readonly logger = new Logger(ScorerService.name);

  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  async score(text: string, withSentences = true): Promise<ScoreResult> {
    const controller = new AbortController();
    // The loop calls this several times per request, so a hung scorer must
    // fail rather than hold the user's request open until the proxy kills it.
    //
    // 20 seconds was the old value and it was measured on a Mac, where the
    // model runs on the GPU. A plain VPS has neither CUDA nor Metal, and
    // distilgpt2 over a 2,000-word article on a shared vCPU can take
    // considerably longer. The result was a working scorer being reported as
    // a dead one. Configurable now, and generous by default.
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.config.scorerTimeoutMs);

    try {
      const response = await fetch(`${this.config.scorerUrl}/score`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, sentences: withSentences }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new ServiceUnavailableException(
          `scorer returned ${response.status}: ${detail.slice(0, 200)}`,
        );
      }

      return (await response.json()) as ScoreResult;
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;

      // Two very different failures used to share one message, and the
      // message named the wrong one. A slow scorer was reported as an absent
      // scorer, which sends you to `systemctl status` to look at a process
      // that is running perfectly well.
      if (timedOut) {
        const seconds = Math.round(this.config.scorerTimeoutMs / 1000);
        this.logger.error(
          `scorer did not answer within ${seconds}s at ${this.config.scorerUrl}`,
        );
        throw new ServiceUnavailableException(
          `The scoring service took longer than ${seconds}s to answer. It is ` +
            'running, just slow: this is usual for long articles on a CPU-only ' +
            'server. Raise SCORER_TIMEOUT_MS, or use a shorter article.',
        );
      }

      this.logger.error(`scorer unreachable at ${this.config.scorerUrl}`, error as Error);
      throw new ServiceUnavailableException(
        'Scoring service is not reachable at ' +
          `${this.config.scorerUrl}. Check it is running: ` +
          'systemctl status digitizerpress-scorer',
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Topical overlap between two texts.
   *
   * Returns null rather than throwing when the service is unreachable. This
   * is one screen among three fidelity layers, and losing it must degrade the
   * check rather than fail the whole request.
   */
  async similarity(original: string, rewritten: string): Promise<SimilarityResult | null> {
    try {
      const response = await fetch(`${this.config.scorerUrl}/similarity`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ original, rewritten }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return null;
      return (await response.json()) as SimilarityResult;
    } catch {
      this.logger.warn('similarity screen unavailable, continuing without it');
      return null;
    }
  }

  async health(): Promise<{ ok: boolean; detail?: unknown }> {
    try {
      const response = await fetch(`${this.config.scorerUrl}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) return { ok: false };
      return { ok: true, detail: await response.json() };
    } catch {
      return { ok: false };
    }
  }
}
