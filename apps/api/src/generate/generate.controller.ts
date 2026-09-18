import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { CacheService } from '../common/cache.service.js';
import { RateLimitGuard } from '../common/rate-limit.guard.js';
import {
  BulkEstimateDto,
  BulkRequestDto,
  DraftRequestDto,
  ApplyFixesDto,
  ProductDetailsDto,
  VoiceRequestDto,
  OutlineRequestDto,
  type DraftResponse,
  type KeywordResponse,
  type OutlineResponse,
} from './dto/generate.dto.js';
import { LibraryService } from '../library/library.service.js';
import { BulkService } from './bulk.service.js';
import { GenerateService } from './generate.service.js';
import { ProgressService } from './progress.service.js';

@Controller('api/generate')
export class GenerateController {
  constructor(
    private readonly generate: GenerateService,
    private readonly progress: ProgressService,
    private readonly cache: CacheService,
    private readonly bulk: BulkService,
    private readonly library: LibraryService,
  ) {}

  /**
   * Price a bulk job without running it.
   *
   * Free, no model calls. Call this before `bulk`, show the number, and only
   * then ask the user to confirm.
   */
  @Post('bulk/estimate')
  @HttpCode(200)
  async bulkEstimate(@Body() body: BulkEstimateDto) {
    return {
      ...this.bulk.estimate(body.briefs),
      note:
        'Two figures. "total" comes from the cost model, which is known to ' +
        'run low. "measuredTotal" is scaled from a real billed run and is the ' +
        'one to plan against. Both assume every phase pools into batches, ' +
        'which needs enough articles running at once to fill them: a job of a ' +
        'handful will cost closer to the unbatched rate.',
    };
  }

  /**
   * Start a bulk job. Returns immediately with an id to poll.
   *
   * Not rate limited by RateLimitGuard, deliberately: the guard counts
   * requests, and one request here is hours of work. The real limit is
   * BULK_MAX_JOB_SIZE plus the required confirmation.
   */
  @Post('bulk')
  @HttpCode(202)
  async bulkStart(@Body() body: BulkRequestDto) {
    if (!body.confirm) {
      const estimate = this.bulk.estimate(body.briefs);
      return {
        started: false,
        estimate,
        message:
          `This job would generate ${estimate.articles} article(s) for about ` +
          `$${estimate.measuredTotal} (model estimate $${estimate.total}). ` +
          'Send the same request with "confirm": true to run it.',
      };
    }
    const job = await this.bulk.start(body.briefs, {
      threshold: body.threshold,
      maxAttempts: body.maxAttempts,
    });
    return { started: true, job };
  }

  @Get('bulk')
  bulkList() {
    return { jobs: this.bulk.list() };
  }

  @Get('bulk/:id')
  bulkStatus(@Param('id') id: string) {
    return this.bulk.get(id);
  }

  /** Finished articles so far. Safe to call while the job is still running. */
  @Get('bulk/:id/articles')
  async bulkArticles(@Param('id') id: string) {
    return { articles: await this.bulk.articles(id) };
  }

  @Post('bulk/:id/cancel')
  @HttpCode(200)
  bulkCancel(@Param('id') id: string) {
    const job = this.bulk.cancel(id);
    return {
      job,
      note:
        'No further articles will start. Anything already sent to the ' +
        'provider still runs and still bills.',
    };
  }

  /**
   * Derive a voice profile from real human writing. Run once per brand.
   */
  @Post('voice-profile')
  @HttpCode(200)
  @UseGuards(RateLimitGuard)
  async voiceProfile(@Body() body: VoiceRequestDto) {
    return this.generate.extractVoice(body.samples);
  }

  /**
   * Read a product page and return factual details for review.
   *
   * Never applied automatically: the response is a suggestion the user
   * confirms in the form, because the page is untrusted third-party content.
   */
  @Post('product-details')
  @HttpCode(200)
  @UseGuards(RateLimitGuard)
  async productDetails(@Body() body: ProductDetailsDto) {
    return this.generate.fetchProductDetails(body.url);
  }

  /**
   * Poll progress for a run.
   *
   * Deliberately outside the rate limiter: this is a read, it does no work,
   * and counting polls against the hourly budget would mean watching a job
   * costs you the right to run another.
   */
  @Get('progress/:key')
  progressFor(@Param('key') key: string) {
    return (
      this.progress.get(key) ?? {
        step: 'Waiting',
        index: 0,
        total: 1,
        percent: 0,
        done: false,
        elapsedMs: 0,
      }
    );
  }

  /** Apply chosen fixes to an article and report whether they helped. */
  @Post('apply-fixes')
  @HttpCode(200)
  @UseGuards(RateLimitGuard)
  async applyFixes(@Body() body: ApplyFixesDto) {
    return this.generate.applyFixes(
      body.brief,
      body.outline,
      body.markdown,
      body.instructions,
    );
  }

  /** Suggest semantically related terms. The cheapest call in the pipeline. */
  @Post('keywords')
  @HttpCode(200)
  @UseGuards(RateLimitGuard)
  async keywords(@Body() body: OutlineRequestDto): Promise<KeywordResponse> {
    return this.generate.suggestKeywords(body.brief);
  }

  /**
   * Step one. Cheap enough to regenerate freely, which is the point: a bad
   * outline should be caught here rather than after a full draft is paid for.
   */
  @Post('outline')
  @HttpCode(200)
  @UseGuards(RateLimitGuard)
  async outline(@Body() body: OutlineRequestDto): Promise<OutlineResponse> {
    return this.generate.outline(body.brief);
  }

  /**
   * Step two. Not cached: the same brief and outline should be able to produce
   * a different draft on a second run, which is exactly what a user asking
   * again wants.
   */
  /**
   * Step two. Writes the article and grades it against the delivery contract.
   * An article below the threshold is still returned, marked undelivered, so
   * you can see what fell short rather than being handed nothing.
   */
  /**
   * Generate one article, and file it under its brand.
   *
   * The filing used to be a button the user had to remember to press. That is
   * the wrong default for something that costs about twenty cents and several
   * minutes to produce: forgetting the button threw the article away, and the
   * browser tab was the only copy. Bulk jobs already filed automatically, so
   * the two paths disagreed about whether generating an article means keeping
   * it.
   *
   * Saving is best-effort and never fails the request. A filing problem must
   * not lose an article that has already been paid for; the caller still gets
   * the full draft either way, and `saved` says what happened.
   */
  @Post('draft')
  @HttpCode(200)
  @UseGuards(RateLimitGuard)
  async draft(
    @Body() body: DraftRequestDto,
  ): Promise<DraftResponse & { saved?: { slug: string; id: string } | null }> {
    const draft = await this.generate.draft(
      body.brief,
      body.outline,
      body.threshold ?? 90,
      body.maxAttempts ?? 2,
    );

    const slug = LibraryService.slugify(body.brief.brandName ?? '');
    if (!slug) return { ...draft, saved: null };

    try {
      const meta = await this.library.saveArticle(slug, draft, {
        topic: body.brief.topic,
      });
      return { ...draft, saved: { slug, id: meta.id } };
    } catch {
      return { ...draft, saved: null };
    }
  }
}
