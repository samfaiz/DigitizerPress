import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';

/**
 * Progress for a generation run.
 *
 * A draft takes two to five minutes. Without this the UI shows a spinner and
 * the user cannot tell a slow run from a hung one, which is the difference
 * between waiting and giving up.
 *
 * Keyed by a hash of the brief rather than a job id, so the client can poll
 * without a second round trip to learn its own id, and so a retry of the same
 * brief reuses the same channel.
 *
 * In-process and short-lived, matching the rest of the anonymous tier. Two
 * instances would report progress for whichever one served the poll, which is
 * another reason Redis is the prerequisite for scaling past one.
 */
export interface ProgressState {
  step: string;
  index: number;
  total: number;
  startedAt: number;
  updatedAt: number;
  done: boolean;
}

/** Roughly how many reported steps a run produces, for the bar's denominator. */
const PHASES_BESIDES_SECTIONS = 6;

@Injectable()
export class ProgressService {
  private static readonly TTL_MS = 30 * 60 * 1000;
  private readonly runs = new Map<string, ProgressState>();

  /** A stable channel for one brief. */
  static key(brief: { topic?: string; primaryKeyword?: string; brandName?: string }): string {
    return createHash('sha256')
      .update(`${brief.topic ?? ''}|${brief.primaryKeyword ?? ''}|${brief.brandName ?? ''}`)
      .digest('hex')
      .slice(0, 16);
  }

  start(brief: Parameters<typeof ProgressService.key>[0], sections: number): string {
    this.sweep();
    const key = ProgressService.key(brief);
    this.runs.set(key, {
      step: 'Starting',
      index: 0,
      total: sections + PHASES_BESIDES_SECTIONS,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      done: false,
    });
    return key;
  }

  step(brief: Parameters<typeof ProgressService.key>[0], label: string): void {
    const state = this.runs.get(ProgressService.key(brief));
    if (!state || state.done) return;
    state.step = label;
    // Never let the counter pass the denominator: a bar that reads 14 of 12
    // is worse than one that sits at 11 of 12 for a moment.
    state.index = Math.min(state.index + 1, state.total - 1);
    state.updatedAt = Date.now();
  }

  finish(brief: Parameters<typeof ProgressService.key>[0], label = 'Done'): void {
    const state = this.runs.get(ProgressService.key(brief));
    if (!state) return;
    state.step = label;
    state.index = state.total;
    state.done = true;
    state.updatedAt = Date.now();
  }

  get(key: string): (ProgressState & { percent: number; elapsedMs: number }) | null {
    const state = this.runs.get(key);
    if (!state) return null;
    return {
      ...state,
      percent: Math.round((state.index / Math.max(1, state.total)) * 100),
      elapsedMs: Date.now() - state.startedAt,
    };
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, state] of this.runs) {
      if (now - state.updatedAt > ProgressService.TTL_MS) this.runs.delete(key);
    }
  }
}
