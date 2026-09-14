import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CacheService } from '../common/cache.service.js';
import { Public } from '../common/public.decorator.js';
import { DetectorService } from '../detectors/detector.service.js';
import { RateLimitGuard } from '../common/rate-limit.guard.js';
import { CONFIG, type AppConfig } from '../config/configuration.js';
import { LlmService } from '../llm/llm.service.js';
import { ScorerService } from '../scorer/scorer.service.js';
import {
  HumanizeDto,
  RephraseSpanDto,
  ScoreDto,
  type HumanizeResponse,
  type SpanRephraseResponse,
} from './dto/humanize.dto.js';
import { HumanizeService } from './humanize.service.js';
import { STYLES } from './pipeline/prompts.js';

@Controller('api')
export class HumanizeController {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly humanizeService: HumanizeService,
    private readonly scorer: ScorerService,
    private readonly llm: LlmService,
    private readonly detectors: DetectorService,
    private readonly cache: CacheService,
  ) {}

  /**
   * What the frontend needs to render itself honestly: the real limits, the
   * available styles, and whether the two backing services are actually up.
   */
  @Get('config')
  @Public()
  async publicConfig() {
    const scorerHealth = await this.scorer.health();
    return {
      // Whether a password is needed, never the password itself. The frontend
      // has to know to ask before it can make any other call.
      passwordRequired: Boolean(this.config.accessPassword),
      maxWords: this.config.maxWords,
      rateLimitPerHour: this.config.rateLimitPerHour,
      targetScore: this.config.loop.targetScore,
      styles: Object.values(STYLES).map(({ id, label, description }) => ({
        id,
        label,
        description,
      })),
      provider: { name: this.llm.name, model: this.llm.model, live: this.llm.isLive },
      scorer: scorerHealth,
      detectors: {
        primary: this.detectors.primaryName,
        verify: this.detectors.verifyNames,
        available: this.detectors.status(),
      },
    };
  }

  /**
   * Check every configured external detector against a known sample.
   *
   * Rate limited because each call costs money at the vendor.
   */
  @Post('detectors/test')
  @HttpCode(200)
  @UseGuards(RateLimitGuard)
  async testDetectors() {
    const results = await this.detectors.selfTest();
    return {
      primary: this.detectors.primaryName,
      configured: results.length,
      results,
      hint:
        results.length === 0
          ? 'No external detector keys are set. Add GPTZERO_API_KEY or ZEROGPT_API_KEY to .env.'
          : 'The sample is obvious machine text, so a working detector should score it high. A low score here means a misconfiguration, not a lenient detector.',
    };
  }

  /** Score only. Cheap, no LLM, and the endpoint the editor polls. */
  @Post('score')
  @HttpCode(200)
  @UseGuards(RateLimitGuard)
  async score(@Body() body: ScoreDto) {
    const key = CacheService.key('score', body.text);
    const cached = this.cache.get<Awaited<ReturnType<ScorerService['score']>>>(key);
    if (cached) return cached;

    const result = await this.scorer.score(body.text);
    this.cache.set(key, result);
    return result;
  }

  @Post('humanize')
  @HttpCode(200)
  @UseGuards(RateLimitGuard)
  async humanize(@Body() body: HumanizeDto): Promise<HumanizeResponse> {
    const style = body.style ?? 'standard';
    const deterministicOnly = body.deterministicOnly ?? false;

    // Keyed on everything that changes the output. Note this makes repeat
    // requests deterministic even though the rewrite itself is sampled, which
    // is the behaviour a user expects from pressing the button twice.
    const key = CacheService.key('humanize', body.text, style, deterministicOnly);
    const cached = this.cache.get<HumanizeResponse>(key);
    if (cached) return cached;

    const result = await this.humanizeService.humanize(body.text, style, deterministicOnly);
    this.cache.set(key, result);
    return result;
  }

  /**
   * Rewrite a single sentence, addressed by the offsets the scorer reported.
   *
   * Deliberately not cached. The whole point of the button is that pressing
   * it again gives you a different sentence to choose from, and a cache keyed
   * on the same span would return the rewrite the user just rejected.
   */
  @Post('rephrase-span')
  @HttpCode(200)
  @UseGuards(RateLimitGuard)
  async rephraseSpan(@Body() body: RephraseSpanDto): Promise<SpanRephraseResponse> {
    return this.humanizeService.rephraseSpan(
      body.text,
      body.start,
      body.end,
      body.style ?? 'standard',
    );
  }
}
