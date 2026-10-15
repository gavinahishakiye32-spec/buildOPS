import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { configureApp } from './bootstrap.js';
import { setupSwagger } from './swagger.setup.js';

async function bootstrap() {
  // `rawBody` keeps the exact bytes of every JSON request on the request, which
  // `POST /billing/webhook` needs: a Stripe signature is computed over what was
  // sent, so a body that a parser has parsed and the app has re-serialised can
  // never match it. Without this the webhook would answer 400 for every
  // delivery, including the real ones.
  const app = await NestFactory.create(AppModule, { rawBody: true });

  configureApp(app);
  setupSwagger(app);

  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
