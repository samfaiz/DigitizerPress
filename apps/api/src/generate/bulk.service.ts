import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG, type AppConfig } from '../config/configuration.js';
import { runQueued } from '../llm/batch-context.js';
import { BatchQueueService } from '../llm/batch-queue.service.js';
import { LibraryService } from '../library/library.service.js';
import { LlmService } from '../llm/llm.service.js';
import { ScorerService } from '../scorer/scorer.service.js';
import type { BriefDto } from './dto/generate.dto.js';
import type { DraftResponse } from './dto/generate.dto.js';
import { GenerateService } from './generate.service.js';
import { estimateCost } from './pipeline/cost-model.js';

/**
 * Generate many articles in one job, at the Batch API's half price.
 *
 * The reason this is a separate path rather than a loop over the ordinary
 * endpoint: batching only pays on calls that do not depend on each other, and
 * within a single article almost none do. Across articles nearly all of them
 * do. So the job runs many articles concurrently and lets BatchQueueService
 * pool whatever they happen to be asking for at the same moment. The
 * generation pipeline itself is untouched and unaware.
 *
 * Measured on one 2,000-word article: $0.193 unbatched, $0.169 batching only
 * the chunk rewrites, and roughly half of $0.193 when every phase pools. That
 * last number is what brings 1,000 articles inside a $100 budget, and it is
 * only reachable with enough articles in flight to fill a batch.
 *
 * What this deliberately is NOT: a durable job queue. State is written to
 * disk so a finished article survives a restart, but a batch already in
 * flight when the process dies is lost and its articles are marked failed.
 * Doing better needs a real queue and a database, which this tier does not
 * have. The tradeoff is stated here rather than discovered later.
 */

export type BulkStatus = 'running' | 'done' | 'failed' | 'cancelled';

export interface BulkItem {
  index: number;
  topic: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  error?: string;
  score?: number;
  words?: number;
  costUsd?: number;
}

export interface BulkJob {
  id: string;
  status: BulkStatus;
  total: number;
  createdAt: number;
  finishedAt?: number;
  items: BulkItem[];
  costUsd: number;
  /** Set when the whole job failed rather than individual articles. */
  error?: string;
}

