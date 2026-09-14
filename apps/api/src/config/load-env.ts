import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Load the repo-root .env into process.env, as an import side effect.
 *
 * This module must be imported before anything that reads configuration.
 * `main.ts` imports it first, ahead of `AppModule`, because ESM executes
 * imports in order and `loadConfig()` snapshots process.env at module init.
 *
 * Uses Node's built-in `process.loadEnvFile` rather than the dotenv package.
 * It has been available since Node 20.12 and the project already requires
 * Node 20, so a dependency would buy nothing here.
 *
 * The search walks upward rather than hardcoding a relative path, because the
 * process starts from `apps/api` under `npm run start:dev` and from the repo
 * root under `npm run dev:api`, and the compiled entry point sits one
 * directory deeper again.
 */
function findEnvFile(startDir: string, levels = 5): string | null {
  let current = resolve(startDir);
  for (let depth = 0; depth <= levels; depth += 1) {
    const candidate = join(current, '.env');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

const envPath = findEnvFile(process.cwd());

if (envPath) {
  // Real environment variables win. An exported ANTHROPIC_API_KEY or a value
  // injected by the deployment platform must not be silently overwritten by a
  // stale file left in the working tree.
  const preexisting = new Set(Object.keys(process.env));
  const before = { ...process.env };

  process.loadEnvFile(envPath);

  for (const key of preexisting) {
    process.env[key] = before[key];
  }

  console.log(`[env] loaded ${envPath}`);
} else {
  console.log('[env] no .env found, using process environment and defaults');
}

export {};
