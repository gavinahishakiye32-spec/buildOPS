import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { jest } from '@jest/globals';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { API_PREFIX, configureApp } from '../src/bootstrap.js';
import { MailService } from '../src/mail/mail.service.js';
import { setupSwagger } from '../src/swagger.setup.js';
import { Plan } from '../src/plan/plan.entity.js';
import { ThrottlerStorage } from '@nestjs/throttler';
import { resetDatabase } from './support/reset-database.js';
import { CSRF_HEADER } from '../src/auth/session-cookies.js';

/**
 * Runtime conformance of the published OpenAPI document, against a real
 * PostgreSQL database.
 *
 * `test/openapi.e2e-spec.ts` proves the document is well formed and
 * self-consistent. It cannot prove the server answers what the document
 * promises — a controller can throw a 500 the contract never mentions, or
 * document a 400 the service never throws. This suite closes that gap two ways:
 *
 *  1. every probe asserts the response status is one the document declares;
 *  2. every declared status is asserted reachable by a real probe, so a status
 *     cannot sit in the contract as an unreachable promise.
 *
 * A status that appears at runtime but not in the document fails immediately,
 * which is how the non-UUID organization context (documented 400, served 500)
 * was found.
 */
jest.setTimeout(60000);

/**
 * The default bucket allows 300 requests per 60 s, which is far too many to
 * exhaust once per operation. Lowering it before the module is compiled makes
 * every route answer 429 after two calls, so the published rate-limit response
 * can be proven on all 18 operations instead of one. `ThrottlerModule` reads
 * this in `forRootAsync`, so it has to be set before `AppModule` is compiled.
 */
const previousThrottleLimit = process.env.THROTTLE_LIMIT;
const previousThrottleTtl = process.env.THROTTLE_TTL;
process.env.THROTTLE_LIMIT = '2';
process.env.THROTTLE_TTL = '60000';

const api = (path: string): string => `/${API_PREFIX}${path}`;

const HTTP_METHODS = ['get', 'post', 'patch', 'put', 'delete'];

interface Operation {
  responses: Record<string, unknown>;
}

interface OpenApiDocument {
  paths: Record<string, Record<string, Operation>>;
}

