import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import { CONFIG, type AppConfig } from '../config/configuration.js';
import { RateLimitStore } from './rate-limit.store.js';

/**
 * Two-window limiter for the anonymous tier.
 *
 * There is no login in v1, so this and the word cap are the only things
 * between the service and someone scripting the LLM budget away. Two windows
 * rather than one: the hourly budget caps total spend, and the short burst
 * window stops a single client from draining that whole budget in ten seconds.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private static readonly BURST_WINDOW_SECONDS = 60;
  private static readonly HOUR_SECONDS = 3600;

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly store: RateLimitStore,
  ) {}

  private clientKey(request: Request): string {
    // X-Forwarded-For is trusted only because this sits behind a proxy you
    // control. Exposed directly, a client can forge it, so the `trust proxy`
    // setting in main.ts and this line have to stay consistent.
    const forwarded = request.headers['x-forwarded-for'];
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0];
    return (first ?? request.ip ?? 'unknown').trim();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const key = this.clientKey(request);

    const burst = await this.store.hit(
      `burst:${key}`,
      RateLimitGuard.BURST_WINDOW_SECONDS,
    );
    if (burst > this.config.rateLimitBurst) {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: 'Too many requests. Wait a minute and try again.',
          retryAfterSeconds: RateLimitGuard.BURST_WINDOW_SECONDS,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const hourly = await this.store.hit(`hour:${key}`, RateLimitGuard.HOUR_SECONDS);
    if (hourly > this.config.rateLimitPerHour) {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: `Hourly limit of ${this.config.rateLimitPerHour} requests reached.`,
          retryAfterSeconds: RateLimitGuard.HOUR_SECONDS,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }
}
