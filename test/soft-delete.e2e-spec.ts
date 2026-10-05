import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import { DataSource, ObjectLiteral, QueryBuilder, UpdateQueryBuilder } from 'typeorm';
import { jest } from '@jest/globals';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { API_PREFIX, configureApp } from '../src/bootstrap.js';
import { MailService } from '../src/mail/mail.service.js';
import { User } from '../src/user/user.entity.js';
import { resetDatabase } from './support/reset-database.js';

/**
 * End-to-end coverage of the safe-deletion contract (spec §22) against a real
 * PostgreSQL database.
 *
 * Two things are being defended here, and they pull against each other:
 *
 *  - Deleting something must not destroy work. Logged hours in particular are a
 *    business record, so a project delete takes its tasks, subtasks and time
 *    with it only after the caller says so, and afterwards it is all still
 *    there.
 *  - Restoring must put back exactly what was deleted -- and no more. A restore
 *    that swept up everything under a parent would silently resurrect a
 *    subtask somebody removed on purpose a week later, which is how a user
 *    learns to be afraid of the restore button.
 *
 * The assertions below check the second property by deliberately deleting one
 * descendant *after* a cascade and asserting it survives the restore deleted.
 */
jest.setTimeout(60000);

const api = (path: string): string => `/${API_PREFIX}${path}`;

