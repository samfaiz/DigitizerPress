import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';

interface Entry<T> {
  value: T;
  expiresAt: number;
}

/**
 * Content-addressed result cache.
 *
 * The same passage with the same settings produces the same output, so there
 * is no reason to pay the model for it twice. On an anonymous endpoint this
 * also blunts the obvious abuse pattern of replaying one request in a loop.
 *
 * In-process and bounded. Move it to Redis alongside the rate limiter when
 * you run more than one instance.
 */
@Injectable()
export class CacheService {
  private static readonly MAX_ENTRIES = 500;
  private static readonly TTL_MS = 30 * 60 * 1000;

  private readonly entries = new Map<string, Entry<unknown>>();

  static key(...parts: Array<string | number | boolean | undefined>): string {
    return createHash('sha256').update(parts.join(' ')).digest('hex');
  }

  get<T>(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    // Refresh insertion order so the eviction below is least-recently-used
    // rather than first-written.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value as T;
  }

  set<T>(key: string, value: T): void {
    if (this.entries.size >= CacheService.MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest) this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expiresAt: Date.now() + CacheService.TTL_MS });
  }
}
