import { Inject, Injectable, Logger } from '@nestjs/common';
import { CONFIG, type AppConfig } from '../config/configuration.js';
import { currentWorker, runDirect } from './batch-context.js';
import { LlmService } from './llm.service.js';
import type { Usage } from './pricing.js';
import { LlmError, type CompletionRequest, type CompletionResult } from './llm.types.js';

/**
 * Pool model calls from many articles running at once into single batches.
 *
 * This exists because of an arithmetic problem. Batching only helps calls
 * that do not depend on each other, and inside ONE article almost nothing
 * qualifies: the outline feeds the sections, each section is handed the tail
 * of the one before, the judge cannot read a rewrite that does not exist yet.
 * The only independent set is the chunk rewrites of a humanize pass, which
 * measured at about 30% of the bill. Batching just those took a 2,000-word
 * article from $0.193 to $0.169, a 12% saving. Useful, and nowhere near the
 * $100 per thousand the project is aiming at.
 *
 * Across articles the picture inverts. Article 7's section 3 has nothing to
 * do with article 12's section 3, so with fifty articles in flight there are
 * fifty independent calls available at almost every moment. Pool those and
 * every phase batches, not just one.
 *
 * The design consequence worth understanding: nothing about the generation
 * pipeline changes. Each article still runs its ordinary sequential steps and
 * still awaits each call. It just awaits a promise this queue resolves later,
 * once enough siblings have arrived to make a batch worth sending.
 *
 * Deadlock is the obvious hazard and is handled explicitly. If every article
 * in flight is parked here waiting, no further request can possibly arrive,
 * so the queue flushes immediately rather than sitting on a timer that cannot
 * help. The timer is a safety net for the ragged end of a job, when only two
 * or three stragglers remain.
 */

interface Waiting {
  id: string;
  worker: string;
  request: CompletionRequest;
  tally?: Usage[];
  resolve: (result: CompletionResult) => void;
  reject: (error: Error) => void;
}

@Injectable()
export class BatchQueueService {
  private readonly logger = new Logger(BatchQueueService.name);

  private pending: Waiting[] = [];
  private timer: NodeJS.Timeout | null = null;
  private sequence = 0;

  /** Worker slots currently running against this queue. */
  private active = 0;
  /**
   * Which workers have at least one request waiting.
   *
   * Counted by WORKER, not by request. One article that fires forty chunk
   * rewrites at once leaves forty requests here but is still a single worker
   * that has arrived, and flushing on the request count would send that batch
   * before any of its seven siblings had queued a thing.
   */
  private readonly parked = new Set<string>();
  /** Guards against two flushes racing over the same pending array. */
  private flushing = false;

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly llm: LlmService,
  ) {
    // One-way wiring: the queue knows the LLM service, never the reverse.
    this.llm.attachQueue(this);
  }

  get isAvailable(): boolean {
    return this.llm.canBatch;
  }

  /**
   * Declare an article in flight.
   *
   * Balanced by `release` in a finally block, always. A caller that dies
   * without releasing inflates `active` forever, and the queue then waits for
   * a sibling that is never coming.
   */
  acquire(): void {
    this.active += 1;
  }

  release(): void {
    this.active = Math.max(0, this.active - 1);
    // The article that just finished may have been the one everybody else was
    // waiting for, so re-check whether the rest can now be sent.
    this.maybeFlush();
  }

  /**
   * Queue one request and wait for the batch that carries it.
   *
   * The returned promise settles when the batch ends, which may be minutes.
   * That is the whole trade and callers have to want it.
   */
  submit(request: CompletionRequest, tally?: Usage[]): Promise<CompletionResult> {
    if (!this.llm.canBatch) {
      // No batch endpoint. Falling through to a normal call keeps the bulk
      // path working on any provider, just without the discount.
      //
      // runDirect is load-bearing, not decoration. completeResult calls
      // complete(), complete() routes to this queue whenever the async
      // context says queued, and this branch would hand it straight back:
      // an infinite recursion on every provider that has no batch endpoint.
      return runDirect(() => this.llm.completeResult(request, tally));
    }

    const worker = currentWorker() ?? 'anonymous';
    return new Promise<CompletionResult>((resolve, reject) => {
      this.pending.push({
        id: `q${(this.sequence += 1)}`,
        worker,
        request,
        tally,
        resolve,
        reject,
      });
      this.parked.add(worker);
      this.arm();
      this.maybeFlush();
    });
  }

  /** Start the safety-net timer if it is not already running. */
  private arm(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush('timer');
    }, this.config.loop.batchQueueWaitMs);
  }

  private maybeFlush(): void {
    if (this.pending.length === 0) return;

    if (this.pending.length >= this.config.loop.batchQueueSize) {
      void this.flush('full');
      return;
    }

    // Every worker still running is parked here, so no further request can
    // arrive and waiting longer only wastes wall-clock time.
    if (this.active > 0 && this.parked.size >= this.active) {
      void this.flush('quiesced');
      return;
    }

    // No workers left at all, yet requests are still queued.
    //
    // This should not happen, and when it did the job hung rather than
    // failing: a dependency died mid-run, the workers unwound, and the
    // requests they had queued sat here with nothing left to trigger a flush.
    // The job stayed "running" forever. Sending them is the safe response,
    // because somebody is still awaiting each one of these promises.
    if (this.active === 0) {
      this.logger.warn(
        `${this.pending.length} request(s) queued with no worker running. ` +
          'Flushing so their callers are not left waiting forever.',
      );
      void this.flush('orphaned');
    }
  }

  private async flush(reason: string): Promise<void> {
    if (this.flushing || this.pending.length === 0) return;
    this.flushing = true;

    // Taken in one go. Anything enqueued from here on belongs to the next
    // batch, which is what lets articles carry on while this one is in the air.
    const batch = this.pending;
    this.pending = [];
    for (const entry of batch) this.parked.delete(entry.worker);
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    this.logger.log(`flushing ${batch.length} request(s) [${reason}]`);

    try {
      const outcomes = await this.llm.runBatch(
        batch.map((entry) => ({ id: entry.id, request: entry.request })),
        undefined,
        { maxWaitMs: this.config.loop.batchMaxWaitMs },
      );

      // Usage is recorded per caller rather than into one shared tally, so
      // each article's cost report only counts its own calls.
      const byId = new Map(outcomes.map((outcome) => [outcome.id, outcome]));
      for (const entry of batch) {
        const outcome = byId.get(entry.id);
        if (outcome?.result) {
          this.llm.recordResult(entry.tally, outcome.result, true);
          entry.resolve(outcome.result);
        } else {
          entry.reject(
            new LlmError(
              outcome?.error ?? 'The batch returned no result for this request.',
              this.llm.name,
            ),
          );
        }
      }
    } catch (error) {
      // The whole batch failed: a bad key, a network partition, a timeout.
      // Every caller has to hear about it or they wait forever.
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`batch of ${batch.length} failed: ${message}`);
      for (const entry of batch) {
        entry.reject(new LlmError(message, this.llm.name));
      }
    } finally {
      this.flushing = false;
      // A flush that ran while more requests were arriving leaves work behind.
      this.maybeFlush();
    }
  }

  /** For the status endpoint. Nothing here is load-bearing. */
  stats(): { active: number; parked: number; pending: number } {
    return { active: this.active, parked: this.parked.size, pending: this.pending.length };
  }
}
