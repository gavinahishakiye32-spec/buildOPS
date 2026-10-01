import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { INestApplication } from '@nestjs/common';

export function setupSwagger(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle('OPS API')
    .setDescription(
      'User management and authentication API. ' +
        'Emails are not actually sent: every verification/reset link (with its raw token) is printed to the server console.',
    )
    .setVersion('1.0')
    .addTag('auth', 'Authentication & user verification')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/v1/docs', app, document, { raw: ['json'] });
}