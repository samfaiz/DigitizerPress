// Must be first. It populates process.env as an import side effect, and
// loadConfig() below snapshots process.env at module initialisation.
import './config/load-env.js';

import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { loadConfig } from './config/configuration.js';
import { BulkService } from './generate/bulk.service.js';

async function bootstrap() {
  const config = loadConfig();
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // The rate limiter keys on X-Forwarded-For. That header is only meaningful
  // when a proxy you control sets it, which is what this enables.
  app.set('trust proxy', 1);

  app.enableCors({ origin: config.corsOrigin, credentials: false });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // A bulk job posts every brief at once, and a thousand of them is well past
  // the 2mb that suits a single long passage.
  app.useBodyParser('json', { limit: '20mb' });

  // Bring back the record of any bulk job from a previous run. Anything that
  // was mid-flight is marked failed rather than resumed: a batch in the air
  // when the process died cannot be reattached, and a job reported as running
  // while nothing works on it is worse than one reported as failed.
  await app.get(BulkService).restore();

  await app.listen(config.port);
  const log = new Logger('Bootstrap');
  log.log(`Gateway on http://localhost:${config.port}`);

  // Say this out loud. An open server and a correctly secured one look
  // identical from the outside, and the library stores real work on disk.
  if (config.accessPassword) {
    log.log('Password required on every route except /api/config.');
  } else {
    log.warn(
      'No ACCESS_PASSWORD set, so every route is open to anyone who can reach ' +
        'this port, including the saved article library. That is fine on your ' +
        'own machine. Set ACCESS_PASSWORD before putting this on a network ' +
        'other people share.',
    );
  }
}

await bootstrap();
