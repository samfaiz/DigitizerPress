import { SetMetadata } from '@nestjs/common';

/**
 * Opt one route out of the API key.
 *
 * The guard is registered globally so that a route added next month is
 * protected without anyone remembering to protect it. That default is only
 * safe if the exceptions are few, explicit and visible, which is what this
 * decorator makes them.
 *
 * There is exactly one right now: the config endpoint, which the frontend has
 * to read before it can know whether a key is even required.
 */
export const IS_PUBLIC = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);
