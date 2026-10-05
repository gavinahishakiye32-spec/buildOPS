import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { ORGANIZATION_HEADER } from './common/types.js';
import { CSRF_HEADER } from './auth/session-cookies.js';

/**
 * Global route prefix. Every endpoint the frontend calls lives under this path,
 * which leaves room for a future `/api/v2` without breaking existing clients.
 */
export const API_PREFIX = 'api/v1';

/**
 * Resolve the CORS allow-list.
 *
 * Defaults to permitting any origin so a frontend on any host (Vite dev
 * server, LAN address, preview deploy, ngrok tunnel) can call the API without
 * configuration. Set `ALLOWED_ORIGINS` to a comma-separated list to restrict it
 * to known frontends.
 *
 * That permissive default is development-only, and it has to stay that way now
 * that credentials are on. The refresh token is an httpOnly cookie, so
 * `credentials: true` is required for the session to work at all -- but combined
 * with reflecting any origin it means any site on the internet can make
 * credentialed calls to the API. `SameSite=strict` on the cookie is what stops
 * those calls from carrying a session, so this is defence in depth rather than
 * the only lock; still, "reflect anything, with cookies" is not a posture worth
 * shipping. In production the list is therefore required, and the same
 * reasoning as `getSecret`: a missing variable is a boot error, not a default.
 */
export function resolveAllowedOrigins(): string[] | true {
  const raw = process.env.ALLOWED_ORIGINS?.trim();

  if (process.env.NODE_ENV === 'production' && !raw) {
    throw new Error(
      'ALLOWED_ORIGINS is required when NODE_ENV=production. The API sends credentialed CORS responses (the refresh token is a cookie), so an unset list would let any origin make credentialed calls. Set it to a comma-separated list of frontend origins.',
    );
  }

  if (!raw) {
    return true;
  }

  const origins = raw
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean);

  if (origins.length === 0) {
    return true;
  }

  if (origins.includes('*')) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'ALLOWED_ORIGINS=* is not permitted when NODE_ENV=production. Wildcard origins cannot be combined with credentialed CORS responses.',
      );
    }

    return true;
  }

  return origins;
}

/**
 * Shared application configuration for `main.ts` and the e2e suites, so tests
 * exercise the exact same pipeline as production (spec §17 input validation).
 */
export function configureApp(app: INestApplication): INestApplication {
  const origins = resolveAllowedOrigins();

  app.setGlobalPrefix(API_PREFIX);
  app.use(helmet());
  // The refresh token is an httpOnly cookie scoped to the auth routes, so the
  // browser has to be allowed to send cookies on those calls. Access tokens stay
  // in the Authorization header, so this does not make ordinary API calls
  // CSRF-reachable: the only cookie the server ever reads is the refresh cookie,
  // and the routes that read it are SameSite=strict and double-submit checked.
  app.use(cookieParser());
  app.enableCors({
    origin: origins,
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    // `x-organization-id` is not a CORS-safelisted request header, so it has to
    // be allow-listed explicitly: browsers preflight any request carrying it and
    // reject the call when it is missing from this list.
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      ORGANIZATION_HEADER,
      CSRF_HEADER,
    ],
    exposedHeaders: ['Content-Type'],
    maxAge: 86400,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );
  app.enableShutdownHooks();

  if (origins === true) {
    console.log(
      '[bootstrap] CORS: allowing all origins (set ALLOWED_ORIGINS to restrict)',
    );
  } else {
    console.log(`[bootstrap] CORS allowed origins: ${origins.join(', ')}`);
  }

  return app;
}
