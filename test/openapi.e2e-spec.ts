import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module.js';
import { setupSwagger } from '../src/swagger.setup.js';

interface Schema {
  $ref?: string;
}

interface Response {
  description?: string;
  content?: Record<string, { schema?: Schema }>;
}

interface Operation {
  summary?: string;
  description?: string;
  tags?: string[];
  security?: { bearer: string[] }[];
  responses: Record<string, Response>;
}

interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, Record<string, Operation>>;
  components: {
    schemas: Record<string, unknown>;
    securitySchemes: Record<string, unknown>;
  };
}

const HTTP_METHODS = ['get', 'post', 'patch', 'put', 'delete'];

/**
 * Every operation the API exposes, with the success status codes it documents.
 * The table is exhaustive on purpose: an undocumented or renamed endpoint, or a
 * lost `@ApiResponse`, fails this test.
 *
 * The document is published incrementally, one module at a time, so this table
 * covers the modules documented so far: auth, plans, subscription and
 * organizations. A module joins the table when it joins the document, which
 * happens in the same commit.
 */
const DOCUMENTED_OPERATIONS: [string, string, string[]][] = [
  ['POST', '/auth/register', ['201']],
  ['POST', '/auth/login', ['201']],
  ['GET', '/auth/verify-email', ['200']],
  ['POST', '/auth/forgot-password', ['201']],
  ['POST', '/auth/reset-password', ['201']],
  // The session routes are split by what actually authenticates them:
  // refresh and logout are reached by the httpOnly cookie, so they publish no
  // bearer scheme; logout-all and the sessions list need an access token.
  ['POST', '/auth/refresh', ['201']],
  ['POST', '/auth/logout', ['201']],
  ['POST', '/auth/logout-all', ['201']],
  ['GET', '/auth/sessions', ['200']],
  ['GET', '/auth/profile', ['200']],
  ['PATCH', '/auth/profile', ['200']],
  ['GET', '/plans', ['200']],
  // 200 when the payment settles (the plan is in force), 202 when a checkout
  // has to be completed before it applies.
  ['POST', '/subscription', ['200', '202']],
  ['GET', '/subscription', ['200']],
  ['DELETE', '/subscription', ['200']],
  ['GET', '/subscription/usage', ['200']],
  ['PATCH', '/subscription/plan', ['200', '202']],
  ['POST', '/organizations', ['201']],
  ['GET', '/organizations', ['200']],
  ['GET', '/organizations/{organizationId}', ['200']],
  ['PATCH', '/organizations/{organizationId}', ['200']],
  ['DELETE', '/organizations/{organizationId}', ['200']],
];

/** Operations reachable without a bearer token. */
const PUBLIC_OPERATIONS = [
  'POST /auth/register',
  'POST /auth/refresh',
  'POST /auth/logout',
  'POST /auth/login',
  'GET /auth/verify-email',
  'POST /auth/forgot-password',
  'POST /auth/reset-password',
  'GET /plans',
];

