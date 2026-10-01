import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import helmet from 'helmet';

/**
 * Origins allowed in development when `ALLOWED_ORIGINS` is unset. Covers the
 * usual Vite/Next/CRA dev servers so a frontend can call the API without extra
 * setup on a fresh clone.
 */
const DEV_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:4200',
];

/**
 * Resolve the CORS allow-list.
 *
 * Fails closed in production: with no `ALLOWED_ORIGINS` configured, no
 * cross-origin request is granted rather than falling back to the dev origins.
 */
export function resolveAllowedOrigins(): string[] {
  const raw = process.env.ALLOWED_ORIGINS?.trim();

  if (raw) {
    const origins = raw
      .split(',')
      .map((origin) => origin.trim().replace(/\/+$/, ''))
      .filter(Boolean);

    if (origins.includes('*')) {
      return ['*'];
    }

    return origins;
  }

  if (process.env.NODE_ENV === 'production') {
    return [];
  }

  return DEV_ORIGINS;
}

/**
 * Shared application configuration for `main.ts` and the e2e suites, so tests
 * exercise the exact same pipeline as production (spec §17 input validation).
 */
export function configureApp(app: INestApplication): INestApplication {
  const origins = resolveAllowedOrigins();

  app.use(helmet());
  app.enableCors({
    origin: origins.length === 1 && origins[0] === '*' ? true : origins,
    // Auth is stateless Bearer JWT, so the browser need not send cookies.
    // Left off deliberately: enabling it would make the API CSRF-reachable
    // once cookie-based refresh tokens are added.
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

  if (origins.length === 0) {
    console.warn(
      '[bootstrap] ALLOWED_ORIGINS is unset in production; all cross-origin requests will be rejected.',
    );
  } else {
    console.log(`[bootstrap] CORS allowed origins: ${origins.join(', ')}`);
  }

  return app;
}