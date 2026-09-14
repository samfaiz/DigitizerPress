import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { NextConfig } from "next";

/**
 * Load the repo-root .env so one file configures all three services.
 *
 * Next.js reads .env files from the app directory only, so without this a
 * NEXT_PUBLIC_API_URL set at the root would be silently ignored. This runs
 * before the build, which is when NEXT_PUBLIC_* values are inlined.
 *
 * apps/web/.env.local still wins, because Next loads it after this and its
 * values take precedence for local overrides.
 */
function findEnvFile(startDir: string, levels = 5): string | null {
  let current = resolve(startDir);
  for (let depth = 0; depth <= levels; depth += 1) {
    const candidate = join(current, ".env");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

const envPath = findEnvFile(process.cwd());
if (envPath) process.loadEnvFile(envPath);

const nextConfig: NextConfig = {};

export default nextConfig;
