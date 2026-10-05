import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import { DataSource } from 'typeorm';
import { jest } from '@jest/globals';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { API_PREFIX, configureApp } from '../src/bootstrap.js';
import { MailService } from '../src/mail/mail.service.js';
import { User } from '../src/user/user.entity.js';
import { Role } from '../src/role/role.entity.js';
import { TeamMember } from '../src/team/team-member.entity.js';
import { UserSettings } from '../src/settings/user-settings.entity.js';
import { RefreshToken } from '../src/auth/refresh-token.entity.js';
import { resetDatabase } from './support/reset-database.js';

/**
 * The `/settings/account` surface end to end against a real PostgreSQL database.
 *
 * What is worth proving here is the behaviour that only exists because of the
 * database, and the two ways an account delete can go wrong:
 *
 *  - it must not take the workspace with it. `tenants.user_id` and
 *    `organizations.tenant_id` both cascade, so the delete has to be a flag and
 *    not a `DELETE FROM`, and the only way to know is to delete the owner of a
 *    live organization and then look at what is left;
 *  - it must leave nothing behind that identifies the person. The address, the
 *    name and the password are all overwritten, which is only checkable against
 *    the raw row.
 *
 * The credential routes are proved against the same fixtures because their whole
 * point is what happens to the sessions afterwards, and a session only really ends
 * when the next request with its token is refused.
 */
jest.setTimeout(60000);

const api = (path: string): string => `/${API_PREFIX}${path}`;

const PASSWORD = 'password123';
const NEW_PASSWORD = 'brandNew456!';

