import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module.js';
import { setupSwagger } from '../src/swagger.setup.js';

interface Operation {
  summary?: string;
  description?: string;
  tags?: string[];
  security?: { bearer: string[] }[];
  responses: Record<string, { description?: string }>;
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
 */
const DOCUMENTED_OPERATIONS: [string, string, string[]][] = [
  ['POST', '/auth/register', ["201"]],
  ['POST', '/auth/login', ["201"]],
  ['GET', '/auth/verify-email', ["200"]],
  ['POST', '/auth/forgot-password', ["201"]],
  ['POST', '/auth/reset-password', ["201"]],
  ['GET', '/auth/profile', ["200"]],
  ['PATCH', '/auth/profile', ["200"]],
  ['GET', '/plans', ["200"]],
  ['POST', '/subscription', ["201"]],
  ['GET', '/subscription', ["200"]],
  ['DELETE', '/subscription', ["200"]],
  ['GET', '/subscription/usage', ["200"]],
  ['PATCH', '/subscription/plan', ["200"]],
  ['GET', '/organizations/{organizationId}/roles', ["200"]],
  ['POST', '/organizations/{organizationId}/roles', ["201"]],
  ['GET', '/organizations/{organizationId}/role-templates', ["200"]],
  ['GET', '/organizations/{organizationId}/members', ["200"]],
  ['POST', '/organizations/{organizationId}/members', ["201"]],
  ['PATCH', '/organizations/{organizationId}/members/{userId}', ["200"]],
  ['DELETE', '/organizations/{organizationId}/members/{userId}', ["200"]],
  ['GET', '/organizations/{organizationId}/roles/{roleId}', ["200"]],
  ['PATCH', '/organizations/{organizationId}/roles/{roleId}', ["200"]],
  ['DELETE', '/organizations/{organizationId}/roles/{roleId}', ["200"]],
  ['PUT', '/organizations/{organizationId}/roles/{roleId}/permissions', ["200"]],
  ['POST', '/organizations/{organizationId}/roles/{roleId}/assign', ["201"]],
  ['DELETE', '/organizations/{organizationId}/roles/{roleId}/assign', ["200"]],
  ['POST', '/organizations', ["201"]],
  ['GET', '/organizations', ["200"]],
  ['GET', '/organizations/{organizationId}', ["200"]],
  ['PATCH', '/organizations/{organizationId}', ["200"]],
  ['DELETE', '/organizations/{organizationId}', ["200"]],
  ['POST', '/teams', ["201"]],
  ['GET', '/teams', ["200"]],
  ['GET', '/teams/{teamId}', ["200"]],
  ['PATCH', '/teams/{teamId}', ["200"]],
  ['DELETE', '/teams/{teamId}', ["200"]],
  ['GET', '/teams/{teamId}/members', ["200"]],
  ['POST', '/teams/{teamId}/members', ["201"]],
  ['PATCH', '/teams/{teamId}/members/{memberId}', ["200"]],
  ['DELETE', '/teams/{teamId}/members/{memberId}', ["200"]],
  ['POST', '/clients', ["201"]],
  ['GET', '/clients', ["200"]],
  ['GET', '/clients/{clientId}', ["200"]],
  ['PATCH', '/clients/{clientId}', ["200"]],
  ['DELETE', '/clients/{clientId}', ["200"]],
  ['POST', '/projects', ["201"]],
  ['GET', '/projects', ["200"]],
  ['GET', '/projects/{projectId}', ["200"]],
  ['PATCH', '/projects/{projectId}', ["200"]],
  ['DELETE', '/projects/{projectId}', ["200"]],
  ['POST', '/badges', ["201"]],
  ['GET', '/badges', ["200"]],
  ['GET', '/badges/{badgeId}', ["200"]],
  ['PATCH', '/badges/{badgeId}', ["200"]],
  ['DELETE', '/badges/{badgeId}', ["200"]],
  ['POST', '/tasks', ["201"]],
  ['GET', '/tasks', ["200"]],
  ['GET', '/tasks/{taskId}', ["200"]],
  ['PATCH', '/tasks/{taskId}', ["200"]],
  ['DELETE', '/tasks/{taskId}', ["200"]],
  ['GET', '/tasks/{taskId}/subtasks', ["200"]],
  ['POST', '/tasks/{taskId}/subtasks', ["201"]],
  ['GET', '/tasks/{taskId}/subtasks/{subtaskId}', ["200"]],
  ['PATCH', '/tasks/{taskId}/subtasks/{subtaskId}', ["200"]],
  ['DELETE', '/tasks/{taskId}/subtasks/{subtaskId}', ["200"]],
  ['POST', '/time-entries', ["201"]],
  ['GET', '/time-entries', ["200"]],
  ['GET', '/time-entries/timer/active', ["200"]],
  ['POST', '/time-entries/timer/start', ["201"]],
  ['POST', '/time-entries/timer/stop', ["200"]],
  ['GET', '/time-entries/{timeEntryId}', ["200"]],
  ['PATCH', '/time-entries/{timeEntryId}', ["200"]],
  ['DELETE', '/time-entries/{timeEntryId}', ["200"]],
  ['POST', '/time-complexity', ["201"]],
  ['GET', '/time-complexity', ["200"]],
  ['GET', '/time-complexity/variance/{taskId}', ["200"]],
  ['GET', '/time-complexity/{complexityId}', ["200"]],
  ['PATCH', '/time-complexity/{complexityId}', ["200"]],
  ['DELETE', '/time-complexity/{complexityId}', ["200"]],
  ['GET', '/dashboard/overview', ["200"]],
  ['GET', '/dashboard/projects', ["200"]],
  ['GET', '/dashboard/clients', ["200"]],
  ['GET', '/dashboard/overdue', ["200"]],
];

/** Operations reachable without a bearer token. */
const PUBLIC_OPERATIONS = [
  'POST /auth/register',
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
    expect(Object.keys(document.components.securitySchemes)).toEqual(['bearer']);
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

      expect(Object.keys(responses).sort()).toEqual(expect.arrayContaining(statuses));
      expect(Object.keys(responses).filter((code) => code.startsWith('2'))).toEqual(
        statuses,
      );
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
