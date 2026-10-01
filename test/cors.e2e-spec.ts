import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureApp, resolveAllowedOrigins } from '../src/bootstrap.js';
import { ORGANIZATION_HEADER } from '../src/common/types.js';

describe('CORS (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('advertises the organization header as allowed on preflight', async () => {
    // A browser preflights every request that carries `x-organization-id`, and
    // fails the call unless the header comes back in this list.
    const response = await request(app.getHttpServer())
      .options('/api/v1/clients')
      .set('Origin', 'http://localhost:5173')
      .set('Access-Control-Request-Method', 'GET')
      .set(
        'Access-Control-Request-Headers',
        `authorization,content-type,${ORGANIZATION_HEADER}`,
      )
      .expect(204);

    const allowed = String(response.headers['access-control-allow-headers'])
      .toLowerCase()
      .split(',')
      .map((header) => header.trim());

    expect(allowed).toContain(ORGANIZATION_HEADER);
    expect(allowed).toContain('authorization');
    expect(allowed).toContain('content-type');
  });

  it('reflects the request origin so credential-free bearer calls work', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/plans')
      .set('Origin', 'http://localhost:5173')
      .expect(200);

    expect(response.headers['access-control-allow-origin']).toBe(
      'http://localhost:5173',
    );
    // Cookies are never accepted, so the browser must not allow them.
    expect(
      response.headers['access-control-allow-credentials'],
    ).toBeUndefined();
  });

  describe('resolveAllowedOrigins', () => {
    const original = process.env.ALLOWED_ORIGINS;

    afterEach(() => {
      if (original === undefined) {
        delete process.env.ALLOWED_ORIGINS;
      } else {
        process.env.ALLOWED_ORIGINS = original;
      }
    });

    it('permits every origin when unset', () => {
      delete process.env.ALLOWED_ORIGINS;
      expect(resolveAllowedOrigins()).toBe(true);
    });

    it('permits every origin for an explicit wildcard', () => {
      process.env.ALLOWED_ORIGINS = '*';
      expect(resolveAllowedOrigins()).toBe(true);
    });

    it('trims trailing slashes and drops empty entries', () => {
      process.env.ALLOWED_ORIGINS =
        'https://app.example.com/ , ,https://ops.example.com';
      expect(resolveAllowedOrigins()).toEqual([
        'https://app.example.com',
        'https://ops.example.com',
      ]);
    });
  });
});
