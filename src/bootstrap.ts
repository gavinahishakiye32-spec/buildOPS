import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import helmet from 'helmet';

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
 * to known frontends later.
 */
export function resolveAllowedOrigins(): string[] | true {
  const raw = process.env.ALLOWED_ORIGINS?.trim();

  if (!raw) {
    return true;
  }

  const origins = raw
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean);

  if (origins.length === 0 || origins.includes('*')) {
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
  app.enableCors({
    origin: origins,
    // Auth is stateless Bearer JWT, so the browser never needs to send cookies.
    // Left off deliberately: enabling it would make the API CSRF-reachable once
    // cookie-based refresh tokens are introduced.
    credentials: false,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
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
    console.log('[bootstrap] CORS: allowing all origins (set ALLOWED_ORIGINS to restrict)');
  } else {
    console.log(`[bootstrap] CORS allowed origins: ${origins.join(', ')}`);
  }

  return app;
}