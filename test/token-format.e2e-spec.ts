import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import { JwtService } from '@nestjs/jwt';
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

/** What a JWT looks like on the wire: three base64url segments, no padding. */
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** What the old opaque tokens looked like. Nothing may still be minted like this. */
const OPAQUE_64_HEX = /^[a-f0-9]{64}$/;

interface Captured {
  verify?: string;
  reset?: string;
  invitation?: string;
}

/**
 * Every credential the API transmits, decoded as the client sees it.
 *
 * The other suites prove the *flows* work -- that a token issued here is
 * accepted there. This one proves the *format*: that all four non-access
 * tokens are signed JWTs carrying the `purpose` claim that separates them,
 * that nothing opaque is still being issued, and that a JWT signed for one
 * purpose or with the wrong secret is refused rather than merely unlooked-up.
 */
describe('token format (e2e)', () => {
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let dataSource: DataSource;
  let jwt: JwtService;
  let throttleStorage: {
    storage: Map<string, unknown>;
    hitExpirations: Map<string, unknown>;
  };

  const mail: Captured = {};

  let accessToken: string;
  let refreshToken: string;
  let csrf: string;
  let organizationId: string;
  let userEmail: string;

  const clearThrottle = (): void => {
    throttleStorage.storage.clear();
    throttleStorage.hitExpirations.clear();
  };

  const decode = (token: string): Record<string, unknown> =>
    jwt.verify(token) as Record<string, unknown>;

  const cookieValue = (setCookie: unknown, name: string): string => {
    const entries = (setCookie ?? []) as unknown as string[];
    const found = entries.find((entry) => entry.startsWith(`${name}=`));
    if (!found) {
      throw new Error(`response did not set the ${name} cookie`);
    }
    return found.split(';')[0].slice(name.length + 1);
  };

  const column = async (
    sql: string,
    params: unknown[],
  ): Promise<string | null> => {
    const rows = (await dataSource.query(sql, params)) as Array<
      Record<string, string | null>
    >;
    return rows[0] ? Object.values(rows[0])[0] : null;
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
        sendInvitationEmail: async (_email: string, token: string) => {
          mail.invitation = token;
        },
      })
      .compile();

    app = configureApp(moduleFixture.createNestApplication());
    await app.init();

    server = app.getHttpServer();
    dataSource = app.get(DataSource);
    jwt = app.get(JwtService, { strict: false });
    throttleStorage = app.get(
      ThrottlerStorage,
    ) as unknown as typeof throttleStorage;

    await resetDatabase(dataSource);

    // --- register, verify, log in -----------------------------------------
    userEmail = `tokens-${Date.now()}@example.com`;

    const registered = await request(server)
      .post(api('/auth/register'))
      .send({ email: userEmail, password: 'password123', name: 'Token' })
      .expect(201);

    expect(registered.body.verificationToken).toEqual(expect.any(String));

    await request(server)
      .get(api('/auth/verify-email'))
      .query({ token: mail.verify })
      .expect(200);

    clearThrottle();
    const login = await request(server)
      .post(api('/auth/login'))
      .send({ email: userEmail, password: 'password123' })
      .expect(201);

    accessToken = login.body.access_token as string;
    refreshToken = cookieValue(login.headers['set-cookie'], 'rt');
    csrf = cookieValue(login.headers['set-cookie'], 'csrf');

    // --- a workspace to invite into ---------------------------------------
    const plans = await request(server).get(api('/plans')).expect(200);
    const starter = plans.body.find(
      (plan: { name: string }) => plan.name === 'Starter',
    );

    await request(server)
      .post(api('/subscription'))
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ planId: starter.id })
      .expect(200);

    const organization = await request(server)
      .post(api('/organizations'))
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ name: 'Token Workspace' })
      .expect(201);

    organizationId = organization.body.id as string;

    await request(server)
      .post(api(`/organizations/${organizationId}/invitations`))
      .set('Authorization', `Bearer ${accessToken}`)
      .set('x-organization-id', organizationId)
      .send({ email: `invitee-${Date.now()}@example.com` })
      .expect(201);

    // --- a reset link, for the reset token --------------------------------
    clearThrottle();
    await request(server)
      .post(api('/auth/forgot-password'))
      .send({ email: userEmail })
      .expect(201);
  });

  afterAll(async () => {
    await app.close();
  });

  it('issues an access token as a session-bound JWT with no purpose claim', () => {
    expect(accessToken).toMatch(JWT_SHAPE);

    const payload = decode(accessToken);
    expect(payload.sub).toEqual(expect.any(String));
    expect(payload.sid).toEqual(expect.any(String));
    expect(payload.purpose).toBeUndefined();
  });

  it('issues the refresh cookie as a purpose-bound JWT in the same session', () => {
    expect(refreshToken).toMatch(JWT_SHAPE);
    expect(refreshToken).not.toMatch(OPAQUE_64_HEX);

    const payload = decode(refreshToken);
    expect(payload.purpose).toBe('refresh');
    expect(payload.sub).toBe(decode(accessToken).sub);
    // Same family as the access token, so revoking one retires the other.
    expect(payload.sid).toBe(decode(accessToken).sid);
    expect(payload.jti).toEqual(expect.any(String));
  });

  it('issues the email verification token as a purpose-bound JWT', () => {
    expect(mail.verify).toMatch(JWT_SHAPE);
    expect(mail.verify).not.toMatch(OPAQUE_64_HEX);

    const payload = decode(mail.verify!);
    expect(payload.purpose).toBe('email_verification');
    expect(payload.sub).toEqual(expect.any(String));
    expect(payload.jti).toEqual(expect.any(String));
  });

  it('issues the password reset token as a purpose-bound JWT', () => {
    expect(mail.reset).toMatch(JWT_SHAPE);
    expect(mail.reset).not.toMatch(OPAQUE_64_HEX);

    const payload = decode(mail.reset!);
    expect(payload.purpose).toBe('password_reset');
    expect(payload.sub).toBe(decode(accessToken).sub);
  });

  it('issues the invitation token as a purpose-bound JWT', () => {
    expect(mail.invitation).toMatch(JWT_SHAPE);
    expect(mail.invitation).not.toMatch(OPAQUE_64_HEX);

    expect(decode(mail.invitation!).purpose).toBe('invitation');
  });

  it('stores only hashes, never the token that was handed out', async () => {
    // A verification token is cleared from the row as soon as it is used, so
    // the one worth reading belongs to a user who has not verified yet.
    clearThrottle();
    const unverified = `unverified-${Date.now()}@example.com`;
    await request(server)
      .post(api('/auth/register'))
      .send({ email: unverified, password: 'password123', name: 'Fresh' })
      .expect(201);

    const stored: Array<string | null> = [
      await column(
        `SELECT rt.token_hash FROM refresh_tokens rt
         JOIN users u ON u.id = rt.user_id WHERE u.email = $1`,
        [userEmail],
      ),
      await column('SELECT verification_token FROM users WHERE email = $1', [
        unverified,
      ]),
      await column('SELECT reset_token FROM users WHERE email = $1', [
        userEmail,
      ]),
      await column(
        'SELECT token_hash FROM organization_invitations LIMIT 1',
        [],
      ),
    ];

    const handedOut = [refreshToken, mail.verify, mail.reset, mail.invitation];

    for (const [index, value] of stored.entries()) {
      expect(value).toMatch(OPAQUE_64_HEX);
      expect(value).not.toBe(handedOut[index]);
    }
  });

  it('refuses a refresh JWT used as a bearer access token', async () => {
    const response = await request(server)
      .get(api('/auth/profile'))
      .set('Authorization', `Bearer ${refreshToken}`)
      .expect(401);

    expect(response.body).toEqual({
      statusCode: 401,
      message: 'Unauthorized',
    });
  });

  it('refuses each token outside the purpose it was signed for', async () => {
    // A verification JWT is a perfectly valid signature; it is simply not a
    // reset token, so the refusal must come from the purpose rather than from
    // the row lookup finding nothing.
    await request(server)
      .post(api('/auth/reset-password'))
      .send({ token: mail.verify, password: 'password123' })
      .expect(400);

    await request(server)
      .get(api('/auth/verify-email'))
      .query({ token: mail.reset })
      .expect(400);

    await request(server)
      .post(api('/auth/reset-password'))
      .send({ token: mail.invitation, password: 'password123' })
      .expect(400);

    await request(server)
      .get(api('/invitations/accept'))
      .query({ token: mail.reset })
      .expect(400);

    // And the reverse direction: a reset token is not a refresh token either.
    await request(server)
      .post(api('/auth/refresh'))
      .set('Cookie', `rt=${mail.reset}; csrf=${csrf}`)
      .set(CSRF_HEADER, csrf)
      .expect(401);
  });

  it('refuses a JWT signed with anything but the configured secret', async () => {
    const forged = jwt.sign(
      {
        sub: decode(accessToken).sub,
        email: userEmail,
        sid: decode(accessToken).sid,
      },
      { secret: 'not-the-server-secret', expiresIn: 3600 },
    );

    await request(server)
      .get(api('/auth/profile'))
      .set('Authorization', `Bearer ${forged}`)
      .expect(401);

    await request(server)
      .get(api('/auth/verify-email'))
      .query({ token: forged })
      .expect(400);
  });
});