@Injectable()
export class BulkService {
  private readonly logger = new Logger(BulkService.name);
  private readonly jobs = new Map<string, BulkJob>();
  /** Articles are held here rather than in the job so status stays small. */
  private readonly results = new Map<string, Map<number, DraftResponse>>();
  private readonly cancelled = new Set<string>();

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly generate: GenerateService,
    private readonly queue: BatchQueueService,
    private readonly llm: LlmService,
    private readonly scorer: ScorerService,
    private readonly library: LibraryService,
  ) {}

  private get dir(): string {
    return this.config.bulk.stateDir;
  }

  /**
   * What a job would cost and how long it would take, before committing.
   *
   * Callers have to acknowledge this. A thousand-article job is real money
   * and an accidental one is not recoverable by cancelling halfway: the
   * batches already sent still bill.
   */
  estimate(briefs: BriefDto[]): {
    perArticle: number;
    total: number;
    articles: number;
    /** Scaled from a real billed run rather than from the model. */
    measuredPerArticle: number;
    measuredTotal: number;
  } {
    const words =
      briefs.reduce((sum, brief) => sum + (brief.wordCount ?? 2000), 0) /
      Math.max(1, briefs.length);
    const single = estimateCost({
      words,
      model: this.config.anthropic.model,
      judgeModel: this.config.anthropic.judgeModel,
      chunkWords: this.config.loop.chunkWords,
      humanizePasses: this.config.loop.maxIterations,
    });
    // Halved because every phase pools in this path. The cost model itself
    // describes a single interactive article and knows nothing about batching.
    //
    // The model is known to run low against reality, so a measured anchor is
    // returned alongside it rather than quietly trusting the estimate. The
    // anchor: one 2,106-word article, Sonnet 5, 60-word chunks, one humanize
    // pass, prompt caching working, billed $0.1931 unbatched. Half of that is
    // what a full-sized bulk job should approach per article.
    const perArticle = single.perArticle * 0.5;
    const measuredPerWord = 0.1931 / 2106;
    const measured = measuredPerWord * words * 0.5;
    return {
      perArticle: Number(perArticle.toFixed(4)),
      total: Number((perArticle * briefs.length).toFixed(2)),
      articles: briefs.length,
      measuredPerArticle: Number(measured.toFixed(4)),
      measuredTotal: Number((measured * briefs.length).toFixed(2)),
    };
  }

  async start(
    briefs: BriefDto[],
    options: { threshold?: number; maxAttempts?: number } = {},
  ): Promise<BulkJob> {
    if (briefs.length === 0) {
      throw new BadRequestException('A bulk job needs at least one brief.');
    }
    if (briefs.length > this.config.bulk.maxJobSize) {
      throw new BadRequestException(
        `${briefs.length} briefs exceeds the per-job limit of ` +
          `${this.config.bulk.maxJobSize}. Split it, or raise BULK_MAX_JOB_SIZE.`,
      );
    }
    if (!this.llm.isLive) {
      throw new BadRequestException('No LLM provider is configured.');
    }

    // Check the scorer BEFORE spending anything.
    //
    // Every article is scored several times, and a scoring failure fails the
    // article. Without this check a job discovers a dead scorer only after
    // its drafting batches have been sent and billed: on a measured run that
    // was eight articles and thirty-seven minutes of paid work thrown away
    // because a local Python service had stopped. The batches still billed.
    const health = await this.scorer.health();
    if (!health.ok) {
      throw new BadRequestException(
        'The scoring service is not responding, and every article in a bulk ' +
          'job needs it. Start it with: npm run dev:scorer',
      );
    }
    if (!this.queue.isAvailable) {
      // Not fatal. The job still runs, it just pays full price, and saying so
      // up front beats a surprise on the invoice.
      this.logger.warn(
        `${this.llm.name} has no batch endpoint, so this job runs at full rate.`,
      );
    }

    const job: BulkJob = {
      id: randomUUID().slice(0, 12),
      status: 'running',
      total: briefs.length,
      createdAt: Date.now(),
      costUsd: 0,
      items: briefs.map((brief, index) => ({
        index,
        topic: brief.topic,
        status: 'pending',
      })),
    };
    this.jobs.set(job.id, job);
    this.results.set(job.id, new Map());
    await this.persist(job);

    // Deliberately not awaited. The caller gets a job id immediately and
    // polls; a bulk run takes hours and holding the HTTP request open for it
    // would time out at every proxy between here and the browser.
    void this.run(job, briefs, options).catch((error: unknown) => {
      job.status = 'failed';
      job.error = error instanceof Error ? error.message : String(error);
      job.finishedAt = Date.now();
      void this.persist(job);
    });

    return job;
  }

  private async run(
    job: BulkJob,
    briefs: BriefDto[],
    options: { threshold?: number; maxAttempts?: number },
  ): Promise<void> {
    const concurrency = Math.min(this.config.bulk.concurrency, briefs.length);
    this.logger.log(
      `bulk ${job.id}: ${briefs.length} article(s), ${concurrency} at a time`,
    );

    // Wall-clock here is set by the number of SEQUENTIAL phases, not by the
    // number of articles: an outline round, one round per section, metadata,
    // the rewrite wave, the judge. Each round is one batch and a batch takes
    // minutes. So a thousand articles finish in about the same elapsed time
    // as four, and only the thousand makes that time worth paying.
    if (briefs.length < 8) {
      this.logger.warn(
        `bulk ${job.id} has only ${briefs.length} article(s). Batches this ` +
          'small save little and still wait minutes per phase. The ordinary ' +
          'draft endpoint is faster below roughly eight articles.',
      );
    }

    // Claim every worker slot BEFORE any article makes a call.
    //
    // The queue flushes as soon as everyone in flight is parked, so if slots
    // were claimed per article the first one to arrive would see active=1,
    // waiting=1, and go out as a batch of one at full effective price. Taking
    // all the slots up front means the first flush waits for the whole cohort.
    for (let i = 0; i < concurrency; i += 1) this.queue.acquire();

    let next = 0;
    const worker = async (): Promise<void> => {
      try {
        for (;;) {
          const index = next;
          next += 1;
          if (index >= briefs.length) return;
          if (this.cancelled.has(job.id)) return;
          await this.one(job, briefs[index], index, options);
        }
      } finally {
        // Released when this worker has no more articles, not after each one.
        // A worker that has finished can never enqueue again, so the queue
        // must stop counting it or the survivors wait on a ghost.
        this.queue.release();
      }
    };

    try {
      await Promise.all(Array.from({ length: concurrency }, worker));
    } catch (error) {
      // A worker should never throw: one() catches per article. If one
      // escapes anyway, the job still has to reach a terminal state rather
      // than sit at "running" while nothing is working on it.
      job.error = error instanceof Error ? error.message : String(error);
      this.logger.error(`bulk ${job.id} worker failed: ${job.error}`);
      for (const item of job.items) {
        if (item.status === 'running' || item.status === 'pending') {
          item.status = 'failed';
          item.error = item.error ?? job.error;
        }
      }
    }

    job.status = this.cancelled.has(job.id)
      ? 'cancelled'
      : job.items.every((item) => item.status === 'failed')
        ? 'failed'
        : 'done';
    job.finishedAt = Date.now();
    await this.persist(job);

    // Drop the finished articles from memory.
    //
    // They are all on disk and `articles()` falls back to reading them, so
    // nothing is lost. Holding them was: a thousand DraftResponse objects,
    // each carrying the full markdown, the SEO package, every per-sentence
    // score and the scorecard, is a few hundred megabytes that the process
    // would never release.
    this.results.set(job.id, new Map());
    this.cancelled.delete(job.id);

    this.logger.log(
      `bulk ${job.id} ${job.status}: ` +
        `${job.items.filter((i) => i.status === 'done').length}/${job.total} ` +
        `at $${job.costUsd.toFixed(2)}`,
    );
  }

  private async one(
    job: BulkJob,
    brief: BriefDto,
    index: number,
    options: { threshold?: number; maxAttempts?: number },
  ): Promise<void> {
    const item = job.items[index];
    item.status = 'running';

    try {
      const draft = await runQueued(async () => {
        const outline = await this.generate.outline(brief);
        return this.generate.draft(
          brief,
          outline.outline,
          options.threshold ?? 90,
          options.maxAttempts ?? 1,
        );
      });

      this.results.get(job.id)?.set(index, draft);
      // Also filed under the brand it was written for. A thousand articles
      // sitting in a job folder keyed by a random id is an archive nobody
      // opens; the same thousand under the company name is a library.
      try {
        const slug = LibraryService.slugify(brief.brandName);
        if (slug) {
          await this.library.saveArticle(slug, draft, { topic: brief.topic });
        }
      } catch (error) {
        // Never fail a paid article over a filing problem. The job folder
        // copy still exists either way.
        this.logger.warn(
          `could not file article ${index} under its brand: ` +
            (error instanceof Error ? error.message : String(error)),
        );
      }
      item.status = 'done';
      item.score = draft.score.ai_score;
      item.words = draft.score.word_count;
      item.costUsd = draft.usage.costUsd;
      job.costUsd = Number((job.costUsd + draft.usage.costUsd).toFixed(4));
      await this.persistArticle(job.id, index, draft);
    } catch (error) {
      item.status = 'failed';
      item.error = error instanceof Error ? error.message : String(error);
      this.logger.warn(`bulk ${job.id} article ${index} failed: ${item.error}`);
    } finally {
      await this.persist(job);
    }
  }

  get(id: string): BulkJob {
    const job = this.jobs.get(id);
    if (!job) throw new NotFoundException(`No bulk job ${id}.`);
    return job;
  }

  /**
   * Finished articles. Available while the job is still running.
   *
   * Falls back to the files on disk when memory has none, which is the case
   * for any job that predates a restart. Without this the endpoint would
   * report a restored job as having produced nothing while its articles sat
   * on disk next to the status file that says otherwise.
   */
  async articles(id: string): Promise<Array<{ index: number; draft: DraftResponse }>> {
    this.get(id);
    const map = this.results.get(id);
    if (map && map.size > 0) {
      return [...map.entries()]
        .sort(([a], [b]) => a - b)
        .map(([index, draft]) => ({ index, draft }));
    }

    const out: Array<{ index: number; draft: DraftResponse }> = [];
    let files: string[];
    try {
      files = await readdir(join(this.dir, id, 'articles'));
    } catch {
      return out;
    }
    for (const file of files.sort()) {
      if (!file.endsWith('.json')) continue;
      try {
        const raw = await readFile(join(this.dir, id, 'articles', file), 'utf8');
        out.push({
          index: Number.parseInt(file, 10),
          draft: JSON.parse(raw) as DraftResponse,
        });
      } catch {
        // A file written while the process was killed. Skipped.
      }
    }
    return out;
  }

  /**
   * Stop starting new articles.
   *
   * Cannot stop what is already in flight, and cannot un-bill a batch that
   * has been sent. The response says so rather than implying a refund.
   */
  cancel(id: string): BulkJob {
    const job = this.get(id);
    if (job.status === 'running') this.cancelled.add(id);
    return job;
  }

  list(): BulkJob[] {
    return [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  private async persist(job: BulkJob): Promise<void> {
    try {
      await mkdir(join(this.dir, job.id), { recursive: true });
      await writeFile(
        join(this.dir, job.id, 'job.json'),
        JSON.stringify(job, null, 2),
        'utf8',
      );
    } catch (error) {
      // Losing the status file is not worth failing a running job over.
      this.logger.warn(
        `could not persist job ${job.id}: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  private async persistArticle(
    jobId: string,
    index: number,
    draft: DraftResponse,
  ): Promise<void> {
    try {
      await mkdir(join(this.dir, jobId, 'articles'), { recursive: true });
      await writeFile(
        join(this.dir, jobId, 'articles', `${String(index).padStart(4, '0')}.json`),
        JSON.stringify(draft, null, 2),
        'utf8',
      );
    } catch (error) {
      this.logger.warn(
        `could not persist article ${index} of ${jobId}: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  /**
   * Reload job records from disk at startup.
   *
   * Anything that was mid-flight is marked failed rather than resumed. A
   * batch in the air when the process died cannot be reattached from here,
   * and reporting a job as still running when nothing is working on it is
   * worse than reporting it as failed.
   */
  async restore(): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch {
      return;
    }

    for (const id of entries) {
      try {
        const raw = await readFile(join(this.dir, id, 'job.json'), 'utf8');
        const job = JSON.parse(raw) as BulkJob;
        if (job.status === 'running') {
          job.status = 'failed';
          job.error = 'The server restarted while this job was running.';
          job.finishedAt = Date.now();
          for (const item of job.items) {
            if (item.status !== 'done') {
              item.status = 'failed';
              item.error = item.error ?? 'Interrupted by a server restart.';
            }
          }
        }
        this.jobs.set(job.id, job);
        this.results.set(job.id, new Map());
      } catch {
        // A half-written file from a crash. Skipped rather than fatal.
      }
    }
    if (this.jobs.size > 0) {
      this.logger.log(`restored ${this.jobs.size} bulk job record(s)`);
    }
  }
}
