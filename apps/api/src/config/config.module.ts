import { Global, Module } from '@nestjs/common';
import { CONFIG, loadConfig } from './configuration.js';

/**
 * Global so every other module can inject CONFIG without importing anything.
 *
 * Declaring the provider on AppModule instead does not work: modules that
 * AppModule imports are instantiated in their own injector context and never
 * see AppModule's own providers.
 */
@Global()
@Module({
  providers: [
    {
      provide: CONFIG,
      // Read once at boot. Reading process.env at call sites instead would
      // scatter defaults across the codebase and make them untestable.
      useFactory: loadConfig,
    },
  ],
  exports: [CONFIG],
})
export class ConfigModule {}
