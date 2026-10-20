import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import { DataSource } from 'typeorm';
import { jest } from '@jest/globals';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { io, type Socket as ChatClientSocket } from 'socket.io-client';
import { AppModule } from '../src/app.module.js';
import { API_PREFIX, configureApp } from '../src/bootstrap.js';
import { MailService } from '../src/mail/mail.service.js';
import { User } from '../src/user/user.entity.js';
import { resetDatabase } from './support/reset-database.js';

/**
 * Chat, end to end.
 *
 * The behaviour under test is the access model more than the happy path: an
 * organization-scoped room anybody with `chat.view` can read, a direct channel
 * nobody else can even confirm exists, edits and deletions that stop at the
 * sender's own messages unless they can moderate, and unread counts that move
 * only for the reader they belong to.
 */
jest.setTimeout(60000);

const api = (path: string): string => `/${API_PREFIX}${path}`;

const CHAT_PERMISSIONS = ['chat.view', 'chat.create'];
const MODERATOR_PERMISSIONS = ['chat.view', 'chat.create', 'chat.manage'];

// Well-formed ids of records that never existed, for the scope route's 404s.
const PROJECT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TASK_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const withTimeout = <T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

const nextEvent = <T = any>(
  socket: ChatClientSocket,
  event: string,
): Promise<T> =>
  new Promise((resolve) => {
    socket.once(event, (payload: T) => resolve(payload));
  });

const emitWithAck = <T = any>(
  socket: ChatClientSocket,
  event: string,
  payload: unknown,
): Promise<T> =>
  new Promise((resolve) => {
    socket.emit(event, payload, (ack: T) => resolve(ack));
  });