describe('Safe deletion (e2e)', () => {
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let dataSource: DataSource;
  let throttleStorage: {
    storage: Map<string, unknown>;
    hitExpirations: Map<string, unknown>;
  };

  const mailTokens: { verify?: string } = {};
  let ownerToken: string;
  let memberToken: string;
  let ownerId: string;
  let organizationId: string;
  let organizationName: string;
  let projectId: string;
  let taskId: string;
  let subtaskId: string;
  let timeEntryId: string;

  // Defined before `createTree` so the tree builder can use them; the tokens
  // they close over are only read once the specs are running.
  const owner = (req: request.Test): request.Test => {
    const test = req.set('Authorization', `Bearer ${ownerToken}`);

    return organizationId
      ? test.set('x-organization-id', organizationId)
      : test;
  };

  const member = (req: request.Test): request.Test => {
    const test = req.set('Authorization', `Bearer ${memberToken}`);

    return organizationId
      ? test.set('x-organization-id', organizationId)
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

  const createTree = async (suffix: string) => {
    const client = await owner(request(server).post(api('/clients')))
      .send({ name: `Client ${suffix}`, email: `client-${suffix}@example.com` })
      .expect(201);

    const project = await owner(request(server).post(api('/projects')))
      .send({ name: `Project ${suffix}`, clientId: client.body.id })
      .expect(201);

    const task = await owner(request(server).post(api('/tasks')))
      .send({ projectId: project.body.id, title: `Task ${suffix}` })
      .expect(201);

    const subtask = await owner(
      request(server).post(api(`/tasks/${task.body.id}/subtasks`)),
    )
      .send({ title: `Subtask ${suffix}` })
      .expect(201);

    const entry = await owner(request(server).post(api('/time-entries')))
      .send({
        subtaskId: subtask.body.id,
        entryTime: '2026-09-01T09:00:00.000Z',
        exitTime: '2026-09-01T11:00:00.000Z',
      })
      .expect(201);

    return {
      clientId: client.body.id as string,
      projectId: project.body.id as string,
      taskId: task.body.id as string,
      subtaskId: subtask.body.id as string,
      timeEntryId: entry.body.id as string,
    };
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

    const owner = await registerVerified('owner@example.com', 'Owner');
    ownerId = owner.id;
    ownerToken = owner.token;

    const member = await registerVerified('member@example.com', 'Member');
    memberToken = member.token;

    // The suite is about authorization at the data level, so the member needs
    // real access to the organization -- the permission template is applied here
    // rather than relying on a hand-built role.
    // Business, not Starter: this suite builds a fresh project tree per spec,
    // and Starter's three projects run out long before the tenth case. The
    // limits themselves are covered in api.e2e-spec.ts; here they would only be
    // in the way.
    const business = (await request(server).get(api('/plans'))).body.find(
      (plan: { name: string }) => plan.name === 'Business',
    );
    await request(server)
      .post(api('/subscription'))
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ planId: business.id })
      .expect(200);

    organizationName = 'Acme Retention';
    const organization = await request(server)
      .post(api('/organizations'))
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: organizationName })
      .expect(201);
    organizationId = organization.body.id;

    // The member needs real working access: the ownership assertions below are
    // about the service refusing a delete the member is *permitted* to make.
    await request(server)
      .post(api(`/organizations/${organizationId}/members`))
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: 'member@example.com', templateKey: 'project_manager' })
      .expect(201);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('confirmation', () => {
    it('refuses a cascading delete that has not been confirmed, and deletes nothing', async () => {
      const tree = await createTree('confirm');

      for (const path of [
        `/projects/${tree.projectId}`,
        `/tasks/${tree.taskId}`,
        `/tasks/${tree.taskId}/subtasks/${tree.subtaskId}`,
      ]) {
        const refused = await owner(request(server).delete(api(path))).expect(409);
        expect(refused.body.message).toMatch(/confirm=cascade/);
      }

      // Nothing moved: the whole tree is still readable, which is the point of
      // checking the database as well as the API.
      await owner(request(server).get(api(`/projects/${tree.projectId}`))).expect(200);
      await owner(request(server).get(api(`/tasks/${tree.taskId}`))).expect(200);
      await owner(
        request(server).get(api(`/tasks/${tree.taskId}/subtasks/${tree.subtaskId}`)),
      ).expect(200);

      const rows = await dataSource.query(
        'SELECT count(*)::int AS count FROM tasks WHERE id = $1 AND deleted_at IS NULL',
        [tree.taskId],
      );
      expect(rows[0].count).toBe(1);
    });

    it('rejects a confirmation value that is not the expected one', async () => {
      const tree = await createTree('badconfirm');

      await owner(
        request(server).delete(api(`/projects/${tree.projectId}`)).query({
          confirm: 'yes',
        }),
      ).expect(400);

      await owner(
        request(server).get(api(`/projects/${tree.projectId}`)),
      ).expect(200);
    });
  });

  describe('project cascade', () => {
    it('flags the project, its tasks, its subtasks and the time logged against them', async () => {
      const tree = await createTree('cascade');
      projectId = tree.projectId;
      taskId = tree.taskId;
      subtaskId = tree.subtaskId;
      timeEntryId = tree.timeEntryId;

      const deleted = await owner(
        request(server).delete(api(`/projects/${projectId}`)).query({
          confirm: 'cascade',
        }),
      ).expect(200);

      // project + task + subtask + time entry
      expect(deleted.body.deleted).toBe(4);
      expect(deleted.body.message).toBe('Project deleted');

      // Every ordinary read is now blind to them.
      await owner(request(server).get(api(`/projects/${projectId}`))).expect(404);
      await owner(request(server).get(api(`/tasks/${taskId}`))).expect(404);
      await owner(
        request(server).get(api(`/tasks/${taskId}/subtasks/${subtaskId}`)),
      ).expect(404);
      await owner(
        request(server).get(api(`/time-entries/${timeEntryId}`)),
      ).expect(404);

      // The list is not empty -- earlier specs left live projects behind -- but
      // the deleted one is gone from it.
      const list = await owner(request(server).get(api('/projects'))).expect(200);
      expect(list.body.items.map((row: { id: string }) => row.id)).not.toContain(
        projectId,
      );

      // But the rows are still in the database, flagged and attributed.
      const rows = await dataSource.query(
        `SELECT t.deleted_at, t.deleted_by, s.deleted_at AS subtask_deleted_at,
                te.deleted_at AS entry_deleted_at
           FROM tasks t
           JOIN subtasks s ON s.task_id = t.id
           JOIN time_entries te ON te.subtask_id = s.id
          WHERE t.id = $1`,
        [taskId],
      );

      expect(rows).toHaveLength(1);
      expect(rows[0].deleted_at).not.toBeNull();
      expect(rows[0].deleted_by).toBe(ownerId);
      // The shared timestamp is what makes the restore exact.
      expect(rows[0].subtask_deleted_at).toEqual(rows[0].deleted_at);
      expect(rows[0].entry_deleted_at).toEqual(rows[0].deleted_at);
    });

    it('lists each resource in its own trash', async () => {
      const projects = await owner(request(server).get(api('/projects/trash'))).expect(200);
      expect(projects.body).toEqual([
        expect.objectContaining({
          id: projectId,
          deletedBy: ownerId,
          deletedAt: expect.any(String),
          resource: expect.objectContaining({ id: projectId }),
        }),
      ]);

      const tasks = await owner(request(server).get(api('/tasks/trash'))).expect(200);
      expect(tasks.body.map((row: { id: string }) => row.id)).toEqual([taskId]);

      const subtasks = await owner(
        request(server).get(api(`/tasks/${taskId}/subtasks/trash`)),
      ).expect(200);
      expect(subtasks.body.map((row: { id: string }) => row.id)).toEqual([subtaskId]);

      const entries = await owner(
        request(server).get(api('/time-entries/trash')),
      ).expect(200);
      expect(entries.body.map((row: { id: string }) => row.id)).toEqual([timeEntryId]);
    });

    it('restores the whole tree, but not a descendant deleted separately', async () => {
      // Set up entirely through the API, in the order a real accident would
      // produce: one subtask is removed on purpose first, and the task is
      // deleted afterwards. The second delete must not absorb the first.
      const tree = await createTree('partial');
      const spare = await owner(
        request(server).post(api(`/tasks/${tree.taskId}/subtasks`)),
      )
        .send({ title: 'Removed on purpose' })
        .expect(201);

      const spareEntry = await owner(request(server).post(api('/time-entries')))
        .send({
          subtaskId: spare.body.id,
          entryTime: '2026-09-03T09:00:00.000Z',
          exitTime: '2026-09-03T10:00:00.000Z',
        })
        .expect(201);

      // First delete: this subtask and its own time, at timestamp T1.
      await owner(
        request(server)
          .delete(api(`/tasks/${tree.taskId}/subtasks/${spare.body.id}`))
          .query({ confirm: 'cascade' }),
      ).expect(200);

      // Second delete: the task and what is left under it, at T2.
      const deleted = await owner(
        request(server).delete(api(`/tasks/${tree.taskId}`)).query({
          confirm: 'cascade',
        }),
      ).expect(200);
      // task + the remaining subtask + its time entry
      expect(deleted.body.deleted).toBe(3);

      const distinctTimestamps = await dataSource.query(
        `SELECT count(DISTINCT deleted_at)::int AS n
           FROM subtasks WHERE id = ANY($1::uuid[])`,
        [[tree.subtaskId, spare.body.id]],
      );
      expect(distinctTimestamps[0].n).toBe(2);

      // Restoring the task brings back T2 and leaves T1 alone.
      await owner(
        request(server).post(api(`/tasks/${tree.taskId}/restore`)),
      ).expect(201);

      const after = await dataSource.query(
        'SELECT id, deleted_at FROM subtasks WHERE id = ANY($1::uuid[])',
        [[tree.subtaskId, spare.body.id]],
      );
      const states = new Map(
        after.map((row: { id: string; deleted_at: Date | null }) => [
          row.id,
          row.deleted_at,
        ]),
      );
      expect(states.get(tree.subtaskId)).toBeNull();
      expect(states.get(spare.body.id)).not.toBeNull();

      const times = await dataSource.query(
        'SELECT id, deleted_at FROM time_entries WHERE id = ANY($1::uuid[])',
        [[tree.timeEntryId, spareEntry.body.id]],
      );
      const timeStates = new Map(
        times.map((row: { id: string; deleted_at: Date | null }) => [
          row.id,
          row.deleted_at,
        ]),
      );
      expect(timeStates.get(tree.timeEntryId)).toBeNull();
      expect(timeStates.get(spareEntry.body.id)).not.toBeNull();

      // The one that stayed in the trash is still restorable on its own, which
      // is the point of keeping it rather than folding it into the task.
      await owner(
        request(server).post(
          api(`/tasks/${tree.taskId}/subtasks/${spare.body.id}/restore`),
        ),
      ).expect(201);

      const finalStates = await dataSource.query(
        'SELECT count(*)::int AS n FROM subtasks WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL',
        [[tree.subtaskId, spare.body.id]],
      );
      expect(finalStates[0].n).toBe(2);
    });

    it('leaves the whole tree in the trash when one restore step fails', async () => {
      // The restore writes four times -- time, subtasks, tasks, project. A
      // failure after the first one would otherwise hand back a live project
      // with no work under it, which is a broken tree rather than a
      // recoverable one. Forcing the failure is the only way to know the
      // transaction is real rather than merely intended.
      const tree = await createTree('halfway');
      await owner(
        request(server)
          .delete(api(`/projects/${tree.projectId}`))
          .query({ confirm: 'cascade' }),
      ).expect(200);

      // Fail the third of the four writes (time, subtasks, tasks, project), so
      // that the first two have already un-flagged rows inside the transaction
      // when it blows up. That is the window a non-transactional restore leaks
      // a half-restored tree through.
      const realExecute = UpdateQueryBuilder.prototype.execute;
      const boom = jest
        .spyOn(UpdateQueryBuilder.prototype, 'execute')
        .mockImplementation(async function (this: QueryBuilder<ObjectLiteral>) {
          if (/UPDATE "tasks"/.test(this.getSql())) {
            throw new Error('storage gave up midway');
          }
          return realExecute.call(this);
        });

      // A 500 is not the point; what the database looks like afterwards is.
      await owner(
        request(server).post(api(`/projects/${tree.projectId}/restore`)),
      ).expect(500);
      boom.mockRestore();

      const state = await dataSource.query(
        `SELECT
           (SELECT count(*)::int FROM projects
             WHERE id = $1 AND deleted_at IS NULL) AS live_projects,
           (SELECT count(*)::int FROM tasks
             WHERE id = $2 AND deleted_at IS NULL) AS live_tasks,
           (SELECT count(*)::int FROM subtasks
             WHERE id = $3 AND deleted_at IS NULL) AS live_subtasks,
           (SELECT count(*)::int FROM time_entries
             WHERE subtask_id = $3 AND deleted_at IS NULL) AS live_entries`,
        [tree.projectId, tree.taskId, tree.subtaskId],
      );

      expect(state[0]).toMatchObject({
        live_projects: 0,
        live_tasks: 0,
        live_subtasks: 0,
        live_entries: 0,
      });

      // And the tree is still restorable afterwards, not stranded.
      await owner(
        request(server).post(api(`/projects/${tree.projectId}/restore`)),
      ).expect(201);
    });

    it('refuses to restore something that is not deleted', async () => {
      const tree = await createTree('notdeleted');

      await owner(
        request(server).post(api(`/projects/${tree.projectId}/restore`)),
      ).expect(409);

      // A live client has nothing to restore, and saying so is more useful than
      // a 200 that quietly did nothing.
      await owner(
        request(server).post(api(`/clients/${tree.clientId}/restore`)),
      ).expect(409);
    });
  });

  describe('nested restore', () => {
    it('refuses to restore a child whose parent is still in the trash', async () => {
      const tree = await createTree('nested');

      await owner(
        request(server).delete(api(`/projects/${tree.projectId}`)).query({
          confirm: 'cascade',
        }),
      ).expect(200);

      // Restoring the task alone would produce a live task under a flagged
      // project: invisible to every read, and invisible in the project trash
      // too. The project is the unit the user deleted, so it is the unit to
      // restore, and the error says so.
      const task = await owner(
        request(server).post(api(`/tasks/${tree.taskId}/restore`)),
      ).expect(409);
      expect(task.body.message).toMatch(/project/i);

      const subtask = await owner(
        request(server).post(api(`/tasks/${tree.taskId}/subtasks/${tree.subtaskId}/restore`)),
      ).expect(409);
      expect(subtask.body.message).toMatch(/task/i);

      // Time entries are the caller's own, and the same reasoning applies.
      const entry = await owner(
        request(server).post(api(`/time-entries/${tree.timeEntryId}/restore`)),
      ).expect(409);
      expect(entry.body.message).toMatch(/subtask/i);

      // Restoring the project brings the whole tree back in one step.
      await owner(
        request(server).post(api(`/projects/${tree.projectId}/restore`)),
      ).expect(201);

      const rows = await dataSource.query(
        `SELECT count(*)::int AS n
           FROM time_entries
          WHERE id = $1 AND deleted_at IS NULL`,
        [tree.timeEntryId],
      );
      expect(rows[0].n).toBe(1);
    });
  });

  describe('leaves', () => {
    it('frees a deleted client\'s email, and refuses to restore over a taken one', async () => {
      const tree = await createTree('leaf');
      const id = tree.clientId;

      await owner(request(server).delete(api(`/clients/${id}`))).expect(200);
      await owner(request(server).get(api(`/clients/${id}`))).expect(404);

      // The partial unique index only covers live rows, so a deleted client's
      // address is reusable -- otherwise the trash would hold addresses
      // permanently, and a deleted record would be unrestorable forever.
      const recycled = await owner(request(server).post(api('/clients')))
        .send({ name: 'Recycled', email: 'client-leaf@example.com' })
        .expect(201);
      expect(recycled.body.id).not.toBe(id);

      const trash = await owner(request(server).get(api('/clients/trash'))).expect(200);
      expect(trash.body.map((row: { id: string }) => row.id)).toContain(id);

      // Restoring now would break the live row, so it is refused as a conflict
      // rather than surfacing a unique-constraint failure as a 500.
      const taken = await owner(
        request(server).post(api(`/clients/${id}/restore`)),
      ).expect(409);
      expect(taken.body.message).toMatch(/email/i);

      // Once the address is free again the restore goes through.
      await owner(
        request(server).delete(api(`/clients/${recycled.body.id}`)),
      ).expect(200);

      await owner(request(server).post(api(`/clients/${id}/restore`))).expect(201);
      await owner(request(server).get(api(`/clients/${id}`))).expect(200);
    });

    it('treats a repeated delete as a 404 rather than a second delete', async () => {
      const tree = await createTree('repeat');
      const id = tree.clientId;

      await owner(request(server).delete(api(`/clients/${id}`))).expect(200);
      await owner(request(server).delete(api(`/clients/${id}`))).expect(404);

      const rows = await dataSource.query('SELECT count(*)::int AS c FROM clients WHERE id = $1', [id]);
      expect(rows[0].c).toBe(1);
    });
  });

  describe('time entry ownership', () => {
    it('hides another user\'s entry from their trash and refuses their delete', async () => {
      // This suite has by now made enough requests to hit the global limiter;
      // clearing the bucket is the same thing `registerVerified` does, and the
      // limiter is covered on its own in api.e2e-spec.ts.
      clearThrottle();

      const tree = await createTree('ownership');
      const entry = await owner(request(server).post(api('/time-entries')))
        .send({
          subtaskId: tree.subtaskId,
          entryTime: '2026-09-02T09:00:00.000Z',
          exitTime: '2026-09-02T10:00:00.000Z',
        })
        .expect(201);

      const memberEntries = await member(
        request(server).get(api('/time-entries/trash')),
      ).expect(200);
      expect(memberEntries.body).toEqual([]);

      await member(
        request(server).delete(api(`/time-entries/${entry.body.id}`)),
      ).expect(404);

      await member(
        request(server).post(api(`/time-entries/${entry.body.id}/restore`)),
      ).expect(404);

      const stillThere = await owner(
        request(server).get(api(`/time-entries/${entry.body.id}`)),
      ).expect(200);
      expect(stillThere.body.id).toBe(entry.body.id);
    });
  });

  describe('organization deletion', () => {
    it('refuses a permanent delete until the organization name is typed', async () => {
      const boss = await registerVerified('boss@example.com', 'Boss');
      const starter = (await request(server).get(api('/plans'))).body.find(
        (plan: { name: string }) => plan.name === 'Starter',
      );

      await request(server)
        .post(api('/subscription'))
        .set('Authorization', `Bearer ${boss.token}`)
        .send({ planId: starter.id })
        .expect(200);

      const name = 'Doomed Org';
      const created = await request(server)
        .post(api('/organizations'))
        .set('Authorization', `Bearer ${boss.token}`)
        .send({ name })
        .expect(201);
      const id = created.body.id;

      const noConfirm = await request(server)
        .delete(api(`/organizations/${id}`))
        .set('Authorization', `Bearer ${boss.token}`)
        .expect(409);
      expect(noConfirm.body.message).toContain(name);

      await request(server)
        .delete(api(`/organizations/${id}`))
        .set('Authorization', `Bearer ${boss.token}`)
        .query({ confirm: 'Doomed' })
        .expect(409);

      await request(server)
        .get(api(`/organizations/${id}`))
        .set('Authorization', `Bearer ${boss.token}`)
        .expect(200);

      await request(server)
        .delete(api(`/organizations/${id}`))
        .set('Authorization', `Bearer ${boss.token}`)
        .query({ confirm: name })
        .expect(200);

      // 403 rather than 404 once it is gone: the membership that would
      // authorize the read no longer exists, and saying "not found" would imply
      // the caller had simply guessed the wrong id.
      await request(server)
        .get(api(`/organizations/${id}`))
        .set('Authorization', `Bearer ${boss.token}`)
        .expect(403);

      const gone = await dataSource.query(
        'SELECT count(*)::int AS n FROM organizations WHERE id = $1',
        [id],
      );
      expect(gone[0].n).toBe(0);
    });
  });
});
