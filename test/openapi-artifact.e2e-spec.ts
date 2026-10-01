import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module.js';
import { setupSwagger } from '../src/swagger.setup.js';
import { API_PREFIX } from '../src/bootstrap.js';

const ARTIFACT = fileURLToPath(
  new URL('../docs/openapi.json', import.meta.url),
);

/**
 * `npm run docs:openapi` sets this flag to rewrite the committed artifact. The
 * normal test run only compares, so a forgotten regeneration fails CI instead of
 * quietly shipping a stale document.
 */
const WRITE = process.env.OPENAPI_WRITE === '1';

const HTTP_METHODS = ['get', 'post', 'patch', 'put', 'delete'];

interface Operation {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
}

interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string; description?: string };
  servers?: { url: string; description?: string }[];
  tags?: { name: string; description?: string }[];
  paths: Record<string, Record<string, Operation>>;
  components: { securitySchemes: Record<string, unknown> };
}

const serialize = (document: unknown): string =>
  `${JSON.stringify(document, null, 2)}\n`;

const operations = (
  document: OpenApiDocument,
): (readonly [string, string, Operation])[] =>
  Object.entries(document.paths).flatMap(([path, methods]) =>
    HTTP_METHODS.filter((method) => methods[method]).map(
      (method) => [method.toUpperCase(), path, methods[method]] as const,
    ),
  );

describe('OpenAPI artifact (e2e)', () => {
  let app: INestApplication;
  let document: OpenApiDocument;
  let generated: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    setupSwagger(app);
    await app.init();

    const response = await request(app.getHttpServer())
      .get(`/${API_PREFIX}/docs-json`)
      .expect(200);

    document = response.body as OpenApiDocument;
    generated = serialize(document);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('completeness', () => {
    it('is a 3.x document with a title, a version and a usable server', () => {
      expect(document.openapi).toMatch(/^3\./);
      expect(document.info.title).toBe('OPS API');
      expect(document.info.version).toBe('1.0');
      expect(document.info.description?.length ?? 0).toBeGreaterThan(0);
      expect(document.servers?.[0]?.url).toBe(
        `http://localhost:3000/${API_PREFIX}`,
      );
    });

    it('describes every tag of the document', () => {
      const described = new Set(
        (document.tags ?? [])
          .filter((tag) => (tag.description?.length ?? 0) > 0)
          .map((tag) => tag.name),
      );
      const used = new Set(
        operations(document).flatMap(([, , operation]) => operation.tags ?? []),
      );

      expect([...used].filter((tag) => !described.has(tag))).toEqual([]);
      expect(operations(document).length).toBeGreaterThan(0);
    });

    it('gives every operation an id, a summary and a description', () => {
      const incomplete = operations(document)
        .filter(
          ([, , operation]) =>
            !operation.operationId ||
            !operation.summary ||
            !operation.description,
        )
        .map(([method, path]) => `${method} ${path}`);

      expect(incomplete).toEqual([]);
    });

    it('declares the bearer scheme used by the protected operations', () => {
      expect(Object.keys(document.components.securitySchemes)).toEqual([
        'bearer',
      ]);
    });
  });

  describe('committed artifact', () => {
    if (WRITE) {
      it('writes docs/openapi.json', async () => {
        await mkdir(dirname(ARTIFACT), { recursive: true });
        await writeFile(ARTIFACT, generated, 'utf8');
        expect(await readFile(ARTIFACT, 'utf8')).toBe(generated);
      });
    } else {
      it('matches docs/openapi.json', async () => {
        const committed = await readFile(ARTIFACT, 'utf8').catch(() => null);

        expect(committed).not.toBeNull();
        expect(committed).toBe(generated);
      });
    }
  });
});
