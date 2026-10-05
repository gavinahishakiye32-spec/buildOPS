import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureApp, resolveAllowedOrigins } from '../src/bootstrap.js';
import { ORGANIZATION_HEADER } from '../src/common/types.js';
import { CSRF_HEADER } from '../src/auth/session-cookies.js';

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

  it('advertises the organization and CSRF headers as allowed on preflight', async () => {
    // A browser preflights every request that carries `x-organization-id` or
    // `x-csrf-token`, and fails the call unless the header comes back in this
    // list. The CSRF one is only sent by the session endpoints, but the preflight
    // is per-origin rather than per-route, so it has to be allowed here too.
    const response = await request(app.getHttpServer())
      .options('/api/v1/clients')
      .set('Origin', 'http://localhost:5173')
      .set('Access-Control-Request-Method', 'GET')
      .set(
        'Access-Control-Request-Headers',
        `authorization,content-type,${ORGANIZATION_HEADER},${CSRF_HEADER}`,
      )
      .expect(204);

    const allowed = String(response.headers['access-control-allow-headers'])
      .toLowerCase()
      .split(',')
      .map((header) => header.trim());

    expect(allowed).toContain(ORGANIZATION_HEADER);
    expect(allowed).toContain(CSRF_HEADER);
    expect(allowed).toContain('authorization');
    expect(allowed).toContain('content-type');
  });

  it('allows credentials so the httpOnly refresh cookie can be sent', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/plans')
      .set('Origin', 'http://localhost:5173')
      .expect(200);

    expect(response.headers['access-control-allow-origin']).toBe(
      'http://localhost:5173',
    );
    // The refresh token only works if the browser is allowed to send cookies.
    expect(response.headers['access-control-allow-credentials']).toBe('true');
  });

  describe('resolveAllowedOrigins', () => {
    const original = process.env.ALLOWED_ORIGINS;
    const originalNodeEnv = process.env.NODE_ENV;

    afterEach(() => {
      if (original === undefined) {
        delete process.env.ALLOWED_ORIGINS;
      } else {
        process.env.ALLOWED_ORIGINS = original;
      }

      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalNodeEnv;
      }
    });

    it('permits every origin when unset, outside production', () => {
      delete process.env.ALLOWED_ORIGINS;
      expect(resolveAllowedOrigins()).toBe(true);
    });

    it('permits every origin for an explicit wildcard, outside production', () => {
      process.env.ALLOWED_ORIGINS = '*';
      expect(resolveAllowedOrigins()).toBe(true);
    });

    it('refuses to start in production without an allow-list', () => {
      // Reflecting any origin with credentials on is not a shippable default.
      delete process.env.ALLOWED_ORIGINS;
      process.env.NODE_ENV = 'production';
      try {
        expect(() => resolveAllowedOrigins()).toThrow(/ALLOWED_ORIGINS/);
      } finally {
        process.env.NODE_ENV = originalNodeEnv;
      }
    });

    it('refuses a wildcard in production', () => {
      process.env.ALLOWED_ORIGINS = '*';
      process.env.NODE_ENV = 'production';
      try {
        expect(() => resolveAllowedOrigins()).toThrow(/ALLOWED_ORIGINS/);
      } finally {
        process.env.NODE_ENV = originalNodeEnv;
      }
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
