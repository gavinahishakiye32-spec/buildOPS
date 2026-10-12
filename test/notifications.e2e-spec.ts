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
 * In-app notifications, end to end.
 *
 * The behaviour under test is narrow and specific: assigning a subtask notifies
 * the person it was assigned to, and nobody else. Everything here exists to
 * prove the "nobody else" half as much as the happy path -- a notification
 * system that tells the whole organization about one person's work is not a
 * feature, it is a leak.
 */
jest.setTimeout(60000);

const api = (path: string): string => `/${API_PREFIX}${path}`;

describe('notifications (e2e)', () => {
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let dataSource: DataSource;
  let throttleStorage: { storage: Map<string, unknown>; hitExpirations: Map<string, unknown> };

  const mailTokens: { verify?: string } = {};

  const ownerTokens: string[] = [];
  const adaTokens: string[] = [];
  const rexTokens: string[] = [];

  const adaIds: string[] = [];
  const rexIds: string[] = [];

  let organizationId: string;
  let projectId: string;
  let taskId: string;
  let subtaskId: string;

  const bearer =
    (token: string) =>
    (req: request.Test): request.Test => {
      const test = req.set('Authorization', `Bearer ${token}`);
      return organizationId ? test.set('x-organization-id', organizationId) : test;
    };

  const asOwner = (req: request.Test): request.Test => bearer(ownerTokens[0])(req);
  const asAda = (req: request.Test): request.Test => bearer(adaTokens[0])(req);
  const asRex = (req: request.Test): request.Test => bearer(rexTokens[0])(req);

  const clearThrottle = (): void => {
    throttleStorage.storage.clear();
    throttleStorage.hitExpirations.clear();
  };

  const registerVerified = async (email: string, name: string): Promise<string> => {
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

    return login.body.access_token as string;
  };

  /** Reads the stored rows directly: proves who was *written to*, not just served. */
  const storedFor = async (userId: string): Promise<{ title: string; type: string }[]> => {
    return dataSource.query(
      'SELECT title, type FROM notifications WHERE user_id = $1 ORDER BY created_at',
      [userId],
    );
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

  it('sets up an organization with two developers', async () => {
    ownerTokens.push(await registerVerified('owner@example.com', 'Olive Owner'));

    const plans = await asOwner(request(server).get(api('/plans'))).expect(200);
    await asOwner(request(server).post(api('/subscription')))
      .send({ planId: plans.body[0].id })
      .expect(200);

    const created = await asOwner(request(server).post(api('/organizations')))
      .send({ name: 'Acme Delivery' })
      .expect(201);
    organizationId = created.body.id;

    const project = await asOwner(request(server).post(api('/projects')))
      .send({ name: 'Authentication rework' })
      .expect(201);
    projectId = project.body.id;

    // Members are written directly rather than through the invitation flow:
    // this suite is about who gets told, and the token plumbing the invitation
    // needs is already covered by `assignment.e2e-spec.ts`.
    const userRepo = dataSource.getRepository(User);

    for (const [index, [name, email]] of (
      [
        ['Ada Login', 'ada@example.com'],
        ['Rex Register', 'rex@example.com'],
      ] as const
    ).entries()) {
      const token = await registerVerified(email, name);
      const user = await userRepo.findOne({ where: { email } });

      await dataSource.query(
        `INSERT INTO roles (organization_id, user_id, name, status)
         VALUES ($1, $2, 'Developer', 'active')
         ON CONFLICT DO NOTHING`,
        [organizationId, user!.id],
      );

      const role = await dataSource.query(
        `SELECT id FROM roles WHERE organization_id = $1 AND user_id = $2`,
        [organizationId, user!.id],
      );

      await dataSource.query(
        `INSERT INTO permissions (role_id, name)
         SELECT $1, unnest(ARRAY['task.view','task.create','task.update',
                                 'subtask.view','subtask.create','subtask.update',
                                 'subtask.assign','project.view','client.view',
                                 'dashboard.view','settings.view'])
         ON CONFLICT DO NOTHING`,
        [role[0].id],
      );

      if (index === 0) {
        adaIds.push(user!.id);
        adaTokens.push(token);
      } else {
        rexIds.push(user!.id);
        rexTokens.push(token);
      }
    }
  });

  it('starts nobody with a notification', async () => {
    const unread = await asOwner(request(server).get(api('/notifications/unread-count')))
      .expect(200);
    expect(unread.body.unread).toBe(0);
  });

  it('notifies the assignee and nobody else', async () => {
    const task = await asOwner(request(server).post(api('/tasks')))
      .send({ projectId, title: 'Authentication' })
      .expect(201);
    taskId = task.body.id;

    const subtask = await asOwner(
      request(server).post(api(`/tasks/${taskId}/subtasks`)),
    )
      .send({ title: 'Build the login form', assignedTo: adaIds[0] })
      .expect(201);
    subtaskId = subtask.body.id;

    const ada = await asAda(request(server).get(api('/notifications')))
      .expect(200);
    expect(ada.body.total).toBe(1);
    expect(ada.body.items[0]).toEqual(
      expect.objectContaining({
        type: 'subtask_assigned',
        taskId,
        subtaskId,
        readAt: null,
      }),
    );
    expect(ada.body.items[0].title).toContain('Build the login form');
    expect(ada.body.items[0].body).toContain('Authentication rework');

    // The two people who must not have been told.
    expect(await storedFor(rexIds[0])).toEqual([]);
    expect(
      await asRex(request(server).get(api('/notifications'))).then((r) => r.body.total),
    ).toBe(0);

    const owner = await asOwner(request(server).get(api('/notifications')))
      .expect(200);
    expect(owner.body.total).toBe(0);
  });

  it('counts unread for the badge', async () => {
    const unread = await asAda(request(server).get(api('/notifications/unread-count')))
      .expect(200);
    expect(unread.body.unread).toBe(1);
  });

  it('does not notify somebody about work they did not receive', async () => {
    // Reassigning away from Ada: Rex is told, Ada is not told again.
    const moved = await asOwner(
      request(server).patch(api(`/tasks/${taskId}/subtasks/${subtaskId}`)),
    )
      .send({ assignedTo: rexIds[0] })
      .expect(200);

    // Assert the move actually happened before asserting anything about who was
    // told, so a failure below cannot be mistaken for a notification bug when it
    // is really an assignment one.
    expect(moved.body.assignedTo).toBe(rexIds[0]);

    expect(await storedFor(adaIds[0])).toHaveLength(1);
    const rex = await storedFor(rexIds[0]);
    expect(rex).toHaveLength(1);
    expect(rex[0].type).toBe('subtask_reassigned');
  });

  it('does not notify anybody when the assignment is unchanged', async () => {
    // Saving a title is not an assignment. Telling somebody their work moved
    // when it did not is how people learn to ignore the bell.
    await asOwner(
      request(server).patch(api(`/tasks/${taskId}/subtasks/${subtaskId}`)),
    )
      .send({ title: 'Build the login form (v2)' })
      .expect(200);

    expect(await storedFor(rexIds[0])).toHaveLength(1);
    expect(await storedFor(adaIds[0])).toHaveLength(1);
  });

  it('does not notify a member about work assigned to themselves', async () => {
    await asAda(
      request(server).post(api(`/tasks/${taskId}/subtasks`)),
    )
      .send({ title: 'Something for me', assignedTo: adaIds[0] })
      .expect(201);

    expect(await storedFor(adaIds[0])).toHaveLength(1);
  });

  it('marks one notification read, and only that one', async () => {
    const before = await asAda(request(server).get(api('/notifications')))
      .expect(200);
    const target = before.body.items[0];

    await asAda(
      request(server).post(api(`/notifications/${target.id}/read`)),
    ).expect(200);

    const after = await asAda(request(server).get(api('/notifications/unread-count')))
      .expect(200);
    expect(after.body.unread).toBe(before.body.total - 1);
  });

  it('refuses to mark somebody else\'s notification read', async () => {
    const rexInbox = await asRex(request(server).get(api('/notifications')))
      .expect(200);
    const theirs = rexInbox.body.items[0];

    // A notification id in a URL is a UUID that arrived from outside. Answering
    // 403 would confirm it exists; 404 says nothing, which is why it is 404.
    await asAda(
      request(server).post(api(`/notifications/${theirs.id}/read`)),
    ).expect(404);

    const still = await asRex(request(server).get(api('/notifications/unread-count')))
      .expect(200);
    expect(still.body.unread).toBe(1);
  });

  it('clears the badge without rewriting what was read before', async () => {
    const before = await asRex(request(server).get(api('/notifications')))
      .expect(200);
    const alreadyReadAt = before.body.items[0].readAt;

    const result = await asRex(request(server).post(api('/notifications/read-all')))
      .expect(200);
    expect(result.body.updated).toBe(1);

    const after = await asRex(request(server).get(api('/notifications')))
      .expect(200);
    expect(after.body.total).toBe(1);
    // The row that was already read keeps its original timestamp, or "read all"
    // would be a way to falsify when somebody saw something.
    expect(alreadyReadAt).toBeNull();
    expect(after.body.items[0].readAt).not.toBeNull();
  });

  it('keeps the notification while the work is only flagged, not deleted', async () => {
    const before = await asAda(request(server).get(api('/notifications')))
      .expect(200);
    expect(before.body.total).toBeGreaterThan(0);

    // Deleting a task flags it rather than removing the row, so the row the
    // notification points at is still there and the notification is still true.
    // It goes when the soft-delete purge actually removes the work.
    await asOwner(
      request(server).delete(api(`/tasks/${taskId}`)).query({ confirm: 'cascade' }),
    ).expect(200);

    const after = await asAda(request(server).get(api('/notifications')))
      .expect(200);
    expect(after.body.total).toBe(before.body.total);
  });

  it('removes the notification once the work it describes is really deleted', async () => {
    // What the purge does: a permanent delete, so the foreign key cascades.
    await dataSource.query('DELETE FROM tasks WHERE id = $1', [taskId]);

    const after = await asAda(request(server).get(api('/notifications')))
      .expect(200);
    // Nothing survives pointing at a task that is gone.
    expect(after.body.total).toBe(0);
  });
});
