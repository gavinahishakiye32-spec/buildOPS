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
 * production the default is kept and logged, which is what keeps `npm test` and
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