describe('chat (e2e)', () => {
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let dataSource: DataSource;
  let throttleStorage: {
    storage: Map<string, unknown>;
    hitExpirations: Map<string, unknown>;
  };

  const mailTokens: { verify?: string } = {};

  const ownerTokens: string[] = [];
  const adaTokens: string[] = [];
  const rexTokens: string[] = [];
  const miaTokens: string[] = [];

  const adaIds: string[] = [];
  const rexIds: string[] = [];
  const miaIds: string[] = [];

  let organizationId: string;

  const bearer =
    (token: string) =>
    (req: request.Test): request.Test => {
      const test = req.set('Authorization', `Bearer ${token}`);
      return organizationId
        ? test.set('x-organization-id', organizationId)
        : test;
    };

  const asOwner = (req: request.Test): request.Test => bearer(ownerTokens[0])(req);
  const asAda = (req: request.Test): request.Test => bearer(adaTokens[0])(req);
  const asRex = (req: request.Test): request.Test => bearer(rexTokens[0])(req);
  const asMia = (req: request.Test): request.Test => bearer(miaTokens[0])(req);

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
    // Listening for real: the gateway smoke test holds an open socket, which
    // supertest's per-request ephemeral server cannot carry. Every HTTP
    // assertion below runs against this same server.
    await app.listen(0, '127.0.0.1');

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

  it('sets up an organization with chat members', async () => {
    ownerTokens.push(await registerVerified('owner@example.com', 'Olive Owner'));

    const plans = await asOwner(request(server).get(api('/plans'))).expect(200);
    await asOwner(request(server).post(api('/subscription')))
      .send({ planId: plans.body[0].id })
      .expect(200);

    const created = await asOwner(request(server).post(api('/organizations')))
      .send({ name: 'Acme Delivery' })
      .expect(201);
    organizationId = created.body.id;

    const userRepo = dataSource.getRepository(User);

    for (const [index, [name, email, permissions]] of (
      [
        ['Ada Login', 'ada@example.com', CHAT_PERMISSIONS],
        ['Rex Register', 'rex@example.com', CHAT_PERMISSIONS],
        // Mia can moderate: the suite proves `chat.manage` is what lets her
        // delete somebody else's message, and nothing weaker does.
        ['Mia Moderator', 'mia@example.com', MODERATOR_PERMISSIONS],
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
         SELECT $1, unnest($2::text[])
         ON CONFLICT DO NOTHING`,
        [role[0].id, [...permissions]],
      );

      if (index === 0) {
        adaIds.push(user!.id);
        adaTokens.push(token);
      } else if (index === 1) {
        rexIds.push(user!.id);
        rexTokens.push(token);
      } else {
        miaIds.push(user!.id);
        miaTokens.push(token);
      }
    }
  });

  it('opens the organization channel on first list, exactly once', async () => {
    const first = await asAda(request(server).get(api('/chat/channels')))
      .expect(200);
    expect(first.body.total).toBe(1);
    expect(first.body.items[0].channel.type).toBe('organization');
    expect(first.body.items[0].channel.name).toBe('General');
    expect(first.body.items[0].unreadCount).toBe(0);

    // A second member listing must not create a second room; the partial
    // unique index is what makes this true under a race, and listing twice is
    // how the race is exercised without threads.
    const second = await asRex(request(server).get(api('/chat/channels')))
      .expect(200);
    expect(second.body.total).toBe(1);
    expect(second.body.items[0].channel.id).toBe(
      first.body.items[0].channel.id,
    );
  });

  it('sends a message and counts it unread for everyone else', async () => {
    const channels = await asAda(request(server).get(api('/chat/channels')))
      .expect(200);
    const channelId = channels.body.items[0].channel.id;

    const sent = await asAda(
      request(server).post(api(`/chat/channels/${channelId}/messages`)),
    )
      .send({ body: 'Standup notes are in the doc.' })
      .expect(201);
    expect(sent.body.body).toBe('Standup notes are in the doc.');
    expect(sent.body.sender).toEqual({ id: adaIds[0], name: 'Ada Login' });

    // Sending is reading: the sender's own badge does not count their message.
    const forAda = await asAda(request(server).get(api('/chat/channels')))
      .expect(200);
    expect(forAda.body.items[0].unreadCount).toBe(0);
    expect(forAda.body.items[0].channel.lastMessageAt).not.toBeNull();
    expect(forAda.body.items[0].lastMessage.body).toBe(
      'Standup notes are in the doc.',
    );
    expect(new Date(forAda.body.items[0].channel.lastMessageAt).getTime()).toBe(
      new Date(forAda.body.items[0].lastMessage.createdAt).getTime(),
    );

    const forRex = await asRex(request(server).get(api('/chat/channels')))
      .expect(200);
    expect(forRex.body.items[0].unreadCount).toBe(1);
  });

  it('marks a channel read without touching anybody else\'s badge', async () => {
    const channels = await asRex(request(server).get(api('/chat/channels')))
      .expect(200);
    const channelId = channels.body.items[0].channel.id;

    await asRex(request(server).post(api(`/chat/channels/${channelId}/read`)))
      .expect(200);

    const forRex = await asRex(request(server).get(api('/chat/channels')))
      .expect(200);
    expect(forRex.body.items[0].unreadCount).toBe(0);

    const forMia = await asMia(request(server).get(api('/chat/channels')))
      .expect(200);
    expect(forMia.body.items[0].unreadCount).toBe(1);
  });

  it('edits the sender\'s own message and refuses anybody else', async () => {
    const channels = await asAda(request(server).get(api('/chat/channels')))
      .expect(200);
    const channelId = channels.body.items[0].channel.id;
    const messages = await asAda(
      request(server).get(api(`/chat/channels/${channelId}/messages`)),
    ).expect(200);
    const messageId = messages.body.items[0].id;

    const edited = await asAda(
      request(server).patch(api(`/chat/messages/${messageId}`)),
    )
      .send({ body: 'Standup notes are in the shared doc.' })
      .expect(200);
    expect(edited.body.body).toBe('Standup notes are in the shared doc.');
    expect(edited.body.editedAt).not.toBeNull();

    // Someone else's message is not editable, permissions or not: `chat.manage`
    // is a moderation right, not a ghost-writing one.
    await asMia(request(server).patch(api(`/chat/messages/${messageId}`)))
      .send({ body: 'rewritten by the moderator' })
      .expect(403);

    const still = await asAda(
      request(server).get(api(`/chat/channels/${channelId}/messages`)),
    ).expect(200);
    expect(still.body.items[0].body).toBe('Standup notes are in the shared doc.');
  });

  it('deletes own messages, and any message with chat.manage', async () => {
    const channels = await asAda(request(server).get(api('/chat/channels')))
      .expect(200);
    const channelId = channels.body.items[0].channel.id;

    const mine = await asAda(
      request(server).post(api(`/chat/channels/${channelId}/messages`)),
    )
      .send({ body: 'Wrong channel, sorry.' })
      .expect(201);

    const theirs = await asRex(
      request(server).post(api(`/chat/channels/${channelId}/messages`)),
    )
      .send({ body: 'Rex said this.' })
      .expect(201);

    // A bystander without chat.manage cannot delete either.
    await asRex(
      request(server).delete(api(`/chat/messages/${mine.body.id}`)),
    ).expect(403);
    await asAda(
      request(server).delete(api(`/chat/messages/${theirs.body.id}`)),
    ).expect(403);

    // The sender deletes their own; the moderator deletes Rex's.
    await asAda(request(server).delete(api(`/chat/messages/${mine.body.id}`)))
      .expect(200);
    await asMia(request(server).delete(api(`/chat/messages/${theirs.body.id}`)))
      .expect(200);

    const after = await asAda(
      request(server).get(api(`/chat/channels/${channelId}/messages`)),
    ).expect(200);
    const bodies = after.body.items.map((item: { body: string }) => item.body);
    expect(bodies).not.toContain('Wrong channel, sorry.');
    expect(bodies).not.toContain('Rex said this.');
    expect(bodies).toContain('Standup notes are in the shared doc.');

    // Soft-deleted, not destroyed: the tombstone keeps the audit trail.
    const stored = await dataSource.query(
      'SELECT deleted_by FROM chat_messages WHERE id = $1',
      [theirs.body.id],
    );
    expect(stored[0].deleted_by).toBe(miaIds[0]);
  });

  it('opens a direct channel once, invisible to outsiders', async () => {
    const created = await asAda(request(server).post(api('/chat/channels')))
      .send({ participantIds: [adaIds[0], rexIds[0]] })
      .expect(201);
    expect(created.body.type).toBe('direct');
    expect(created.body.organizationId).toBe(organizationId);

    // The same set returns the same room; a third wheel is not silently added.
    const again = await asRex(request(server).post(api('/chat/channels')))
      .send({ participantIds: [rexIds[0], adaIds[0]] })
      .expect(201);
    expect(again.body.id).toBe(created.body.id);

    // Mia is not in it, and the room answers her the way a missing one would:
    // 404, never a 403 that would confirm the id is real.
    await asMia(request(server).get(api(`/chat/channels/${created.body.id}`)))
      .expect(404);
    await asMia(
      request(server).post(
        api(`/chat/channels/${created.body.id}/messages`),
      ),
    )
      .send({ body: 'let me in' })
      .expect(404);

    // It does not show up in her channel list either.
    const miaChannels = await asMia(request(server).get(api('/chat/channels')))
      .expect(200);
    const ids = miaChannels.body.items.map(
      (item: { channel: { id: string } }) => item.channel.id,
    );
    expect(ids).not.toContain(created.body.id);

    // The channel detail carries who is in it, so a client can render the
    // conversation header without a second endpoint.
    const detail = await asAda(
      request(server).get(api(`/chat/channels/${created.body.id}`)),
    ).expect(200);
    expect(detail.body.type).toBe('direct');
    expect(detail.body.participants).toEqual(
      expect.arrayContaining([
        { id: adaIds[0], name: 'Ada Login' },
        { id: rexIds[0], name: 'Rex Register' },
      ]),
    );
    expect(detail.body.participants).toHaveLength(2);

    // A scoped room is everybody's room, so it has no member list to show.
    const orgChannels = await asAda(request(server).get(api('/chat/channels')))
      .expect(200);
    const orgRoom = orgChannels.body.items.find(
      (item: { channel: { type: string } }) => item.channel.type === 'organization',
    );
    const orgDetail = await asAda(
      request(server).get(api(`/chat/channels/${orgRoom.channel.id}`)),
    ).expect(200);
    expect(orgDetail.body.participants).toBeNull();
  });

  it('refuses a direct channel that is not the caller\'s own member set', async () => {
    await asAda(request(server).post(api('/chat/channels')))
      .send({ participantIds: [rexIds[0], miaIds[0]] })
      .expect(400);

    // A non-member id is refused rather than quietly dropped from the set:
    // a room that silently excludes people is worse than one that fails.
    await asAda(request(server).post(api('/chat/channels')))
      .send({ participantIds: [adaIds[0], rexIds[0], miaIds[0], 'ffffffff-ffff-4fff-8fff-ffffffffffff'] })
      .expect(400);
  });

  it('carries the conversation in the direct channel', async () => {
    const opened = await asAda(request(server).post(api('/chat/channels')))
      .send({ participantIds: [adaIds[0], rexIds[0]] })
      .expect(201);
    const channelId = opened.body.id;

    await asAda(
      request(server).post(api(`/chat/channels/${channelId}/messages`)),
    )
      .send({ body: 'Pair on the migration?' })
      .expect(201);

    const forRex = await asRex(
      request(server).get(api(`/chat/channels/${channelId}/messages`)),
    ).expect(200);
    expect(forRex.body.total).toBe(1);
    expect(forRex.body.items[0].body).toBe('Pair on the migration?');
  });

  it('refuses messages a member without chat.create cannot send', async () => {
    // Viewer-style member: chat.view only. Seeded directly so the suite does
    // not depend on invitation plumbing it is not testing.
    clearThrottle();
    await request(server)
      .post(api('/auth/register'))
      .send({ email: 'vic@example.com', password: 'password123', name: 'Vic Viewer' })
      .expect(201);
    await request(server)
      .get(api('/auth/verify-email'))
      .query({ token: mailTokens.verify })
      .expect(200);
    const login = await request(server)
      .post(api('/auth/login'))
      .send({ email: 'vic@example.com', password: 'password123' })
      .expect(201);
    const vicToken = login.body.access_token as string;

    const user = await dataSource
      .getRepository(User)
      .findOne({ where: { email: 'vic@example.com' } });
    await dataSource.query(
      `INSERT INTO roles (organization_id, user_id, name, status)
       VALUES ($1, $2, 'Viewer', 'active')`,
      [organizationId, user!.id],
    );
    const role = await dataSource.query(
      `SELECT id FROM roles WHERE organization_id = $1 AND user_id = $2`,
      [organizationId, user!.id],
    );
    await dataSource.query(
      `INSERT INTO permissions (role_id, name) VALUES ($1, 'chat.view')`,
      [role[0].id],
    );

    const asVic = bearer(vicToken);

    const channels = await asVic(request(server).get(api('/chat/channels')))
      .expect(200);
    const channelId = channels.body.items[0].channel.id;

    await asVic(
      request(server).post(api(`/chat/channels/${channelId}/messages`)),
    )
      .send({ body: 'can I speak?' })
      .expect(403);

    // Reading is fine; writing is not. The asymmetry is the whole point of
    // splitting the two permissions.
    await asVic(
      request(server).get(api(`/chat/channels/${channelId}/messages`)),
    ).expect(200);
  });

  it('opens the room of a project, task or subtask on demand', async () => {
    const project = await asOwner(request(server).post(api('/projects')))
      .send({ name: 'Billing flow' })
      .expect(201);
    const task = await asOwner(request(server).post(api('/tasks')))
      .send({
        projectId: project.body.id,
        title: 'Invoice emails',
        priority: 'medium',
      })
      .expect(201);
    const subtask = await asOwner(
      request(server).post(api(`/tasks/${task.body.id}/subtasks`)),
    )
      .send({ title: 'Template the invoice' })
      .expect(201);

    const room = await asAda(
      request(server)
        .get(api('/chat/channels/scope'))
        .query({ type: 'project', projectId: project.body.id }),
    ).expect(200);
    expect(room.body.channel.type).toBe('project');
    expect(room.body.channel.projectId).toBe(project.body.id);

    // Asking again returns the same room rather than a second one: the scope,
    // not the request, decides how many rooms there are.
    const again = await asRex(
      request(server)
        .get(api('/chat/channels/scope'))
        .query({ type: 'project', projectId: project.body.id }),
    ).expect(200);
    expect(again.body.channel.id).toBe(room.body.channel.id);

    const taskRoom = await asAda(
      request(server)
        .get(api('/chat/channels/scope'))
        .query({ type: 'task', taskId: task.body.id }),
    ).expect(200);
    expect(taskRoom.body.channel.type).toBe('task');
    expect(taskRoom.body.channel.taskId).toBe(task.body.id);

    const subtaskRoom = await asAda(
      request(server)
        .get(api('/chat/channels/scope'))
        .query({ type: 'subtask', subtaskId: subtask.body.id }),
    ).expect(200);
    expect(subtaskRoom.body.channel.type).toBe('subtask');
    expect(subtaskRoom.body.channel.subtaskId).toBe(subtask.body.id);

    // The organization room resolves too, and it is the very room the channel
    // list has been opening since the first test in this suite.
    const orgRoom = await asAda(
      request(server).get(api('/chat/channels/scope')).query({ type: 'organization' }),
    ).expect(200);
    expect(orgRoom.body.channel.type).toBe('organization');
    expect(orgRoom.body.channel.name).toBe('General');

    // The new room is a room like any other: it shows in the list and carries
    // a conversation.
    const channels = await asAda(request(server).get(api('/chat/channels')))
      .expect(200);
    const ids = channels.body.items.map(
      (item: { channel: { id: string } }) => item.channel.id,
    );
    expect(ids).toContain(room.body.channel.id);
    expect(ids).toContain(orgRoom.body.channel.id);

    await asAda(
      request(server).post(
        api(`/chat/channels/${room.body.channel.id}/messages`),
      ),
    )
      .send({ body: 'Invoice copy reviewed.' })
      .expect(201);
    const read = await asRex(
      request(server).get(
        api(`/chat/channels/${room.body.channel.id}/messages`),
      ),
    ).expect(200);
    expect(read.body.total).toBe(1);
    expect(read.body.items[0].body).toBe('Invoice copy reviewed.');
  });

  it('refuses scope requests that are wrong, unknown, or unpermitted', async () => {
    // The wrong shape: an id where none belongs, a missing id, and two scopes
    // at once. Each is a 400, not a guess at what was meant.
    await asAda(
      request(server).get(api('/chat/channels/scope')).query({ type: 'organization', projectId: PROJECT_ID }),
    ).expect(400);
    await asAda(
      request(server).get(api('/chat/channels/scope')).query({ type: 'project' }),
    ).expect(400);
    await asAda(
      request(server)
        .get(api('/chat/channels/scope'))
        .query({ type: 'task', taskId: TASK_ID, projectId: PROJECT_ID }),
    ).expect(400);

    // Well-formed ids of records that do not exist answer 404 — never a 400
    // that would leak which half was wrong, and never a room.
    await asAda(
      request(server)
        .get(api('/chat/channels/scope'))
        .query({ type: 'project', projectId: PROJECT_ID }),
    ).expect(404);
    await asAda(
      request(server).get(api('/chat/channels/scope')).query({ type: 'task', taskId: TASK_ID }),
    ).expect(404);
    await asAda(
      request(server).get(api('/chat/channels/scope')).query({ type: 'subtask', subtaskId: PROJECT_ID }),
    ).expect(404);

    // A member without `chat.view` is refused outright, scope or no scope.
    clearThrottle();
    await request(server)
      .post(api('/auth/register'))
      .send({ email: 'nona@example.com', password: 'password123', name: 'Nona None' })
      .expect(201);
    await request(server)
      .get(api('/auth/verify-email'))
      .query({ token: mailTokens.verify })
      .expect(200);
    const login = await request(server)
      .post(api('/auth/login'))
      .send({ email: 'nona@example.com', password: 'password123' })
      .expect(201);
    const nona = await dataSource
      .getRepository(User)
      .findOne({ where: { email: 'nona@example.com' } });
    await dataSource.query(
      `INSERT INTO roles (organization_id, user_id, name, status)
       VALUES ($1, $2, 'Guest', 'active')`,
      [organizationId, nona!.id],
    );

    await bearer(login.body.access_token as string)(
      request(server).get(api('/chat/channels/scope')).query({ type: 'organization' }),
    ).expect(403);

    // The plain channel list refuses her too — `chat.view` gates every read
    // route, not just the scope resolver.
    await bearer(login.body.access_token as string)(
      request(server).get(api('/chat/channels')),
    ).expect(403);
  });

  it('carries a conversation over the socket gateway', async () => {
    const channels = await asAda(request(server).get(api('/chat/channels')))
      .expect(200);
    const channelId = channels.body.items[0].channel.id;

    const { port } = server.address() as AddressInfo;
    const connect = (token: string): ChatClientSocket =>
      io(`http://127.0.0.1:${port}/chat`, {
        auth: { token, organizationId },
        transports: ['websocket'],
        reconnection: false,
        forceNew: true,
      });

    const ada = connect(adaTokens[0]);
    const rex = connect(rexTokens[0]);

    try {
      await withTimeout(nextEvent(ada, 'connect'), 5000, 'ada connect');
      await withTimeout(nextEvent(rex, 'connect'), 5000, 'rex connect');

      // Both members join the org room; the ack is the gateway's access
      // check answering, not an optimistic local subscribe.
      const joined = await withTimeout(
        emitWithAck(ada, 'channel:join', { channelId }),
        5000,
        'channel:join ack',
      );
      expect(joined).toEqual({ ok: true });
      await withTimeout(
        emitWithAck(rex, 'channel:join', { channelId }),
        5000,
        'rex channel:join ack',
      );

      // A message written over REST arrives on the other member's socket.
      const delivered = nextEvent<any>(rex, 'message:created');
      await asAda(
        request(server).post(api(`/chat/channels/${channelId}/messages`)),
      )
        .send({ body: 'Shipped behind the gateway.' })
        .expect(201);
      const payload = await withTimeout(delivered, 5000, 'message:created');
      expect(payload).toEqual(
        expect.objectContaining({
          channelId,
          senderId: adaIds[0],
          body: 'Shipped behind the gateway.',
        }),
      );

      // Typing is relayed to the room without being persisted anywhere.
      const typing = nextEvent<any>(rex, 'typing');
      await withTimeout(
        emitWithAck(ada, 'typing', { channelId, isTyping: true }),
        5000,
        'typing ack',
      );
      await expect(withTimeout(typing, 5000, 'typing')).resolves.toEqual({
        channelId,
        userId: adaIds[0],
        isTyping: true,
      });

      // Joining a room that does not exist is refused through the same
      // access check, over the ack rather than a dropped connection.
      const refused = await withTimeout(
        emitWithAck(ada, 'channel:join', { channelId: PROJECT_ID }),
        5000,
        'bad channel:join ack',
      );
      expect(refused.ok).toBe(false);

      // Leaving stops delivery: the next message never reaches this socket.
      const quiet = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => resolve(), 1500);
        rex.once('message:created', () => {
          clearTimeout(timer);
          reject(new Error('received a message after leaving the room'));
        });
      });
      await withTimeout(
        emitWithAck(rex, 'channel:leave', { channelId }),
        5000,
        'channel:leave ack',
      );
      await asAda(
        request(server).post(api(`/chat/channels/${channelId}/messages`)),
      )
        .send({ body: 'Nobody in the room for this one.' })
        .expect(201);
      await withTimeout(quiet, 5000, 'leave silence');
    } finally {
      ada.disconnect();
      rex.disconnect();
    }
  }, 30000);
});
