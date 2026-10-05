import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import { DataSource } from 'typeorm';
import { jest } from '@jest/globals';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { API_PREFIX, configureApp } from '../src/bootstrap.js';
import { MailService } from '../src/mail/mail.service.js';
import { Organization } from '../src/organization/organization.entity.js';
import { Project } from '../src/project/project.entity.js';
import { Role } from '../src/role/role.entity.js';
import { Team } from '../src/team/team.entity.js';
import { User } from '../src/user/user.entity.js';
import { resetDatabase } from './support/reset-database.js';

/**
 * End-to-end coverage of the operational flow from spec §14 against a real
 * PostgreSQL database: account → plan → tenant → organization → roles →
 * team → client → project → badge → task → subtask → time entry → time
 * complexity → dashboard, plus the isolation, permission and plan-limit rules
 * from spec §5, §15 and §17.
 */
jest.setTimeout(60000);

/**
 * Every route is served under the global prefix, so specs build their paths
 * through here rather than hardcoding `/api/v1` at each call site.
 */
const api = (path: string): string => `/${API_PREFIX}${path}`;

describe('BuildOps operational flow (e2e)', () => {
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let dataSource: DataSource;
  let throttleStorage: {
    storage: Map<string, unknown>;
    hitExpirations: Map<string, unknown>;
  };

  const mailTokens: { verify?: string; reset?: string } = {};
  const ownerToken: string[] = [];
  const memberToken: string[] = [];
  let ownerId: string;
  let memberId: string;
  let organizationId: string;
  let roleId: string;
  let teamId: string;
  let clientId: string;
  let projectId: string;
  let badgeId: string;
  let taskId: string;
  let subtaskId: string;

  // The organization header is only sent once an organization exists: tenant
  // routes (/subscription, /organizations) run before that point.
  const asOwner = (req: request.Test): request.Test => {
    const test = req.set(
      'Authorization',
      `Bearer ${ownerToken[ownerToken.length - 1]}`,
    );

    return organizationId
      ? test.set('x-organization-id', organizationId)
      : test;
  };

  const asMember = (req: request.Test): request.Test => {
    const test = req.set(
      'Authorization',
      `Bearer ${memberToken[memberToken.length - 1]}`,
    );

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
    // The auth bucket allows 10 registrations per 15 minutes; this suite needs
    // more than that, so each registration starts from a clean bucket.
    clearThrottle();

    await request(server)
      .post(api('/auth/register'))
      .send({ email, password: 'password123', name })
      .expect(201);

    const token = mailTokens.verify;
    expect(token).toBeDefined();

    await request(server)
      .get(api('/auth/verify-email'))
      .query({ token })
      .expect(200);

    const login = await request(server)
      .post(api('/auth/login'))
      .send({ email, password: 'password123' })
      .expect(201);

    const userRepo = dataSource.getRepository(User);
    const user = await userRepo.findOne({ where: { email } });
    expect(user).not.toBeNull();

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
        sendResetPasswordEmail: async (_email: string, token: string) => {
          mailTokens.reset = token;
        },
      })
      .compile();

    app = configureApp(moduleFixture.createNestApplication());
    await app.init();

    server = app.getHttpServer();
    dataSource = app.get(DataSource);
    // The throttler registers its storage under a symbol token, not the class.
    throttleStorage = app.get(ThrottlerStorage) as unknown as {
      storage: Map<string, unknown>;
      hitExpirations: Map<string, unknown>;
    };

    await resetDatabase(dataSource);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('account, subscription and organization', () => {
    it('registers, verifies and logs in a user', async () => {
      const owner = await registerVerified('owner@example.com', 'Owner');
      ownerId = owner.id;
      ownerToken.push(owner.token);

      expect(owner.token).toEqual(expect.any(String));
    });

    it('exposes the seeded plan catalogue', async () => {
      const res = await request(server).get(api('/plans')).expect(200);

      expect(res.body).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'Starter',
            maxOrganizations: 1,
          }),
          expect.objectContaining({ name: 'Growth' }),
          expect.objectContaining({ name: 'Business' }),
        ]),
      );
    });

    it('subscribes to a plan and creates the first organization', async () => {
      const plans = await request(server).get(api('/plans')).expect(200);
      const starter = plans.body.find(
        (plan: { name: string }) => plan.name === 'Starter',
      );

      const subscription = await asOwner(
        request(server).post(api('/subscription')),
      )
        .send({ planId: starter.id })
        .expect(200);

      expect(subscription.body.subscription.plan.name).toBe('Starter');
      expect(subscription.body.subscription.status).toBe('active');
      // The stub provider settles immediately, so the paid plan is in force by
      // the time the response is written. The pending branch is covered in
      // billing.e2e-spec.ts with a provider that defers.
      expect(subscription.body.purchase).toEqual({
        status: 'settled',
        checkoutUrl: null,
      });
      expect(subscription.body.usage).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ resource: 'organizations', limit: 1 }),
        ]),
      );

      const created = await asOwner(request(server).post(api('/organizations')))
        .send({ name: 'Acme Delivery' })
        .expect(201);

      organizationId = created.body.id;
      expect(created.body.name).toBe('Acme Delivery');

      // The creator is an Owner with the full template permission set.
      const roleRepo = dataSource.getRepository(Role);
      const ownerRole = await roleRepo.findOne({
        where: { organizationId, userId: ownerId },
      });
      expect(ownerRole).not.toBeNull();

      const permissions = await asOwner(
        request(server).get(
          api(`/organizations/${organizationId}/roles/${ownerRole!.id}`),
        ),
      ).expect(200);
      expect(permissions.body.permissions.length).toBeGreaterThan(20);
    });

    it('enforces max_organizations from the plan', async () => {
      // Starter allows exactly one organization: the limit is a plan refusal.
      const refused = await asOwner(request(server).post(api('/organizations')))
        .send({ name: 'Second Workspace' })
        .expect(400);
      expect(refused.body.message).toContain('Plan limit reached');

      const organizationRepo = dataSource.getRepository(Organization);
      expect(
        await organizationRepo.countBy({ tenant: { userId: ownerId } }),
      ).toBe(1);
    });

    it('keeps organizations of the same tenant isolated', async () => {
      const growth = await request(server).get(api('/plans')).expect(200);
      const growthPlan = growth.body.find(
        (plan: { name: string }) => plan.name === 'Growth',
      );

      await asOwner(request(server).patch(api('/subscription/plan')))
        .send({ planId: growthPlan.id })
        .expect(200);

      const other = await asOwner(request(server).post(api('/organizations')))
        .send({ name: 'Second Workspace' })
        .expect(201);

      const otherId = other.body.id as string;

      // Role routes are addressed through the organization in the path.
      // The tenant creator is bootstrapped as Owner of every organization
      // they create, and the new workspace starts empty of operational data.
      const roles = await asOwner(
        request(server).get(api(`/organizations/${otherId}/roles`)),
      ).expect(200);
      expect(roles.body).toHaveLength(1);
      expect(roles.body[0]).toEqual(
        expect.objectContaining({ name: 'Owner', userId: ownerId }),
      );

      const otherTasks = await asOwner(
        request(server).get(api('/tasks')).set('x-organization-id', otherId),
      ).expect(200);
      expect(otherTasks.body.items).toEqual([]);

      await asOwner(
        request(server).patch(api(`/organizations/${organizationId}`)),
      )
        .send({ status: 'inactive' })
        .expect(200);

      const stillThere = await asOwner(
        request(server).get(api(`/organizations/${otherId}`)),
      ).expect(200);
      expect(stillThere.body.id).toBe(otherId);

      // Organization deletion is permanent -- it takes the soft-deleted rows
      // with it -- so it requires the name to be typed. See soft-delete.e2e.
      await asOwner(
        request(server).delete(api(`/organizations/${otherId}`)),
      )
        .query({ confirm: 'Second Workspace' })
        .expect(200);
    });
  });

  describe('authorization', () => {
    it('invites a member, assigns a role and enforces permissions', async () => {
      const member = await registerVerified('member@example.com', 'Member');
      memberId = member.id;
      memberToken.push(member.token);

      // A custom role with no permissions yet, then assign it to the member.
      const createdRole = await asOwner(
        request(server).post(api(`/organizations/${organizationId}/roles`)),
      )
        .send({ name: 'Contributor', permissions: [] })
        .expect(201);
      roleId = createdRole.body.id as string;

      await asOwner(
        request(server).post(
          api(`/organizations/${organizationId}/roles/${roleId}/assign`),
        ),
      )
        .send({ userId: memberId })
        .expect(201);

      // Member has no permissions yet, so client creation is forbidden.
      await asMember(request(server).post(api('/clients')))
        .send({ name: 'Forbidden Client' })
        .expect(403);

      await asOwner(
        request(server).put(
          api(`/organizations/${organizationId}/roles/${roleId}/permissions`),
        ),
      )
        .send({ permissions: ['client.view', 'client.create', 'task.view'] })
        .expect(200);

      const allowed = await asMember(request(server).post(api('/clients')))
        .send({ name: 'Allowed Client' })
        .expect(201);
      expect(allowed.body.name).toBe('Allowed Client');

      await asOwner(
        request(server).delete(api(`/clients/${allowed.body.id}`)),
      ).expect(200);

      // Back to a read-only role for the remaining assertions.
      await asOwner(
        request(server).put(
          api(`/organizations/${organizationId}/roles/${roleId}/permissions`),
        ),
      )
        .send({ permissions: ['client.view', 'task.view'] })
        .expect(200);

      await asMember(request(server).post(api('/clients')))
        .send({ name: 'Forbidden Again' })
        .expect(403);
    });

    it('rejects requests without a token, with a bad token and without organization context', async () => {
      await request(server).get(api('/clients')).expect(401);

      await request(server)
        .get(api('/clients'))
        .set('Authorization', 'Bearer not-a-jwt')
        .expect(401);

      // Valid token but no organization context at all.
      await request(server)
        .get(api('/clients'))
        .set('Authorization', `Bearer ${ownerToken[0]}`)
        .expect(404);
    });

    it('refuses organization context the caller is not a member of', async () => {
      const outsider = await registerVerified(
        'outsider@example.com',
        'Outsider',
      );

      await request(server)
        .get(api('/clients'))
        .set('Authorization', `Bearer ${outsider.token}`)
        .set('x-organization-id', organizationId)
        .expect(403);
    });

    it('answers 400 for a non-UUID organization context instead of 500', async () => {
      // Guards run before pipes, so `ParseUUIDPipe` never sees this value.
      // Without the guard's own check the membership query reaches PostgreSQL
      // and `invalid input syntax for type uuid` surfaces as a 500.
      const malformed = await asOwner(
        request(server).get(api('/organizations/not-a-uuid')),
      ).expect(400);

      expect(malformed.body).toEqual({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Validation failed (uuid is expected)',
      });

      // The same value in the header, and the same value on a collection route.
      await asOwner(request(server).get(api('/clients')))
        .set('x-organization-id', 'not-a-uuid')
        .expect(400);

      await asOwner(request(server).get(api('/organizations')))
        .set('x-organization-id', 'not-a-uuid')
        .expect(200); // @SkipOrganization(): the header is ignored there.

      // A well-formed UUID that simply does not exist is still a 403/404, not 400.
      await asOwner(request(server).get(api('/clients'))).set(
        'x-organization-id',
        '00000000-0000-4000-8000-000000000000',
      );
    });
  });

  describe('plan limits', () => {
    const planNamed = async (name: string) => {
      const plans = await request(server).get(api('/plans')).expect(200);
      return plans.body.find((plan: { name: string }) => plan.name === name);
    };

    const authorize = (token: string) => (req: request.Test): request.Test =>
      req.set('Authorization', `Bearer ${token}`);

    const startTenant = async (
      email: string,
      planName: string,
    ): Promise<{ auth: (req: request.Test) => request.Test }> => {
      const plan = await planNamed(planName);
      const owner = await registerVerified(email, email);
      const auth = authorize(owner.token);

      await auth(request(server).post(api('/subscription')))
        .send({ planId: plan.id })
        .expect(200);

      return { auth };
    };

    it('refuses to subscribe straight into a non-usable status', async () => {
      const starter = await planNamed('Starter');
      const user = await registerVerified('status@example.com', 'Status');

      await authorize(user.token)(request(server).post(api('/subscription')))
        .send({ planId: starter.id, status: 'cancelled' })
        .expect(400);
    });

    it('serialises concurrent organization creation and enforces max_users', async () => {
      const { auth } = await startTenant('limits-owner@example.com', 'Starter');

      // Starter allows exactly one organization: two requests racing the same
      // limit must resolve to one success and one plan refusal.
      const [first, second] = await Promise.all([
        auth(request(server).post(api('/organizations'))).send({
          name: 'Race A',
        }),
        auth(request(server).post(api('/organizations'))).send({
          name: 'Race B',
        }),
      ]);
      expect([first.status, second.status].sort()).toEqual([201, 400]);
      const organizationId = [first, second].find(
        (response) => response.status === 201,
      )!.body.id as string;

      // Starter allows five users: the owner holds one seat, four invites fill it.
      for (let i = 0; i < 4; i += 1) {
        const invitee = await registerVerified(
          `limits-${i}@example.com`,
          `Limits ${i}`,
        );
        await auth(
          request(server).post(
            api(`/organizations/${organizationId}/members`),
          ),
        )
          .send({ userId: invitee.id })
          .expect(201);
      }

      const usage = await auth(
        request(server).get(api('/subscription/usage')),
      ).expect(200);
      const seats = usage.body.find(
        (row: { resource: string }) => row.resource === 'users',
      );
      expect(seats).toMatchObject({ used: 5, limit: 5, remaining: 0 });

      const overflow = await registerVerified(
        'limits-overflow@example.com',
        'Overflow',
      );
      const refused = await auth(
        request(server).post(api(`/organizations/${organizationId}/members`)),
      )
        .send({ userId: overflow.id })
        .expect(400);
      expect(refused.body.message).toContain('Plan limit reached');
    });

    it('refuses a downgrade that exceeds the target plan limits', async () => {
      const growth = await planNamed('Growth');
      const starter = await planNamed('Starter');
      const owner = await registerVerified('downgrade@example.com', 'Downgrade');
      const auth = authorize(owner.token);

      await auth(request(server).post(api('/subscription')))
        .send({ planId: growth.id })
        .expect(200);
      await auth(request(server).post(api('/organizations')))
        .send({ name: 'Downgrade A' })
        .expect(201);
      const second = await auth(request(server).post(api('/organizations')))
        .send({ name: 'Downgrade B' })
        .expect(201);

      // Two organizations fit Growth but not Starter, whose max is one.
      const refused = await auth(
        request(server).patch(api('/subscription/plan')),
      )
        .send({ planId: starter.id })
        .expect(400);
      expect(refused.body.message).toContain('Cannot switch to the Starter');

      await auth(
        request(server).delete(api(`/organizations/${second.body.id}`)),
      )
        .query({ confirm: 'Downgrade B' })
        .expect(200);
      const accepted = await auth(
        request(server).patch(api('/subscription/plan')),
      )
        .send({ planId: starter.id })
        .expect(200);
      expect(accepted.body.subscription.plan.name).toBe('Starter');
    });
  });

  describe('operational resources', () => {
    it('creates a team and adds the member to it', async () => {
      const team = await asOwner(request(server).post(api('/teams')))
        .send({ name: 'Platform' })
        .expect(201);
      teamId = team.body.id;

      await asOwner(request(server).post(api(`/teams/${teamId}/members`)))
        .send({ userId: memberId, role: 'member' })
        .expect(201);

      const members = await asOwner(
        request(server).get(api(`/teams/${teamId}/members`)),
      ).expect(200);
      expect(members.body).toHaveLength(1);
      expect(members.body[0].status).toBe('active');
    });

    it('creates a client, a project and a badge', async () => {
      const client = await asOwner(request(server).post(api('/clients')))
        .send({
          name: 'Globex',
          email: 'contact@globex.test',
          industry: 'Manufacturing',
        })
        .expect(201);
      clientId = client.body.id;
      expect(client.body.email).toBe('contact@globex.test');

      const project = await asOwner(request(server).post(api('/projects')))
        .send({
          name: 'Factory rollout',
          clientId,
          status: 'active',
          budget: 15000,
        })
        .expect(201);
      projectId = project.body.id;
      expect(project.body.clientId).toBe(clientId);

      const badge = await asOwner(request(server).post(api('/badges')))
        .send({
          name: 'Urgent',
          color: '#ef4444',
          description: 'Needs attention',
        })
        .expect(201);
      badgeId = badge.body.id;
    });

    it('rejects a project pointing at a client of another organization', async () => {
      const other = await registerVerified('other@example.com', 'Other');

      const otherAuth = `Bearer ${other.token}`;
      const business = (await request(server).get(api('/plans'))).body.find(
        (plan: { name: string }) => plan.name === 'Business',
      );

      await request(server)
        .post(api('/subscription'))
        .set('Authorization', otherAuth)
        .send({ planId: business.id })
        .expect(200);

      const otherOrganization = await request(server)
        .post(api('/organizations'))
        .set('Authorization', otherAuth)
        .send({ name: 'Other Org' })
        .expect(201);

      // The client belongs to another organization: the reference is refused.
      await request(server)
        .post(api('/projects'))
        .set('Authorization', otherAuth)
        .set('x-organization-id', otherOrganization.body.id)
        .send({ name: 'Cross tenant', clientId })
        .expect(404);

      // And nothing from this organization is readable from the other one.
      const foreignTasks = await request(server)
        .get(api('/tasks'))
        .set('Authorization', otherAuth)
        .set('x-organization-id', otherOrganization.body.id)
        .expect(200);
      expect(foreignTasks.body.items).toEqual([]);

      await request(server)
        .get(api(`/projects/${projectId}`))
        .set('Authorization', otherAuth)
        .set('x-organization-id', otherOrganization.body.id)
        .expect(404);
    });

    it('creates a task with team and badge, then a subtask for a team member', async () => {
      const task = await asOwner(request(server).post(api('/tasks')))
        .send({
          projectId,
          teamId,
          badgeId,
          title: 'Line balancing',
          priority: 'high',
          dueDate: '2026-12-01',
        })
        .expect(201);
      taskId = task.body.id;
      expect(task.body.status).toBe('todo');
      expect(task.body.teamId).toBe(teamId);
      expect(task.body.badgeId).toBe(badgeId);

      const subtask = await asOwner(
        request(server).post(api(`/tasks/${taskId}/subtasks`)),
      )
        .send({
          assignedTo: memberId,
          title: 'Measure cycle time',
          dueDate: '2026-11-20',
        })
        .expect(201);
      subtaskId = subtask.body.id;
      expect(subtask.body.assignedTo).toBe(memberId);
      expect(subtask.body.status).toBe('todo');
    });

    it('refuses to assign a subtask to a non-member of the task team', async () => {
      const outsider = await registerVerified('helper@example.com', 'Helper');

      await asOwner(request(server).post(api(`/tasks/${taskId}/subtasks`)))
        .send({ assignedTo: outsider.id, title: 'Not my team' })
        .expect(400);

      await asOwner(request(server).post(api(`/tasks/${taskId}/subtasks`)))
        .send({ title: 'Unassigned work' })
        .expect(201);
    });

    it('logs a manual time entry and rejects inconsistent timestamps', async () => {
      const entry = await asOwner(request(server).post(api('/time-entries')))
        .send({
          subtaskId,
          entryTime: '2026-09-01T09:00:00.000Z',
          exitTime: '2026-09-01T11:30:00.000Z',
        })
        .expect(201);

      expect(entry.body.durationSeconds).toBe(9000);
      expect(entry.body.isRunning).toBe(false);

      await asOwner(request(server).post(api('/time-entries')))
        .send({
          subtaskId,
          entryTime: '2026-09-01T12:00:00.000Z',
          exitTime: '2026-09-01T11:00:00.000Z',
        })
        .expect(400);
    });

    it('runs the timer lifecycle and refuses a second concurrent timer', async () => {
      const started = await asOwner(
        request(server).post(api('/time-entries/timer/start')),
      )
        .send({ subtaskId })
        .expect(201);

      expect(started.body.entry.isRunning).toBe(true);
      expect(started.body.entry.exitTime).toBeNull();

      const active = await asOwner(
        request(server).get(api('/time-entries/timer/active')),
      ).expect(200);
      expect(active.body.entry.id).toBe(started.body.entry.id);

      await asOwner(request(server).post(api('/time-entries/timer/start')))
        .send({ subtaskId })
        .expect(409);

      const stopped = await asOwner(
        request(server).post(api('/time-entries/timer/stop')),
      )
        .send({})
        .expect(200);

      expect(stopped.body.entry.isRunning).toBe(false);
      expect(stopped.body.entry.exitTime).not.toBeNull();

      const after = await asOwner(
        request(server).get(api('/time-entries/timer/active')),
      ).expect(200);
      expect(after.body.entry).toBeNull();
    });

    it('defines a time complexity envelope and reports variance', async () => {
      await asOwner(request(server).post(api('/time-complexity')))
        .send({
          taskId,
          subtaskId,
          name: 'medium',
          minDuration: 7200,
          maxDuration: 14400,
        })
        .expect(201);

      await asOwner(request(server).post(api('/time-complexity')))
        .send({
          taskId,
          name: 'low',
          minDuration: 14400,
          maxDuration: 3600,
        })
        .expect(400);

      await asOwner(request(server).post(api('/time-complexity')))
        .send({
          taskId,
          subtaskId,
          name: 'high',
          minDuration: 60,
          maxDuration: 120,
        })
        .expect(409);

      const variance = await asOwner(
        request(server).get(api(`/time-complexity/variance/${taskId}`)),
      ).expect(200);

      expect(variance.body).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            subtaskId,
            minSeconds: 7200,
            maxSeconds: 14400,
            variance: 'within',
          }),
        ]),
      );
    });

    it('reports the dashboard aggregates', async () => {
      const overview = await asOwner(
        request(server).get(api('/dashboard/overview')),
      )
        .query({ from: '2026-08-01', to: '2026-12-31' })
        .expect(200);

      expect(overview.body.projects).toBe(1);
      expect(overview.body.tasks).toBe(1);
      expect(overview.body.subtasks).toBeGreaterThanOrEqual(2);
      expect(overview.body.timeEntries).toBeGreaterThanOrEqual(2);
      // 2h30m of manual time plus the timer that was just stopped.
      expect(overview.body.totalSeconds).toBeGreaterThanOrEqual(9000);
      expect(overview.body.timeByGroup.length).toBeGreaterThan(0);
      expect(overview.body.variance.compared).toBeGreaterThan(0);

      const projects = await asOwner(
        request(server).get(api('/dashboard/projects')),
      ).expect(200);
      expect(projects.body.items[0]).toEqual(
        expect.objectContaining({
          projectId,
          tasks: 1,
        }),
      );

      const clients = await asOwner(
        request(server).get(api('/dashboard/clients')),
      ).expect(200);
      expect(clients.body.items[0]).toEqual(
        expect.objectContaining({ clientId, projects: 1 }),
      );
    });

    it('paginates list endpoints with metadata', async () => {
      const page = await asOwner(request(server).get(api('/tasks')))
        .query({ page: 1, limit: 1 })
        .expect(200);

      expect(page.body).toEqual(
        expect.objectContaining({ page: 1, limit: 1, total: 1 }),
      );
      expect(page.body.items).toHaveLength(1);

      const filtered = await asOwner(request(server).get(api('/tasks')))
        .query({ status: 'todo' })
        .expect(200);
      expect(filtered.body.total).toBe(1);

      const empty = await asOwner(request(server).get(api('/tasks')))
        .query({ status: 'done' })
        .expect(200);
      expect(empty.body.items).toHaveLength(0);
    });

    it('validates payloads with the global validation pipe', async () => {
      await asOwner(request(server).post(api('/clients')))
        .send({})
        .expect(400);

      await asOwner(request(server).post(api('/clients')))
        .send({ name: 'Bad', unknownField: true })
        .expect(400);

      await asOwner(request(server).post(api('/clients')))
        .send({ name: 'Bad', email: 'not-an-email' })
        .expect(400);
    });
  });

  describe('repository consistency', () => {
    it('stored every resource in PostgreSQL', async () => {
      const projectRepo = dataSource.getRepository(Project);
      const teamRepo = dataSource.getRepository(Team);

      expect(await projectRepo.countBy({ organizationId, clientId })).toBe(1);
      expect(await teamRepo.countBy({ organizationId })).toBe(1);
      expect(await projectRepo.countBy({ organizationId })).toBe(1);
    });
  });
});
