import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AccessPasswordGuard } from './access-password.guard.js';
import { CacheService } from './cache.service.js';
import { RateLimitGuard } from './rate-limit.guard.js';
import { RateLimitStore } from './rate-limit.store.js';

@Global()
@Module({
  providers: [
    RateLimitStore,
    RateLimitGuard,
    CacheService,
    // Registered globally on purpose. Guarding controller by controller means
    // the next endpoint someone adds is open until they remember, and the
    // endpoints here either spend money or return stored work. Opting out is
    // explicit, via @Public(), and there is currently one of those.
    //
    // Does nothing at all unless ACCESS_PASSWORD is set, so a clean clone and
    // a single-machine setup are unaffected.
    { provide: APP_GUARD, useClass: AccessPasswordGuard },
  ],
  exports: [RateLimitStore, RateLimitGuard, CacheService],
})
export class CommonModule {}