describe('OpenAPI document (e2e)', () => {
  let app: INestApplication;
  let document: OpenApiDocument;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    setupSwagger(app);
    await app.init();

    const response = await request(app.getHttpServer())
      .get('/api/v1/docs-json')
      .expect(200);
    document = response.body as OpenApiDocument;
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves the document as JSON', () => {
    expect(document.openapi).toMatch(/^3\./);
    expect(document.info.title).toBe('OPS API');
    expect(Object.keys(document.components.securitySchemes)).toEqual([
      'bearer',
    ]);
  });

  it('documents every operation of the API exactly once', () => {
    const actual: string[] = [];

    for (const [path, operations] of Object.entries(document.paths)) {
      for (const method of HTTP_METHODS) {
        if (operations[method]) {
          actual.push(`${method.toUpperCase()} ${path}`);
        }
      }
    }

    const expected = DOCUMENTED_OPERATIONS.map(
      ([method, path]) => `${method} ${path}`,
    );

    expect(actual.sort()).toEqual(expected.sort());
    expect(actual).toHaveLength(DOCUMENTED_OPERATIONS.length);
  });

  it('documents the success status codes of every operation', () => {
    for (const [method, path, statuses] of DOCUMENTED_OPERATIONS) {
      const responses = document.paths[path][method.toLowerCase()].responses;

      expect(Object.keys(responses).sort()).toEqual(
        expect.arrayContaining(statuses),
      );
      expect(
        Object.keys(responses).filter((code) => code.startsWith('2')),
      ).toEqual(statuses);
    }
  });

  it('documents a summary and a tag for every operation', () => {
    for (const [method, path] of DOCUMENTED_OPERATIONS) {
      const operation = document.paths[path][method.toLowerCase()];

      expect(typeof operation.summary).toBe('string');
      expect((operation.summary as string).length).toBeGreaterThan(0);
      expect(operation.tags?.length).toBeGreaterThan(0);
    }
  });

  it('requires the bearer token everywhere but on the public endpoints', () => {
    const unsecured: string[] = [];

    for (const [method, path] of DOCUMENTED_OPERATIONS) {
      const operation = document.paths[path][method.toLowerCase()];

      if (!operation.security?.some((requirement) => requirement.bearer)) {
        unsecured.push(`${method} ${path}`);
      }
    }

    expect(unsecured.sort()).toEqual([...PUBLIC_OPERATIONS].sort());
  });

  it('publishes the organization context each operation actually enforces', () => {
    // `x-auth.context` and `x-organization-context.required` come from the
    // decorators, so they must agree: a route that skips the organization
    // resolution cannot also advertise a required organization context.
    const wrong: string[] = [];

    // The `x-` extensions are contributed by our own decorators, so the
    // generated document's `Operation` type does not describe them.
    type DocumentedOperation = {
      security?: unknown[];
      'x-auth'?: { context?: string };
      'x-organization-context'?: { required?: boolean };
    };

    for (const [method, path] of DOCUMENTED_OPERATIONS) {
      const operation = document.paths[path][
        method.toLowerCase()
      ] as DocumentedOperation;
      const context = operation['x-auth']?.context;
      const required = operation['x-organization-context']?.required;

      if (!context) {
        if (operation.security?.length) {
          wrong.push(
            `${method} ${path} is protected but has no x-auth.context`,
          );
        }
        continue;
      }

      const expected = required ? 'organization' : 'subscription';

      if (context === 'organization' && required === false) {
        wrong.push(
          `${method} ${path} skips the org but says context=organization`,
        );
      } else if (context === 'user' && required) {
        wrong.push(`${method} ${path} is user-scoped but requires an org`);
      } else if (context !== expected && context !== 'user') {
        wrong.push(`${method} ${path} context=${context} required=${required}`);
      }
    }

    expect(wrong).toEqual([]);
  });

  it('requires the bearer token exactly once, never twice', () => {
    // `@ApiBearerAuth()` on both the controller and the operation emitted
    // `[{ bearer: [] }, { bearer: [] }]`, which some client generators turn
    // into a duplicated requirement.
    const duplicated: string[] = [];

    for (const [method, path] of DOCUMENTED_OPERATIONS) {
      const operation = document.paths[path][method.toLowerCase()];
      const requirements = operation.security ?? [];

      if (requirements.length > 1) {
        duplicated.push(`${method} ${path} (${requirements.length})`);
      }
    }

    expect(duplicated).toEqual([]);
  });

  it('gives every error response the shared error schema', () => {
    const unschemaed: string[] = [];

    for (const [method, path] of DOCUMENTED_OPERATIONS) {
      const operation = document.paths[path][method.toLowerCase()];

      for (const [code, response] of Object.entries(operation.responses)) {
        if (code.startsWith('2')) {
          continue;
        }

        const schema = response.content?.['application/json']?.schema;

        if (schema?.$ref !== '#/components/schemas/ErrorResponseDto') {
          unschemaed.push(`${method} ${path} ${code}`);
        }
      }
    }

    expect(unschemaed).toEqual([]);
  });

  it('describes every response, error responses included', () => {
    const undescribed: string[] = [];

    for (const [method, path] of DOCUMENTED_OPERATIONS) {
      const operation = document.paths[path][method.toLowerCase()];

      for (const [code, response] of Object.entries(operation.responses)) {
        if ((response.description?.length ?? 0) === 0) {
          undescribed.push(`${method} ${path} ${code}`);
        }
      }
    }

    expect(undescribed).toEqual([]);
  });

  it('documents the rate limit on every operation', () => {
    // ThrottlerGuard is global, so a 429 is reachable everywhere.
    const missing: string[] = [];

    for (const [method, path] of DOCUMENTED_OPERATIONS) {
      const operation = document.paths[path][method.toLowerCase()];

      if (!operation.responses['429']) {
        missing.push(`${method} ${path}`);
      }
    }

    expect(missing).toEqual([]);
  });

  it('references only schemas present in the document', () => {
    const schemas = Object.keys(document.components.schemas);
    const missing = new Set<string>();

    const visit = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(visit);
        return;
      }

      if (!node || typeof node !== 'object') {
        return;
      }

      for (const [key, value] of Object.entries(node)) {
        if (key === '$ref' && typeof value === 'string') {
          const name = value.replace('#/components/schemas/', '');
          if (!schemas.includes(name)) {
            missing.add(name);
          }
          continue;
        }
        visit(value);
      }
    };

    visit(document.paths);

    expect([...missing]).toEqual([]);
  });
});
