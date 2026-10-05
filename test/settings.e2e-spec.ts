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
import { Organization } from '../src/organization/organization.entity.js';
import { UserSettings } from '../src/settings/user-settings.entity.js';
import { OrganizationSettings } from '../src/settings/organization-settings.entity.js';
import {
  DEFAULT_ORGANIZATION_SETTINGS,
  DEFAULT_USER_SETTINGS,
} from '../src/common/enums.js';
import { resetDatabase } from './support/reset-database.js';

/**
 * The two settings endpoints end to end against a real PostgreSQL database.
 *
 * What is worth asserting here, and cannot be asserted in a unit test, is the
 * behaviour that depends on the database: that a defaults row is really written
 * on first read, that the CHECK constraints reject a value the API documents as
 * valid when it is written past the API, and that the two rows cascade away with
 * the users and organizations they belong to.
 */
jest.setTimeout(60000);

const api = (path: string): string => `/${API_PREFIX}${path}`;

describe('settings (e2e)', () => {
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let dataSource: DataSource;
  let throttleStorage: {
    storage: Map<string, unknown>;
    hitExpirations: Map<string, unknown>;
  };

  const mailTokens: { verify?: string; reset?: string } = {};
  const ownerToken: string[] = [];
  const viewerToken: string[] = [];
  let ownerId: string;
  let viewerId: string;
  let organizationId: string;

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
      .send({ email, password: 'password123', name })
      .expect(201);

    await request(server)
      .get(api('/auth/verify-email'))
      .query({ token: mailTokens.verify })
      .expect(200);

    const login = await request(server)
      .post(api('/auth/login'))
      .send({ email, password: 'password123' })
      .expect(201);

    const user = await dataSource
      .getRepository(User)
      .findOne({ where: { email } });

    return { id: user!.id, token: login.body.access_token as string };
  };

  const asOwner = (req: request.Test): request.Test => {
    const test = req.set(
      'Authorization',
      `Bearer ${ownerToken[ownerToken.length - 1]}`,
    );
    return organizationId
      ? test.set('x-organization-id', organizationId)
      : test;
  };

  const asViewer = (req: request.Test): request.Test => {
    const test = req.set(
      'Authorization',
      `Bearer ${viewerToken[viewerToken.length - 1]}`,
    );
    return organizationId
      ? test.set('x-organization-id', organizationId)
      : test;
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
    throttleStorage = app.get(ThrottlerStorage) as unknown as {
      storage: Map<string, unknown>;
      hitExpirations: Map<string, unknown>;
    };

    await resetDatabase(dataSource);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('setup', () => {
    it('registers an owner, subscribes and creates an organization', async () => {
      const owner = await registerVerified(
        'settings-owner@example.com',
        'Owner',
      );
      ownerId = owner.id;
      ownerToken.push(owner.token);

      // An organization needs a subscription behind it, and the Growth plan is
      // what allows more than one -- the second organization in `deletion` needs
      // it, and the Starter limit would refuse it.
      const plans = await request(server).get(api('/plans')).expect(200);
      const growth = plans.body.find(
        (plan: { name: string }) => plan.name === 'Growth',
      );

      await asOwner(request(server).post(api('/subscription')))
        .send({ planId: growth.id })
        .expect(200);

      const res = await asOwner(request(server).post(api('/organizations')))
        .send({ name: 'Settings Org' })
        .expect(201);

      organizationId = res.body.id as string;
      expect(organizationId).toEqual(expect.any(String));
    });

    it('adds a viewer who can read the organization settings but not write them', async () => {
      const viewer = await registerVerified(
        'settings-viewer@example.com',
        'Viewer',
      );
      viewerId = viewer.id;
      viewerToken.push(viewer.token);

      // The viewer template carries `settings.view` and, by the same rule as
      // every other resource, no write permission.
      await asOwner(
        request(server).post(api(`/organizations/${organizationId}/members`)),
      )
        .send({ email: 'settings-viewer@example.com', templateKey: 'viewer' })
        .expect(201);

      const members = await asOwner(
        request(server).get(api(`/organizations/${organizationId}/members`)),
      ).expect(200);
      const added = members.body.find(
        (member: { userId: string }) => member.userId === viewerId,
      );
      expect(added).toBeDefined();
      expect(added.permissions).toContain('settings.view');
      expect(added.permissions).not.toContain('settings.update');
    });
  });

  describe('GET /settings/me', () => {
    it('returns the defaults and writes the row on first read', async () => {
      const before = await dataSource
        .getRepository(UserSettings)
        .findOne({ where: { userId: ownerId } });
      expect(before).toBeNull();

      const res = await request(server)
        .get(api('/settings/me'))
        .set('Authorization', `Bearer ${ownerToken[0]}`)
        .expect(200);

      expect(res.body).toMatchObject({
        userId: ownerId,
        ...DEFAULT_USER_SETTINGS,
      });

      // The point of materializing on read: a second caller sees the same row
      // rather than a fresh set of defaults.
      const row = await dataSource
        .getRepository(UserSettings)
        .findOne({ where: { userId: ownerId } });
      expect(row).not.toBeNull();
      expect(row!.createdAt).toBeInstanceOf(Date);
    });

    it('does not require an organization header or a permission', async () => {
      // A user with no organization at all can still read their own settings,
      // because personal preferences are not the organization's business.
      const outsider = await registerVerified(
        'settings-outsider@example.com',
        'Outsider',
      );

      const res = await request(server)
        .get(api('/settings/me'))
        .set('Authorization', `Bearer ${outsider.token}`)
        .expect(200);

      expect(res.body.userId).toBe(outsider.id);
    });

    it('rejects a request with no token', async () => {
      await request(server).get(api('/settings/me')).expect(401);
    });
  });

  describe('PATCH /settings/me', () => {
    it('changes only the fields sent', async () => {
      const token = ownerToken[ownerToken.length - 1];

      await request(server)
        .patch(api('/settings/me'))
        .set('Authorization', `Bearer ${token}`)
        .send({ theme: 'dark' })
        .expect(200);

      const res = await request(server)
        .patch(api('/settings/me'))
        .set('Authorization', `Bearer ${token}`)
        .send({ locale: 'fr' })
        .expect(200);

      // `theme` was set by the previous call and is untouched here; the
      // untouched `timezone` is still the default.
      expect(res.body).toMatchObject({
        theme: 'dark',
        locale: 'fr',
        timezone: DEFAULT_USER_SETTINGS.timezone,
      });
    });

    it('accepts every documented value, including digest off', async () => {
      const token = ownerToken[ownerToken.length - 1];

      for (const theme of ['system', 'light', 'dark']) {
        await request(server)
          .patch(api('/settings/me'))
          .set('Authorization', `Bearer ${token}`)
          .send({ theme })
          .expect(200);
      }

      const res = await request(server)
        .patch(api('/settings/me'))
        .set('Authorization', `Bearer ${token}`)
        .send({ digestFrequency: 'off', timeFormat: '12h' })
        .expect(200);

      expect(res.body.digestFrequency).toBe('off');
      expect(res.body.timeFormat).toBe('12h');
    });

    it('rejects a value outside the documented set', async () => {
      const token = ownerToken[ownerToken.length - 1];

      const res = await request(server)
        .patch(api('/settings/me'))
        .set('Authorization', `Bearer ${token}`)
        .send({ theme: 'neon' })
        .expect(400);

      expect(JSON.stringify(res.body.message)).toContain('theme');
    });

    it('rejects a timezone that is not an IANA name', async () => {
      const token = ownerToken[ownerToken.length - 1];

      await request(server)
        .patch(api('/settings/me'))
        .set('Authorization', `Bearer ${token}`)
        .send({ timezone: 'Europe/Paris; DROP TABLE users' })
        .expect(400);

      const res = await request(server)
        .patch(api('/settings/me'))
        .set('Authorization', `Bearer ${token}`)
        .send({ timezone: 'Europe/Paris' })
        .expect(200);

      expect(res.body.timezone).toBe('Europe/Paris');
    });
  });

  describe('GET /settings/organization', () => {
    it('returns the defaults and writes the row on first read', async () => {
      const before = await dataSource
        .getRepository(OrganizationSettings)
        .findOne({ where: { organizationId } });
      expect(before).toBeNull();

      const res = await asOwner(
        request(server).get(api('/settings/organization')),
      ).expect(200);

      expect(res.body).toMatchObject({
        organizationId,
        ...DEFAULT_ORGANIZATION_SETTINGS,
      });

      const row = await dataSource
        .getRepository(OrganizationSettings)
        .findOne({ where: { organizationId } });
      expect(row).not.toBeNull();
    });

    it('lets a role with settings.view read it', async () => {
      await asViewer(request(server).get(api('/settings/organization'))).expect(
        200,
      );
    });

    it('refuses a caller who is not a member of the organization', async () => {
      const outsider = await registerVerified(
        'settings-stranger@example.com',
        'Stranger',
      );

      await request(server)
        .get(api('/settings/organization'))
        .set('Authorization', `Bearer ${outsider.token}`)
        .set('x-organization-id', organizationId)
        .expect(403);
    });

    it('refuses a caller who sends no organization', async () => {
      // The guard answers 404, not 403: an organization-scoped route with no
      // organization header is a route that does not exist for this request.
      await request(server)
        .get(api('/settings/organization'))
        .set('Authorization', `Bearer ${ownerToken[0]}`)
        .expect(404);
    });
  });

  describe('PATCH /settings/organization', () => {
    it('changes the reporting timezone and week start', async () => {
      const res = await asOwner(
        request(server).patch(api('/settings/organization')),
      )
        .send({ timezone: 'Europe/Paris', weekStart: 'sunday' })
        .expect(200);

      expect(res.body.timezone).toBe('Europe/Paris');
      expect(res.body.weekStart).toBe('sunday');
    });

    it('narrows one bound of the working window without resending the other', async () => {
      // Validated against the resulting row rather than the request, so a
      // client can adjust one end of an existing window.
      const res = await asOwner(
        request(server).patch(api('/settings/organization')),
      )
        .send({ workingDayStartMinutes: 8 * 60 })
        .expect(200);

      expect(res.body.workingDayStartMinutes).toBe(480);
      expect(res.body.workingDayEndMinutes).toBe(17 * 60);
    });

    it('refuses a working day that ends before it starts', async () => {
      const res = await asOwner(
        request(server).patch(api('/settings/organization')),
      )
        .send({ workingDayStartMinutes: 18 * 60, workingDayEndMinutes: 9 * 60 })
        .expect(400);

      expect(JSON.stringify(res.body.message)).toContain('working day');
    });

    it('refuses a zero-length working day', async () => {
      await asOwner(request(server).patch(api('/settings/organization')))
        .send({ workingDayStartMinutes: 540, workingDayEndMinutes: 540 })
        .expect(400);
    });

    it('refuses a bound outside the day', async () => {
      await asOwner(request(server).patch(api('/settings/organization')))
        .send({ workingDayStartMinutes: -1 })
        .expect(400);
    });

    it('refuses a viewer, who has settings.view but not settings.update', async () => {
      await asViewer(request(server).patch(api('/settings/organization')))
        .send({ weekStart: 'monday' })
        .expect(403);
    });

    it('leaves the previous values in place when a request is refused', async () => {
      const res = await asOwner(
        request(server).get(api('/settings/organization')),
      ).expect(200);

      // The rejected writes above must not have half-applied.
      expect(res.body.weekStart).toBe('sunday');
      expect(res.body.workingDayStartMinutes).toBe(8 * 60);
      expect(res.body.workingDayEndMinutes).toBe(17 * 60);
    });
  });

  describe('database constraints', () => {
    it('rejects a value the API documents as valid when written past the API', async () => {
      // The CHECK constraints are what stop an out-of-band write from leaving a
      // value in the column that a later reader cannot render.
      const repo = dataSource.getRepository(UserSettings);
      const themeBefore = (await repo.findOne({ where: { userId: ownerId } }))!
        .theme;

      await expect(
        dataSource.query(
          `UPDATE "user_settings" SET "theme" = 'neon' WHERE "user_id" = $1`,
          [ownerId],
        ),
      ).rejects.toThrow();

      // The rejected write left the column as it was, whatever that was.
      const row = await repo.findOne({ where: { userId: ownerId } });
      expect(row!.theme).toBe(themeBefore);
    });

    it('rejects a working window that ends before it starts', async () => {
      await expect(
        dataSource.query(
          `UPDATE "organization_settings"
             SET "working_day_start_minutes" = 1200,
                 "working_day_end_minutes" = 600
           WHERE "organization_id" = $1`,
          [organizationId],
        ),
      ).rejects.toThrow();
    });

    it('refuses a second settings row for the same user', async () => {
      // The primary key being the foreign key is what makes this structural
      // rather than a constraint to be separately enforced.
      await expect(
        dataSource
          .getRepository(UserSettings)
          .insert({ userId: ownerId } as Partial<UserSettings>),
      ).rejects.toThrow();
    });
  });

  describe('deletion', () => {
    it('removes the settings rows when their owner is deleted', async () => {
      const doomed = await registerVerified(
        'settings-doomed@example.com',
        'Doomed',
      );

      await request(server)
        .get(api('/settings/me'))
        .set('Authorization', `Bearer ${doomed.token}`)
        .expect(200);

      await dataSource.getRepository(User).delete(doomed.id);

      const orphan = await dataSource
        .getRepository(UserSettings)
        .findOne({ where: { userId: doomed.id } });
      expect(orphan).toBeNull();
    });

    it('removes the organization settings when the organization is deleted', async () => {
      const res = await asOwner(request(server).post(api('/organizations')))
        .send({ name: 'Doomed Org' })
        .expect(201);
      const doomedOrganizationId = res.body.id as string;

      await request(server)
        .get(api('/settings/organization'))
        .set('Authorization', `Bearer ${ownerToken[ownerToken.length - 1]}`)
        .set('x-organization-id', doomedOrganizationId)
        .expect(200);

      await dataSource
        .getRepository(Organization)
        .delete({ id: doomedOrganizationId });

      const orphan = await dataSource
        .getRepository(OrganizationSettings)
        .findOne({ where: { organizationId: doomedOrganizationId } });
      expect(orphan).toBeNull();
    });
  });
});
