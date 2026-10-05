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
 * It is ordered the way a caller walks the API: identity first, then billing,
 * then the tenant, then the records that hang off it. Every module is here, so
 * the document and this table only ever move together.
 */
const DOCUMENTED_OPERATIONS: [string, string, string[]][] = [
  // Identity: registration, verification, credentials and the session itself.
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
  // Billing: the catalogue is public, everything else needs a token.
  ['GET', '/plans', ['200']],
  // 200 when the payment settles (the plan is in force), 202 when a checkout
  // has to be completed before it applies.
  ['POST', '/subscription', ['200', '202']],
  ['GET', '/subscription', ['200']],
  ['PATCH', '/subscription/plan', ['200', '202']],
  ['DELETE', '/subscription', ['200']],
  ['GET', '/subscription/usage', ['200']],
  // The tenant. The list and the create need no organization yet, so they are
  // scoped to the subscription; everything else names the organization.
  ['POST', '/organizations', ['201']],
  ['GET', '/organizations', ['200']],
  ['GET', '/organizations/{organizationId}', ['200']],
  ['PATCH', '/organizations/{organizationId}', ['200']],
  ['DELETE', '/organizations/{organizationId}', ['200']],
  // Roles and the members that hold them.
  ['GET', '/organizations/{organizationId}/roles', ['200']],
  ['POST', '/organizations/{organizationId}/roles', ['201']],
  ['GET', '/organizations/{organizationId}/roles/{roleId}', ['200']],
  ['PATCH', '/organizations/{organizationId}/roles/{roleId}', ['200']],
  ['DELETE', '/organizations/{organizationId}/roles/{roleId}', ['200']],
  [
    'PUT',
    '/organizations/{organizationId}/roles/{roleId}/permissions',
    ['200'],
  ],
  ['POST', '/organizations/{organizationId}/roles/{roleId}/assign', ['201']],
  ['DELETE', '/organizations/{organizationId}/roles/{roleId}/assign', ['200']],
  ['GET', '/organizations/{organizationId}/role-templates', ['200']],
  ['GET', '/organizations/{organizationId}/members', ['200']],
  ['POST', '/organizations/{organizationId}/members', ['201']],
  ['PATCH', '/organizations/{organizationId}/members/{userId}', ['200']],
  ['DELETE', '/organizations/{organizationId}/members/{userId}', ['200']],
  // Teams and their membership.
  ['POST', '/teams', ['201']],
  ['GET', '/teams', ['200']],
  ['GET', '/teams/{teamId}', ['200']],
  ['PATCH', '/teams/{teamId}', ['200']],
  ['DELETE', '/teams/{teamId}', ['200']],
  ['GET', '/teams/{teamId}/members', ['200']],
  ['POST', '/teams/{teamId}/members', ['201']],
  ['PATCH', '/teams/{teamId}/members/{memberId}', ['200']],
  ['DELETE', '/teams/{teamId}/members/{memberId}', ['200']],
  // Soft deletes: the trash listing and the restore of one record.
  ['GET', '/teams/trash', ['200']],
  ['POST', '/teams/{teamId}/restore', ['201']],
  // Clients.
  ['POST', '/clients', ['201']],
  ['GET', '/clients', ['200']],
  ['GET', '/clients/{clientId}', ['200']],
  ['PATCH', '/clients/{clientId}', ['200']],
  ['DELETE', '/clients/{clientId}', ['200']],
  ['GET', '/clients/trash', ['200']],
  ['POST', '/clients/{clientId}/restore', ['201']],
  // Badges.
  ['POST', '/badges', ['201']],
  ['GET', '/badges', ['200']],
  ['GET', '/badges/{badgeId}', ['200']],
  ['PATCH', '/badges/{badgeId}', ['200']],
  ['DELETE', '/badges/{badgeId}', ['200']],
  ['GET', '/badges/trash', ['200']],
  ['POST', '/badges/{badgeId}/restore', ['201']],
  // Projects.
  ['POST', '/projects', ['201']],
  ['GET', '/projects', ['200']],
  ['GET', '/projects/{projectId}', ['200']],
  ['PATCH', '/projects/{projectId}', ['200']],
  ['DELETE', '/projects/{projectId}', ['200']],
  ['GET', '/projects/trash', ['200']],
  ['POST', '/projects/{projectId}/restore', ['201']],
  // Tasks, and the subtasks nested under them.
  ['POST', '/tasks', ['201']],
  ['GET', '/tasks', ['200']],
  ['GET', '/tasks/{taskId}', ['200']],
  ['PATCH', '/tasks/{taskId}', ['200']],
  ['DELETE', '/tasks/{taskId}', ['200']],
  ['GET', '/tasks/trash', ['200']],
  ['POST', '/tasks/{taskId}/restore', ['201']],
  ['POST', '/tasks/{taskId}/subtasks', ['201']],
  ['GET', '/tasks/{taskId}/subtasks', ['200']],
  ['GET', '/tasks/{taskId}/subtasks/{subtaskId}', ['200']],
  ['PATCH', '/tasks/{taskId}/subtasks/{subtaskId}', ['200']],
  ['DELETE', '/tasks/{taskId}/subtasks/{subtaskId}', ['200']],
  ['GET', '/tasks/{taskId}/subtasks/trash', ['200']],
  ['POST', '/tasks/{taskId}/subtasks/{subtaskId}/restore', ['201']],
  // Time entries, including the running-timer endpoints.
  ['POST', '/time-entries', ['201']],
  ['GET', '/time-entries', ['200']],
  ['GET', '/time-entries/{timeEntryId}', ['200']],
  ['PATCH', '/time-entries/{timeEntryId}', ['200']],
  ['DELETE', '/time-entries/{timeEntryId}', ['200']],
  ['GET', '/time-entries/trash', ['200']],
  ['POST', '/time-entries/{timeEntryId}/restore', ['201']],
  ['POST', '/time-entries/timer/start', ['201']],
  // Stopping the timer edits the entry that was running, so it answers 200.
  ['POST', '/time-entries/timer/stop', ['200']],
  ['GET', '/time-entries/timer/active', ['200']],
  // Time complexity: the estimate attached to a task and its variance.
  ['POST', '/time-complexity', ['201']],
  ['GET', '/time-complexity', ['200']],
  ['GET', '/time-complexity/{complexityId}', ['200']],
  ['PATCH', '/time-complexity/{complexityId}', ['200']],
  ['DELETE', '/time-complexity/{complexityId}', ['200']],
  ['GET', '/time-complexity/variance/{taskId}', ['200']],
  // Dashboard: read-only aggregates over the same records.
  ['GET', '/dashboard/overview', ['200']],
  // Settings, split by what authenticates them: `/settings/me` belongs to the
  // user and needs no organization, `/settings/organization` is scoped to one.
  ['GET', '/settings/me', ['200']],
  ['PATCH', '/settings/me', ['200']],
  ['GET', '/settings/organization', ['200']],
  ['PATCH', '/settings/organization', ['200']],
  // The account surface, which belongs to the person rather than to any
  // organization: a token is enough, so none of these take a bearer-plus-org
  // combination and none of them publish a 403 or a 404 for a missing context.
  ['GET', '/settings/account', ['200']],
  ['PATCH', '/settings/account/password', ['200']],
  ['PATCH', '/settings/account/email', ['200']],
  ['GET', '/settings/account/sessions', ['200']],
  ['DELETE', '/settings/account/sessions/{sessionId}', ['200']],
  ['DELETE', '/settings/account', ['200']],
  ['GET', '/dashboard/projects', ['200']],
  ['GET', '/dashboard/clients', ['200']],
  ['GET', '/dashboard/overdue', ['200']],
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