describe('published contract vs runtime (e2e)', () => {
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let dataSource: DataSource;
  let document: OpenApiDocument;

  const mail: { verify?: string; reset?: string } = {};

  /** Every status the server actually returned, keyed `METHOD path:status`. */
  const observed = new Set<string>();
  /** Declared statuses per operation, success included, so drift is detectable. */
  const declared = new Map<string, Set<string>>();
  /** The declared error statuses, which every probe run has to reach. */
  const requiredErrors = new Map<string, Set<string>>();
  /** Declared error statuses a probe was able to reach. */
  const reached = new Map<string, Set<string>>();
  /** Operations with at least one probe. */
  const probed = new Set<string>();

  let planIds: string[] = [];
  let ownerToken = '';
  let memberToken = '';
  let outsiderToken = '';
  let organizationId = '';
  let unverifiedEmail = '';
  let otherEmail = '';
  const userTokens: string[] = [];

  /**
   * Collapses a probe path back to the document's template. Any single path
   * segment becomes its `{parameter}`, because the malformed-id probes send
   * `not-a-uuid`, which is not a UUID the regex below could match.
   */
  const template = (path: string): string =>
    path.replace(/\/organizations\/[^/]+$/, '/organizations/{organizationId}');

  const key = (method: string, path: string): string =>
    `${method.toUpperCase()} ${template(path)}`;

  /**
   * The auth bucket allows 5 register calls per 15 minutes, which this suite
   * exhausts on purpose. Clearing the storage between probes keeps a 429 from
   * standing in for the 400 under test; `429` is proven separately below.
   */
  let throttleStorage: {
    storage: Map<string, unknown>;
    hitExpirations: Map<string, unknown>;
  };

  /**
   * Both maps have to go. `ThrottlerStorageService` tracks per-hit expirations
   * in a private `hitExpirations` map, and `pruneExpiredHits` replays them into a
   * freshly created record — so clearing only `storage` leaves the count
   * exhausted and the next request still answers 429.
   */
  const clearThrottle = (): void => {
    throttleStorage.storage.clear();
    throttleStorage.hitExpirations.clear();
  };

  /** Every status the document declares for an operation, success included. */
  const documented = (method: string, path: string): string[] => {
    const operation = document.paths[template(path)]?.[method.toLowerCase()];
    expect(operation).toBeDefined();

    return Object.keys(operation!.responses);
  };

  /**
   * Sends the request, records the status, and fails if the server answered with
   * something the document does not declare for this operation.
   */
  const probe = async (
    method: 'get' | 'post' | 'patch' | 'delete',
    path: string,
    build: (req: request.Test) => request.Test,
    expectStatus: string,
    label = '',
  ): Promise<request.Response> => {
    clearThrottle();

    const response = await build(
      request(server)[method](api(path)) as request.Test,
    );

    const operationKey = key(method, path);
    observed.add(`${operationKey}:${response.status}`);

    expect({
      operation: `${operationKey}${label ? ` (${label})` : ''}`,
      status: response.status,
      body: response.body,
    }).toEqual({
      operation: `${operationKey}${label ? ` (${label})` : ''}`,
      status: Number(expectStatus),
      body: response.body,
    });

    // The status the server chose has to be one the document promises, so a 500
    // on a route that declares 400 fails here rather than passing silently.
    const declared_ = documented(method, path);
    expect(declared_).toContain(expectStatus);

    probed.add(operationKey);
    if (expectStatus[0] !== '2') {
      reached.get(operationKey)!.add(expectStatus);
    }

    return response;
  };

  const auth = (token: string, req: request.Test): request.Test =>
    req.set('Authorization', `Bearer ${token}`);

  const asOwner = (req: request.Test): request.Test =>
    auth(ownerToken, req).set('x-organization-id', organizationId);

  /** Registers, verifies and logs in, returning a usable bearer token. */
  const verifiedUser = async (email: string): Promise<string> => {
    clearThrottle();

    const registered = await request(server)
      .post(api('/auth/register'))
      .send({ email, password: 'Someone123!', name: 'Someone' });
    expect(registered.status).toBe(201);

    const verified = await request(server)
      .get(api('/auth/verify-email'))
      .query({ token: mail.verify });
    expect(verified.status).toBe(200);

    const login = await request(server)
      .post(api('/auth/login'))
      .send({ email, password: 'Someone123!' });
    expect(login.status).toBe(201);

    return login.body.access_token as string;
  };

  /**
   * Logs in and returns the session cookies alongside the access token.
   *
   * The refresh token only exists in an httpOnly cookie, so the only honest way
   * to test the refresh flow is to read the cookie a real login set -- building
   * the request by hand would be testing a shape the server never produces.
   */
  const loginCookies = async (
    email: string,
  ): Promise<{
    accessToken: string;
    csrf: string;
    refreshToken: string;
    cookieHeader: string;
  }> => {
    clearThrottle();

    const login = await request(server)
      .post(api('/auth/login'))
      .send({ email, password: 'Someone123!' });
    expect(login.status).toBe(201);

    const setCookie = (login.headers['set-cookie'] ?? []) as unknown as string[];
    const valueOf = (name: string): string => {
      const found = setCookie.find((entry) => entry.startsWith(`${name}=`));
      expect(found).toEqual(expect.any(String));
      return (found as string).split(';')[0].split('=')[1];
    };

    const refresh = valueOf('rt');
    const csrf = valueOf('csrf');

    return {
      accessToken: login.body.access_token as string,
      csrf,
      refreshToken: refresh,
      cookieHeader: `rt=${refresh}; csrf=${csrf}`,
    };
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(MailService)
      .useValue({
        sendVerificationEmail: async (_email: string, token: string) => {
          mail.verify = token;
        },
        sendResetPasswordEmail: async (_email: string, token: string) => {
          mail.reset = token;
        },
      })
      .compile();

    app = configureApp(moduleFixture.createNestApplication());
    // `configureApp` does not mount the docs, so the contract this suite checks
    // the server against has to be built explicitly.
    setupSwagger(app);
    await app.init();

    server = app.getHttpServer();
    dataSource = app.get(DataSource);
    // The throttler registers its storage under a symbol token, not the class.
    const storage = app.get(ThrottlerStorage) as unknown as Record<
      string,
      Map<string, unknown>
    >;

    // `storage` is a getter on the prototype, so it is absent from Object.keys.
    expect('storage' in storage).toBe(true);
    expect(Object.keys(storage)).toContain('hitExpirations');
    throttleStorage = storage as unknown as {
      storage: Map<string, unknown>;
      hitExpirations: Map<string, unknown>;
    };

    await resetDatabase(dataSource);

    const json = await request(server).get(api('/docs-json')).expect(200);
    document = json.body as OpenApiDocument;

    for (const [path, operations] of Object.entries(document.paths)) {
      for (const method of HTTP_METHODS) {
        const operation = operations[method];
        if (!operation) continue;

        const all = Object.keys(operation.responses);
        const errors = all.filter((code) => code[0] !== '2');

        declared.set(key(method, path), new Set(all));
        requiredErrors.set(key(method, path), new Set(errors));
        reached.set(key(method, path), new Set());
      }
    }
  });

  afterAll(async () => {
    // Leave the database as the suite found it: this file truncates on the way in,
    // and a later suite should not inherit the users, plans and subscriptions here.
    await resetDatabase(dataSource);
    await app.close();

    // Jest reuses workers between files, so restore the bucket the other suites
    // expect instead of leaving `THROTTLE_LIMIT=2` behind.
    process.env.THROTTLE_LIMIT = previousThrottleLimit;
    process.env.THROTTLE_TTL = previousThrottleTtl;
  });

  describe('auth', () => {
    it('POST /auth/register returns 400 and 409 as documented', async () => {
      unverifiedEmail = `unverified-${Date.now()}@example.com`;
      otherEmail = `other-${Date.now()}@example.com`;

      const first = await probe(
        'post',
        '/auth/register',
        (req) => req.send({ email: unverifiedEmail, password: 'Someone123!' }),
        '201',
        'valid body',
      );
      expect(first.body.user).not.toHaveProperty('passwordHash');

      await probe(
        'post',
        '/auth/register',
        (req) => req.send({ email: unverifiedEmail, password: 'Someone123!' }),
        '409',
        'duplicate email',
      );

      await probe(
        'post',
        '/auth/register',
        (req) => req.send({ email: 'not-an-email', password: 'Someone123!' }),
        '400',
        'malformed email',
      );

      await probe(
        'post',
        '/auth/register',
        (req) => req.send({ email: otherEmail, password: 'short' }),
        '400',
        'password too short',
      );

      await probe(
        'post',
        '/auth/register',
        (req) => req.send({ email: otherEmail, password: 'nodigitshere' }),
        '400',
        'password without a digit',
      );

      // `forbidNonWhitelisted` rejects a stray key rather than ignoring it.
      const validation = await probe(
        'post',
        '/auth/register',
        (req) =>
          req.send({
            email: `extra-${Date.now()}@example.com`,
            password: 'Someone123!',
            role: 'admin',
          }),
        '400',
        'unknown property',
      );
      expect(Array.isArray(validation.body.message)).toBe(true);
    });

    it('POST /auth/login returns 400, 401 and 403 as documented', async () => {
      // Login deliberately refuses unverified accounts and re-issues the
      // verification token, so the 403 below needs the account from the register
      // test to still be unverified.
      await probe(
        'post',
        '/auth/login',
        (req) =>
          req.send({ email: 'ghost@nowhere.io', password: 'Someone123!' }),
        '401',
        'unknown account',
      );

      await probe(
        'post',
        '/auth/login',
        (req) => req.send({ email: unverifiedEmail, password: 'WrongPass123' }),
        '401',
        'wrong password',
      );

      await probe(
        'post',
        '/auth/login',
        (req) => req.send({ email: 'not-an-email', password: 'Someone123!' }),
        '400',
        'malformed email',
      );

      await probe(
        'post',
        '/auth/login',
        (req) => req.send({ email: unverifiedEmail }),
        '400',
        'missing password',
      );

      await probe(
        'post',
        '/auth/login',
        (req) => req.send({ email: unverifiedEmail, password: 'Someone123!' }),
        '403',
        'email not verified',
      );
    });

    it('GET /auth/verify-email returns 400 as documented', async () => {
      // A dedicated account, so verifying it does not disturb `unverifiedEmail`,
      // which the login test above needs to stay unverified.
      clearThrottle();
      const dedicated = `verify-${Date.now()}@example.com`;
      const registered = await request(server)
        .post(api('/auth/register'))
        .send({ email: dedicated, password: 'Someone123!' });
      expect(registered.status).toBe(201);

      const missing = await probe(
        'get',
        '/auth/verify-email',
        (req) => req,
        '400',
        'no token',
      );
      expect(missing.body).toEqual({
        statusCode: 400,
        error: 'Bad Request',
        message:
          'Verification token is required. Read it from the ?token= link sent by email.',
      });

      await probe(
        'get',
        '/auth/verify-email',
        (req) => req.query({ token: 'garbage' }),
        '400',
        'unknown token',
      );

      // Verifying consumes the token, so a replay is a documented 400, not a 500.
      const consumed = mail.verify as string;
      const verified = await probe(
        'get',
        '/auth/verify-email',
        (req) => req.query({ token: consumed }),
        '200',
        'valid token',
      );
      expect(verified.body).toEqual({ message: 'Email verified successfully' });

      await probe(
        'get',
        '/auth/verify-email',
        (req) => req.query({ token: consumed }),
        '400',
        'replayed token',
      );
    });

    it('POST /auth/forgot-password returns 400 as documented', async () => {
      await probe(
        'post',
        '/auth/forgot-password',
        (req) => req.send({ email: 'not-an-email' }),
        '400',
        'malformed email',
      );

      // An unknown address still answers 201: no account enumeration.
      const silent = await probe(
        'post',
        '/auth/forgot-password',
        (req) => req.send({ email: 'ghost@nowhere.io' }),
        '201',
        'unknown address',
      );
      expect(String(silent.body.message).toLowerCase()).toContain(
        'if an account',
      );
    });

    it('POST /auth/reset-password returns 400 as documented', async () => {
      await probe(
        'post',
        '/auth/reset-password',
        (req) => req.send({ token: 'short', password: 'Someone123!' }),
        '400',
        'token too short',
      );

      await probe(
        'post',
        '/auth/reset-password',
        (req) => req.send({ token: 'a'.repeat(40), password: 'short' }),
        '400',
        'password too short',
      );

      const unknown = await probe(
        'post',
        '/auth/reset-password',
        (req) => req.send({ token: 'b'.repeat(40), password: 'Someone123!' }),
        '400',
        'unknown token',
      );
      expect(unknown.body.error).toBe('Bad Request');

      // The documented happy path, then the replay that must not succeed. This
      // needs an account that exists, so it gets its own.
      const resetEmail = `reset-${Date.now()}@example.com`;
      const resetToken = await verifiedUser(resetEmail);
      expect(resetToken).toEqual(expect.any(String));

      const reset = await request(server)
        .post(api('/auth/forgot-password'))
        .send({ email: resetEmail });
      expect(reset.status).toBe(201);
      expect(mail.reset).toEqual(expect.any(String));

      const success = await probe(
        'post',
        '/auth/reset-password',
        (req) => req.send({ token: mail.reset, password: 'BrandNew123' }),
        '201',
        'valid token',
      );
      expect(success.body).toEqual({ message: 'Password reset successfully' });

      // The new password works, which proves the reset really happened.
      const relogin = await request(server)
        .post(api('/auth/login'))
        .send({ email: resetEmail, password: 'BrandNew123' });
      expect(relogin.status).toBe(201);

      await probe(
        'post',
        '/auth/reset-password',
        (req) => req.send({ token: mail.reset, password: 'Another123' }),
        '400',
        'replayed token',
      );
    });

    it('POST /auth/refresh enforces the CSRF check and rotates the cookie', async () => {
      // No cookie at all: the CSRF check runs first and refuses.
      await probe(
        'post',
        '/auth/refresh',
        (req) => req,
        '403',
        'no csrf token',
      );

      // A CSRF pair with no session behind it: past the check, 401.
      await probe(
        'post',
        '/auth/refresh',
        (req) =>
          req
            .set('Cookie', 'csrf=abc123')
            .set(CSRF_HEADER, 'abc123'),
        '401',
        'csrf valid, no session',
      );

      // A session that has really been established, refreshed the documented
      // way. This is the only place the happy path is exercised, because a
      // double-submit check that is never satisfied is indistinguishable from
      // one that is broken.
      const refreshEmail = `refresh-${Date.now()}@example.com`;
      await verifiedUser(refreshEmail);
      const cookies = await loginCookies(refreshEmail);
      const rotated = await request(server)
        .post(api('/auth/refresh'))
        .set('Cookie', cookies.cookieHeader)
        .set(CSRF_HEADER, cookies.csrf);

      expect(rotated.status).toBe(201);
      expect(rotated.body.access_token).toEqual(expect.any(String));

      // The refresh cookie is what rotated. The access token is *not* expected to
      // differ: two JWTs minted in the same second for the same session carry
      // identical claims, so they are byte-identical. Asserting otherwise would
      // be asserting on `iat` granularity, not on behaviour.
      const rotatedCookie = (rotated.headers['set-cookie'] ?? []) as unknown as string[];
      const newRefresh = rotatedCookie
        .find((entry) => entry.startsWith('rt='))
        ?.split(';')[0];
      expect(newRefresh).toEqual(expect.any(String));
      expect(newRefresh).not.toBe(`rt=${cookies.refreshToken}`);

      // The new access token is accepted, so the session really is still alive.
      const profile = await request(server)
        .get(api('/auth/profile'))
        .set('Authorization', `Bearer ${rotated.body.access_token}`);
      expect(profile.status).toBe(200);

      // The presented cookie is single-use: replaying it is now a documented 401.
      const replayed = await request(server)
        .post(api('/auth/refresh'))
        .set('Cookie', cookies.cookieHeader)
        .set(CSRF_HEADER, cookies.csrf);
      expect(replayed.status).toBe(401);
    });

    it('POST /auth/logout is idempotent and still CSRF-checked', async () => {
      // No session cookie at all: there is nothing to revoke, so no CSRF token is
      // demanded. A page tearing down an already-expired session must not see an
      // error.
      const noSession = await probe(
        'post',
        '/auth/logout',
        (req) => req,
        '201',
        'nothing to end',
      );
      expect(noSession.body).toEqual({ message: 'Logged out' });

      // A real session cookie without the CSRF header: this endpoint destroys
      // state, so a cross-site POST must not be able to end somebody's session.
      const logoutEmail = `logout-${Date.now()}@example.com`;
      await verifiedUser(logoutEmail);
      const withSession = await loginCookies(logoutEmail);
      await probe(
        'post',
        '/auth/logout',
        (req) =>
          req
            .set('Cookie', `rt=${withSession.refreshToken}`)
            .set(CSRF_HEADER, 'wrong-value'),
        '403',
        'csrf mismatch',
      );

      // The right token, and the session is gone: the access token minted from
      // it stops being accepted.
      const done = await probe(
        'post',
        '/auth/logout',
        (req) =>
          req
            .set('Cookie', withSession.cookieHeader)
            .set(CSRF_HEADER, withSession.csrf),
        '201',
        'valid csrf',
      );
      expect(done.body).toEqual({ message: 'Logged out' });

      const afterLogout = await request(server)
        .get(api('/auth/profile'))
        .set('Authorization', `Bearer ${withSession.accessToken}`);
      expect(afterLogout.status).toBe(401);
    });

    it('POST /auth/logout-all returns 401 without a valid token', async () => {
      await probe('post', '/auth/logout-all', (req) => req, '401');
    });

    it('GET /auth/sessions returns 401 without a valid token', async () => {
      await probe('get', '/auth/sessions', (req) => req, '401');
    });

    it('GET /auth/profile returns 401 without a valid token', async () => {
      const anonymous = await probe(
        'get',
        '/auth/profile',
        (req) => req,
        '401',
        'no token',
      );
      expect(anonymous.body).toEqual({
        statusCode: 401,
        message: 'Unauthorized',
      });
      expect(anonymous.body.error).toBeUndefined();

      const garbage = await probe(
        'get',
        '/auth/profile',
        (req) => req.set('Authorization', 'Bearer not-a-jwt'),
        '401',
        'malformed token',
      );
      expect(garbage.body).toEqual({
        statusCode: 401,
        message: 'Unauthorized',
      });
    });

    it('PATCH /auth/profile returns 400, 401 and 409 as documented', async () => {
      ownerToken = await verifiedUser(`owner-${Date.now()}@example.com`);
      userTokens.push(ownerToken);

      const profile = await probe(
        'get',
        '/auth/profile',
        (req) => auth(ownerToken, req),
        '200',
        'valid token',
      );
      expect(profile.body.email).toContain('@');

      await probe('patch', '/auth/profile', (req) => req, '401', 'no token');

      await probe(
        'patch',
        '/auth/profile',
        (req) =>
          asOwner(req).send({ name: '', currentPassword: 'Someone123!' }),
        '400',
        'empty name',
      );

      await probe(
        'patch',
        '/auth/profile',
        (req) =>
          asOwner(req).send({ email: 'not-an-email', currentPassword: 'x' }),
        '400',
        'malformed email',
      );

      // A password change demands the current one. The send is wrapped by
      // `asOwner`, so the `x-organization-id` header travels too — the route is
      // user-scoped and ignores it.
      const noCurrent = await probe(
        'patch',
        '/auth/profile',
        (req) => asOwner(req).send({ password: 'BrandNew123' }),
        '400',
        'password without currentPassword',
      );
      expect(noCurrent.body.message).toBe(
        'Current password is required to change the password',
      );

      // The DTO rejects an empty password before the service sees it, so the
      // service-level guard is only reachable by a non-HTTP caller. The pipe's
      // message is the one a client actually gets.
      const emptyPassword = await probe(
        'patch',
        '/auth/profile',
        (req) => asOwner(req).send({ password: '', currentPassword: 'x' }),
        '400',
        'empty new password',
      );
      expect(emptyPassword.body.message).toEqual([
        expect.stringContaining('password'),
      ]);

      const wrong = await probe(
        'patch',
        '/auth/profile',
        (req) =>
          asOwner(req).send({
            password: 'BrandNew123',
            currentPassword: 'WrongPass123',
          }),
        '400',
        'wrong currentPassword',
      );
      expect(wrong.body.message).toBe('Incorrect current password');

      // The address has to belong to somebody: `otherEmail` only ever failed
      // validation above, so a second real account is needed for the conflict.
      const takenEmail = `taken-${Date.now()}@example.com`;
      const taken = await verifiedUser(takenEmail);
      expect(taken).toEqual(expect.any(String));

      const conflict = await probe(
        'patch',
        '/auth/profile',
        (req) => auth(ownerToken, req).send({ email: takenEmail }),
        '409',
        'email already taken',
      );
      expect(conflict.body.error).toBe('Conflict');
    });
  });

  describe('plans', () => {
    it('GET /plans returns the catalogue and takes no input', async () => {
      const response = await probe('get', '/plans', (req) => req, '200');

      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBeGreaterThan(0);

      planIds = response.body.map((plan: Plan) => plan.id);
      expect(planIds).toHaveLength(response.body.length);

      for (const plan of response.body) {
        expect(typeof plan.name).toBe('string');
        expect(typeof plan.maxOrganizations).toBe('number');
        expect(typeof plan.maxUsers).toBe('number');
        expect(typeof plan.maxProjects).toBe('number');
      }
    });
  });

  describe('subscription', () => {
    it('POST /subscription returns 200, 202, 400, 404 and 409 as documented', async () => {
      // No subscription yet, so a bad plan id is a 404 and a bad body a 400.
      await probe(
        'post',
        '/subscription',
        (req) => auth(ownerToken, req).send({ planId: 'not-a-uuid' }),
        '400',
        'malformed planId',
      );

      await probe(
        'post',
        '/subscription',
        (req) => auth(ownerToken, req).send({}),
        '400',
        'missing planId',
      );

      await probe(
        'post',
        '/subscription',
        (req) => auth(ownerToken, req).send({ planId: 'x', status: 'nope' }),
        '400',
        'unknown status',
      );

      const unknownPlan = await probe(
        'post',
        '/subscription',
        (req) =>
          auth(ownerToken, req).send({
            planId: '00000000-0000-4000-8000-000000000000',
          }),
        '404',
        'unknown plan',
      );
      expect(unknownPlan.body.message).toBe('Plan not found');

      const anonymous = await probe(
        'post',
        '/subscription',
        (req) => req.send({ planId: planIds[0] }),
        '401',
        'no token',
      );
      expect(anonymous.body).toEqual({
        statusCode: 401,
        message: 'Unauthorized',
      });

      // Payment settled: the stub provider takes no checkout step, so the paid
      // plan is in force and the response is 200 rather than 201.
      const created = await probe(
        'post',
        '/subscription',
        (req) => auth(ownerToken, req).send({ planId: planIds[0] }),
        '200',
        'valid plan',
      );
      expect(created.body.subscription).toHaveProperty('id');
      expect(created.body.usage).toBeInstanceOf(Array);

      // Same plan is idempotent, a different plan is the documented 409.
      await probe(
        'post',
        '/subscription',
        (req) => auth(ownerToken, req).send({ planId: planIds[0] }),
        '200',
        'same plan, idempotent',
      );

      const conflict = await probe(
        'post',
        '/subscription',
        (req) => auth(ownerToken, req).send({ planId: planIds[1] }),
        '409',
        'different plan while active',
      );
      expect(conflict.body.message).toContain('already exists');
    });

    it('GET /subscription returns 200 and 404 as documented', async () => {
      const active = await probe(
        'get',
        '/subscription',
        (req) => auth(ownerToken, req),
        '200',
        'active subscription',
      );
      expect(active.body.subscription.status).toBe('active');
      expect(active.body.usage).toBeInstanceOf(Array);

      await probe('get', '/subscription', (req) => req, '401', 'no token');

      // A user who never subscribed gets the documented 404, not a 500.
      const fresh = await verifiedUser(`fresh-${Date.now()}@example.com`);
      userTokens.push(fresh);
      const missing = await probe(
        'get',
        '/subscription',
        (req) => auth(fresh, req),
        '404',
        'no subscription yet',
      );
      expect(missing.body.message).toContain('Subscribe to a plan first');
    });

    it('GET /subscription/usage returns 200 as documented', async () => {
      const usage = await probe(
        'get',
        '/subscription/usage',
        (req) => auth(ownerToken, req),
        '200',
        'active subscription',
      );

      expect(usage.body).toBeInstanceOf(Array);
      for (const row of usage.body) {
        expect(row).toHaveProperty('resource');
        expect(row).toHaveProperty('used');
        expect(row).toHaveProperty('limit');
      }

      await probe(
        'get',
        '/subscription/usage',
        (req) => req,
        '401',
        'no token',
      );

      const fresh = await verifiedUser(
        `no-sub-usage-${Date.now()}@example.com`,
      );
      userTokens.push(fresh);
      const missing = await probe(
        'get',
        '/subscription/usage',
        (req) => auth(fresh, req),
        '404',
        'no subscription',
      );
      expect(missing.body.message).toContain('Subscribe to a plan');
    });

    it('PATCH /subscription/plan returns 400, 401 and 404 as documented', async () => {
      await probe(
        'patch',
        '/subscription/plan',
        (req) => req.send({ planId: planIds[1] }),
        '401',
        'no token',
      );

      await probe(
        'patch',
        '/subscription/plan',
        (req) => auth(ownerToken, req).send({ planId: 'not-a-uuid' }),
        '400',
        'malformed planId',
      );

      await probe(
        'patch',
        '/subscription/plan',
        (req) => auth(ownerToken, req).send({}),
        '400',
        'missing planId',
      );

      const unknown = await probe(
        'patch',
        '/subscription/plan',
        (req) =>
          auth(ownerToken, req).send({
            planId: '00000000-0000-4000-8000-000000000000',
          }),
        '404',
        'unknown plan',
      );
      expect(unknown.body.message).toBe('Plan not found');

      const changed = await probe(
        'patch',
        '/subscription/plan',
        (req) => auth(ownerToken, req).send({ planId: planIds[1] }),
        '200',
        'valid upgrade',
      );
      expect(changed.body.subscription.planId).toBe(planIds[1]);

      await probe(
        'patch',
        '/subscription/plan',
        (req) => auth(ownerToken, req).send({ planId: planIds[1] }),
        '200',
        'same plan, idempotent',
      );
    });

    it('DELETE /subscription returns 200 as documented', async () => {
      const cancelled = await probe(
        'delete',
        '/subscription',
        (req) => auth(ownerToken, req),
        '200',
        'active subscription',
      );
      expect(cancelled.body).toEqual({ message: 'Subscription cancelled' });

      await probe('delete', '/subscription', (req) => req, '401', 'no token');

      // Cancelling keeps the record, so a user who never subscribed is the way
      // to reach the documented 404.
      const fresh = await verifiedUser(`no-sub-del-${Date.now()}@example.com`);
      userTokens.push(fresh);
      const missing = await probe(
        'delete',
        '/subscription',
        (req) => auth(fresh, req),
        '404',
        'no subscription',
      );
      expect(missing.body.message).toContain('Subscribe to a plan');
    });
  });

  describe('organizations', () => {
    it('POST /organizations returns 400, 401 and 404 as documented', async () => {
      // A user with no subscription reaches the documented 404.
      const unsubscribed = await verifiedUser(
        `no-sub-org-${Date.now()}@example.com`,
      );
      userTokens.push(unsubscribed);
      const noSubscription = await probe(
        'post',
        '/organizations',
        (req) => auth(unsubscribed, req).send({ name: 'Never Subscribed' }),
        '404',
        'no subscription',
      );
      expect(noSubscription.body.message).toContain('Subscribe to a plan');

      // The subscription was just cancelled, so the plan check fails first.
      const cancelled = await probe(
        'post',
        '/organizations',
        (req) => auth(ownerToken, req).send({ name: 'Too Late Inc' }),
        '400',
        'cancelled subscription',
      );
      expect(cancelled.body.message).toContain('Reactivate it');

      // Reactivate, then subscribe a second user whose plan allows only one org.
      const reactivated = await request(server)
        .post(api('/subscription'))
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ planId: planIds[1] })
        .expect(200);
      expect(reactivated.status).toBe(200);

      await probe(
        'post',
        '/organizations',
        (req) => auth(ownerToken, req).send({ name: '   ' }),
        '400',
        'whitespace name',
      );

      await probe(
        'post',
        '/organizations',
        (req) => auth(ownerToken, req).send({ name: 'X', status: 'nope' }),
        '400',
        'unknown status',
      );

      const unknownProperty = await probe(
        'post',
        '/organizations',
        (req) => auth(ownerToken, req).send({ name: 'X', tenantId: 'y' }),
        '400',
        'unknown property',
      );
      expect(unknownProperty.body.message).toBeInstanceOf(Array);

      const created = await probe(
        'post',
        '/organizations',
        (req) => auth(ownerToken, req).send({ name: 'Contract Co' }),
        '201',
        'valid name',
      );
      expect(created.body).toEqual({
        id: expect.any(String),
        tenantId: expect.any(String),
        name: 'Contract Co',
        status: 'active',
        createdAt: expect.any(String),
      });
      organizationId = created.body.id;

      await probe(
        'post',
        '/organizations',
        (req) => req.send({ name: 'Anonymous Co' }),
        '401',
        'no token',
      );
    });

    it('GET /organizations returns 200 and 404 as documented', async () => {
      const page = await probe(
        'get',
        '/organizations',
        (req) => auth(ownerToken, req),
        '200',
        'list',
      );

      expect(page.body).toEqual({
        items: expect.any(Array),
        total: expect.any(Number),
        page: expect.any(Number),
        limit: expect.any(Number),
        totalPages: expect.any(Number),
      });
      expect(page.body.items).toHaveLength(1);

      const filtered = await probe(
        'get',
        '/organizations',
        (req) => auth(ownerToken, req).query({ page: 1, limit: 1 }),
        '200',
        'pagination applied',
      );
      expect(filtered.body.items).toHaveLength(1);

      // The query is validated by the global pipe, so an out-of-range limit is a
      // 400 on a list endpoint that also takes pagination.
      const outOfRange = await probe(
        'get',
        '/organizations',
        (req) => auth(ownerToken, req).query({ limit: 101 }),
        '400',
        'limit above the documented maximum',
      );
      expect(outOfRange.body.message).toBeInstanceOf(Array);

      await probe(
        'get',
        '/organizations',
        (req) => auth(ownerToken, req).query({ page: 0 }),
        '400',
        'page below the documented minimum',
      );

      await probe('get', '/organizations', (req) => req, '401', 'no token');

      const fresh = await verifiedUser(`no-sub-${Date.now()}@example.com`);
      userTokens.push(fresh);
      const noSubscription = await probe(
        'get',
        '/organizations',
        (req) => auth(fresh, req),
        '404',
        'no subscription',
      );
      expect(noSubscription.body.message).toContain('Subscribe to a plan');
    });

    it('GET /organizations/{organizationId} returns 400 and 403 as documented', async () => {
      memberToken = await verifiedUser(`member-${Date.now()}@example.com`);
      userTokens.push(memberToken);
      outsiderToken = await verifiedUser(`outsider-${Date.now()}@example.com`);
      userTokens.push(outsiderToken);

      const found = await probe(
        'get',
        `/organizations/${organizationId}`,
        (req) => asOwner(req),
        '200',
        'owner reads own organization',
      );
      expect(found.body.id).toBe(organizationId);

      // The path parameter alone is enough: the header is optional here.
      const withoutHeader = await probe(
        'get',
        `/organizations/${organizationId}`,
        (req) => auth(ownerToken, req),
        '200',
        'path param supplies the context',
      );
      expect(withoutHeader.body.id).toBe(organizationId);

      await probe(
        'get',
        `/organizations/${organizationId}`,
        (req) => req,
        '401',
        'no token',
      );

      const malformed = await probe(
        'get',
        '/organizations/not-a-uuid',
        (req) => auth(ownerToken, req),
        '400',
        'malformed path id',
      );
      expect(malformed.body).toEqual({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Validation failed (uuid is expected)',
      });

      await probe(
        'get',
        '/organizations/not-a-uuid',
        (req) => auth(ownerToken, req).set('x-organization-id', 'not-a-uuid'),
        '400',
        'malformed header id',
      );

      // A well-formed id that resolves to nothing answers 403, not 404: the guard
      // checks membership before the service looks the record up, so a deleted or
      // foreign organization is indistinguishable from one you were never in.
      const unknown = await probe(
        'get',
        '/organizations/00000000-0000-4000-8000-000000000000',
        (req) => auth(ownerToken, req),
        '403',
        'well-formed but unknown',
      );
      expect(unknown.body.error).toBe('Forbidden');
      expect(unknown.body.message).toBe(
        'You do not have access to this organization',
      );
    });

    it('PATCH /organizations/{organizationId} returns 400, 401 and 403', async () => {
      await probe(
        'patch',
        `/organizations/${organizationId}`,
        (req) => req.send({ name: 'Anonymous' }),
        '401',
        'no token',
      );

      await probe(
        'patch',
        `/organizations/${organizationId}`,
        (req) => asOwner(req).send({ name: '' }),
        '400',
        'empty name',
      );

      await probe(
        'patch',
        `/organizations/${organizationId}`,
        (req) => asOwner(req).send({ name: '   ' }),
        '400',
        'whitespace name',
      );

      await probe(
        'patch',
        `/organizations/${organizationId}`,
        (req) => asOwner(req).send({ status: 'nope' }),
        '400',
        'unknown status',
      );

      await probe(
        'patch',
        `/organizations/${organizationId}`,
        (req) => asOwner(req).send({ tenantId: 'hijack' }),
        '400',
        'unknown property',
      );

      const renamed = await probe(
        'patch',
        `/organizations/${organizationId}`,
        (req) => asOwner(req).send({ name: 'Contract Co EU' }),
        '200',
        'rename',
      );
      expect(renamed.body.name).toBe('Contract Co EU');
      expect(renamed.body.id).toBe(organizationId);

      const archived = await probe(
        'patch',
        `/organizations/${organizationId}`,
        (req) => asOwner(req).send({ status: 'archived' }),
        '200',
        'status change',
      );
      expect(archived.body.status).toBe('archived');

      await probe(
        'patch',
        `/organizations/${organizationId}`,
        (req) => auth(outsiderToken, req).send({ name: 'Stolen' }),
        '403',
        'not a member',
      );

      await probe(
        'patch',
        `/organizations/${organizationId}`,
        (req) => auth(memberToken, req).send({ name: 'Stolen' }),
        '403',
        'member without the permission',
      );
    });

    it('DELETE /organizations/{organizationId} returns 400, 401, 403 and 200', async () => {
      await probe(
        'delete',
        `/organizations/${organizationId}`,
        (req) => req,
        '401',
        'no token',
      );

      await probe(
        'delete',
        `/organizations/${organizationId}`,
        (req) => auth(outsiderToken, req),
        '403',
        'not a member',
      );

      await probe(
        'delete',
        '/organizations/not-a-uuid',
        (req) => auth(ownerToken, req),
        '400',
        'malformed path id',
      );

      await probe(
        'delete',
        `/organizations/${organizationId}`,
        (req) => auth(memberToken, req),
        '403',
        'member without the permission',
      );

      // A permanent delete has to be asked for twice: first the route refuses
      // and names what to type, then the same owner types it.
      const refused = await probe(
        'delete',
        `/organizations/${organizationId}`,
        (req) => asOwner(req),
        '409',
        'unconfirmed',
      );
      expect(refused.body.message).toContain('Contract Co EU');

      const deleted = await probe(
        'delete',
        `/organizations/${organizationId}`,
        (req) => asOwner(req).query({ confirm: 'Contract Co EU' }),
        '200',
        'owner confirms',
      );
      expect(deleted.body).toEqual({ message: 'Organization deleted' });

      // Deleting cascades the roles away, so the second delete loses membership
      // first and the guard answers 403. It must not surface as a 500.
      const again = await probe(
        'delete',
        `/organizations/${organizationId}`,
        (req) => asOwner(req),
        '403',
        'already deleted',
      );
      expect(again.body.error).toBe('Forbidden');
    });
  });

  describe('rate limiting', () => {
    it('answers 429 with the documented body, and `error` absent', async () => {
      // The auth bucket allows 5 register calls per 15 minutes, and the default
      // bucket is capped at 2 here, so the burst trips whichever comes first.
      let limited: request.Response | null = null;

      for (let attempt = 0; attempt < 8; attempt++) {
        const response = await request(server)
          .post(api('/auth/register'))
          .send({
            email: `burst-${Date.now()}-${attempt}@example.com`,
            password: 'Someone123!',
          });

        if (response.status === 429) {
          limited = response;
          break;
        }
      }

      expect(limited).not.toBeNull();
      expect(limited!.status).toBe(429);

      // The exact shape the schema promises: no `error`, because
      // `ThrottlerException` is thrown with a string and not with a message.
      expect(limited!.body).toEqual({
        statusCode: 429,
        message: 'ThrottlerException: Too Many Requests',
      });

      const declared_ = documented('post', '/auth/register');
      expect(declared_).toContain('429');
      observed.add('POST /auth/register:429');
      reached.get('POST /auth/register')!.add('429');

      clearThrottle();
    });

    it.each([
      ['post', '/auth/login'],
      ['post', '/auth/refresh'],
      ['post', '/auth/logout'],
      ['post', '/auth/logout-all'],
      ['get', '/auth/sessions'],
      ['get', '/auth/verify-email'],
      ['post', '/auth/forgot-password'],
      ['post', '/auth/reset-password'],
      ['get', '/plans'],
      ['get', '/subscription'],
      ['post', '/subscription'],
      ['delete', '/subscription'],
      ['get', '/subscription/usage'],
      ['patch', '/subscription/plan'],
      ['get', '/organizations'],
      ['post', '/organizations'],
      ['get', '/organizations/00000000-0000-4000-8000-000000000000'],
      ['patch', '/organizations/00000000-0000-4000-8000-000000000000'],
      ['delete', '/organizations/00000000-0000-4000-8000-000000000000'],
      ['get', '/auth/profile'],
      ['patch', '/auth/profile'],
    ] as ['get' | 'post' | 'patch' | 'delete', string][])(
      '%s %s answers 429 once the bucket is exhausted',
      async (method, path) => {
        // The bucket is keyed per handler, so each operation has to be exhausted
        // on its own. `THROTTLE_LIMIT` is 2 here, so the third call is limited.
        let limited: request.Response | null = null;

        for (let attempt = 0; attempt < 6; attempt++) {
          const response = await request(server)
            [method](api(path))
            .set('Authorization', `Bearer ${ownerToken}`)
            .set('x-organization-id', organizationId)
            .send(method === 'get' || method === 'delete' ? {} : {});

          if (response.status === 429) {
            limited = response;
            break;
          }
        }

        expect(limited?.body).toEqual({
          statusCode: 429,
          message: 'ThrottlerException: Too Many Requests',
        });

        expect(documented(method, path)).toContain('429');
        observed.add(`${key(method, path)}:429`);
        reached.get(key(method, path))!.add('429');
        probed.add(key(method, path));

        clearThrottle();
      },
    );
  });

  describe('the contract itself', () => {
    it('never returned a status the document does not declare', () => {
      const undeclared: string[] = [];

      for (const entry of observed) {
        const separator = entry.lastIndexOf(':');
        const operation = entry.slice(0, separator);
        const status = entry.slice(separator + 1);

        if (!declared.get(operation)?.has(status)) {
          undeclared.push(`${operation} answered ${status}`);
        }
      }

      expect(undeclared).toEqual([]);
    });

    it('probed every published operation', () => {
      const missed = [...declared.keys()]
        .filter((operation) => !probed.has(operation))
        .sort();

      expect(missed).toEqual([]);
    });

    it('answered every declared error status at least once', () => {
      // A status that cannot be reached is a promise the server cannot keep, so
      // it has to be either exercised by a probe or removed from the document.
      const unreachable: string[] = [];

      for (const [operation, statuses] of requiredErrors) {
        for (const status of statuses) {
          if (!reached.get(operation)?.has(status)) {
            unreachable.push(`${operation} documents ${status}, never seen`);
          }
        }
      }

      expect(unreachable).toEqual([]);
    });

    it('probed a meaningful number of paths', () => {
      // Guards the suite itself: a broken fixture would make the assertions above
      // pass vacuously.
      expect(observed.size).toBeGreaterThanOrEqual(55);
      expect(userTokens.length).toBeGreaterThanOrEqual(4);
    });
  });
});
