import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import helmet from 'helmet';

/**
 * Shared application configuration for `main.ts` and the e2e suites, so tests
 * exercise the exact same pipeline as production (spec §17 input validation).
 */
export function configureApp(app: INestApplication): INestApplication {
  app.use(helmet());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );
  app.enableShutdownHooks();

  return app;
}