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
  let memberUserId = '';
  let outsiderToken = '';
  let organizationId = '';
  let unverifiedEmail = '';
  let otherEmail = '';
  const userTokens: string[] = [];

  /** Every published operation as `[method, template]`, filled in `beforeAll`. */
  const publishedOperations: [
    'get' | 'post' | 'put' | 'patch' | 'delete',
    string,
  ][] = [];

  // Fixtures that cross describe boundaries: a task needs a live team and badge,
  // logged time needs a live subtask, and estimation needs a live task. Each is
  // published by the suite that owns it and read by the suite downstream.
  let teamIdForTask = '';
  let badgeIdForTask = '';
  let taskIdForEstimate = '';
  let subtaskIdForTime = '';

  /**
   * Document templates, split into literal and `{parameter}` segments.
   *
   * The matcher cannot be a plain regex: `/teams/trash` and `/teams/{teamId}`
   * both answer a concrete `/teams/<id>` request in the same shape, so a regex
   * would map the trashed-collection probe to the parameterised one. Splitting
   * the segments and scoring the candidates keeps the literal match.
   *
   * Built lazily because the document only exists once `beforeAll` has run.
   */
  let templates: {
    path: string;
    segments: string[];
    parameters: number;
  }[] = [];

  const readTemplates = (): void => {
    if (templates.length) return;

    templates = Object.keys(document.paths).map((path) => ({
      path,
      segments: path.split('/'),
      parameters: (path.match(/\{/g) ?? []).length,
    }));
  };

  /**
   * Collapses a probe path back to the document's template.
   *
   * Any single segment the document does not spell out is taken as a value for
   * the matching `{parameter}`, because the malformed-id probes send
   * `not-a-uuid`, which is not a UUID any regex could match. Where several
   * templates fit, the one with the fewest parameters wins: `/teams/trash` is a
   * real collection and must not be read as a team called `trash`.
   */
  const template = (path: string): string => {
    readTemplates();

    const segments = path.split('/');
    const match = templates
      .filter(
        (candidate) =>
          candidate.segments.length === segments.length &&
          candidate.segments.every(
            (segment, index) =>
              segment.startsWith('{') || segment === segments[index],
          ),
      )
      .sort((left, right) => left.parameters - right.parameters)[0];

    // A probe path with no template means the operation it was supposed to cover
    // is not in the document, which would let it pass the contract silently.
    expect({ path, template: match?.path ?? null }).toEqual({
      path,
      template: match ? match.path : null,
    });

    return match.path;
  };

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
    method: 'get' | 'post' | 'put' | 'patch' | 'delete',
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

  /**
   * A registered user who is not a member of the organization. The header has
   * to travel with the token: `@OrganizationHeader` runs before the permission
   * guard, so without it these probes are answered with 404 and never reach the
   * 403 they are there to prove.
   */
  const asOutsider = (req: request.Test): request.Test =>
    auth(outsiderToken, req).set('x-organization-id', organizationId);

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
   * Registers a user and returns their id as well as their token.
   *
   * The member probes need both: a member is added by `userId`, but every other
   * module is probed with a token, and the id is only readable from the profile
   * of a live session.
   */
  const verifiedUserWithId = async (
    email: string,
  ): Promise<{ token: string; userId: string }> => {
    const token = await verifiedUser(email);

    const profile = await request(server)
      .get(api('/auth/profile'))
      .set('Authorization', `Bearer ${token}`);

    expect(profile.status).toBe(200);

    return { token, userId: profile.body.id as string };
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

    const setCookie = (login.headers['set-cookie'] ??
      []) as unknown as string[];
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
        publishedOperations.push([
          method as 'get' | 'post' | 'put' | 'patch' | 'delete',
          path,
        ]);
      }
    }

    publishedOperations.sort((left, right) =>
      `${left[0]} ${left[1]}`.localeCompare(`${right[0]} ${right[1]}`),
    );
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
        (req) => req.set('Cookie', 'csrf=abc123').set(CSRF_HEADER, 'abc123'),
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
      const rotatedCookie = (rotated.headers['set-cookie'] ??
        []) as unknown as string[];
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
      // The member is added to the organization right away: the module suites
      // below reuse this id as a team member, and a team membership requires an
      // organization membership to sit on. `outsider` stays out on purpose, so
      // every 403 probe keeps a user who resolves no membership at all.
      const member = await verifiedUserWithId(
        `member-${Date.now()}@example.com`,
      );
      memberToken = member.token;
      memberUserId = member.userId;
      userTokens.push(memberToken);
      outsiderToken = await verifiedUser(`outsider-${Date.now()}@example.com`);
      userTokens.push(outsiderToken);

      const joined = await request(server)
        .post(api(`/organizations/${organizationId}/members`))
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ userId: memberUserId });
      expect(joined.status).toBe(201);

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
        (req) => asOutsider(req).send({ name: 'Stolen' }),
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
        (req) => asOutsider(req),
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
    });
  });

  describe('roles and members', () => {
    // A shared, unassigned role and a user who is not a member yet: the
    // assign/unassign pairs need a role nobody holds, and the member add needs
    // a real user to attach it to.
    let spareRoleId = '';
    let spareUserId = '';

    it('registers the user the member probes will add to the organization', async () => {
      const spare = await verifiedUserWithId(`spare-${Date.now()}@example.com`);
      spareUserId = spare.userId;
    });

    it('POST /organizations/{organizationId}/members returns 400, 401, 403, 404, 409 and 201', async () => {
      await probe(
        'post',
        `/organizations/${organizationId}/members`,
        (req) => req.send({}),
        '401',
        'no token',
      );

      await probe(
        'post',
        `/organizations/${organizationId}/members`,
        (req) => asOutsider(req).send({ email: otherEmail }),
        '403',
        'not a member',
      );

      await probe(
        'post',
        `/organizations/${organizationId}/members`,
        (req) => asOwner(req).send({}),
        '400',
        'neither userId nor email',
      );

      await probe(
        'post',
        `/organizations/${organizationId}/members`,
        (req) =>
          asOwner(req).send({
            email: `absent-${Date.now()}@example.com`,
          }),
        '404',
        'unknown user',
      );

      const added = await probe(
        'post',
        `/organizations/${organizationId}/members`,
        (req) => asOwner(req).send({ userId: spareUserId }),
        '201',
        'new member',
      );
      expect(added.body.userId).toBe(spareUserId);
      spareUserId = added.body.userId;

      await probe(
        'post',
        `/organizations/${organizationId}/members`,
        (req) => asOwner(req).send({ userId: spareUserId }),
        '409',
        'already a member',
      );
    });

    it('GET /organizations/{organizationId}/members returns 200, 401 and 403', async () => {
      const listed = await probe(
        'get',
        `/organizations/${organizationId}/members`,
        (req) => asOwner(req),
        '200',
      );
      expect(Array.isArray(listed.body)).toBe(true);

      await probe(
        'get',
        `/organizations/${organizationId}/members`,
        (req) => asOutsider(req),
        '403',
        'not a member',
      );
      await probe(
        'get',
        `/organizations/${organizationId}/members`,
        (req) => req,
        '401',
        'no token',
      );
    });

    it('GET /organizations/{organizationId}/role-templates returns 200 and 403', async () => {
      const listed = await probe(
        'get',
        `/organizations/${organizationId}/role-templates`,
        (req) => asOwner(req),
        '200',
      );
      expect(listed.body.length).toBeGreaterThan(0);

      await probe(
        'get',
        `/organizations/${organizationId}/role-templates`,
        (req) => asOutsider(req),
        '403',
        'not a member',
      );
      await probe(
        'get',
        `/organizations/${organizationId}/role-templates`,
        (req) => req,
        '401',
        'no token',
      );
    });

    it('POST /organizations/{organizationId}/roles returns 400, 401, 403, 404, 409 and 201', async () => {
      await probe(
        'post',
        `/organizations/${organizationId}/roles`,
        (req) => req.send({ name: 'Anonymous' }),
        '401',
        'no token',
      );

      await probe(
        'post',
        `/organizations/${organizationId}/roles`,
        (req) => asOutsider(req).send({ name: 'Stolen' }),
        '403',
        'not a member',
      );

      await probe(
        'post',
        `/organizations/${organizationId}/roles`,
        (req) =>
          asOwner(req).send({
            name: 'Unknown permission',
            permissions: ['nope'],
          }),
        '400',
        'unknown permission name',
      );

      await probe(
        'post',
        `/organizations/${organizationId}/roles`,
        (req) =>
          asOwner(req).send({
            name: 'Ghost',
            userId: '00000000-0000-4000-8000-000000000000',
          }),
        '404',
        'unknown userId',
      );

      await probe(
        'post',
        `/organizations/${organizationId}/roles`,
        (req) =>
          asOwner(req).send({ name: 'Second seat', userId: spareUserId }),
        '409',
        'user already holds a role',
      );

      const created = await probe(
        'post',
        `/organizations/${organizationId}/roles`,
        (req) =>
          asOwner(req).send({
            name: 'Reviewer',
            description: 'Reads everything, changes nothing',
            permissions: ['project.view'],
          }),
        '201',
        'unassigned role',
      );
      spareRoleId = created.body.id;
      expect(created.body.userId).toBeNull();
    });

    it('GET /organizations/{organizationId}/roles returns 200, 401 and 403', async () => {
      const listed = await probe(
        'get',
        `/organizations/${organizationId}/roles`,
        (req) => asOwner(req),
        '200',
      );
      expect(listed.body.length).toBeGreaterThan(0);

      await probe(
        'get',
        `/organizations/${organizationId}/roles`,
        (req) => asOutsider(req),
        '403',
        'not a member',
      );
      await probe(
        'get',
        `/organizations/${organizationId}/roles`,
        (req) => req,
        '401',
        'no token',
      );
    });

    it('GET /organizations/{organizationId}/roles/{roleId} returns 200, 401, 403 and 404', async () => {
      const found = await probe(
        'get',
        `/organizations/${organizationId}/roles/${spareRoleId}`,
        (req) => asOwner(req),
        '200',
      );
      expect(found.body.id).toBe(spareRoleId);

      await probe(
        'get',
        `/organizations/${organizationId}/roles/${spareRoleId}`,
        (req) => req,
        '401',
        'no token',
      );

      await probe(
        'get',
        `/organizations/${organizationId}/roles/${spareRoleId}`,
        (req) => asOutsider(req),
        '403',
        'not a member',
      );

      await probe(
        'get',
        `/organizations/${organizationId}/roles/00000000-0000-4000-8000-000000000000`,
        (req) => asOwner(req),
        '404',
        'unknown role',
      );
    });

    it('PATCH /organizations/{organizationId}/roles/{roleId} returns 200, 400, 401, 403 and 404', async () => {
      const renamed = await probe(
        'patch',
        `/organizations/${organizationId}/roles/${spareRoleId}`,
        (req) => asOwner(req).send({ name: 'Reviewer team' }),
        '200',
      );
      expect(renamed.body.name).toBe('Reviewer team');

      await probe(
        'patch',
        `/organizations/${organizationId}/roles/${spareRoleId}`,
        (req) => asOwner(req).send({ name: '' }),
        '400',
        'empty name',
      );

      await probe(
        'patch',
        `/organizations/${organizationId}/roles/${spareRoleId}`,
        (req) => asOutsider(req).send({ name: 'Stolen' }),
        '403',
        'not a member',
      );

      await probe(
        'patch',
        `/organizations/${organizationId}/roles/${spareRoleId}`,
        (req) => req.send({ name: 'Anonymous' }),
        '401',
        'no token',
      );

      await probe(
        'patch',
        `/organizations/${organizationId}/roles/00000000-0000-4000-8000-000000000000`,
        (req) => asOwner(req).send({ name: 'Ghost' }),
        '404',
        'unknown role',
      );
    });

    it('PUT /organizations/{organizationId}/roles/{roleId}/permissions returns 200, 400, 401, 403 and 404', async () => {
      const replaced = await probe(
        'put',
        `/organizations/${organizationId}/roles/${spareRoleId}/permissions`,
        (req) =>
          asOwner(req).send({
            permissions: ['project.view', 'task.view', 'dashboard.view'],
          }),
        '200',
      );
      // `permissions` holds the permission rows, so compare their names.
      expect(
        (replaced.body.permissions as { name: string }[]).map(
          (permission) => permission.name,
        ),
      ).toEqual(['project.view', 'task.view', 'dashboard.view']);

      await probe(
        'put',
        `/organizations/${organizationId}/roles/${spareRoleId}/permissions`,
        (req) => asOwner(req).send({ permissions: ['nope'] }),
        '400',
        'unknown permission name',
      );

      await probe(
        'put',
        `/organizations/${organizationId}/roles/${spareRoleId}/permissions`,
        (req) => asOutsider(req).send({ permissions: [] }),
        '403',
        'not a member',
      );

      await probe(
        'put',
        `/organizations/${organizationId}/roles/${spareRoleId}/permissions`,
        (req) => req.send({ permissions: [] }),
        '401',
        'no token',
      );

      await probe(
        'put',
        `/organizations/${organizationId}/roles/00000000-0000-4000-8000-000000000000/permissions`,
        (req) => asOwner(req).send({ permissions: ['task.view'] }),
        '404',
        'unknown role',
      );
    });

    it('POST /organizations/{organizationId}/roles/{roleId}/assign returns 400, 401, 403, 404, 409 and 201', async () => {
      await probe(
        'post',
        `/organizations/${organizationId}/roles/${spareRoleId}/assign`,
        (req) => asOwner(req).send({}),
        '400',
        'missing userId',
      );

      await probe(
        'post',
        `/organizations/${organizationId}/roles/${spareRoleId}/assign`,
        (req) => asOutsider(req).send({ userId: spareUserId }),
        '403',
        'not a member',
      );

      await probe(
        'post',
        `/organizations/${organizationId}/roles/${spareRoleId}/assign`,
        (req) => req.send({ userId: spareUserId }),
        '401',
        'no token',
      );

      await probe(
        'post',
        `/organizations/${organizationId}/roles/00000000-0000-4000-8000-000000000000/assign`,
        (req) => asOwner(req).send({ userId: spareUserId }),
        '404',
        'unknown role',
      );

      // `spareUserId` already holds a role from the add-member probe, so the
      // assignee has to be somebody without one: a user who holds no role is
      // exactly what `assertMemberSlotFree` looks for.
      const assignee = await verifiedUserWithId(
        `assignee-${Date.now()}@example.com`,
      );
      userTokens.push(assignee.token);

      const assigned = await probe(
        'post',
        `/organizations/${organizationId}/roles/${spareRoleId}/assign`,
        (req) => asOwner(req).send({ userId: assignee.userId }),
        '201',
      );
      expect(assigned.body.userId).toBe(assignee.userId);

      // The role now has a holder, so a second assignee is refused.
      const second = await verifiedUserWithId(
        `second-${Date.now()}@example.com`,
      );
      userTokens.push(second.token);

      await probe(
        'post',
        `/organizations/${organizationId}/roles/${spareRoleId}/assign`,
        (req) => asOwner(req).send({ userId: second.userId }),
        '409',
        'role already assigned',
      );
    });

    it('DELETE /organizations/{organizationId}/roles/{roleId}/assign returns 200, 401, 403 and 404', async () => {
      const unassigned = await probe(
        'delete',
        `/organizations/${organizationId}/roles/${spareRoleId}/assign`,
        (req) => asOwner(req),
        '200',
      );
      expect(unassigned.body.userId).toBeNull();

      await probe(
        'delete',
        `/organizations/${organizationId}/roles/${spareRoleId}/assign`,
        (req) => asOutsider(req),
        '403',
        'not a member',
      );

      await probe(
        'delete',
        `/organizations/${organizationId}/roles/${spareRoleId}/assign`,
        (req) => req,
        '401',
        'no token',
      );

      await probe(
        'delete',
        `/organizations/${organizationId}/roles/00000000-0000-4000-8000-000000000000/assign`,
        (req) => asOwner(req),
        '404',
        'unknown role',
      );
    });

    it('DELETE /organizations/{organizationId}/roles/{roleId} returns 200, 401, 403 and 404', async () => {
      await probe(
        'delete',
        `/organizations/${organizationId}/roles/${spareRoleId}`,
        (req) => asOwner(req),
        '200',
      );

      await probe(
        'delete',
        `/organizations/${organizationId}/roles/${spareRoleId}`,
        (req) => asOutsider(req),
        '403',
        'not a member',
      );

      await probe(
        'delete',
        `/organizations/${organizationId}/roles/${spareRoleId}`,
        (req) => req,
        '401',
        'no token',
      );

      await probe(
        'delete',
        `/organizations/${organizationId}/roles/00000000-0000-4000-8000-000000000000`,
        (req) => asOwner(req),
        '404',
        'unknown role',
      );
    });

    it('PATCH /organizations/{organizationId}/members/{userId} returns 200, 401, 403 and 404', async () => {
      const roles = await probe(
        'post',
        `/organizations/${organizationId}/roles`,
        (req) => asOwner(req).send({ name: 'Temp for reassignment' }),
        '201',
      );

      const moved = await probe(
        'patch',
        `/organizations/${organizationId}/members/${spareUserId}`,
        (req) => asOwner(req).send({ roleId: roles.body.id }),
        '200',
      );
      expect(moved.body.roleId).toBe(roles.body.id);

      await probe(
        'patch',
        `/organizations/${organizationId}/members/${spareUserId}`,
        (req) => asOutsider(req).send({ roleId: roles.body.id }),
        '403',
        'not a member',
      );

      await probe(
        'patch',
        `/organizations/${organizationId}/members/${spareUserId}`,
        (req) => req.send({ roleId: roles.body.id }),
        '401',
        'no token',
      );

      await probe(
        'patch',
        `/organizations/${organizationId}/members/00000000-0000-4000-8000-000000000000`,
        (req) => asOwner(req).send({ roleId: roles.body.id }),
        '404',
        'unknown member',
      );

      // No cleanup here on purpose: `updateMemberRole` moved the spare user onto
      // `roles` and deleted their previous role, so the member-removal probe
      // below is what disposes of it.
      expect(roles.body.id).toEqual(expect.any(String));
    });

    it('DELETE /organizations/{organizationId}/members/{userId} returns 200, 401, 403 and 404', async () => {
      const removed = await probe(
        'delete',
        `/organizations/${organizationId}/members/${spareUserId}`,
        (req) => asOwner(req),
        '200',
      );
      expect(removed.body.message).toBe('Member removed from the organization');

      await probe(
        'delete',
        `/organizations/${organizationId}/members/${spareUserId}`,
        (req) => asOutsider(req),
        '403',
        'not a member',
      );

      await probe(
        'delete',
        `/organizations/${organizationId}/members/${spareUserId}`,
        (req) => req,
        '401',
        'no token',
      );

      await probe(
        'delete',
        `/organizations/${organizationId}/members/00000000-0000-4000-8000-000000000000`,
        (req) => asOwner(req),
        '404',
        'unknown member',
      );
    });
  });

  describe('teams', () => {
    let teamId = '';
    let teamMemberId = '';
    // Teams are probed twice over: the live one carries the membership and
    // restore pairs, the throwaway one is what the 409 restore probe deletes.
    let trashTeamId = '';

    it('POST /teams returns 400, 401, 403 and 201', async () => {
      await probe(
        'post',
        '/teams',
        (req) => req.send({ name: 'Backend Guild' }),
        '401',
        'no token',
      );

      await probe(
        'post',
        '/teams',
        (req) => asOutsider(req).send({ name: 'Stolen' }),
        '403',
        'not a member',
      );

      await probe(
        'post',
        '/teams',
        (req) => asOwner(req).send({ name: '' }),
        '400',
        'empty name',
      );

      const created = await probe(
        'post',
        '/teams',
        (req) =>
          asOwner(req).send({
            name: 'Backend Guild',
            description: 'Services and integrations squad.',
          }),
        '201',
      );
      teamId = created.body.id;
      // The task suite assigns subtasks to this team's members, so it needs the
      // team to still be live.
      teamIdForTask = teamId;

      const throwaway = await probe(
        'post',
        '/teams',
        (req) => asOwner(req).send({ name: 'Disbanded' }),
        '201',
        'to be trashed',
      );
      trashTeamId = throwaway.body.id;
    });

    it('GET /teams returns 200, 401 and 403', async () => {
      const listed = await probe('get', '/teams', (req) => asOwner(req), '200');
      expect(listed.body.items.length).toBeGreaterThanOrEqual(2);

      await probe('get', '/teams', (req) => req, '401', 'no token');
      await probe(
        'get',
        '/teams',
        (req) => asOutsider(req),
        '403',
        'not a member',
      );
    });

    it('GET /teams/{teamId} returns 200, 401, 403 and 404', async () => {
      const found = await probe(
        'get',
        `/teams/${teamId}`,
        (req) => asOwner(req),
        '200',
      );
      expect(found.body.id).toBe(teamId);

      await probe('get', `/teams/${teamId}`, (req) => req, '401', 'no token');
      await probe(
        'get',
        `/teams/${teamId}`,
        (req) => asOutsider(req),
        '403',
        'not a member',
      );
      await probe(
        'get',
        '/teams/00000000-0000-4000-8000-000000000000',
        (req) => asOwner(req),
        '404',
        'unknown team',
      );
    });

    it('PATCH /teams/{teamId} returns 200, 400, 401, 403 and 404', async () => {
      const renamed = await probe(
        'patch',
        `/teams/${teamId}`,
        (req) => asOwner(req).send({ name: 'Platform Guild' }),
        '200',
      );
      expect(renamed.body.name).toBe('Platform Guild');

      await probe(
        'patch',
        `/teams/${teamId}`,
        (req) => asOwner(req).send({ status: 'nope' }),
        '400',
        'unknown status',
      );
      await probe(
        'patch',
        `/teams/${teamId}`,
        (req) => asOutsider(req).send({ name: 'Stolen' }),
        '403',
        'not a member',
      );
      await probe(
        'patch',
        `/teams/${teamId}`,
        (req) => req.send({ name: 'Anonymous' }),
        '401',
        'no token',
      );
      await probe(
        'patch',
        '/teams/00000000-0000-4000-8000-000000000000',
        (req) => asOwner(req).send({ name: 'Ghost' }),
        '404',
        'unknown team',
      );
    });

    it('GET /teams/{teamId}/members returns 200, 401, 403 and 404', async () => {
      const listed = await probe(
        'get',
        `/teams/${teamId}/members`,
        (req) => asOwner(req),
        '200',
      );
      expect(Array.isArray(listed.body)).toBe(true);

      await probe(
        'get',
        `/teams/${teamId}/members`,
        (req) => req,
        '401',
        'no token',
      );
      await probe(
        'get',
        `/teams/${teamId}/members`,
        (req) => asOutsider(req),
        '403',
        'not a member',
      );
      await probe(
        'get',
        '/teams/00000000-0000-4000-8000-000000000000/members',
        (req) => asOwner(req),
        '404',
        'unknown team',
      );
    });

    it('POST /teams/{teamId}/members returns 400, 401, 403, 404, 409 and 201', async () => {
      await probe(
        'post',
        `/teams/${teamId}/members`,
        (req) => asOwner(req).send({}),
        '400',
        'neither userId nor email',
      );

      await probe(
        'post',
        `/teams/${teamId}/members`,
        (req) => asOutsider(req).send({ userId: memberUserId }),
        '403',
        'not a member',
      );

      await probe(
        'post',
        `/teams/${teamId}/members`,
        (req) =>
          asOwner(req).send({ email: `absent-${Date.now()}@example.com` }),
        '404',
        'unknown user',
      );

      await probe(
        'post',
        '/teams/00000000-0000-4000-8000-000000000000/members',
        (req) => asOwner(req).send({ userId: memberUserId }),
        '404',
        'unknown team',
      );

      const added = await probe(
        'post',
        `/teams/${teamId}/members`,
        (req) => asOwner(req).send({ userId: memberUserId, role: 'lead' }),
        '201',
      );
      teamMemberId = added.body.id;

      await probe(
        'post',
        `/teams/${teamId}/members`,
        (req) => asOwner(req).send({ userId: memberUserId }),
        '409',
        'already a member',
      );

      await probe(
        'post',
        `/teams/${teamId}/members`,
        (req) => req.send({ userId: memberUserId }),
        '401',
        'no token',
      );
    });

    it('PATCH /teams/{teamId}/members/{memberId} returns 200, 400, 401, 403 and 404', async () => {
      const moved = await probe(
        'patch',
        `/teams/${teamId}/members/${teamMemberId}`,
        (req) => asOwner(req).send({ status: 'inactive' }),
        '200',
      );
      expect(moved.body.status).toBe('inactive');

      // Back to active: a subtask can only be assigned to an active team member,
      // and the task suite below assigns one.
      await probe(
        'patch',
        `/teams/${teamId}/members/${teamMemberId}`,
        (req) => asOwner(req).send({ status: 'active' }),
        '200',
        'active again',
      );

      await probe(
        'patch',
        `/teams/${teamId}/members/${teamMemberId}`,
        (req) => asOwner(req).send({ role: 'nope' }),
        '400',
        'unknown team role',
      );
      await probe(
        'patch',
        `/teams/${teamId}/members/${teamMemberId}`,
        (req) => asOutsider(req).send({ status: 'inactive' }),
        '403',
        'not a member',
      );
      await probe(
        'patch',
        `/teams/${teamId}/members/${teamMemberId}`,
        (req) => req.send({ status: 'inactive' }),
        '401',
        'no token',
      );
      await probe(
        'patch',
        `/teams/${teamId}/members/00000000-0000-4000-8000-000000000000`,
        (req) => asOwner(req).send({ status: 'inactive' }),
        '404',
        'unknown team member',
      );
    });

    it('DELETE /teams/{teamId}/members/{memberId} returns 200, 401, 403 and 404', async () => {
      await probe(
        'delete',
        `/teams/${teamId}/members/${teamMemberId}`,
        (req) => asOwner(req),
        '200',
      );

      await probe(
        'delete',
        `/teams/${teamId}/members/${teamMemberId}`,
        (req) => asOutsider(req),
        '403',
        'not a member',
      );
      await probe(
        'delete',
        `/teams/${teamId}/members/${teamMemberId}`,
        (req) => req,
        '401',
        'no token',
      );
      await probe(
        'delete',
        `/teams/${teamId}/members/00000000-0000-4000-8000-000000000000`,
        (req) => asOwner(req),
        '404',
        'unknown team member',
      );

      // Readded so the subtask assignment below has an active member to name.
      const readded = await probe(
        'post',
        `/teams/${teamId}/members`,
        (req) => asOwner(req).send({ userId: memberUserId, role: 'member' }),
        '201',
        'ready for assignment',
      );
      teamMemberId = readded.body.id;
    });

    it('DELETE /teams/{teamId} returns 200, 401, 403 and 404', async () => {
      await probe(
        'delete',
        `/teams/${trashTeamId}`,
        (req) => asOwner(req),
        '200',
      );

      await probe(
        'delete',
        `/teams/${teamId}`,
        (req) => asOutsider(req),
        '403',
        'not a member',
      );
      await probe(
        'delete',
        `/teams/${teamId}`,
        (req) => req,
        '401',
        'no token',
      );
      await probe(
        'delete',
        '/teams/00000000-0000-4000-8000-000000000000',
        (req) => asOwner(req),
        '404',
        'unknown team',
      );
    });

    it('GET /teams/trash returns 200, 401 and 403', async () => {
      const listed = await probe(
        'get',
        '/teams/trash',
        (req) => asOwner(req),
        '200',
      );
      expect(listed.body.map((entry: { id: string }) => entry.id)).toContain(
        trashTeamId,
      );

      await probe('get', '/teams/trash', (req) => req, '401', 'no token');
      await probe(
        'get',
        '/teams/trash',
        (req) => asOutsider(req),
        '403',
        'not a member',
      );
    });

    it('POST /teams/{teamId}/restore returns 201, 401, 403, 404 and 409', async () => {
      const restored = await probe(
        'post',
        `/teams/${trashTeamId}/restore`,
        (req) => asOwner(req),
        '201',
      );
      expect(restored.body.id).toBe(trashTeamId);

      await probe(
        'post',
        `/teams/${trashTeamId}/restore`,
        (req) => asOutsider(req),
        '403',
        'not a member',
      );
      await probe(
        'post',
        `/teams/${trashTeamId}/restore`,
        (req) => req,
        '401',
        'no token',
      );
      await probe(
        'post',
        '/teams/00000000-0000-4000-8000-000000000000/restore',
        (req) => asOwner(req),
        '404',
        'unknown team',
      );
      await probe(
        'post',
        `/teams/${trashTeamId}/restore`,
        (req) => asOwner(req),
        '409',
        'not deleted',
      );

      // Leave the team trashed for the 409 to be reproducible if this reruns.
      await probe(
        'delete',
        `/teams/${trashTeamId}`,
        (req) => asOwner(req),
        '200',
        'trash again',
      );
    });
  });

  describe('clients', () => {
    let clientId = '';
    let trashClientId = '';
    let takenEmail = '';
    let holderClientId = '';
    let holderEmail = '';

    it('POST /clients returns 400, 401, 403, 409 and 201', async () => {
      await probe(
        'post',
        '/clients',
        (req) => req.send({ name: 'Globex' }),
        '401',
        'no token',
      );

      await probe(
        'post',
        '/clients',
        (req) => asOutsider(req).send({ name: 'Stolen' }),
        '403',
        'not a member',
      );

      await probe(
        'post',
        '/clients',
        (req) => asOwner(req).send({ name: 'Globex', email: 'not-an-email' }),
        '400',
        'malformed email',
      );

      takenEmail = `globex-${Date.now()}@example.com`;

      const created = await probe(
        'post',
        '/clients',
        (req) =>
          asOwner(req).send({
            name: 'Globex Corporation',
            email: takenEmail,
            industry: 'Manufacturing',
          }),
        '201',
      );
      clientId = created.body.id;

      await probe(
        'post',
        '/clients',
        (req) =>
          asOwner(req).send({ name: 'Globex duplicate', email: takenEmail }),
        '409',
        'duplicate email',
      );

      const throwaway = await probe(
        'post',
        '/clients',
        (req) => asOwner(req).send({ name: 'Disbanded client' }),
        '201',
        'to be trashed',
      );
      trashClientId = throwaway.body.id;

      // The first client already owns `takenEmail` and addresses are unique per
      // organization, so the patch probe needs a second client of its own to
      // aim the taken address at.
      const holder = await probe(
        'post',
        '/clients',
        (req) =>
          asOwner(req).send({
            name: 'Initech',
            email: `initech-${Date.now()}@example.com`,
          }),
        '201',
        'a second client to collide with',
      );
      expect(holder.body.id).not.toBe(clientId);
      holderClientId = holder.body.id;
      holderEmail = holder.body.email;
    });

    it('GET /clients returns 200, 401 and 403', async () => {
      const listed = await probe(
        'get',
        '/clients',
        (req) => asOwner(req),
        '200',
      );
      expect(listed.body.items.length).toBeGreaterThanOrEqual(2);

      await probe('get', '/clients', (req) => req, '401', 'no token');
      await probe(
        'get',
        '/clients',
        (req) => asOutsider(req),
        '403',
        'not a member',
      );
    });

    it('GET /clients/{clientId} returns 200, 401, 403 and 404', async () => {
      const found = await probe(
        'get',
        `/clients/${clientId}`,
        (req) => asOwner(req),
        '200',
      );
      expect(found.body.id).toBe(clientId);

      await probe(
        'get',
        `/clients/${clientId}`,
        (req) => req,
        '401',
        'no token',
      );
      await probe(
        'get',
        `/clients/${clientId}`,
        (req) => asOutsider(req),
        '403',
        'not a member',
      );
      await probe(
        'get',
        '/clients/00000000-0000-4000-8000-000000000000',
        (req) => asOwner(req),
        '404',
        'unknown client',
      );
    });

    it('PATCH /clients/{clientId} returns 200, 400, 401, 403, 404 and 409', async () => {
      const renamed = await probe(
        'patch',
        `/clients/${clientId}`,
        (req) => asOwner(req).send({ name: 'Globex Holdings' }),
        '200',
      );
      expect(renamed.body.name).toBe('Globex Holdings');

      await probe(
        'patch',
        `/clients/${clientId}`,
        (req) => asOwner(req).send({ email: 'not-an-email' }),
        '400',
        'malformed email',
      );
      await probe(
        'patch',
        `/clients/${clientId}`,
        (req) => asOutsider(req).send({ name: 'Stolen' }),
        '403',
        'not a member',
      );
      await probe(
        'patch',
        `/clients/${clientId}`,
        (req) => req.send({ name: 'Anonymous' }),
        '401',
        'no token',
      );
      await probe(
        'patch',
        '/clients/00000000-0000-4000-8000-000000000000',
        (req) => asOwner(req).send({ name: 'Ghost' }),
        '404',
        'unknown client',
      );
      // Initech already holds `takenEmail`, so aiming its own patch at that address
      // is a real collision rather than the client keeping what it arrived with.
      await probe(
        'patch',
        `/clients/${holderClientId}`,
        (req) => asOwner(req).send({ email: takenEmail }),
        '409',
        'email already taken',
      );
      const unchanged = await probe(
        'get',
        `/clients/${holderClientId}`,
        (req) => asOwner(req),
        '200',
        'unchanged by the refusal',
      );
      expect(unchanged.body).toMatchObject({ email: holderEmail });
    });

    it('DELETE /clients/{clientId} returns 200, 401, 403 and 404', async () => {
      await probe(
        'delete',
        `/clients/${trashClientId}`,
        (req) => asOwner(req),
        '200',
      );

      await probe(
        'delete',
        `/clients/${clientId}`,
        (req) => asOutsider(req),
        '403',
        'not a member',
      );
      await probe(
        'delete',
        `/clients/${clientId}`,
        (req) => req,
        '401',
        'no token',
      );
      await probe(
        'delete',
        '/clients/00000000-0000-4000-8000-000000000000',
        (req) => asOwner(req),
        '404',
        'unknown client',
      );
    });

    it('GET /clients/trash returns 200, 401 and 403', async () => {
      const listed = await probe(
        'get',
        '/clients/trash',
        (req) => asOwner(req),
        '200',
      );
      expect(listed.body.map((entry: { id: string }) => entry.id)).toContain(
        trashClientId,
      );

      await probe('get', '/clients/trash', (req) => req, '401', 'no token');
      await probe(
        'get',
        '/clients/trash',
        (req) => asOutsider(req),
        '403',
        'not a member',
      );
    });

    it('POST /clients/{clientId}/restore returns 201, 401, 403, 404 and 409', async () => {
      const restored = await probe(
        'post',
        `/clients/${trashClientId}/restore`,
        (req) => asOwner(req),
        '201',
      );
      expect(restored.body.id).toBe(trashClientId);

      await probe(
        'post',
        `/clients/${trashClientId}/restore`,
        (req) => asOutsider(req),
        '403',
        'not a member',
      );
      await probe(
        'post',
        `/clients/${trashClientId}/restore`,
        (req) => req,
        '401',
        'no token',
      );
      await probe(
        'post',
        '/clients/00000000-0000-4000-8000-000000000000/restore',
        (req) => asOwner(req),
        '404',
        'unknown client',
      );
      await probe(
        'post',
        `/clients/${trashClientId}/restore`,
        (req) => asOwner(req),
        '409',
        'not deleted',
      );

      await probe(
        'delete',
        `/clients/${trashClientId}`,
        (req) => asOwner(req),
        '200',
        'trash again',
      );
    });
  });

  describe('badges', () => {
    let badgeId = '';
    let trashBadgeId = '';

    it('POST /badges returns 400, 401, 403 and 201', async () => {
      await probe(
        'post',
        '/badges',
        (req) => req.send({ name: 'Regression' }),
        '401',
        'no token',
      );
      await probe(
        'post',
        '/badges',
        (req) => asOutsider(req).send({ name: 'Stolen' }),
        '403',
        'not a member',
      );
      await probe(
        'post',
        '/badges',
        (req) => asOwner(req).send({ name: '', color: 'red' }),
        '400',
        'empty name',
      );
      await probe(
        'post',
        '/badges',
        (req) => asOwner(req).send({ name: 'Regression', color: 'red' }),
        '400',
        'colour without a hash',
      );

      const created = await probe(
        'post',
        '/badges',
        (req) =>
          asOwner(req).send({
            name: 'Regression',
            color: '#ef4444',
            icon: 'bug',
          }),
        '201',
      );
      badgeId = created.body.id;
      badgeIdForTask = badgeId;

      const throwaway = await probe(
        'post',
        '/badges',
        (req) => asOwner(req).send({ name: 'Retired' }),
        '201',
        'to be trashed',
      );
      trashBadgeId = throwaway.body.id;
    });

    it('GET /badges returns 200, 401 and 403', async () => {
      const listed = await probe(
        'get',
        '/badges',
        (req) => asOwner(req),
        '200',
      );
      expect(listed.body.items.length).toBeGreaterThanOrEqual(2);

      await probe('get', '/badges', (req) => req, '401', 'no token');
      await probe(
        'get',
        '/badges',
        (req) => asOutsider(req),
        '403',
        'not a member',
      );
    });

    it('GET /badges/{badgeId} returns 200, 401, 403 and 404', async () => {
      const found = await probe(
        'get',
        `/badges/${badgeId}`,
        (req) => asOwner(req),
        '200',
      );
      expect(found.body.id).toBe(badgeId);

      await probe('get', `/badges/${badgeId}`, (req) => req, '401', 'no token');
      await probe(
        'get',
        `/badges/${badgeId}`,
        (req) => asOutsider(req),
        '403',
        'not a member',
      );
      await probe(
        'get',
        '/badges/00000000-0000-4000-8000-000000000000',
        (req) => asOwner(req),
        '404',
        'unknown badge',
      );
    });

    it('PATCH /badges/{badgeId} returns 200, 400, 401, 403 and 404', async () => {
      const renamed = await probe(
        'patch',
        `/badges/${badgeId}`,
        (req) => asOwner(req).send({ name: 'Regression risk' }),
        '200',
      );
      expect(renamed.body.name).toBe('Regression risk');

      await probe(
        'patch',
        `/badges/${badgeId}`,
        (req) => asOwner(req).send({ color: 'red' }),
        '400',
        'colour without a hash',
      );
      await probe(
        'patch',
        `/badges/${badgeId}`,
        (req) => asOutsider(req).send({ name: 'Stolen' }),
        '403',
        'not a member',
      );
      await probe(
        'patch',
        `/badges/${badgeId}`,
        (req) => req.send({ name: 'Anonymous' }),
        '401',
        'no token',
      );
      await probe(
        'patch',
        '/badges/00000000-0000-4000-8000-000000000000',
        (req) => asOwner(req).send({ name: 'Ghost' }),
        '404',
        'unknown badge',
      );
    });

    it('DELETE /badges/{badgeId} returns 200, 401, 403 and 404', async () => {
      await probe(
        'delete',
        `/badges/${trashBadgeId}`,
        (req) => asOwner(req),
        '200',
      );

      await probe(
        'delete',
        `/badges/${badgeId}`,
        (req) => asOutsider(req),
        '403',
        'not a member',
      );
      await probe(
        'delete',
        `/badges/${badgeId}`,
        (req) => req,
        '401',
        'no token',
      );
      await probe(
        'delete',
        '/badges/00000000-0000-4000-8000-000000000000',
        (req) => asOwner(req),
        '404',
        'unknown badge',
      );
    });

    it('GET /badges/trash returns 200, 401 and 403', async () => {
      const listed = await probe(
        'get',
        '/badges/trash',
        (req) => asOwner(req),
        '200',
      );
      expect(listed.body.map((entry: { id: string }) => entry.id)).toContain(
        trashBadgeId,
      );

      await probe('get', '/badges/trash', (req) => req, '401', 'no token');
      await probe(
        'get',
        '/badges/trash',
        (req) => asOutsider(req),
        '403',
        'not a member',
      );
    });

    it('POST /badges/{badgeId}/restore returns 201, 401, 403, 404 and 409', async () => {
      const restored = await probe(
        'post',
        `/badges/${trashBadgeId}/restore`,
        (req) => asOwner(req),
        '201',
      );
      expect(restored.body.id).toBe(trashBadgeId);

      await probe(
        'post',
        `/badges/${trashBadgeId}/restore`,
        (req) => asOutsider(req),
        '403',
        'not a member',
      );
      await probe(
        'post',
        `/badges/${trashBadgeId}/restore`,
        (req) => req,
        '401',
        'no token',
      );
      await probe(
        'post',
        '/badges/00000000-0000-4000-8000-000000000000/restore',
        (req) => asOwner(req),
        '404',
        'unknown badge',
      );
      await probe(
        'post',
        `/badges/${trashBadgeId}/restore`,
        (req) => asOwner(req),
        '409',
        'not deleted',
      );

      await probe(
        'delete',
        `/badges/${trashBadgeId}`,
        (req) => asOwner(req),
        '200',
        'trash again',
      );
    });
  });

  describe('projects, tasks and subtasks', () => {
    // One chain of fixtures, because each level refuses a parent that does not
    // belong to the organization: a task needs a project, a subtask needs a
    // task with a team, and logged time needs a subtask.
    let projectId = '';
    let trashProjectId = '';
    let taskId = '';
    let trashTaskId = '';
    let teamlessTaskId = '';
    let subtaskId = '';
    let trashSubtaskId = '';

    it('POST /projects returns 400, 401, 403, 404 and 201', async () => {
      await probe(
        'post',
        '/projects',
        (req) => req.send({ name: 'Ghost' }),
        '401',
        'no token',
      );
      await probe(
        'post',
        '/projects',
        (req) => asOutsider(req).send({ name: 'Stolen' }),
        '403',
        'not a member',
      );
      await probe(
        'post',
        '/projects',
        (req) => asOwner(req).send({ name: '', status: 'planned' }),
        '400',
        'empty name',
      );
      await probe(
        'post',
        '/projects',
        (req) =>
          asOwner(req).send({
            name: 'End dates',
            startDate: '2026-06-01',
            endDate: '2026-01-01',
          }),
        '400',
        'end before start',
      );
      await probe(
        'post',
        '/projects',
        (req) =>
          asOwner(req).send({
            name: 'Ghost',
            clientId: '00000000-0000-4000-8000-000000000000',
          }),
        '404',
        'unknown client',
      );

      const created = await probe(
        'post',
        '/projects',
        (req) => asOwner(req).send({ name: 'Website relaunch' }),
        '201',
      );
      projectId = created.body.id;

      const throwaway = await probe(
        'post',
        '/projects',
        (req) => asOwner(req).send({ name: 'Abandoned' }),
        '201',
        'to be trashed',
      );
      trashProjectId = throwaway.body.id;
    });

    it('GET /projects returns 200, 401 and 403', async () => {
      const listed = await probe(
        'get',
        '/projects',
        (req) => asOwner(req),
        '200',
      );
      expect(listed.body.items.length).toBeGreaterThanOrEqual(2);

      await probe('get', '/projects', (req) => req, '401', 'no token');
      await probe(
        'get',
        '/projects',
        (req) => asOutsider(req),
        '403',
        'not a member',
      );
    });

    it('GET /projects/{projectId} returns 200, 401, 403 and 404', async () => {
      const found = await probe(
        'get',
        `/projects/${projectId}`,
        (req) => asOwner(req),
        '200',
      );
      expect(found.body.id).toBe(projectId);

      await probe(
        'get',
        `/projects/${projectId}`,
        (req) => req,
        '401',
        'no token',
      );
      await probe(
        'get',
        `/projects/${projectId}`,
        (req) => asOutsider(req),
        '403',
        'not a member',
      );
      await probe(
        'get',
        '/projects/00000000-0000-4000-8000-000000000000',
        (req) => asOwner(req),
        '404',
        'unknown project',
      );
    });

    it('PATCH /projects/{projectId} returns 200, 400, 401, 403 and 404', async () => {
      const renamed = await probe(
        'patch',
        `/projects/${projectId}`,
        (req) => asOwner(req).send({ name: 'Website relaunch 2' }),
        '200',
      );
      expect(renamed.body.name).toBe('Website relaunch 2');

      await probe(
        'patch',
        `/projects/${projectId}`,
        (req) => asOwner(req).send({ status: 'nope' }),
        '400',
        'unknown status',
      );
      await probe(
        'patch',
        `/projects/${projectId}`,
        (req) => asOutsider(req).send({ name: 'Stolen' }),
        '403',
        'not a member',
      );
      await probe(
        'patch',
        `/projects/${projectId}`,
        (req) => req.send({ name: 'Anonymous' }),
        '401',
        'no token',
      );
      await probe(
        'patch',
        '/projects/00000000-0000-4000-8000-000000000000',
        (req) => asOwner(req).send({ name: 'Ghost' }),
        '404',
        'unknown project',
      );
    });

    it('POST /tasks returns 400, 401, 403, 404 and 201', async () => {
      await probe(
        'post',
        '/tasks',
        (req) => req.send({ title: 'Anonymous' }),
        '401',
        'no token',
      );
      await probe(
        'post',
        '/tasks',
        (req) => asOutsider(req).send({ title: 'Stolen' }),
        '403',
        'not a member',
      );
      await probe(
        'post',
        '/tasks',
        (req) => asOwner(req).send({ title: '' }),
        '400',
        'empty title',
      );
      await probe(
        'post',
        '/tasks',
        (req) =>
          asOwner(req).send({
            title: 'Ghost',
            projectId: '00000000-0000-4000-8000-000000000000',
          }),
        '404',
        'unknown project',
      );

      // With a team, so a subtask can be assigned to a member of it.
      const assigned = await probe(
        'post',
        '/tasks',
        (req) =>
          asOwner(req).send({
            title: 'Implement invoicing endpoint',
            projectId,
            teamId: teamIdForTask,
            badgeId: badgeIdForTask,
          }),
        '201',
      );
      taskId = assigned.body.id;
      expect(assigned.body.teamId).toBe(teamIdForTask);
      // The estimation suite below reads this task for its variance.
      taskIdForEstimate = taskId;

      const unteamed = await probe(
        'post',
        '/tasks',
        (req) => asOwner(req).send({ title: 'No team yet', projectId }),
        '201',
        'without a team',
      );
      teamlessTaskId = unteamed.body.id;

      const throwaway = await probe(
        'post',
        '/tasks',
        (req) => asOwner(req).send({ title: 'Obsolete', projectId }),
        '201',
        'to be trashed',
      );
      trashTaskId = throwaway.body.id;
    });

    it('GET /tasks returns 200, 401 and 403', async () => {
      const listed = await probe(
        'get',
        '/tasks',
        (req) => asOwner(req).query({ projectId }),
        '200',
      );
      expect(listed.body.items.length).toBe(3);

      await probe('get', '/tasks', (req) => req, '401', 'no token');
      await probe(
        'get',
        '/tasks',
        (req) => asOutsider(req),
        '403',
        'not a member',
      );
    });

    it('GET /tasks/{taskId} returns 200, 401, 403 and 404', async () => {
      const found = await probe(
        'get',
        `/tasks/${taskId}`,
        (req) => asOwner(req),
        '200',
      );
      expect(found.body.id).toBe(taskId);

      await probe('get', `/tasks/${taskId}`, (req) => req, '401', 'no token');
      await probe(
        'get',
        `/tasks/${taskId}`,
        (req) => asOutsider(req),
        '403',
        'not a member',
      );
      await probe(
        'get',
        '/tasks/00000000-0000-4000-8000-000000000000',
        (req) => asOwner(req),
        '404',
        'unknown task',
      );
    });

    it('PATCH /tasks/{taskId} returns 200, 400, 401, 403 and 404', async () => {
      const renamed = await probe(
        'patch',
        `/tasks/${taskId}`,
        (req) =>
          asOwner(req).send({ title: 'Implement invoicing endpoint v2' }),
        '200',
      );
      expect(renamed.body.title).toBe('Implement invoicing endpoint v2');

      await probe(
        'patch',
        `/tasks/${taskId}`,
        (req) => asOwner(req).send({ priority: 'nope' }),
        '400',
        'unknown priority',
      );
      await probe(
        'patch',
        `/tasks/${taskId}`,
        (req) => asOutsider(req).send({ title: 'Stolen' }),
        '403',
        'not a member',
      );
      await probe(
        'patch',
        `/tasks/${taskId}`,
        (req) => req.send({ title: 'Anonymous' }),
        '401',
        'no token',
      );
      await probe(
        'patch',
        '/tasks/00000000-0000-4000-8000-000000000000',
        (req) => asOwner(req).send({ title: 'Ghost' }),
        '404',
        'unknown task',
      );
    });

    it('POST /tasks/{taskId}/subtasks returns 400, 401, 403, 404 and 201', async () => {
      await probe(
        'post',
        `/tasks/${taskId}/subtasks`,
        (req) => req.send({ title: 'Anonymous' }),
        '401',
        'no token',
      );
      await probe(
        'post',
        `/tasks/${taskId}/subtasks`,
        (req) => asOutsider(req).send({ title: 'Stolen' }),
        '403',
        'not a member',
      );
      await probe(
        'post',
        `/tasks/${taskId}/subtasks`,
        (req) => asOwner(req).send({ title: '' }),
        '400',
        'empty title',
      );
      await probe(
        'post',
        `/tasks/${teamlessTaskId}/subtasks`,
        (req) =>
          asOwner(req).send({
            title: 'Write the schema',
            assignedTo: memberUserId,
          }),
        '400',
        'task has no team',
      );
      await probe(
        'post',
        '/tasks/00000000-0000-4000-8000-000000000000/subtasks',
        (req) => asOwner(req).send({ title: 'Ghost' }),
        '404',
        'unknown task',
      );

      const created = await probe(
        'post',
        `/tasks/${taskId}/subtasks`,
        (req) =>
          asOwner(req).send({
            title: 'Write the migration',
            assignedTo: memberUserId,
          }),
        '201',
      );
      subtaskId = created.body.id;
      expect(created.body.assignedTo).toBe(memberUserId);
      // The logged-time suite below needs a subtask under a live task.
      subtaskIdForTime = subtaskId;

      const unassigned = await probe(
        'post',
        `/tasks/${taskId}/subtasks`,
        (req) => asOwner(req).send({ title: 'Review the migration' }),
        '201',
        'unassigned',
      );
      expect(unassigned.body.assignedTo).toBeNull();

      const throwaway = await probe(
        'post',
        `/tasks/${taskId}/subtasks`,
        (req) => asOwner(req).send({ title: 'Obsolete step' }),
        '201',
        'to be trashed',
      );
      trashSubtaskId = throwaway.body.id;
    });

    it('GET /tasks/{taskId}/subtasks returns 200, 401, 403 and 404', async () => {
      const listed = await probe(
        'get',
        `/tasks/${taskId}/subtasks`,
        (req) => asOwner(req),
        '200',
      );
      expect(listed.body.items.length).toBe(3);

      await probe(
        'get',
        `/tasks/${taskId}/subtasks`,
        (req) => req,
        '401',
        'no token',
      );
      await probe(
        'get',
        `/tasks/${taskId}/subtasks`,
        (req) => asOutsider(req),
        '403',
        'not a member',
      );
      await probe(
        'get',
        '/tasks/00000000-0000-4000-8000-000000000000/subtasks',
        (req) => asOwner(req),
        '404',
        'unknown task',
      );
    });

    it('GET /tasks/{taskId}/subtasks/{subtaskId} returns 200, 401, 403 and 404', async () => {
      const found = await probe(
        'get',
        `/tasks/${taskId}/subtasks/${subtaskId}`,
        (req) => asOwner(req),
        '200',
      );
      expect(found.body.id).toBe(subtaskId);

      await probe(
        'get',
        `/tasks/${taskId}/subtasks/${subtaskId}`,
        (req) => req,
        '401',
        'no token',
      );
      await probe(
        'get',
        `/tasks/${taskId}/subtasks/${subtaskId}`,
        (req) => asOutsider(req),
        '403',
        'not a member',
      );
      await probe(
        'get',
        `/tasks/${taskId}/subtasks/00000000-0000-4000-8000-000000000000`,
        (req) => asOwner(req),
        '404',
        'unknown subtask',
      );
    });

    it('PATCH /tasks/{taskId}/subtasks/{subtaskId} returns 200, 400, 401, 403 and 404', async () => {
      const renamed = await probe(
        'patch',
        `/tasks/${taskId}/subtasks/${subtaskId}`,
        (req) => asOwner(req).send({ title: 'Write and review the migration' }),
        '200',
      );
      expect(renamed.body.title).toBe('Write and review the migration');

      await probe(
        'patch',
        `/tasks/${teamlessTaskId}/subtasks/${subtaskId}`,
        (req) => asOwner(req).send({ status: 'done' }),
        '404',
        'subtask under another task',
      );
      await probe(
        'patch',
        `/tasks/${taskId}/subtasks/${subtaskId}`,
        (req) => asOwner(req).send({ status: 'nope' }),
        '400',
        'unknown status',
      );
      await probe(
        'patch',
        `/tasks/${taskId}/subtasks/${subtaskId}`,
        (req) => asOutsider(req).send({ title: 'Stolen' }),
        '403',
        'not a member',
      );
      await probe(
        'patch',
        `/tasks/${taskId}/subtasks/${subtaskId}`,
        (req) => req.send({ title: 'Anonymous' }),
        '401',
        'no token',
      );
      await probe(
        'patch',
        `/tasks/${taskId}/subtasks/00000000-0000-4000-8000-000000000000`,
        (req) => asOwner(req).send({ title: 'Ghost' }),
        '404',
        'unknown subtask',
      );
    });

    it('GET /tasks/trash returns 200, 401 and 403', async () => {
      await probe('get', '/tasks/trash', (req) => asOwner(req), '200');
      await probe('get', '/tasks/trash', (req) => req, '401', 'no token');
      await probe(
        'get',
        '/tasks/trash',
        (req) => asOutsider(req),
        '403',
        'not a member',
      );
    });

    it('GET /tasks/{taskId}/subtasks/trash returns 200, 401 and 403', async () => {
      await probe(
        'get',
        `/tasks/${taskId}/subtasks/trash`,
        (req) => asOwner(req),
        '200',
      );
      await probe(
        'get',
        `/tasks/${taskId}/subtasks/trash`,
        (req) => req,
        '401',
        'no token',
      );
      await probe(
        'get',
        `/tasks/${taskId}/subtasks/trash`,
        (req) => asOutsider(req),
        '403',
        'not a member',
      );
    });

    it('GET /projects/trash returns 200, 401 and 403', async () => {
      await probe('get', '/projects/trash', (req) => asOwner(req), '200');
      await probe('get', '/projects/trash', (req) => req, '401', 'no token');
      await probe(
        'get',
        '/projects/trash',
        (req) => asOutsider(req),
        '403',
        'not a member',
      );
    });

    it('DELETE /tasks/{taskId}/subtasks/{subtaskId} returns 400, 401, 403, 404 and 409', async () => {
      await probe(
        'delete',
        `/tasks/${taskId}/subtasks/${subtaskId}`,
        (req) => asOwner(req),
        '409',
        'unconfirmed',
      );

      await probe(
        'delete',
        `/tasks/${taskId}/subtasks/${subtaskId}`,
        (req) => asOutsider(req).query({ confirm: 'cascade' }),
        '403',
        'not a member',
      );
      await probe(
        'delete',
        `/tasks/${taskId}/subtasks/${subtaskId}`,
        (req) => req.query({ confirm: 'cascade' }),
        '401',
        'no token',
      );
      await probe(
        'delete',
        `/tasks/${taskId}/subtasks/${subtaskId}`,
        (req) => asOwner(req).query({ confirm: 'not-a-boolean' }),
        '400',
        'malformed confirmation',
      );
      await probe(
        'delete',
        `/tasks/${taskId}/subtasks/00000000-0000-4000-8000-000000000000`,
        // `confirm` has to be the real token: the query pipe rejects anything
        // else with a 400 before the handler looks the record up.
        (req) => asOwner(req).query({ confirm: 'cascade' }),
        '404',
        'unknown subtask',
      );

      const removed = await probe(
        'delete',
        `/tasks/${taskId}/subtasks/${trashSubtaskId}`,
        (req) => asOwner(req).query({ confirm: 'cascade' }),
        '200',
      );
      // `deleted` counts the time entries logged against the subtask as well as
      // the subtask itself.
      expect(removed.body).toMatchObject({ message: 'Subtask deleted' });
      expect(removed.body.deleted).toBeGreaterThanOrEqual(1);
    });

    it('POST /tasks/{taskId}/subtasks/{subtaskId}/restore returns 201, 401, 403, 404 and 409', async () => {
      const restored = await probe(
        'post',
        `/tasks/${taskId}/subtasks/${trashSubtaskId}/restore`,
        (req) => asOwner(req),
        '201',
      );
      expect(restored.body.id).toBe(trashSubtaskId);

      await probe(
        'post',
        `/tasks/${taskId}/subtasks/${trashSubtaskId}/restore`,
        (req) => asOwner(req),
        '409',
        'not deleted',
      );
      await probe(
        'post',
        `/tasks/${taskId}/subtasks/${trashSubtaskId}/restore`,
        (req) => asOutsider(req),
        '403',
        'not a member',
      );
      await probe(
        'post',
        `/tasks/${taskId}/subtasks/${trashSubtaskId}/restore`,
        (req) => req,
        '401',
        'no token',
      );
      await probe(
        'post',
        `/tasks/${taskId}/subtasks/00000000-0000-4000-8000-000000000000/restore`,
        (req) => asOwner(req),
        '404',
        'unknown subtask',
      );

      await probe(
        'delete',
        `/tasks/${taskId}/subtasks/${trashSubtaskId}`,
        (req) => asOwner(req).query({ confirm: 'cascade' }),
        '200',
        'trash again',
      );
    });

    it('DELETE /tasks/{taskId} returns 400, 401, 403, 404 and 409', async () => {
      await probe(
        'delete',
        `/tasks/${trashTaskId}`,
        (req) => asOwner(req),
        '409',
        'unconfirmed',
      );

      await probe(
        'delete',
        `/tasks/${trashTaskId}`,
        (req) => asOutsider(req).query({ confirm: 'cascade' }),
        '403',
        'not a member',
      );
      await probe(
        'delete',
        `/tasks/${trashTaskId}`,
        (req) => req.query({ confirm: 'cascade' }),
        '401',
        'no token',
      );
      await probe(
        'delete',
        `/tasks/${trashTaskId}`,
        (req) => asOwner(req).query({ confirm: 'maybe' }),
        '400',
        'malformed confirmation',
      );
      await probe(
        'delete',
        '/tasks/00000000-0000-4000-8000-000000000000',
        (req) => asOwner(req).query({ confirm: 'cascade' }),
        '404',
        'unknown task',
      );

      const removed = await probe(
        'delete',
        `/tasks/${trashTaskId}`,
        (req) => asOwner(req).query({ confirm: 'cascade' }),
        '200',
      );
      expect(removed.body.message).toBe('Task deleted');
      expect(removed.body.deleted).toBeGreaterThanOrEqual(1);
    });

    it('POST /tasks/{taskId}/restore returns 201, 401, 403, 404 and 409', async () => {
      const restored = await probe(
        'post',
        `/tasks/${trashTaskId}/restore`,
        (req) => asOwner(req),
        '201',
      );
      expect(restored.body.id).toBe(trashTaskId);

      await probe(
        'post',
        `/tasks/${trashTaskId}/restore`,
        (req) => asOwner(req),
        '409',
        'not deleted',
      );
      await probe(
        'post',
        `/tasks/${trashTaskId}/restore`,
        (req) => asOutsider(req),
        '403',
        'not a member',
      );
      await probe(
        'post',
        `/tasks/${trashTaskId}/restore`,
        (req) => req,
        '401',
        'no token',
      );
      await probe(
        'post',
        '/tasks/00000000-0000-4000-8000-000000000000/restore',
        (req) => asOwner(req),
        '404',
        'unknown task',
      );

      await probe(
        'delete',
        `/tasks/${trashTaskId}`,
        (req) => asOwner(req).query({ confirm: 'cascade' }),
        '200',
        'trash again',
      );
    });

    it('DELETE /projects/{projectId} returns 400, 401, 403, 404 and 409', async () => {
      await probe(
        'delete',
        `/projects/${trashProjectId}`,
        (req) => asOwner(req),
        '409',
        'unconfirmed',
      );

      await probe(
        'delete',
        `/projects/${trashProjectId}`,
        (req) => asOutsider(req).query({ confirm: 'cascade' }),
        '403',
        'not a member',
      );
      await probe(
        'delete',
        `/projects/${trashProjectId}`,
        (req) => req.query({ confirm: 'cascade' }),
        '401',
        'no token',
      );
      await probe(
        'delete',
        `/projects/${trashProjectId}`,
        (req) => asOwner(req).query({ confirm: 'maybe' }),
        '400',
        'malformed confirmation',
      );
      await probe(
        'delete',
        '/projects/00000000-0000-4000-8000-000000000000',
        (req) => asOwner(req).query({ confirm: 'cascade' }),
        '404',
        'unknown project',
      );

      const removed = await probe(
        'delete',
        `/projects/${trashProjectId}`,
        (req) => asOwner(req).query({ confirm: 'cascade' }),
        '200',
      );
      expect(removed.body.message).toBe('Project deleted');
    });

    it('POST /projects/{projectId}/restore returns 201, 401, 403, 404 and 409', async () => {
      const restored = await probe(
        'post',
        `/projects/${trashProjectId}/restore`,
        (req) => asOwner(req),
        '201',
      );
      expect(restored.body.id).toBe(trashProjectId);

      await probe(
        'post',
        `/projects/${trashProjectId}/restore`,
        (req) => asOwner(req),
        '409',
        'not deleted',
      );
      await probe(
        'post',
        `/projects/${trashProjectId}/restore`,
        (req) => asOutsider(req),
        '403',
        'not a member',
      );
      await probe(
        'post',
        `/projects/${trashProjectId}/restore`,
        (req) => req,
        '401',
        'no token',
      );
      await probe(
        'post',
        '/projects/00000000-0000-4000-8000-000000000000/restore',
        (req) => asOwner(req),
        '404',
        'unknown project',
      );
    });
  });

  describe('time entries and estimation', () => {
    let entryId = '';
    let trashEntryId = '';
    let complexityId = '';

    it('POST /time-entries returns 400, 401, 403, 404, 409 and 201', async () => {
      await probe(
        'post',
        '/time-entries',
        (req) => req.send({ subtaskId: subtaskIdForTime }),
        '401',
        'no token',
      );
      await probe(
        'post',
        '/time-entries',
        (req) => asOutsider(req).send({ subtaskId: subtaskIdForTime }),
        '403',
        'not a member',
      );
      await probe(
        'post',
        '/time-entries',
        (req) =>
          asOwner(req).send({
            subtaskId: subtaskIdForTime,
            entryTime: 'not-a-date',
          }),
        '400',
        'malformed entry time',
      );
      await probe(
        'post',
        '/time-entries',
        (req) =>
          asOwner(req).send({
            subtaskId: '00000000-0000-4000-8000-000000000000',
            entryTime: '2026-01-01T09:00:00.000Z',
          }),
        '404',
        'unknown subtask',
      );
      await probe(
        'post',
        '/time-entries',
        (req) =>
          asOwner(req).send({
            subtaskId: subtaskIdForTime,
            entryTime: '2026-01-01T11:00:00.000Z',
            exitTime: '2026-01-01T10:00:00.000Z',
          }),
        '400',
        'exit before entry',
      );

      const logged = await probe(
        'post',
        '/time-entries',
        (req) =>
          asOwner(req).send({
            subtaskId: subtaskIdForTime,
            entryTime: '2026-01-01T09:00:00.000Z',
            exitTime: '2026-01-01T11:00:00.000Z',
          }),
        '201',
      );
      entryId = logged.body.id;

      const throwaway = await probe(
        'post',
        '/time-entries',
        (req) =>
          asOwner(req).send({
            subtaskId: subtaskIdForTime,
            entryTime: '2026-01-02T09:00:00.000Z',
            exitTime: '2026-01-02T10:00:00.000Z',
          }),
        '201',
        'to be trashed',
      );
      trashEntryId = throwaway.body.id;
    });

    it('GET /time-entries returns 200, 401 and 403', async () => {
      const listed = await probe(
        'get',
        '/time-entries',
        (req) => asOwner(req).query({ subtaskId: subtaskIdForTime }),
        '200',
      );
      expect(listed.body.items.length).toBe(2);

      await probe('get', '/time-entries', (req) => req, '401', 'no token');
      await probe(
        'get',
        '/time-entries',
        (req) => asOutsider(req),
        '403',
        'not a member',
      );
    });

    it('GET /time-entries/{timeEntryId} returns 200, 401, 403 and 404', async () => {
      const found = await probe(
        'get',
        `/time-entries/${entryId}`,
        (req) => asOwner(req),
        '200',
      );
      expect(found.body.id).toBe(entryId);

      await probe(
        'get',
        `/time-entries/${entryId}`,
        (req) => req,
        '401',
        'no token',
      );
      await probe(
        'get',
        `/time-entries/${entryId}`,
        (req) => asOutsider(req),
        '403',
        'not a member',
      );
      await probe(
        'get',
        '/time-entries/00000000-0000-4000-8000-000000000000',
        (req) => asOwner(req),
        '404',
        'unknown entry',
      );
    });

    it('PATCH /time-entries/{timeEntryId} returns 200, 400, 401, 403 and 404', async () => {
      const moved = await probe(
        'patch',
        `/time-entries/${entryId}`,
        (req) => asOwner(req).send({ entryTime: '2026-01-01T08:00:00.000Z' }),
        '200',
      );
      expect(moved.body.entryTime).toBe('2026-01-01T08:00:00.000Z');

      await probe(
        'patch',
        `/time-entries/${entryId}`,
        (req) => asOwner(req).send({ exitTime: '2026-01-01T07:00:00.000Z' }),
        '400',
        'exit before entry',
      );
      await probe(
        'patch',
        `/time-entries/${entryId}`,
        (req) =>
          asOutsider(req).send({
            entryTime: '2026-01-01T08:00:00.000Z',
          }),
        '403',
        'not a member',
      );
      await probe(
        'patch',
        `/time-entries/${entryId}`,
        (req) => req.send({ entryTime: '2026-01-01T08:00:00.000Z' }),
        '401',
        'no token',
      );
      await probe(
        'patch',
        '/time-entries/00000000-0000-4000-8000-000000000000',
        (req) => asOwner(req).send({ entryTime: '2026-01-01T08:00:00.000Z' }),
        '404',
        'unknown entry',
      );
    });

    it('DELETE /time-entries/{timeEntryId} returns 200, 401, 403 and 404', async () => {
      await probe(
        'delete',
        `/time-entries/${trashEntryId}`,
        (req) => asOwner(req),
        '200',
      );

      await probe(
        'delete',
        `/time-entries/${entryId}`,
        (req) => asOutsider(req),
        '403',
        'not a member',
      );
      await probe(
        'delete',
        `/time-entries/${entryId}`,
        (req) => req,
        '401',
        'no token',
      );
      await probe(
        'delete',
        '/time-entries/00000000-0000-4000-8000-000000000000',
        (req) => asOwner(req),
        '404',
        'unknown entry',
      );
    });

    it('GET /time-entries/trash returns 200, 401 and 403', async () => {
      const listed = await probe(
        'get',
        '/time-entries/trash',
        (req) => asOwner(req),
        '200',
      );
      expect(listed.body.map((entry: { id: string }) => entry.id)).toContain(
        trashEntryId,
      );

      await probe(
        'get',
        '/time-entries/trash',
        (req) => req,
        '401',
        'no token',
      );
      await probe(
        'get',
        '/time-entries/trash',
        (req) => asOutsider(req),
        '403',
        'not a member',
      );
    });

    it('POST /time-entries/{timeEntryId}/restore returns 201, 401, 403, 404 and 409', async () => {
      const restored = await probe(
        'post',
        `/time-entries/${trashEntryId}/restore`,
        (req) => asOwner(req),
        '201',
      );
      expect(restored.body.id).toBe(trashEntryId);

      await probe(
        'post',
        `/time-entries/${trashEntryId}/restore`,
        (req) => asOwner(req),
        '409',
        'not deleted',
      );
      await probe(
        'post',
        `/time-entries/${trashEntryId}/restore`,
        (req) => asOutsider(req),
        '403',
        'not a member',
      );
      await probe(
        'post',
        `/time-entries/${trashEntryId}/restore`,
        (req) => req,
        '401',
        'no token',
      );
      await probe(
        'post',
        '/time-entries/00000000-0000-4000-8000-000000000000/restore',
        (req) => asOwner(req),
        '404',
        'unknown entry',
      );

      await probe(
        'delete',
        `/time-entries/${trashEntryId}`,
        (req) => asOwner(req),
        '200',
        'trash again',
      );
    });

    it('POST /time-entries/timer/start and /timer/stop return 400, 401, 403, 404, 409 and 200/201', async () => {
      await probe(
        'post',
        '/time-entries/timer/start',
        (req) => req.send({ subtaskId: subtaskIdForTime }),
        '401',
        'no token',
      );
      await probe(
        'post',
        '/time-entries/timer/start',
        (req) => asOutsider(req).send({ subtaskId: subtaskIdForTime }),
        '403',
        'not a member',
      );
      await probe(
        'post',
        '/time-entries/timer/start',
        (req) =>
          asOwner(req).send({
            subtaskId: subtaskIdForTime,
            entryTime: 'not-a-date',
          }),
        '400',
        'malformed start',
      );
      await probe(
        'post',
        '/time-entries/timer/start',
        (req) =>
          asOwner(req).send({
            subtaskId: '00000000-0000-4000-8000-000000000000',
          }),
        '404',
        'unknown subtask',
      );

      const started = await probe(
        'post',
        '/time-entries/timer/start',
        (req) => asOwner(req).send({ subtaskId: subtaskIdForTime }),
        '201',
      );
      // `timer/start` answers an envelope: the message and the saved entry.
      expect(started.body.entry).toMatchObject({
        isRunning: true,
        exitTime: null,
      });

      await probe(
        'post',
        '/time-entries/timer/start',
        (req) => asOwner(req).send({ subtaskId: subtaskIdForTime }),
        '409',
        'a timer is already running',
      );
      await probe(
        'post',
        '/time-entries',
        (req) =>
          asOwner(req).send({
            subtaskId: subtaskIdForTime,
            entryTime: '2026-01-03T09:00:00.000Z',
          }),
        '409',
        'manual entry while the timer runs',
      );

      await probe(
        'post',
        '/time-entries/timer/stop',
        (req) => asOwner(req).send({ exitTime: 'not-a-date' }),
        '400',
        'malformed stop',
      );
      await probe(
        'post',
        '/time-entries/timer/stop',
        (req) => asOutsider(req),
        '403',
        'not a member',
      );
      await probe(
        'post',
        '/time-entries/timer/stop',
        (req) => req,
        '401',
        'no token',
      );
      await probe(
        'post',
        '/time-entries/timer/stop',
        (req) =>
          asOwner(req).send({
            timeEntryId: '00000000-0000-4000-8000-000000000000',
          }),
        '404',
        'unknown timer',
      );

      const stopped = await probe(
        'post',
        '/time-entries/timer/stop',
        (req) => asOwner(req).send({ timeEntryId: started.body.entry.id }),
        '200',
      );
      expect(stopped.body.entry.exitTime).not.toBeNull();

      await probe(
        'post',
        '/time-entries/timer/stop',
        (req) => asOwner(req).send({ timeEntryId: started.body.entry.id }),
        '409',
        'the timer is already stopped',
      );
    });

    it('GET /time-entries/timer/active returns 200, 401 and 403', async () => {
      const running = await probe(
        'get',
        '/time-entries/timer/active',
        (req) => asOwner(req),
        '200',
        'nothing running after the stop',
      );
      expect(running.body).toEqual({ entry: null });

      const started = await probe(
        'post',
        '/time-entries/timer/start',
        (req) => asOwner(req).send({ subtaskId: subtaskIdForTime }),
        '201',
        'so the read has something to find',
      );

      const active = await probe(
        'get',
        '/time-entries/timer/active',
        (req) => asOwner(req),
        '200',
        'running',
      );
      expect(active.body.entry.id).toBe(started.body.entry.id);

      await probe(
        'get',
        '/time-entries/timer/active',
        (req) => req,
        '401',
        'no token',
      );
      await probe(
        'get',
        '/time-entries/timer/active',
        (req) => asOutsider(req),
        '403',
        'not a member',
      );

      await probe(
        'post',
        '/time-entries/timer/stop',
        (req) => asOwner(req).send({ timeEntryId: started.body.entry.id }),
        '200',
        'stop it again',
      );
    });

    it('POST /time-complexity returns 400, 401, 403, 404, 409 and 201', async () => {
      await probe(
        'post',
        '/time-complexity',
        (req) => req.send({}),
        '401',
        'no token',
      );
      await probe(
        'post',
        '/time-complexity',
        (req) => asOutsider(req).send({}),
        '403',
        'not a member',
      );
      await probe(
        'post',
        '/time-complexity',
        (req) =>
          asOwner(req).send({
            taskId: taskIdForEstimate,
            name: 'medium',
            minDuration: 7200,
            maxDuration: 3600,
          }),
        '400',
        'min above max',
      );
      await probe(
        'post',
        '/time-complexity',
        (req) =>
          asOwner(req).send({
            taskId: '00000000-0000-4000-8000-000000000000',
            name: 'medium',
            minDuration: 3600,
            maxDuration: 7200,
          }),
        '404',
        'unknown task',
      );

      const created = await probe(
        'post',
        '/time-complexity',
        (req) =>
          asOwner(req).send({
            taskId: taskIdForEstimate,
            name: 'medium',
            minDuration: 3600,
            maxDuration: 7200,
          }),
        '201',
      );
      complexityId = created.body.id;

      await probe(
        'post',
        '/time-complexity',
        (req) =>
          asOwner(req).send({
            taskId: taskIdForEstimate,
            name: 'high',
            minDuration: 3600,
            maxDuration: 7200,
          }),
        '409',
        'an active estimate already exists',
      );
      await probe(
        'post',
        '/time-complexity',
        (req) =>
          asOwner(req).send({
            taskId: taskIdForEstimate,
            subtaskId: '00000000-0000-4000-8000-000000000000',
            name: 'medium',
            minDuration: 3600,
            maxDuration: 7200,
          }),
        '400',
        'subtask under another task',
      );
    });

    it('GET /time-complexity returns 200, 401 and 403', async () => {
      const listed = await probe(
        'get',
        '/time-complexity',
        (req) => asOwner(req).query({ taskId: taskIdForEstimate }),
        '200',
      );
      expect(listed.body.items.length).toBe(1);

      await probe('get', '/time-complexity', (req) => req, '401', 'no token');
      await probe(
        'get',
        '/time-complexity',
        (req) => asOutsider(req),
        '403',
        'not a member',
      );
    });

    it('GET /time-complexity/{complexityId} returns 200, 401, 403 and 404', async () => {
      const found = await probe(
        'get',
        `/time-complexity/${complexityId}`,
        (req) => asOwner(req),
        '200',
      );
      expect(found.body.id).toBe(complexityId);

      await probe(
        'get',
        `/time-complexity/${complexityId}`,
        (req) => req,
        '401',
        'no token',
      );
      await probe(
        'get',
        `/time-complexity/${complexityId}`,
        (req) => asOutsider(req),
        '403',
        'not a member',
      );
      await probe(
        'get',
        '/time-complexity/00000000-0000-4000-8000-000000000000',
        (req) => asOwner(req),
        '404',
        'unknown estimate',
      );
    });

    it('PATCH /time-complexity/{complexityId} returns 200, 400, 401, 403, 404 and 409', async () => {
      const renamed = await probe(
        'patch',
        `/time-complexity/${complexityId}`,
        (req) => asOwner(req).send({ name: 'high' }),
        '200',
      );
      expect(renamed.body.name).toBe('high');

      await probe(
        'patch',
        `/time-complexity/${complexityId}`,
        (req) => asOwner(req).send({ minDuration: 7200, maxDuration: 3600 }),
        '400',
        'min above max',
      );
      await probe(
        'patch',
        `/time-complexity/${complexityId}`,
        (req) => asOwner(req).send({ status: 'archived' }),
        '200',
        'archived clears the active slot',
      );

      await probe(
        'post',
        '/time-complexity',
        (req) =>
          asOwner(req).send({
            taskId: taskIdForEstimate,
            name: 'medium',
            minDuration: 3600,
            maxDuration: 7200,
          }),
        '201',
        'the archived one no longer blocks it',
      );

      await probe(
        'patch',
        `/time-complexity/${complexityId}`,
        (req) => asOwner(req).send({ status: 'active' }),
        '409',
        'the replacement already holds the active slot',
      );
      await probe(
        'patch',
        `/time-complexity/${complexityId}`,
        (req) => asOutsider(req).send({ name: 'low' }),
        '403',
        'not a member',
      );
      await probe(
        'patch',
        `/time-complexity/${complexityId}`,
        (req) => req.send({ name: 'low' }),
        '401',
        'no token',
      );
      await probe(
        'patch',
        '/time-complexity/00000000-0000-4000-8000-000000000000',
        (req) => asOwner(req).send({ name: 'low' }),
        '404',
        'unknown estimate',
      );
    });

    it('DELETE /time-complexity/{complexityId} returns 200, 401, 403 and 404', async () => {
      await probe(
        'delete',
        `/time-complexity/${complexityId}`,
        (req) => asOwner(req),
        '200',
      );

      await probe(
        'delete',
        `/time-complexity/${complexityId}`,
        (req) => asOutsider(req),
        '403',
        'not a member',
      );
      await probe(
        'delete',
        `/time-complexity/${complexityId}`,
        (req) => req,
        '401',
        'no token',
      );
      await probe(
        'delete',
        '/time-complexity/00000000-0000-4000-8000-000000000000',
        (req) => asOwner(req),
        '404',
        'unknown estimate',
      );
    });

    it('GET /time-complexity/variance/{taskId} returns 200, 401, 403 and 404', async () => {
      const variance = await probe(
        'get',
        `/time-complexity/variance/${taskIdForEstimate}`,
        (req) => asOwner(req),
        '200',
      );
      // The route answers one row per subtask, each with a `variance` verdict rather
      // than a single aggregate number.
      expect(
        variance.body.map((row: { subtaskId: string }) => row.subtaskId),
      ).toContain(subtaskIdForTime);
      for (const row of variance.body as { variance: string | null }[]) {
        expect(['under', 'within', 'over', null]).toContain(row.variance);
      }

      await probe(
        'get',
        `/time-complexity/variance/${taskIdForEstimate}`,
        (req) => req,
        '401',
        'no token',
      );
      await probe(
        'get',
        `/time-complexity/variance/${taskIdForEstimate}`,
        (req) => asOutsider(req),
        '403',
        'not a member',
      );
      await probe(
        'get',
        '/time-complexity/variance/00000000-0000-4000-8000-000000000000',
        (req) => asOwner(req),
        '404',
        'unknown task',
      );
    });
  });

  describe('dashboard', () => {
    const readOnly = [
      ['get', '/dashboard/overview'],
      ['get', '/dashboard/projects'],
      ['get', '/dashboard/clients'],
      ['get', '/dashboard/overdue'],
    ] as ['get', string][];

    it.each(readOnly)(
      '%s returns 400, 401, 403 and 200',
      async (method, path) => {
        const overview = await probe(
          method,
          path,
          (req) => asOwner(req),
          '200',
        );
        expect(overview.body).toBeTruthy();

        await probe(method, path, (req) => req, '401', 'no token');
        await probe(
          method,
          path,
          (req) => asOutsider(req),
          '403',
          'not a member',
        );
        await probe(
          method,
          path,
          (req) => asOwner(req).query({ from: 'not-a-date' }),
          '400',
          'malformed range',
        );
      },
    );
  });

  describe('settings', () => {
    /**
     * The two settings routes are proved apart because they are authenticated
     * differently, and the difference is the point of splitting them.
     *
     * `/settings/me` runs the JWT guard without the organization context or the
     * permission check: personal preferences belong to the user, so a member who
     * has lost every role can still choose their own date format, and a user
     * with no organization at all can still reach theirs. It therefore has no 403
     * to prove and documents none.
     *
     * `/settings/organization` is organization-scoped, so it has all three: 401
     * with no token, 404 with no organization context (the guard treats a missing
     * header as a route that does not exist for the request), and 403 for a
     * caller who is not a member.
     */
    it('GET /settings/me returns 200 for the token owner and 401 without a token', async () => {
      const mine = await probe('get', '/settings/me', (req) =>
        auth(ownerToken, req),
      '200');
      expect(mine.body.userId).toEqual(expect.any(String));
      // Created on first read, so the response is complete rather than sparse.
      expect(mine.body.theme).toEqual(expect.any(String));
      expect(mine.body.locale).toEqual(expect.any(String));

      await probe('get', '/settings/me', (req) => req, '401', 'no token');
    });

    it('GET /settings/me needs no organization context', async () => {
      // No `x-organization-id` header at all, which an organization-scoped route
      // would answer 404 to.
      const response = await request(server)
        .get(api('/settings/me'))
        .set('Authorization', `Bearer ${outsiderToken}`);
      expect(response.status).toBe(200);
    });

    it('PATCH /settings/me returns 200, 400 for a bad value and 401 without a token', async () => {
      const updated = await probe('patch', '/settings/me', (req) =>
        auth(ownerToken, req).send({ theme: 'dark', digestFrequency: 'off' }),
      '200');
      expect(updated.body.theme).toBe('dark');
      expect(updated.body.digestFrequency).toBe('off');

      await probe(
        'patch',
        '/settings/me',
        (req) => auth(ownerToken, req).send({ theme: 'neon' }),
        '400',
        'undocumented value',
      );

      await probe(
        'patch',
        '/settings/me',
        (req) => req.send({ theme: 'dark' }),
        '401',
        'no token',
      );
    });

    it('GET /settings/organization returns 200, 401, 403 and 404', async () => {
      const settings = await probe(
        'get',
        '/settings/organization',
        (req) => asOwner(req),
        '200',
      );
      expect(settings.body.organizationId).toBe(organizationId);
      expect(settings.body.workingDayStartMinutes).toEqual(
        expect.any(Number),
      );

      await probe(
        'get',
        '/settings/organization',
        (req) => req,
        '401',
        'no token',
      );

      await probe(
        'get',
        '/settings/organization',
        (req) => asOutsider(req),
        '403',
        'not a member',
      );

      // Membership is resolved before the lookup, so the header has to travel.
      await probe(
        'get',
        '/settings/organization',
        (req) => auth(ownerToken, req),
        '404',
        'no organization context',
      );
    });

    it('PATCH /settings/organization returns 200, 400, 401, 403 and 404', async () => {
      const updated = await probe(
        'patch',
        '/settings/organization',
        (req) =>
          asOwner(req).send({
            timezone: 'Europe/Paris',
            weekStart: 'sunday',
            workingDayStartMinutes: 480,
            workingDayEndMinutes: 1020,
          }),
        '200',
      );
      expect(updated.body.timezone).toBe('Europe/Paris');
      expect(updated.body.weekStart).toBe('sunday');

      // The working window is a rule about the pair, not either bound, so this
      // is a 400 the field validation alone could not have produced.
      await probe(
        'patch',
        '/settings/organization',
        (req) =>
          asOwner(req).send({
            workingDayStartMinutes: 18 * 60,
            workingDayEndMinutes: 9 * 60,
          }),
        '400',
        'window ends before it starts',
      );

      await probe(
        'patch',
        '/settings/organization',
        (req) => req.send({ weekStart: 'monday' }),
        '401',
        'no token',
      );

      await probe(
        'patch',
        '/settings/organization',
        (req) => asOutsider(req).send({ weekStart: 'monday' }),
        '403',
        'not a member',
      );

      await probe(
        'patch',
        '/settings/organization',
        (req) => auth(ownerToken, req).send({ weekStart: 'monday' }),
        '404',
        'no organization context',
      );
    });
  });

  describe('organization teardown', () => {
    it('DELETE /organizations/{organizationId} returns 200 for a confirmed owner', async () => {
      // The only operation that tears the tenant down, so it runs after every
      // module suite: each of them needs a live organization to probe against.
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

    /**
     * The sweep is derived from the document rather than listed by hand: a
     * route added without a `429` probe would fail the two contract assertions
     * below instead of quietly going untested. Every parameter becomes a
     * well-formed UUID, because a malformed one is answered by the pipe with a
     * 400 and would never reach the throttle.
     *
     * One `it` rather than `it.each`: the operation table is only filled in once
     * `beforeAll` has served the document, and `it.each` reads it at collection
     * time, before any hook has run.
     */
    it('every published operation answers 429 once its bucket is exhausted', async () => {
      const neverLimited: string[] = [];

      for (const [method, template] of publishedOperations) {
        const path = template.replace(
          /\{[^}]+\}/g,
          '00000000-0000-4000-8000-000000000000',
        );

        // The bucket is keyed per handler, so each operation has to be exhausted
        // on its own. `THROTTLE_LIMIT` is 2 here, so the third call is limited.
        let limited: request.Response | null = null;

        for (let attempt = 0; attempt < 6; attempt++) {
          const response = await request(server)
            [method](api(path))
            .set('Authorization', `Bearer ${ownerToken}`)
            .set('x-organization-id', organizationId)
            .send({});

          if (response.status === 429) {
            limited = response;
            break;
          }
        }

        if (
          limited?.body?.message !== 'ThrottlerException: Too Many Requests'
        ) {
          neverLimited.push(
            `${method.toUpperCase()} ${template} answered ${
              limited
                ? `${limited.status} ${JSON.stringify(limited.body)}`
                : 'never'
            } instead of 429`,
          );
        }

        expect(documented(method, template)).toContain('429');
        observed.add(`${key(method, template)}:429`);
        reached.get(key(method, template))!.add('429');
        probed.add(key(method, template));

        clearThrottle();
      }

      expect(neverLimited).toEqual([]);
    });
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
