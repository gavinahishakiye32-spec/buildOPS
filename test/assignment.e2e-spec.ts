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
 * Task and subtask assignment end to end, against a real database.
 *
 * The scenario is the one this feature exists for: an organization with several
 * people, one task with several steps, and the steps handed to different
 * members. It covers the rule that changed (a subtask assignee is a member of
 * the organization rather than a member of the task's team), the reads that make
 * the work findable again, and the isolation that keeps one organization from
 * seeing another's people.
 */
jest.setTimeout(60000);

const api = (path: string): string => `/${API_PREFIX}${path}`;

describe('Task and subtask assignment (e2e)', () => {
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let dataSource: DataSource;
  let throttleStorage: {
    storage: Map<string, unknown>;
    hitExpirations: Map<string, unknown>;
  };

  const mailTokens: { verify?: string; invitation?: string } = {};

  const ownerToken: string[] = [];
  /** One token per teammate, in the order the members are added. */
  const memberTokens: string[] = [];

  const ownerId: string[] = [];
  const memberIds: string[] = [];

  let organizationId: string;
  let projectId: string;
  let taskId: string;

  /** Ids of the three subtasks, in creation order. */
  const subtaskIds: string[] = [];

  const bearer =
    (token: string) =>
    (req: request.Test): request.Test => {
      const test = req.set('Authorization', `Bearer ${token}`);

      return organizationId
        ? test.set('x-organization-id', organizationId)
        : test;
    };

  const asOwner = (req: request.Test): request.Test =>
    bearer(ownerToken[ownerToken.length - 1])(req);

  /** A teammate, by index into {@link memberTokens}. */
  const asMember = (index: number) => (req: request.Test): request.Test =>
    bearer(memberTokens[index])(req);

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

    const user = await dataSource.getRepository(User).findOne({
      where: { email },
    });

    return { id: user!.id, token: login.body.access_token as string };
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
        sendInvitationEmail: async (_email: string, token: string) => {
          mailTokens.invitation = token;
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
  });

  afterAll(async () => {
    await app.close();
  });

  it('sets up an organization, a project and three members', async () => {
    const owner = await registerVerified('owner@example.com', 'Olive Owner');
    ownerId.push(owner.id);
    ownerToken.push(owner.token);

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

    // Three teammates, invited and accepted so each holds a real membership.
    // The `developer` template is used deliberately: it carries
    // `subtask.assign` but not `member.view`, which is exactly the role that
    // could not fill in an assignee before this feature.
    const names = [
      ['Ada Login', 'ada@example.com'],
      ['Rex Register', 'rex@example.com'],
      ['Uma Reset', 'uma@example.com'],
    ];

    for (const [name, email] of names) {
      clearThrottle();
      await asOwner(
        request(server).post(api(`/organizations/${organizationId}/invitations`)),
      )
        .send({ email, templateKey: 'developer' })
        .expect(201);

      // The invitee has no account, so accepting is what creates it -- with the
      // password they choose and a session that lets them straight in.
      clearThrottle();
      const accepted = await request(server)
        .post(api('/invitations/accept'))
        .send({ token: mailTokens.invitation, password: 'password123', name })
        .expect(201);

      expect(accepted.body.organizationId).toBe(organizationId);
      expect(accepted.body.roleName).toBe('Developer');

      const user = await dataSource.getRepository(User).findOne({
        where: { email },
      });
      memberIds.push(user!.id);
      memberTokens.push(accepted.body.access_token as string);
    }

    expect(memberTokens).toHaveLength(3);
  });

  it('creates a task, which carries no assignee of its own', async () => {
    const created = await asOwner(request(server).post(api('/tasks')))
      .send({ projectId, title: 'Authentication', priority: 'high' })
      .expect(201);
    taskId = created.body.id;

    // A task is the piece of work; the people doing it are named on the steps
    // under it. There is deliberately no owner here, and the response has to
    // not pretend otherwise.
    expect(created.body).not.toHaveProperty('assigneeId');
    expect(created.body).not.toHaveProperty('assignee');
    // A task that has just been created has no subtasks yet, and the response
    // has to say so rather than leave the fields off.
    expect(created.body.subtaskTotal).toBe(0);
    expect(created.body.subtaskDone).toBe(0);
    expect(created.body.assignees).toEqual([]);
  });

  it('assigns each subtask to a different member of the organization', async () => {
    const titles = [
      'Build the login form',
      'Build the registration form',
      'Build the password reset form',
    ];

    for (let i = 0; i < titles.length; i += 1) {
      const created = await asOwner(
        request(server).post(api(`/tasks/${taskId}/subtasks`)),
      )
        .send({ title: titles[i], assignedTo: memberIds[i] })
        .expect(201);

      subtaskIds.push(created.body.id);

      expect(created.body.assignedTo).toBe(memberIds[i]);
      // The response names the person, so a board can draw an avatar without a
      // second request per row.
      expect(created.body.assignee).toEqual({
        id: memberIds[i],
        name: ['Ada Login', 'Rex Register', 'Uma Reset'][i],
      });
    }
  });

  it('assigns a subtask to somebody outside the organization', async () => {
    const outsider = await registerVerified(
      'outsider@example.com',
      'Otto Outside',
    );

    const refused = await asOwner(
      request(server).post(api(`/tasks/${taskId}/subtasks`)),
    )
      .send({ title: 'Not ours to assign', assignedTo: outsider.id })
      // 400, not 404: the id names a real user who simply cannot be assigned
      // here, and "not found" would send the caller hunting for a typo.
      .expect(400);

    expect(refused.body.message).toContain('active member of this organization');
  });

  it('rolls subtask counts and assignees up onto the task', async () => {
    const detail = await asOwner(request(server).get(api(`/tasks/${taskId}`)))
      .expect(200);

    expect(detail.body.subtaskTotal).toBe(3);
    expect(detail.body.subtaskDone).toBe(0);
    expect(detail.body.assignees).toHaveLength(3);
    expect(detail.body.assignees.map((a: { id: string }) => a.id).sort()).toEqual(
      [...memberIds].sort(),
    );

    // The same numbers have to arrive on the list route, or a board would show
    // blanks on every card while the detail page showed counts.
    const list = await asOwner(request(server).get(api('/tasks')))
      .query({ projectId })
      .expect(200);

    const listed = list.body.items.find(
      (item: { id: string }) => item.id === taskId,
    );
    expect(listed.subtaskTotal).toBe(3);
    expect(listed.assignees).toHaveLength(3);
  });

  it('lists only the work assigned to the caller', async () => {
    const mine = await asMember(0)(request(server).get(api('/subtasks'))).expect(
      200,
    );

    expect(mine.body.total).toBe(1);
    expect(mine.body.items[0].assignedTo).toBe(memberIds[0]);

    // A subtask on its own is not actionable, so the feed carries the context
    // needed to place it: which task, in which project.
    expect(mine.body.items[0].task).toEqual(
      expect.objectContaining({ id: taskId, title: 'Authentication' }),
    );
    expect(mine.body.items[0].project).toEqual(
      expect.objectContaining({ id: projectId, name: 'Authentication rework' }),
    );

    // A second member sees their own single step, not the one above: the feed
    // is a personal queue, and the people asking it cannot see each other's.
    const theirs = await asMember(1)(request(server).get(api('/subtasks'))).expect(
      200,
    );
    expect(theirs.body.total).toBe(1);
    expect(theirs.body.items[0].assignedTo).toBe(memberIds[1]);
  });

  it('refuses to read another person\'s work, even for the Owner', async () => {
    // The Owner can assign work to anybody, which makes it the obvious way to
    // ask "what has everyone got". It is still refused: this route answers one
    // question, and its answer has one subject.
    const refused = await asOwner(
      request(server).get(api('/subtasks')).query({ assigneeId: memberIds[0] }),
    ).expect(403);

    expect(refused.body.message).toContain('your own subtasks');

    // Answered with a 403 rather than quietly with the Owner's own queue: a
    // caller who asked "what has Rex got" and got an empty list back would
    // read it as "Rex has nothing", which is a different and wrong conclusion.
    expect(refused.body.message).not.toMatch(/Rex|not found/i);
  });

  it('refuses to list the unassigned backlog', async () => {
    const refused = await asOwner(
      request(server).get(api('/subtasks')).query({ assignment: 'unassigned' }),
    ).expect(403);

    expect(refused.body.message).toContain('unassigned backlog');
  });

  it('narrows the caller\'s own queue with the status and project filters', async () => {
    await asOwner(
      request(server).post(api(`/tasks/${taskId}/subtasks`)),
    )
      .send({ title: 'Nobody has taken this yet' })
      .expect(201);

    // Unassigned work is invisible on this route, so it cannot show up in the
    // Owner's queue -- the same rule keeps it out of a member's.
    const unfiltered = await asOwner(request(server).get(api('/subtasks')))
      .expect(200);
    expect(unfiltered.body.total).toBe(0);

    const byProject = await asOwner(
      request(server).get(api('/subtasks')).query({ projectId }),
    ).expect(200);
    expect(byProject.body.total).toBe(0);

    const byStatus = await asOwner(
      request(server).get(api('/subtasks')).query({ status: 'todo' }),
    ).expect(200);
    expect(byStatus.body.total).toBe(0);

    // Once work is assigned to the Owner it appears, and the filters start to
    // narrow it.
    const created = await asOwner(
      request(server).post(api(`/tasks/${taskId}/subtasks`)),
    )
      .send({ title: 'Owned by the owner', assignedTo: ownerId[0] })
      .expect(201);
    subtaskIds.push(created.body.id);

    const nowMine = await asOwner(request(server).get(api('/subtasks'))).expect(
      200,
    );
    expect(nowMine.body.total).toBe(1);
    expect(nowMine.body.items[0].assignedTo).toBe(ownerId[0]);

    const done = await asOwner(
      request(server).patch(api(`/tasks/${taskId}/subtasks/${created.body.id}`)),
    )
      .send({ status: 'done' })
      .expect(200);

    const stillTodo = await asOwner(
      request(server).get(api('/subtasks')).query({ status: 'todo' }),
    ).expect(200);
    expect(stillTodo.body.total).toBe(0);

    const onlyDone = await asOwner(
      request(server).get(api('/subtasks')).query({ status: 'done' }),
    ).expect(200);
    expect(onlyDone.body.total).toBe(1);
    expect(done.body.status).toBe('done');
  });

  it('moves a subtask between people, and back to the backlog', async () => {
    const reassigned = await asOwner(
      request(server).patch(api(`/tasks/${taskId}/subtasks/${subtaskIds[0]}`)),
    )
      .send({ assignedTo: memberIds[1] })
      .expect(200);

    expect(reassigned.body.assignedTo).toBe(memberIds[1]);
    expect(reassigned.body.assignee.name).toBe('Rex Register');

    const unassigned = await asOwner(
      request(server).patch(api(`/tasks/${taskId}/subtasks/${subtaskIds[0]}`)),
    )
      .send({ assignedTo: null })
      .expect(200);

    expect(unassigned.body.assignedTo).toBeNull();
    expect(unassigned.body.assignee).toBeNull();
  });

  it('lets the assignee mark their own subtask done, and the task counts it', async () => {
    const done = await asMember(1)(
      request(server).patch(api(`/tasks/${taskId}/subtasks/${subtaskIds[1]}`)),
    )
      .send({ status: 'done' })
      .expect(200);

    expect(done.body.status).toBe('done');

    const detail = await asOwner(request(server).get(api(`/tasks/${taskId}`)))
      .expect(200);
    expect(detail.body.subtaskDone).toBe(2);
    expect(detail.body.subtaskTotal).toBe(5);
  });

  it('lists the people work can be assigned to, without their permissions', async () => {
    const assignees = await asOwner(
      request(server).get(api('/assignees')),
    ).expect(200);

    const ids = assignees.body.map((a: { id: string }) => a.id);
    expect(ids).toEqual(
      expect.arrayContaining([ownerId[0], ...memberIds]),
    );

    // The picker needs a name and an address and nothing about the member's
    // role: this is a much wider surface than the member directory.
    expect(Object.keys(assignees.body[0]).sort()).toEqual([
      'email',
      'id',
      'name',
    ]);
  });

  it('withholds the assignee list from a member who cannot assign', async () => {
    // A role carrying `task.view` and `subtask.view` but not `subtask.assign`.
    // This is the split the route is gated on: reading the work and handing it
    // out are different grants, and the picker needs the second.
    const created = await asOwner(
      request(server).post(api(`/organizations/${organizationId}/roles`)),
    )
      .send({ name: 'Reader', permissions: ['task.view', 'subtask.view'] })
      .expect(201);

    clearThrottle();
    await asOwner(
      request(server).post(api(`/organizations/${organizationId}/invitations`)),
    )
      .send({ email: 'reader@example.com', roleId: created.body.id })
      .expect(201);

    clearThrottle();
    const reader = await request(server)
      .post(api('/invitations/accept'))
      .send({
        token: mailTokens.invitation,
        password: 'password123',
        name: 'Robin Read',
      })
      .expect(201);

    const readerToken = reader.body.access_token as string;
    const asReader = bearer(readerToken);

    // They can read the work...
    await asReader(request(server).get(api('/subtasks'))).expect(200);
    // ...but not the list of people it could be handed to.
    await asReader(request(server).get(api('/assignees'))).expect(403);
  });

  it("does not show one organization another organization's people", async () => {
    const stranger = await registerVerified(
      'stranger@example.com',
      'Stella Stranger',
    );

    const asStranger = bearer(stranger.token);
    const plans = await asStranger(request(server).get(api('/plans'))).expect(
      200,
    );
    await asStranger(request(server).post(api('/subscription')))
      .send({ planId: plans.body[0].id })
      .expect(200);

    const strangerOrg = await asStranger(
      request(server).post(api('/organizations')),
    )
      .send({ name: 'Other Co' })
      .expect(201);

    // Their own project to hang work off, so the refusal below is about the
    // assignee and not about a missing parent.
    const strangerProject = await asStranger(
      request(server).post(api('/projects')),
    )
      .set('x-organization-id', strangerOrg.body.id)
      .send({ name: 'Theirs' })
      .expect(201);

    // Our teammate is a real user and a member of *our* organization, which is
    // not the same thing as being assignable in theirs.
    const refused = await asStranger(
      request(server).post(api('/tasks')),
    )
      .set('x-organization-id', strangerOrg.body.id)
      .send({ projectId: strangerProject.body.id, title: 'Foreign task' })
      .expect(201);

    await asStranger(
      request(server).post(api(`/tasks/${refused.body.id}/subtasks`)),
    )
      .set('x-organization-id', strangerOrg.body.id)
      .send({ title: 'Borrowed owner', assignedTo: memberIds[0] })
      .expect(400);

    // Nor do we see their people, and they do not see ours.
    const theirAssignees = await asStranger(
      request(server).get(api('/assignees')),
    )
      .set('x-organization-id', strangerOrg.body.id)
      .expect(200);

    expect(
      theirAssignees.body.map((a: { id: string }) => a.id),
    ).not.toEqual(expect.arrayContaining(memberIds));

    // And our projects are invisible from there, so the route above cannot be
    // used to attach work to another organization's project.
    await asStranger(request(server).post(api('/tasks')))
      .set('x-organization-id', strangerOrg.body.id)
      .send({ projectId, title: 'Hijack' })
      .expect(404);
  });

  it('stops offering a suspended member as an assignee', async () => {
    const before = await asOwner(request(server).get(api('/assignees'))).expect(
      200,
    );
    expect(before.body.map((a: { id: string }) => a.id)).toEqual(
      expect.arrayContaining(memberIds),
    );

    await asOwner(
      request(server).post(
        api(`/organizations/${organizationId}/members/${memberIds[2]}/deactivate`),
      ),
    ).expect(200);

    // A suspended member has lost access to the organization, so offering them
    // would produce work assigned to somebody who cannot open it.
    const after = await asOwner(request(server).get(api('/assignees'))).expect(
      200,
    );
    expect(after.body.map((a: { id: string }) => a.id)).not.toContain(
      memberIds[2],
    );

    // Assigning to them is refused, rather than accepted and then invisible.
    await asOwner(
      request(server).post(api(`/tasks/${taskId}/subtasks`)),
    )
      .send({ title: 'For the suspended one', assignedTo: memberIds[2] })
      .expect(400);

    // Work already on their name stays there: releasing a person is not a
    // reason to reassign what they were doing.
    const detail = await asOwner(
      request(server).get(api(`/tasks/${taskId}`)),
    ).expect(200);
    expect(detail.body.assignees.map((a: { id: string }) => a.id)).toContain(
      memberIds[2],
    );
    expect(detail.body.subtaskTotal).toBe(5);
  });

  it('refuses a task-level assignee, because steps are what get handed out', async () => {
    // Guarded by `forbidNonWhitelisted`, so a client that still sends the old
    // field is told rather than silently ignored -- a caller who thinks they
    // assigned somebody would otherwise believe they had.
    const refused = await asOwner(
      request(server).patch(api(`/tasks/${taskId}`)),
    )
      .send({ assigneeId: memberIds[0] })
      .expect(400);

    expect(String(refused.body.message)).toMatch(/assigneeId/i);

    // The subtasks are untouched by the attempt.
    const detail = await asOwner(request(server).get(api(`/tasks/${taskId}`)))
      .expect(200);
    expect(detail.body.subtaskTotal).toBe(5);
    expect(detail.body.subtaskDone).toBe(2);
  });
});