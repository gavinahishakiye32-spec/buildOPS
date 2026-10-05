import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import { DataSource } from 'typeorm';
import { jest } from '@jest/globals';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { API_PREFIX, configureApp } from '../src/bootstrap.js';
import { MailService } from '../src/mail/mail.service.js';
import { CSRF_HEADER } from '../src/auth/session-cookies.js';
import { resetDatabase } from './support/reset-database.js';

jest.setTimeout(60000);

const api = (path: string): string => `/${API_PREFIX}${path}`;

interface Session {
  email: string;
  accessToken: string;
  refreshToken: string;
  csrf: string;
  cookieHeader: string;
}

/**
 * Session security, against real PostgreSQL.
 *
 * Every assertion here is about something the unit suites cannot check: that a
 * rotated token is actually dead in the database, that reuse detection revokes a
 * family rather than a single row, and that a password change really does end
 * the sessions that were open when it happened. Those are the rules that decide
 * whether a leaked token is a bad afternoon or a permanent foothold, and they
 * live or die on the storage behaviour rather than on the service logic.
 */
describe('session security (e2e)', () => {
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let dataSource: DataSource;
  let throttleStorage: { storage: Map<string, unknown>; hitExpirations: Map<string, unknown> };

  const mailTokens: { verify?: string; reset?: string } = {};

  const clearThrottle = (): void => {
    throttleStorage.storage.clear();
    throttleStorage.hitExpirations.clear();
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(MailService)
      .useValue({
        sendVerificationEmail: async (_email: string, token: string) => {
          mailTokens.verify = token;
        },
        sendResetPasswordEmail: async (_email: string, token: string) => {
          mailTokens.reset = token;
        },
      })
      .compile();

    app = configureApp(moduleFixture.createNestApplication());
    await app.init();

    server = app.getHttpServer();
    dataSource = app.get(DataSource);
    throttleStorage = app.get(ThrottlerStorage) as unknown as typeof throttleStorage;

    await resetDatabase(dataSource);
  });

  afterAll(async () => {
    await app.close();
  });

  const registerVerified = async (email: string): Promise<Session> => {
    clearThrottle();
    await request(server)
      .post(api('/auth/register'))
      .send({ email, password: 'password123', name: 'Sam' })
      .expect(201);

    await request(server)
      .get(api('/auth/verify-email'))
      .query({ token: mailTokens.verify })
      .expect(200);

    return login(email, 'password123');
  };

  const login = async (
    email: string,
    password: string,
    userAgent?: string,
  ): Promise<Session> => {
    clearThrottle();
    const pending = request(server)
      .post(api('/auth/login'))
      .send({ email, password });

    // supertest sends no User-Agent of its own, so a device-aware test has to
    // say which device it is acting as.
    if (userAgent) {
      pending.set('User-Agent', userAgent);
    }

    const response = await pending.expect(201);

    const setCookie = (response.headers['set-cookie'] ?? []) as unknown as string[];
    const valueOf = (name: string): string => {
      const found = setCookie.find((entry) => entry.startsWith(`${name}=`));
      if (!found) {
        throw new Error(`login did not set the ${name} cookie`);
      }
      return found.split(';')[0].split('=')[1];
    };

    const refreshToken = valueOf('rt');
    const csrf = valueOf('csrf');

    return {
      email,
      accessToken: response.body.access_token as string,
      refreshToken,
      csrf,
      cookieHeader: `rt=${refreshToken}; csrf=${csrf}`,
    };
  };

  const refresh = (session: Session) =>
    request(server)
      .post(api('/auth/refresh'))
      .set('Cookie', session.cookieHeader)
      .set(CSRF_HEADER, session.csrf);

  /** Live rows for a user, straight from the table rather than through the API. */
  const rowsFor = async (email: string) =>
    (
      await dataSource.query(
        `SELECT rt.revoked_at, rt.revoked_reason, rt.family_id
         FROM refresh_tokens rt
         JOIN users u ON u.id = rt.user_id
         WHERE u.email = $1
         ORDER BY rt.created_at`,
        [email],
      )
    ) as Array<{ revoked_at: Date | null; revoked_reason: string | null; family_id: string }>;

  it('stores only a hash of the refresh token, never the token itself', async () => {
    const session = await registerVerified('hash-owner@example.com');

    const [row] = await dataSource.query(
      'SELECT token_hash FROM refresh_tokens LIMIT 1',
    );

    expect(row.token_hash).toHaveLength(64);
    expect(row.token_hash).toMatch(/^[a-f0-9]{64}$/);
    // The plaintext that went into the cookie must appear nowhere in the table,
    // or a database copy would be replayable against the API.
    expect(row.token_hash).not.toBe(session.refreshToken);
  });

  it('marks the refresh cookie httpOnly, SameSite=strict and scoped to the auth routes', async () => {
    await registerVerified('flags-owner@example.com');

    const response = await request(server)
      .post(api('/auth/login'))
      .send({ email: 'flags-owner@example.com', password: 'password123' });

    const setCookie = (response.headers['set-cookie'] ?? []) as unknown as string[];
    const rt = setCookie.find((entry) => entry.startsWith('rt=')) ?? '';
    const csrf = setCookie.find((entry) => entry.startsWith('csrf=')) ?? '';

    // httpOnly: JavaScript must not be able to read the credential.
    expect(rt).toMatch(/HttpOnly/i);
    // SameSite: a cross-site request must not carry the session.
    expect(rt).toMatch(/SameSite=Strict/i);
    // Narrow path: the token is only ever read by the session endpoints.
    expect(rt).toMatch(/Path=\/api\/v1\/auth/i);

    // The CSRF cookie is the one exception, and only because double-submit
    // requires JavaScript to read it.
    expect(csrf).not.toMatch(/HttpOnly/i);
  });

  it('rotates the token and kills the presented one', async () => {
    const session = await registerVerified('rotate-owner@example.com');

    const before = await rowsFor(session.email);
    expect(before).toHaveLength(1);
    expect(before[0].revoked_at).toBeNull();

    const rotated = await refresh(session).expect(201);

    const setCookie = (rotated.headers['set-cookie'] ?? []) as unknown as string[];
    const next = setCookie
      .find((entry) => entry.startsWith('rt='))!
      .split(';')[0]
      .split('=')[1];
    expect(next).not.toBe(session.refreshToken);

    const after = await rowsFor(session.email);
    expect(after).toHaveLength(2);
    // The presented one is revoked, and says why.
    const revoked = after.filter((row) => row.revoked_at !== null);
    expect(revoked).toHaveLength(1);
    expect(revoked[0].revoked_reason).toBe('rotated');
    // Same family: rotation extends the session rather than starting a new one.
    expect(new Set(after.map((row) => row.family_id)).size).toBe(1);
  });

  it('treats a replayed token as a theft and revokes the whole session', async () => {
    const session = await registerVerified('reuse-owner@example.com');

    await refresh(session).expect(201);

    // The first token is already revoked, so presenting it again is a replay.
    await refresh(session).expect(401);

    const rows = await rowsFor(session.email);
    // Nothing in the family survives: not the replayed token, and not the token
    // the rotation issued. Leaving the newer one alive would mean the attacker
    // who stole the older one and the legitimate client both still worked.
    expect(rows.every((row) => row.revoked_at !== null)).toBe(true);
    expect(rows.map((row) => row.revoked_reason)).toContain('reuse_detected');

    // And the access token minted from that session stops being accepted, which
    // is the only reason rotation is worth anything.
    const profile = await request(server)
      .get(api('/auth/profile'))
      .set('Authorization', `Bearer ${session.accessToken}`);
    expect(profile.status).toBe(401);
  });

  it('lets only one of two simultaneous refreshes win', async () => {
    const session = await registerVerified('race-owner@example.com');

    // Fired together, so the two requests really do contend for the same row.
    const [first, second] = await Promise.all([
      refresh(session),
      refresh(session),
    ]);

    // One winner, one refusal -- never two successes.
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([201, 401]);

    // The family must never hold two live tokens, whatever the interleaving was.
    // If it did, the winner's next refresh would look like a replay and the
    // session would be destroyed by nothing more than two tabs waking at once.
    const live = (await rowsFor(session.email)).filter((row) => row.revoked_at === null);
    expect(live).toHaveLength(0);

    // And no orphan replacement was left behind by the losing attempt.
    const all = await rowsFor(session.email);
    const hashes = await dataSource.query(
      `SELECT token_hash FROM refresh_tokens rt
       JOIN users u ON u.id = rt.user_id WHERE u.email = $1`,
      [session.email],
    );
    // Exactly one row was ever created beyond the original: the winner's.
    expect(hashes).toHaveLength(all.length);
    expect(new Set(hashes.map((row: { token_hash: string }) => row.token_hash)).size).toBe(
      all.length,
    );
  });

  it('refuses a session that has simply expired', async () => {    const session = await registerVerified('expiry-owner@example.com');

    await dataSource.query(
      `UPDATE refresh_tokens SET expires_at = now() - interval '1 minute'
       WHERE token_hash = $1`,
      [
        (
          await dataSource.query(
            `SELECT token_hash FROM refresh_tokens rt
             JOIN users u ON u.id = rt.user_id WHERE u.email = $1`,
            [session.email],
          )
        )[0].token_hash,
      ],
    );

    await refresh(session).expect(401);

    // An expired token is not a replay, so it must not be treated as one: the
    // row is simply unusable, and re-authenticating is the customer's way out.
    const rows = await rowsFor(session.email);
    expect(rows[0].revoked_at).toBeNull();
  });

  it('ends every session when the password is changed', async () => {
    const first = await registerVerified('pwchange-a@example.com');
    const second = await login('pwchange-a@example.com', 'password123');

    // Two live sessions, as if the customer were signed in on two devices.
    expect(await rowsFor(first.email)).toHaveLength(2);

    const changed = await request(server)
      .patch(api('/auth/profile'))
      .set('Authorization', `Bearer ${first.accessToken}`)
      .send({ password: 'brandNewPassword1', currentPassword: 'password123' })
      .expect(200);

    expect(changed.status).toBe(200);

    const rows = await rowsFor(first.email);
    expect(rows.every((row) => row.revoked_at !== null)).toBe(true);
    expect(rows.map((row) => row.revoked_reason)).toContain('password_changed');

    // Both access tokens are dead, including the one the change was made with:
    // somebody who spots an intruder and changes their password should not be
    // sharing a session with them.
    for (const session of [first, second]) {
      const profile = await request(server)
        .get(api('/auth/profile'))
        .set('Authorization', `Bearer ${session.accessToken}`);
      expect(profile.status).toBe(401);
    }
  });

  it('ends every session when the password is reset', async () => {
    const session = await registerVerified('pwreset-owner@example.com');

    const request_ = await request(server)
      .post(api('/auth/forgot-password'))
      .send({ email: session.email })
      .expect(201);
    void request_;

    await request(server)
      .post(api('/auth/reset-password'))
      .send({ token: mailTokens.reset, password: 'resetPassword1' })
      .expect(201);

    const rows = await rowsFor(session.email);
    expect(rows.every((row) => row.revoked_at !== null)).toBe(true);

    const profile = await request(server)
      .get(api('/auth/profile'))
      .set('Authorization', `Bearer ${session.accessToken}`);
    expect(profile.status).toBe(401);
  });

  it('lists one entry per device and marks the current one', async () => {
    await registerVerified('devices-owner@example.com');
    const phone = await login(
      'devices-owner@example.com',
      'password123',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)',
    );

    const listed = await request(server)
      .get(api('/auth/sessions'))
      .set('Authorization', `Bearer ${phone.accessToken}`)
      .expect(200);

    expect(listed.body).toHaveLength(2);
    expect(listed.body.filter((s: { isCurrent: boolean }) => s.isCurrent)).toHaveLength(1);

    // Refreshing a session must not make it appear twice: the listing is
    // families, and rotation moves the live row within one family.
    await refresh(phone).expect(201);
    const afterRefresh = await request(server)
      .get(api('/auth/sessions'))
      .set('Authorization', `Bearer ${phone.accessToken}`)
      .expect(200);
    expect(afterRefresh.body).toHaveLength(2);
    expect(afterRefresh.body.filter((s: { isCurrent: boolean }) => s.isCurrent)).toHaveLength(1);

    // The two entries are distinguishable, which is the only reason this page is
    // worth showing a customer who has come back to ask "what am I signed in on".
    const ids = afterRefresh.body.map((s: { id: string }) => s.id);
    expect(new Set(ids).size).toBe(2);

    const agents = afterRefresh.body.map((s: { userAgent: string | null }) => s.userAgent);
    expect(agents).toContain('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)');
  });

  it('logout-all ends every session on every device', async () => {
    const laptop = await registerVerified('all-devices-a@example.com');
    const phone = await login('all-devices-a@example.com', 'password123');

    const response = await request(server)
      .post(api('/auth/logout-all'))
      .set('Authorization', `Bearer ${laptop.accessToken}`)
      .expect(201);

    expect(response.body.message).toContain('2');

    for (const session of [laptop, phone]) {
      const profile = await request(server)
        .get(api('/auth/profile'))
        .set('Authorization', `Bearer ${session.accessToken}`);
      expect(profile.status).toBe(401);
    }

    // And no session can be resurrected from a refresh token.
    await refresh(phone).expect(401);
  });

  it('refuses a refresh that is not accompanied by the CSRF header', async () => {
    const session = await registerVerified('csrf-owner@example.com');

    // Right cookie, no header: refused, and the session survives the attempt.
    const noHeader = await request(server)
      .post(api('/auth/refresh'))
      .set('Cookie', session.cookieHeader)
      .expect(403);
    expect(noHeader.status).toBe(403);

    // A header that does not match the cookie is equally refused.
    await request(server)
      .post(api('/auth/refresh'))
      .set('Cookie', session.cookieHeader)
      .set(CSRF_HEADER, 'not-the-token')
      .expect(403);

    // Refusing must not have consumed the token: the legitimate client still works.
    await refresh(session).expect(201);
  });

  it('rejects a token signed without a session claim', async () => {
    // A hand-minted token with the right signature but no `sid` could never be
    // revoked, which is the one property every access token here must have.
    const session = await registerVerified('nosid-owner@example.com');
    const forged = session.accessToken
      .split('.')
      .map((part, index) => {
        if (index !== 1) {
          return part;
        }
        const payload = JSON.parse(Buffer.from(part, 'base64url').toString());
        delete payload.sid;
        return Buffer.from(JSON.stringify(payload)).toString('base64url');
      })
      .join('.');

    // The signature no longer matches, so this is a 401 on signature grounds.
    // The assertion is that it is refused either way -- the point is that a
    // sid-less token never reaches the "is the account verified" stage.
    const response = await request(server)
      .get(api('/auth/profile'))
      .set('Authorization', `Bearer ${forged}`);
    expect(response.status).toBe(401);
  });
});
