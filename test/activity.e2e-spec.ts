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
import { resetDatabase } from './support/reset-database.js';

/**
 * Activity analysis, end to end (spec §21).
 *
 * The interesting property is not that the four read endpoints answer, it is
 * that the events they read are written by the real mutations and only when
 * those mutations commit. The suite therefore drives genuine project/task/
 * client work through the API and then reads it back through `/activity/*`,
 * proves the tenant boundary holds, and proves a mutation that is rejected
 * leaves no event behind -- the failure mode a best-effort writer would have.
 */
jest.setTimeout(60000);

const api = (path: string): string => `/${API_PREFIX}${path}`;

const ANALYTICS_DENIED = ['dashboard.view'];

describe('activity (e2e)', () => {
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let dataSource: DataSource;
  let throttleStorage: {
    storage: Map<string, unknown>;
    hitExpirations: Map<string, unknown>;
  };

  const mailTokens: { verify?: string } = {};

  let ownerToken: string;
  let ownerId: string;
  let outsiderToken: string;
  let organizationId: string;
  let outsiderOrganizationId: string;

  const owner = (req: request.Test): request.Test => {
    const test = req.set('Authorization', `Bearer ${ownerToken}`);
    return organizationId
      ? test.set('x-organization-id', organizationId)
      : test;
  };

  const outsider = (req: request.Test): request.Test => {
    const test = req.set('Authorization', `Bearer ${outsiderToken}`);
    return outsiderOrganizationId
      ? test.set('x-organization-id', outsiderOrganizationId)
      : test;
  };

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

  /** Creates an organization on the Business plan and returns its id. */
  const createOrganization = async (
    token: string,
    name: string,
  ): Promise<string> => {
    const plans = await request(server)
      .get(api('/plans'))
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const business = plans.body.find(
      (plan: { name: string }) => plan.name === 'Business',
    );

    await request(server)
      .post(api('/subscription'))
      .set('Authorization', `Bearer ${token}`)
      .send({ planId: business.id })
      .expect(200);

    const organization = await request(server)
      .post(api('/organizations'))
      .set('Authorization', `Bearer ${token}`)
      .send({ name })
      .expect(201);

    return organization.body.id as string;
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
        sendResetPasswordEmail: async () => undefined,
        sendInvitationEmail: async () => undefined,
        sendNotificationEmail: async () => undefined,
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

    const owner = await registerVerified('owner@example.com', 'Olive Owner');
    ownerId = owner.id;
    ownerToken = owner.token;
    organizationId = await createOrganization(ownerToken, 'Acme Delivery');

    const other = await registerVerified('other@example.com', 'Otto Other');
    outsiderToken = other.token;
    outsiderOrganizationId = await createOrganization(
      outsiderToken,
      'Other Corp',
    );
  });

  afterAll(async () => {
    await app.close();
  });

  it('records created events for real project and task work', async () => {
    const client = await owner(request(server).post(api('/clients')))
      .send({ name: 'Globex', email: 'globex@example.com' })
      .expect(201);

    const project = await owner(request(server).post(api('/projects')))
      .send({ name: 'Rebrand', clientId: client.body.id })
      .expect(201);

    const task = await owner(request(server).post(api('/tasks')))
      .send({ projectId: project.body.id, title: 'Design system' })
      .expect(201);

    await owner(request(server).patch(api(`/tasks/${task.body.id}`)))
      .send({ title: 'Design system v2' })
      .expect(200);

    const feed = await owner(request(server).get(api('/activity/events')))
      .expect(200);

    const byEntity = (entityType: string, entityId: string) =>
      feed.body.items.find(
        (event: { entityType: string; entityId: string }) =>
          event.entityType === entityType && event.entityId === entityId,
      );

    expect(byEntity('client', client.body.id)).toMatchObject({
      action: 'created',
      actor: { id: ownerId, name: 'Olive Owner' },
    });
    expect(byEntity('project', project.body.id)).toMatchObject({
      action: 'created',
      projectId: project.body.id,
    });
    expect(byEntity('task', task.body.id)).toMatchObject({
      action: 'updated',
      projectId: project.body.id,
    });
  });

  it('writes no event for a mutation that is rejected', async () => {
    const before = await owner(request(server).get(api('/activity/breakdown')))
      .expect(200);

    // A client id that does not exist makes the whole insert fail; the event
    // that would describe the project must roll back with it.
    await owner(request(server).post(api('/projects')))
      .send({
        name: 'Ghost',
        clientId: '00000000-0000-4000-8000-0000000000ff',
      })
      .expect(404);

    const after = await owner(request(server).get(api('/activity/breakdown')))
      .expect(200);

    expect(after.body.total).toBe(before.body.total);
    const ghosts = await dataSource.query(
      "SELECT count(*)::int AS count FROM activity_events WHERE metadata->>'name' = 'Ghost'",
    );
    expect(ghosts[0].count).toBe(0);
  });

  it('filters the feed by entity type and action', async () => {
    const tasks = await owner(
      request(server).get(api('/activity/events')).query({ entityType: 'task' }),
    ).expect(200);
    expect(tasks.body.items.length).toBeGreaterThan(0);
    expect(
      tasks.body.items.every(
        (event: { entityType: string }) => event.entityType === 'task',
      ),
    ).toBe(true);

    const created = await owner(
      request(server)
        .get(api('/activity/events'))
        .query({ entityType: 'client', action: 'created' }),
    ).expect(200);
    expect(
      created.body.items.every(
        (event: { entityType: string; action: string }) =>
          event.entityType === 'client' && event.action === 'created',
      ),
    ).toBe(true);
  });

  it('ranks the actor on the leaderboard and buckets the timeline', async () => {
    const leaderboard = await owner(
      request(server).get(api('/activity/leaderboard')),
    ).expect(200);
    expect(leaderboard.body.entries[0]).toMatchObject({
      actorId: ownerId,
      name: 'Olive Owner',
    });
    expect(leaderboard.body.entries[0].count).toBeGreaterThan(0);

    const timeline = await owner(
      request(server).get(api('/activity/timeline')),
    ).expect(200);
    expect(timeline.body.groupBy).toBe('day');
    expect(timeline.body.buckets.length).toBeGreaterThan(0);
  });

  it('keeps organizations apart', async () => {
    const mine = await owner(request(server).get(api('/activity/events')))
      .expect(200);
    expect(
      mine.body.items.some(
        (event: { entityType: string }) => event.entityType === 'project',
      ),
    ).toBe(true);

    // The outsider's own feed may hold the events their own setup produced
    // (joining the organization), but none of mine: no project or task work
    // from the other tenant leaks across.
    const theirs = await outsider(request(server).get(api('/activity/events')))
      .expect(200);
    expect(
      theirs.body.items.some((event: { entityType: string }) =>
        ['project', 'task', 'client'].includes(event.entityType),
      ),
    ).toBe(false);
  });

  it('refuses the analytics without analytics.view', async () => {
    const plain = await registerVerified('plain@example.com', 'Pat Plain');

    const role = await dataSource.query(
      `INSERT INTO roles (organization_id, user_id, name, status)
       VALUES ($1, $2, 'Developer', 'active') RETURNING id`,
      [organizationId, plain.id],
    );
    await dataSource.query(
      `INSERT INTO permissions (role_id, name)
       SELECT $1, unnest($2::text[])`,
      [role[0].id, ANALYTICS_DENIED],
    );

    const asPlain = (req: request.Test): request.Test =>
      req
        .set('Authorization', `Bearer ${plain.token}`)
        .set('x-organization-id', organizationId);

    await asPlain(request(server).get(api('/activity/events'))).expect(403);
    await asPlain(request(server).get(api('/activity/timeline'))).expect(403);
    await asPlain(request(server).get(api('/activity/leaderboard'))).expect(403);
    await asPlain(request(server).get(api('/activity/breakdown'))).expect(403);
  });

  it('rejects a malformed range and an unknown entity type', async () => {
    await owner(
      request(server).get(api('/activity/events')).query({ from: 'nope' }),
    ).expect(400);
    await owner(
      request(server)
        .get(api('/activity/breakdown'))
        .query({ entityType: 'bogus' }),
    ).expect(400);
  });
});
