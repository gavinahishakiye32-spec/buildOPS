import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

const logger = new Logger('Config');

/** True when the process refuses to start on an unsafe default. */
export function isProduction(config: ConfigService): boolean {
  return config.get<string>('NODE_ENV') === 'production';
}

/**
 * Reads a value that must never fall back to a hardcoded default in
 * production.
 *
 * A shipped fallback is worse than a missing variable: `JWT_SECRET` defaulting
 * to a constant means anyone who has read the repository can forge access
 * tokens for a deployment that forgot to set it. In production this throws, so
 * the misconfiguration surfaces at boot instead of at the first breach. Outside
 * production the default is kept and logged, which is what keeps `pnpm test` and
 * a fresh clone working.
 */
export function getSecret(
  config: ConfigService,
  key: string,
  developmentDefault: string,
): string {
  const value = config.get<string>(key)?.trim();

  if (value) {
    return value;
  }

  if (isProduction(config)) {
    throw new Error(
      `${key} is required when NODE_ENV=production. Generate one with: openssl rand -hex 32`,
    );
  }

  logger.warn(
    `${key} is not set; falling back to the development default. Never do this in production.`,
  );

  return developmentDefault;
}

/**
 * Whether request throttling is on.
 *
 * Off by default, and the default is the point: during development every
 * person, script and test run on one machine shares a single key, because the
 * limiter tracks the request IP. A dashboard that loads six resources on mount
 * will trip a limit written for a public API, and the 429 that comes back is
 * indistinguishable from a real one — it reads as "the app is broken" and costs
 * an afternoon to trace to a bucket that was never meant to apply to localhost.
 *
 * The limiter is kept, not deleted. It is the only thing standing between a
 * deployed instance and credential stuffing against `/auth/login`, and between
 * `/auth/forgot-password` and mailing every customer on demand. Turning it on
 * for a real deployment is one variable, no code change:
 *
 *   THROTTLE_ENABLED=true
 */
export function isThrottlingEnabled(config: ConfigService): boolean {
  return config.get<string>('THROTTLE_ENABLED')?.trim() === 'true';
}