describe('account (e2e)', () => {
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let dataSource: DataSource;
  let throttleStorage: {
    storage: Map<string, unknown>;
    hitExpirations: Map<string, unknown>;
  };

  const mail: { verify?: string; reset?: string } = {};

  /**
   * Both maps have to go. `ThrottlerStorageService` replays the private
   * `hitExpirations` into a freshly created record, so clearing only `storage`
   * leaves the count exhausted and the next register answers 429.
   */
  const clearThrottle = (): void => {
    throttleStorage.storage.clear();
    throttleStorage.hitExpirations.clear();
  };

  const registerVerified = async (
    email: string,
    name: string,
  ): Promise<{ id: string; token: string }> => {
    clearThrottle();

    await request(server)
      .post(api('/auth/register'))
      .send({ email, password: PASSWORD, name })
      .expect(201);

    await request(server)
      .get(api('/auth/verify-email'))
      .query({ token: mail.verify })
      .expect(200);

    const login = await request(server)
      .post(api('/auth/login'))
      .send({ email, password: PASSWORD })
      .expect(201);

    const user = await dataSource
      .getRepository(User)
      .findOne({ where: { email } });

    return { id: user!.id, token: login.body.access_token as string };
  };

  const login = async (email: string, password: string): Promise<string> => {
    clearThrottle();

    const response = await request(server)
      .post(api('/auth/login'))
      .send({ email, password });

    return response.body.access_token as string;
  };

  const asUser = (token: string, req: request.Test): request.Test =>
    req.set('Authorization', `Bearer ${token}`);

  // The account the deletion tests operate on: it owns a subscription, an
  // organization, a role and a team membership, so the cascade that a hard delete
  // would trigger has something to destroy if the flag is ever removed.
  let ownerId = '';
  let ownerEmail = 'account-owner@example.com';
  let organizationId = '';
  let teamId = '';

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
    await app.init();

    server = app.getHttpServer();
    dataSource = app.get(DataSource);
    throttleStorage = app.get(ThrottlerStorage) as unknown as {
      storage: Map<string, unknown>;
      hitExpirations: Map<string, unknown>;
    };

    await resetDatabase(dataSource);
  });

  afterAll(async () => {
    // This suite deletes an organization owner and writes a row that points at the
    // tombstone; the next suite should not inherit either.
    await resetDatabase(dataSource);
    await app.close();
  });

  describe('setup', () => {
    it('gives the owner a subscription, an organization and a team', async () => {
      const owner = await registerVerified(ownerEmail, 'Owner');
      ownerId = owner.id;

      const plans = await request(server).get(api('/plans')).expect(200);
      const starter = plans.body.find(
        (plan: { name: string }) => plan.name === 'Starter',
      );

      await asUser(owner.token, request(server).post(api('/subscription')))
        .send({ planId: starter.id })
        .expect(200);

      const organization = await asUser(
        owner.token,
        request(server).post(api('/organizations')),
      )
        .send({ name: 'Account Org' })
        .expect(201);

      organizationId = organization.body.id as string;

      const team = await asUser(
        owner.token,
        request(server).post(api('/teams')),
      )
        .set('x-organization-id', organizationId)
        .send({ name: 'Account Team' })
        .expect(201);

      teamId = team.body.id as string;

      // A membership the deletion has to clean up; `uq_team_members_team_user`
      // would otherwise reserve the pair for an account nobody can add again.
      await asUser(
        owner.token,
        request(server).post(api(`/teams/${teamId}/members`)),
      )
        .set('x-organization-id', organizationId)
        .send({ userId: ownerId })
        .expect(201);
    });
  });

  describe('GET /settings/account', () => {
    it('answers with the account behind the token', async () => {
      const user = await registerVerified('account-read@example.com', 'Reader');

      const response = await asUser(
        user.token,
        request(server).get(api('/settings/account')),
      ).expect(200);

      expect(response.body).toEqual({
        id: user.id,
        email: 'account-read@example.com',
        name: 'Reader',
        status: 'active',
        isVerified: true,
        activeSessions: 1,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      });
    });

    it('counts devices, not tokens', async () => {
      const user = await registerVerified(
        'account-devices@example.com',
        'Devices',
      );

      // A second login is a second device. Refreshing would not add one, because
      // `listForUser` collapses a rotation family into a single row.
      await login('account-devices@example.com', PASSWORD);

      const response = await asUser(
        user.token,
        request(server).get(api('/settings/account')),
      ).expect(200);

      expect(response.body.activeSessions).toBe(2);
    });

    it('needs no organization context and no permission', async () => {
      // A registered user who belongs to nothing can still read their own
      // account: an account is not an organization's business.
      const lonely = await registerVerified(
        'account-lonely@example.com',
        'Lonely',
      );

      const response = await asUser(
        lonely.token,
        request(server).get(api('/settings/account')),
      ).expect(200);

      expect(response.body.id).toBe(lonely.id);
    });

    it('refuses a request with no token', async () => {
      await request(server).get(api('/settings/account')).expect(401);
    });
  });

  describe('PATCH /settings/account/password', () => {
    it('changes the password and ends every session, this one included', async () => {
      const email = 'account-password@example.com';
      const user = await registerVerified(email, 'Password');

      const response = await asUser(
        user.token,
        request(server).patch(api('/settings/account/password')),
      )
        .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD })
        .expect(200);

      // The access token in hand belongs to a session that no longer exists, and
      // the response says so rather than leaving the client to find out.
      expect(response.body.activeSessions).toBe(0);

      await asUser(
        user.token,
        request(server).get(api('/settings/account')),
      ).expect(401);

      // The new password is the one that works, and only that one.
      await login(email, NEW_PASSWORD);
      await request(server)
        .post(api('/auth/login'))
        .send({ email, password: PASSWORD })
        .expect(401);
    });

    it('refuses a wrong current password and changes nothing', async () => {
      const email = 'account-wrong-current@example.com';
      const user = await registerVerified(email, 'Wrong Current');

      const response = await asUser(
        user.token,
        request(server).patch(api('/settings/account/password')),
      )
        .send({
          currentPassword: 'not-the-password',
          newPassword: NEW_PASSWORD,
        })
        .expect(400);

      expect(response.body.message).toBe('Incorrect current password');

      // Still usable: a refused change must not end the sessions either.
      await asUser(
        user.token,
        request(server).get(api('/settings/account')),
      ).expect(200);
      await login(email, PASSWORD);
    });

    it('refuses a new password that breaks the password rules', async () => {
      const user = await registerVerified('account-weak@example.com', 'Weak');

      const response = await asUser(
        user.token,
        request(server).patch(api('/settings/account/password')),
      )
        .send({ currentPassword: PASSWORD, newPassword: 'short' })
        .expect(400);

      expect(JSON.stringify(response.body.message)).toContain('password');
    });

    it('refuses a body with no current password', async () => {
      // The reason this route exists rather than only `PATCH /auth/profile`: here
      // `currentPassword` is required by the schema, so it cannot be forgotten.
      const user = await registerVerified(
        'account-nocurrent@example.com',
        'None',
      );

      const response = await asUser(
        user.token,
        request(server).patch(api('/settings/account/password')),
      )
        .send({ newPassword: NEW_PASSWORD })
        .expect(400);

      expect(JSON.stringify(response.body.message)).toContain(
        'currentPassword',
      );
    });

    it('refuses a request with no token', async () => {
      await request(server)
        .patch(api('/settings/account/password'))
        .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD })
        .expect(401);
    });
  });

  describe('PATCH /settings/account/email', () => {
    it('moves the address, resets verification and sends a fresh link', async () => {
      const user = await registerVerified('account-old@example.com', 'Old');
      const moved = 'account-new@example.com';

      const response = await asUser(
        user.token,
        request(server).patch(api('/settings/account/email')),
      )
        .send({ email: moved })
        .expect(200);

      expect(response.body.email).toBe(moved);
      expect(response.body.isVerified).toBe(false);

      // The token went to the new address: the link that arrives is what makes the
      // account usable again, and the old address is no longer worth anything.
      const row = await dataSource
        .getRepository(User)
        .findOne({ where: { id: user.id } });
      expect(row!.isVerified).toBe(false);
      expect(mail.verify).toEqual(expect.any(String));

      await request(server)
        .get(api('/auth/verify-email'))
        .query({ token: mail.verify })
        .expect(200);

      // And the account signs in at its new address.
      await login(moved, PASSWORD);
      await request(server)
        .post(api('/auth/login'))
        .send({ email: 'account-old@example.com', password: PASSWORD })
        .expect(401);
    });

    it('refuses an address that already belongs to somebody', async () => {
      const taken = 'account-taken@example.com';
      await registerVerified(taken, 'Taken');

      const user = await registerVerified('account-clash@example.com', 'Clash');

      const response = await asUser(
        user.token,
        request(server).patch(api('/settings/account/email')),
      )
        .send({ email: taken })
        .expect(409);

      expect(response.body.error).toBe('Conflict');

      const row = await dataSource
        .getRepository(User)
        .findOne({ where: { id: user.id } });
      expect(row!.email).toBe('account-clash@example.com');
    });

    it('refuses a malformed address', async () => {
      const user = await registerVerified('account-bad@example.com', 'Bad');

      await asUser(
        user.token,
        request(server).patch(api('/settings/account/email')),
      )
        .send({ email: 'not-an-email' })
        .expect(400);
    });

    it('refuses a request with no token', async () => {
      await request(server)
        .patch(api('/settings/account/email'))
        .send({ email: 'account-anon@example.com' })
        .expect(401);
    });
  });

  describe('sessions', () => {
    it('lists every live device and flags the caller', async () => {
      const email = 'account-sessions@example.com';
      const first = await registerVerified(email, 'Sessions');
      const second = await login(email, PASSWORD);

      const response = await asUser(
        first.token,
        request(server).get(api('/settings/account/sessions')),
      ).expect(200);

      expect(response.body).toHaveLength(2);
      expect(
        response.body.filter((row: { isCurrent: boolean }) => row.isCurrent),
      ).toHaveLength(1);

      // The other device sees the same two rows with the flag on the other one:
      // the list is the account's, not the caller's.
      const fromSecond = await asUser(
        second,
        request(server).get(api('/settings/account/sessions')),
      ).expect(200);

      expect(
        fromSecond.body.filter((row: { isCurrent: boolean }) => row.isCurrent),
      ).toHaveLength(1);
      expect(
        fromSecond.body.map((row: { id: string }) => row.id).sort(),
      ).toEqual(response.body.map((row: { id: string }) => row.id).sort());
    });

    it('refuses a request with no token', async () => {
      await request(server).get(api('/settings/account/sessions')).expect(401);
    });

    it('ends the session it is given, and only that one', async () => {
      const email = 'account-revoke@example.com';
      const first = await registerVerified(email, 'Revoke');
      const second = await login(email, PASSWORD);

      const listed = await asUser(
        first.token,
        request(server).get(api('/settings/account/sessions')),
      ).expect(200);

      // The caller's own session is the one it did not just create.
      const other = listed.body.find(
        (row: { isCurrent: boolean }) => !row.isCurrent,
      ) as { id: string };

      const revoked = await asUser(
        first.token,
        request(server).delete(api(`/settings/account/sessions/${other.id}`)),
      ).expect(200);

      expect(revoked.body).toEqual({ message: 'Session revoked' });

      // That device's access token is refused from the next request onwards.
      await asUser(
        second,
        request(server).get(api('/settings/account')),
      ).expect(401);
      await asUser(
        first.token,
        request(server).get(api('/settings/account')),
      ).expect(200);
    });

    it("answers 404 for a session that is not the caller's", async () => {
      const stranger = await registerVerified(
        'account-stranger@example.com',
        'Stranger',
      );
      const otherEmail = 'account-other@example.com';
      const other = await registerVerified(otherEmail, 'Other');

      const listed = await asUser(
        other.token,
        request(server).get(api('/settings/account/sessions')),
      ).expect(200);

      const notMine = listed.body[0].id as string;

      // Somebody else's session id is indistinguishable from one that does not
      // exist, so this route cannot be used to find valid ids.
      const response = await asUser(
        stranger.token,
        request(server).delete(api(`/settings/account/sessions/${notMine}`)),
      ).expect(404);

      expect(response.body.message).toBe('Session not found');

      // And the attempt really did nothing.
      await asUser(
        other.token,
        request(server).get(api('/settings/account/sessions')),
      ).expect(200);
    });

    it('answers 404 for an unknown session id, and 400 for a malformed one', async () => {
      const user = await registerVerified(
        'account-unknown@example.com',
        'Unknown',
      );

      await asUser(
        user.token,
        request(server).delete(
          api(
            '/settings/account/sessions/00000000-0000-4000-8000-000000000000',
          ),
        ),
      ).expect(404);

      await asUser(
        user.token,
        request(server).delete(api('/settings/account/sessions/not-a-uuid')),
      ).expect(400);
    });

    it('refuses a request with no token', async () => {
      await request(server)
        .delete(
          api(
            '/settings/account/sessions/00000000-0000-4000-8000-000000000000',
          ),
        )
        .expect(401);
    });
  });

  describe('DELETE /settings/account', () => {
    it('refuses a request with no token', async () => {
      await request(server)
        .delete(api('/settings/account'))
        .query({ confirm: ownerEmail })
        .send({ password: PASSWORD })
        .expect(401);
    });

    it('refuses without the confirmation and names the address to type', async () => {
      const user = await registerVerified(
        'account-noconfirm@example.com',
        'None',
      );

      const response = await asUser(
        user.token,
        request(server).delete(api('/settings/account')),
      )
        .send({ password: PASSWORD })
        .expect(409);

      expect(response.body.message).toContain('account-noconfirm@example.com');

      const row = await dataSource
        .getRepository(User)
        .findOne({ where: { id: user.id } });
      expect(row).not.toBeNull();
      expect(row!.deletedAt).toBeNull();
    });

    it('refuses a confirmation that is not the address on the account', async () => {
      const user = await registerVerified(
        'account-mismatch@example.com',
        'Nope',
      );

      const response = await asUser(
        user.token,
        request(server).delete(api('/settings/account')),
      )
        .query({ confirm: 'somebody-else@example.com' })
        .send({ password: PASSWORD })
        .expect(409);

      expect(response.body.message).toContain('account-mismatch@example.com');

      await asUser(
        user.token,
        request(server).get(api('/settings/account')),
      ).expect(200);
    });

    it('refuses a wrong password, and keeps the account open', async () => {
      const email = 'account-badpass@example.com';
      const user = await registerVerified(email, 'Bad Pass');

      const response = await asUser(
        user.token,
        request(server).delete(api('/settings/account')),
      )
        .query({ confirm: email })
        .send({ password: 'not-the-password' })
        .expect(400);

      expect(response.body.message).toBe('Incorrect password');

      // A refused delete must not cost the customer their sessions.
      await asUser(
        user.token,
        request(server).get(api('/settings/account')),
      ).expect(200);
      await login(email, PASSWORD);
    });

    it('refuses a request with no password at all', async () => {
      const user = await registerVerified(
        'account-nopass@example.com',
        'No Pass',
      );

      const response = await asUser(
        user.token,
        request(server).delete(api('/settings/account')),
      )
        .query({ confirm: 'account-nopass@example.com' })
        .send({})
        .expect(400);

      expect(JSON.stringify(response.body.message)).toContain('password');
    });

    it('closes the account and ends the sessions, this one included', async () => {
      const token = await login(ownerEmail, PASSWORD);

      await asUser(token, request(server).get(api('/settings/account'))).expect(
        200,
      );

      const response = await asUser(
        token,
        request(server).delete(api('/settings/account')),
      )
        .query({ confirm: ownerEmail })
        .send({ password: PASSWORD })
        .expect(200);

      expect(response.body).toEqual({ message: 'Account deleted' });

      // The token that did it is already dead, on every route rather than just
      // this one: the family is revoked and the row no longer resolves, and either
      // alone is enough.
      await asUser(token, request(server).get(api('/settings/account'))).expect(
        401,
      );
      await asUser(
        token,
        request(server).get(api('/settings/account/sessions')),
      ).expect(401);

      // And the account cannot be signed into again at the address that was freed.
      clearThrottle();
      await request(server)
        .post(api('/auth/login'))
        .send({ email: ownerEmail, password: PASSWORD })
        .expect(401);
    });

    it('leaves the organization, the tenant and the role in place', async () => {
      const organizations = await dataSource.query(
        'SELECT id FROM organizations WHERE id = $1',
        [organizationId],
      );
      expect(organizations).toHaveLength(1);

      const tenants = await dataSource.query(
        'SELECT id FROM tenants WHERE id = (SELECT tenant_id FROM organizations WHERE id = $1)',
        [organizationId],
      );
      expect(tenants).toHaveLength(1);

      // The role definition survives; only the assignment is released, which is
      // what frees the seat against `max_users`.
      const roles = await dataSource.getRepository(Role).find({
        where: { organizationId },
      });
      expect(roles.length).toBeGreaterThan(0);
      expect(roles.every((role) => role.userId === null)).toBe(true);
    });

    it('anonymises the row and releases everything attached to it', async () => {
      const [row] = await dataSource.query(
        `SELECT email, name, password_hash, is_verified, deleted_at, organization_id
           FROM users WHERE id = $1`,
        [ownerId],
      );

      expect(row).toBeDefined();
      expect(row.deleted_at).not.toBeNull();
      expect(row.email).toBe(`deleted+${ownerId}@deleted.invalid`);
      expect(row.name).toBeNull();
      expect(row.is_verified).toBe(false);
      expect(row.organization_id).toBeNull();

      // Nothing that could authenticate is left: the hash is a bcrypt hash of a
      // random string, so `compare` can never succeed against it.
      expect(row.password_hash).toMatch(/^\$2[aby]\$/);

      // The account no longer resolves through the API's own reads, which is what
      // makes every existing guard refuse it without knowing about deletion.
      const resolved = await dataSource
        .getRepository(User)
        .findOne({ where: { id: ownerId } });
      expect(resolved).toBeNull();

      // Sessions, team memberships and preferences are gone.
      const sessions = await dataSource
        .getRepository(RefreshToken)
        .createQueryBuilder('token')
        .where('token.user_id = :userId', { userId: ownerId })
        .getMany();
      expect(sessions).toHaveLength(0);

      const memberships = await dataSource
        .getRepository(TeamMember)
        .createQueryBuilder('member')
        .where('member.user_id = :userId', { userId: ownerId })
        .getMany();
      expect(memberships).toHaveLength(0);

      const settings = await dataSource
        .getRepository(UserSettings)
        .createQueryBuilder('settings')
        .where('settings.user_id = :userId', { userId: ownerId })
        .getMany();
      expect(settings).toHaveLength(0);

      // And the logged hours keep their `user_id`: the column is `ON DELETE
      // RESTRICT`, so the database would have refused a hard delete of this row the
      // moment anything was logged against the account. Flagging it is what leaves
      // that history resolvable, pointing at an id that no longer names anybody,
      // instead of rewritten or cascaded away.
      const [history] = await dataSource.query(
        `SELECT rc.delete_rule
           FROM information_schema.table_constraints tc
           JOIN information_schema.referential_constraints rc
             ON rc.constraint_name = tc.constraint_name
            AND rc.constraint_schema = tc.constraint_schema
          WHERE tc.table_name = 'time_entries'
            AND tc.constraint_type = 'FOREIGN KEY'
            AND tc.constraint_name = 'FK_time_entries_user'`,
      );
      expect(history).toMatchObject({ delete_rule: 'RESTRICT' });
    });

    it('frees the address for a new registration', async () => {
      clearThrottle();

      await request(server)
        .post(api('/auth/register'))
        .send({ email: ownerEmail, password: PASSWORD })
        .expect(201);
    });
  });
});
