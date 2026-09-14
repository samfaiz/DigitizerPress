import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { CONFIG, type AppConfig } from '../config/configuration.js';

/**
 * Counter store behind the rate limiter.
 *
 * In-process by default, Redis when REDIS_URL is set. The in-process store is
 * correct for exactly one instance. The moment you run two, each one enforces
 * its own separate budget and the effective limit doubles, so anything past a
 * single box needs the Redis path.
 */
export interface CounterStore {
  /** Increment a key and return the new count. Sets the TTL on first write. */
  hit(key: string, windowSeconds: number): Promise<number>;
  close(): Promise<void>;
}

class MemoryStore implements CounterStore {
  private readonly counters = new Map<string, { count: number; expiresAt: number }>();
  private readonly sweeper: NodeJS.Timeout;

  constructor() {
    // Without this the map grows once per unique IP and never shrinks, which
    // is a slow memory leak on a public endpoint.
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.counters) {
      if (entry.expiresAt <= now) this.counters.delete(key);
    }
  }

  async hit(key: string, windowSeconds: number): Promise<number> {
    const now = Date.now();
    const existing = this.counters.get(key);
    if (!existing || existing.expiresAt <= now) {
      this.counters.set(key, { count: 1, expiresAt: now + windowSeconds * 1000 });
      return 1;
    }
    existing.count += 1;
    return existing.count;
  }

  async close(): Promise<void> {
    clearInterval(this.sweeper);
    this.counters.clear();
  }
}

class RedisStore implements CounterStore {
  constructor(private readonly client: import('ioredis').Redis) {}

  async hit(key: string, windowSeconds: number): Promise<number> {
    // INCR then EXPIRE only on the first hit, so the window is fixed from the
    // first request rather than sliding forward with every one after it.
    const count = await this.client.incr(key);
    if (count === 1) await this.client.expire(key, windowSeconds);
    return count;
  }

  async close(): Promise<void> {
    await this.client.quit();
  }
}

@Injectable()
export class RateLimitStore implements CounterStore, OnModuleDestroy {
  private readonly logger = new Logger(RateLimitStore.name);
  private delegate: CounterStore = new MemoryStore();
  private readonly ready: Promise<void>;

  constructor(@Inject(CONFIG) private readonly config: AppConfig) {
    this.ready = this.connect();
  }

  private async connect(): Promise<void> {
    if (!this.config.redisUrl) {
      this.logger.log(
        'Rate limiting in-process. Set REDIS_URL before scaling past one instance.',
      );
      return;
    }
    try {
      const { Redis } = await import('ioredis');
      const client = new Redis(this.config.redisUrl, {
        maxRetriesPerRequest: 2,
        lazyConnect: true,
      });
      await client.connect();
      this.delegate = new RedisStore(client);
      this.logger.log('Rate limiting via Redis.');
    } catch (error) {
      // Falling back beats refusing to boot. The log is loud enough to notice.
      this.logger.error(
        `Redis unavailable at ${this.config.redisUrl}, using in-process counters.`,
        error as Error,
      );
    }
  }

  async hit(key: string, windowSeconds: number): Promise<number> {
    await this.ready;
    return this.delegate.hit(key, windowSeconds);
  }

  async close(): Promise<void> {
    await this.delegate.close();
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }
}
