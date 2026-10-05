import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { INestApplication } from '@nestjs/common';
import { API_PREFIX } from './bootstrap.js';

/**
 * Every tag of the API with the summary shown above its group in Swagger UI.
 * Kept here so the grouping stays in one place instead of being spread over the
 * thirteen controllers.
 */
const TAGS: [name: string, description: string][] = [
  ['auth', 'Registration, email verification, login, password reset, profile'],
  ['plans', 'Public catalogue of subscription plans and their capacity limits'],
  [
    'subscription',
    'The subscription of the authenticated user: plan, status and usage',
  ],
  ['organizations', 'Organization CRUD within the subscription'],
];

const DESCRIPTION = [
  'Multi-tenant operations API, documented one module at a time.',
  '',
  '**This document is published incrementally.** It currently covers everything',
  'from `POST /auth/register` through the organization endpoints (`auth`, `plans`,',
  '`subscription`, `organizations`). The remaining modules — roles, teams,',
  'clients, projects, badges, tasks, subtasks, time entries, time complexity and',
  'the dashboard — are implemented and served but are not in this document yet.',
  'They are added as they are documented, one module per release.',
  '',
  'Authentication is a stateless bearer JWT sent in the `Authorization` header.',
  'Organization-scoped routes additionally require the active organization in the',
  '`x-organization-id` header, or in an `:organizationId` path segment, which',
  'takes precedence when both are sent; your membership in that organization is',
  'verified on every call and the permissions of your role decide what is allowed.',
  '',
  'Record collections are paginated with the `page` and `limit` query parameters',
  'and wrapped as `{ items, total, page, limit, totalPages }`. A few catalogue',
  'endpoints (`/plans` and `/subscription/usage`) answer with a plain JSON array',
  'instead.',
  '',
  'Every response body is JSON, errors included. An error always carries a',
  '`statusCode` and a `message`, and nothing else: `message` is a single string',
  'for a business error and a string array when several fields failed validation.',
  'A third `error` key names the status, but it is absent on a rejected or',
  'expired JWT (401) and on every 429, so branch on `statusCode` rather than on',
  '`error`. There is no `timestamp` and no `path`.',
  '',
  'Rate limiting is global, so every operation — public ones included — documents a',
  '`429` alongside its other errors.',
].join('\n');

export function setupSwagger(app: INestApplication): void {
  const port = process.env.PORT ?? '3000';

  const config = new DocumentBuilder()
    .setTitle('OPS API')
    .setDescription(DESCRIPTION)
    .setVersion('1.0')
    // Paths in this document are relative to the prefix, so the server URL has
    // to carry it for "Try it out" and generated clients to reach real routes.
    .addServer(`http://localhost:${port}/${API_PREFIX}`, 'Local development');

  for (const [name, description] of TAGS) {
    config.addTag(name, description);
  }

  config.addBearerAuth(
    { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    'bearer',
  );

  // `ignoreGlobalPrefix` keeps the paths relative to the server URL above. The
  // default would bake `api/v1` into every path *and* into the server URL, so
  // "Try it out" and generated clients would request `/api/v1/api/v1/...`.
  const document = SwaggerModule.createDocument(app, config.build(), {
    ignoreGlobalPrefix: true,
  });

  // The builder always emits an empty contact object; drop it instead of
  // shipping a meaningless one in the document.
  if (
    document.info.contact &&
    Object.keys(document.info.contact).length === 0
  ) {
    delete document.info.contact;
  }

  SwaggerModule.setup(`${API_PREFIX}/docs`, app, document, { raw: ['json'] });
}
