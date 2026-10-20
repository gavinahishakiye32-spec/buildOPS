import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ChatService } from './chat.service.js';
import { PERMISSIONS } from '../common/permissions.js';

/**
 * Chat service decisions that are cheap to get wrong and expensive in
 * production: who may edit or moderate a message, who may open a DM, and the
 * two races -- the org channel insert and the duplicate DM -- that the unique
 * index and the advisory lock exist to win. Everything here runs against
 * hand-rolled repository doubles; the SQL itself is exercised by the e2e
 * suite, which is the only place a real Postgres can prove the partial unique
 * indexes and `FILTER` clause behave.
 */

const ORG = '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b';
const USER = '9a2b7c1d-4e5f-4a6b-8c9d-0e1f2a3b4c5d';
const OTHER = '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e';
const CHANNEL = 'c3d4e5f6-a7b8-4c9d-0e1f-2a3b4c5d6e7f';
const MESSAGE = 'f4a5b6c7-d8e9-4f0a-9b1c-2d3e4f5a6b7c';
const PROJECT = '0d1e2f3a-4b5c-4d6e-8f7a-1b2c3d4e5f6a';
const TASK = '7f8e9d0c-1a2b-4c3d-8e5f-6a7b8c9d0e1f';

/** The raw grouped queries `decorateChannels` runs: chainable, always empty. */
const rawQueryChain = () => {
  const chain: any = {};
  for (const method of [
    'select',
    'addSelect',
    'innerJoin',
    'leftJoin',
    'where',
    'andWhere',
    'orderBy',
    'groupBy',
    'addGroupBy',
  ]) {
    chain[method] = jest.fn(() => chain);
  }
  chain.getRawMany = jest.fn(async () => []);
  chain.getOne = jest.fn(async () => ({ id: 'scope-record' }));
  return chain;
};

const build = () => {
  const channelRepo: any = {
    findOne: jest.fn(async () => null),
    create: jest.fn((value: Record<string, unknown>) => ({
      ...value,
      toResponse() {
        return { id: this.id, type: this.type, name: this.name };
      },
    })),
    save: jest.fn(async (value: unknown) => value),
    createQueryBuilder: jest.fn(),
    manager: {
      transaction: jest.fn(async (work: (manager: unknown) => unknown) =>
        work(transactionManager),
      ),
    },
  };

  const messageRepo: any = {
    findOne: jest.fn(async () => null),
    create: jest.fn((value: unknown) => value),
    save: jest.fn(async (value: unknown) => value),
    createQueryBuilder: jest.fn(() => rawQueryChain()),
    manager: {
      transaction: jest.fn(async (work: (manager: unknown) => unknown) =>
        work(transactionManager),
      ),
    },
  };

  const participantRepo: any = {
    findOne: jest.fn(async () => null),
    create: jest.fn((value: unknown) => value),
    save: jest.fn(async (value: unknown) => value),
    query: jest.fn(async () => []),
    manager: {
      transaction: jest.fn(async (work: (manager: unknown) => unknown) =>
        work(transactionManager),
      ),
    },
    createQueryBuilder: jest.fn(),
  };

  const roleRepo: any = {
    find: jest.fn(async () => []),
  };

  const userRepo: any = {
    findOne: jest.fn(async () => ({ id: USER, name: 'Ada Login' })),
  };

  const projectRepo: any = {
    findOne: jest.fn(async () => ({ id: PROJECT })),
  };

  const taskRepo: any = {
    createQueryBuilder: jest.fn(() => rawQueryChain()),
  };

  const subtaskRepo: any = {
    createQueryBuilder: jest.fn(() => rawQueryChain()),
  };

  const membershipResolver: any = {
    resolve: jest.fn(async () => ({
      roleId: 'role-1',
      roleName: 'Developer',
      permissions: [PERMISSIONS.CHAT_VIEW, PERMISSIONS.CHAT_CREATE],
    })),
  };

  const gateway: any = {
    emitToChannel: jest.fn(),
    emitToUser: jest.fn(),
  };

  const transactionManager: any = {
    query: jest.fn(async () => []),
    getRepository: jest.fn((entity: { name: string }) => {
      if (entity.name === 'ChatChannel') {
        return {
          create: channelRepo.create,
          save: channelRepo.save,
          findOne: jest.fn(async () => null),
          update: jest.fn(async () => undefined),
        };
      }
      if (entity.name === 'ChatMessage') {
        return {
          create: messageRepo.create,
          save: messageRepo.save,
        };
      }
      return {
        create: participantRepo.create,
        save: participantRepo.save,
      };
    }),
  };

  const service = new ChatService(
    channelRepo,
    messageRepo,
    participantRepo,
    roleRepo,
    userRepo,
    projectRepo,
    taskRepo,
    subtaskRepo,
    membershipResolver,
    gateway,
  );

  return {
    service,
    channelRepo,
    messageRepo,
    participantRepo,
    roleRepo,
    projectRepo,
    taskRepo,
    membershipResolver,
    gateway,
    transactionManager,
  };
};

const liveMessage = (overrides: Record<string, unknown> = {}) => ({
  id: MESSAGE,
  organizationId: ORG,
  channelId: CHANNEL,
  senderId: USER,
  body: 'hello',
  editedAt: null,
  deletedAt: null,
  deletedBy: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  toResponse() {
    return {
      id: this.id,
      channelId: this.channelId,
      sender: { id: this.senderId, name: 'Ada Login' },
      body: this.body,
      editedAt: this.editedAt,
      createdAt: this.createdAt,
    };
  },
  ...overrides,
});

describe('ChatService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('editMessage', () => {
    it('refuses to let somebody else edit a message', async () => {
      const { service, messageRepo } = build();
      messageRepo.findOne.mockResolvedValueOnce(liveMessage({ senderId: OTHER }));

      await expect(
        service.editMessage(ORG, MESSAGE, USER, 'rewritten'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refuses to edit a message that was soft-deleted', async () => {
      const { service, messageRepo } = build();
      messageRepo.findOne.mockResolvedValueOnce(null);

      await expect(
        service.editMessage(ORG, MESSAGE, USER, 'rewritten'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('sets editedAt when the sender rewrites their own message', async () => {
      const { service, messageRepo, gateway } = build();
      messageRepo.findOne.mockResolvedValueOnce(liveMessage());

      const saved = await service.editMessage(ORG, MESSAGE, USER, 'rewritten');

      expect(saved.body).toBe('rewritten');
      expect(saved.editedAt).toBeInstanceOf(Date);
      expect(gateway.emitToChannel).toHaveBeenCalledWith(
        CHANNEL,
        'message:updated',
        expect.objectContaining({ id: MESSAGE, body: 'rewritten' }),
      );
    });
  });

  describe('deleteMessage', () => {
    it('refuses a bystander without chat.manage', async () => {
      const { service, messageRepo } = build();
      messageRepo.findOne.mockResolvedValueOnce(liveMessage({ senderId: OTHER }));

      await expect(
        service.deleteMessage(ORG, MESSAGE, USER, [PERMISSIONS.CHAT_VIEW]),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('lets chat.manage moderate anybody\'s message', async () => {
      const { service, messageRepo, gateway } = build();
      messageRepo.findOne.mockResolvedValueOnce(liveMessage({ senderId: OTHER }));

      await service.deleteMessage(ORG, MESSAGE, USER, [
        PERMISSIONS.CHAT_VIEW,
        PERMISSIONS.CHAT_MANAGE,
      ]);

      expect(messageRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ deletedBy: USER }),
      );
      expect(gateway.emitToChannel).toHaveBeenCalledWith(
        CHANNEL,
        'message:deleted',
        expect.objectContaining({ id: MESSAGE }),
      );
    });

    it('lets the sender delete their own message without chat.manage', async () => {
      const { service, messageRepo } = build();
      messageRepo.findOne.mockResolvedValueOnce(liveMessage());

      await service.deleteMessage(ORG, MESSAGE, USER, [PERMISSIONS.CHAT_VIEW]);

      expect(messageRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ deletedBy: USER }),
      );
    });
  });

  describe('resolveScopedChannel', () => {
    it('refuses an organization room handed a scope id', async () => {
      const { service } = build();

      await expect(
        service.resolveScopedChannel(ORG, USER, {
          type: 'organization',
          projectId: PROJECT,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('requires the id of the scope it is asked for', async () => {
      const { service } = build();

      await expect(
        service.resolveScopedChannel(ORG, USER, { type: 'project' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses ids of other scopes alongside the one it takes', async () => {
      const { service } = build();

      await expect(
        service.resolveScopedChannel(ORG, USER, {
          type: 'task',
          taskId: TASK,
          projectId: PROJECT,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('answers 404 for a scope outside this organization before opening anything', async () => {
      const { service, projectRepo, channelRepo } = build();
      projectRepo.findOne.mockResolvedValueOnce(null);

      await expect(
        service.resolveScopedChannel(ORG, USER, {
          type: 'project',
          projectId: PROJECT,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(channelRepo.save).not.toHaveBeenCalled();
    });

    it('opens the missing room with its scope attached', async () => {
      const { service, channelRepo } = build();

      const entry = await service.resolveScopedChannel(ORG, USER, {
        type: 'task',
        taskId: TASK,
      });

      expect(channelRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'task', taskId: TASK }),
      );
      expect(entry.lastMessage).toBeNull();
      expect(entry.unreadCount).toBe(0);
      expect(entry.channel).toEqual(
        expect.objectContaining({ type: 'task', name: null }),
      );
    });

    it('reuses the room the scope already has', async () => {
      const { service, channelRepo } = build();
      const room = {
        id: CHANNEL,
        organizationId: ORG,
        type: 'project',
        projectId: PROJECT,
        toResponse() {
          return { id: this.id, type: this.type, projectId: this.projectId };
        },
      };
      channelRepo.findOne.mockResolvedValueOnce(room);

      const entry = await service.resolveScopedChannel(ORG, USER, {
        type: 'project',
        projectId: PROJECT,
      });

      expect(entry.channel.id).toBe(CHANNEL);
      expect(channelRepo.save).not.toHaveBeenCalled();
    });

    it('reads the winner\'s row when the unique index rejects its insert', async () => {
      const { service, channelRepo } = build();
      const winner = {
        id: CHANNEL,
        organizationId: ORG,
        type: 'project',
        projectId: PROJECT,
        name: null,
        toResponse() {
          return { id: this.id, type: this.type, projectId: this.projectId };
        },
      };

      // First lookup misses, the insert loses the race with constraint 23505,
      // and the retry lookup finds the row the winner wrote.
      channelRepo.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(winner);
      channelRepo.save.mockRejectedValueOnce({ code: '23505' });

      const entry = await service.resolveScopedChannel(ORG, USER, {
        type: 'project',
        projectId: PROJECT,
      });

      expect(entry.channel.id).toBe(CHANNEL);
      expect(channelRepo.save).toHaveBeenCalledTimes(1);
      expect(channelRepo.findOne).toHaveBeenCalledTimes(2);
    });

    it('rethrows a constraint failure that is not a unique violation', async () => {
      const { service, channelRepo } = build();
      channelRepo.findOne.mockResolvedValueOnce(null);
      channelRepo.save.mockRejectedValueOnce({ code: '23503' });

      await expect(
        service.resolveScopedChannel(ORG, USER, {
          type: 'project',
          projectId: PROJECT,
        }),
      ).rejects.toEqual({ code: '23503' });
    });
  });

  describe('getChannel', () => {
    const orgChannel = {
      id: CHANNEL,
      organizationId: ORG,
      type: 'organization',
      toResponse() {
        return { id: this.id, type: this.type };
      },
    };

    it('joins the caller to a scoped room on first open without touching their read marker', async () => {
      const { service, channelRepo, participantRepo } = build();
      channelRepo.findOne.mockResolvedValueOnce(orgChannel);

      const channel = await service.getChannel(ORG, CHANNEL, USER);

      expect(channel.id).toBe(CHANNEL);
      expect(participantRepo.query).toHaveBeenCalledWith(
        expect.stringContaining('ON CONFLICT ("channel_id", "user_id") DO NOTHING'),
        [CHANNEL, USER],
      );
    });

    it('answers 404 for a direct channel the caller is not in', async () => {
      const { service, channelRepo, participantRepo } = build();
      channelRepo.findOne.mockResolvedValueOnce({
        id: CHANNEL,
        organizationId: ORG,
        type: 'direct',
      });
      participantRepo.findOne.mockResolvedValueOnce(null);

      await expect(service.getChannel(ORG, CHANNEL, USER)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(participantRepo.query).not.toHaveBeenCalled();
    });
  });

  describe('createDirectChannel', () => {
    it('requires the caller to be part of the set they are opening', async () => {
      const { service } = build();

      await expect(
        service.createDirectChannel(ORG, USER, [OTHER]),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses ids that are not active members of the organization', async () => {
      const { service, roleRepo } = build();
      roleRepo.find.mockResolvedValueOnce([{ userId: USER }]);

      await expect(
        service.createDirectChannel(ORG, USER, [USER, OTHER]),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('returns the existing channel when the set already has one', async () => {
      const { service, roleRepo, transactionManager } = build();
      roleRepo.find.mockResolvedValueOnce([{ userId: USER }, { userId: OTHER }]);

      const existing = { id: CHANNEL, type: 'direct' };
      transactionManager.query.mockImplementation(async (sql: string) => {
        if (sql.includes('pg_advisory_xact_lock')) {
          return [];
        }
        // The dedupe query: non-empty result means the channel already exists.
        return [{ id: CHANNEL }];
      });
      transactionManager.getRepository = jest.fn((entity: { name: string }) => ({
        findOne: jest.fn(async () => (entity.name === 'ChatChannel' ? existing : null)),
      }));

      const channel = await service.createDirectChannel(ORG, USER, [USER, OTHER]);

      expect(channel).toBe(existing);
    });

    it('serialises the decision on a participant-set advisory lock', async () => {
      const { service, roleRepo, transactionManager } = build();
      roleRepo.find.mockResolvedValueOnce([{ userId: USER }, { userId: OTHER }]);
      transactionManager.query.mockResolvedValueOnce([]);

      await service.createDirectChannel(ORG, USER, [USER, OTHER]);

      expect(transactionManager.query).toHaveBeenCalledWith(
        'SELECT pg_advisory_xact_lock(hashtext($1))',
        [expect.stringContaining(USER)],
      );
    });
  });

  describe('markRead', () => {
    it('refuses an upToMessageId that is not in the channel', async () => {
      const { service, channelRepo, messageRepo } = build();
      channelRepo.findOne.mockResolvedValueOnce({
        id: CHANNEL,
        organizationId: ORG,
        type: 'organization',
      });
      messageRepo.findOne.mockResolvedValueOnce(null);

      await expect(
        service.markRead(ORG, CHANNEL, USER, { upToMessageId: MESSAGE }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('resolveSocketIdentity', () => {
    it('refuses a non-uuid organization without touching the database', async () => {
      const { service, membershipResolver } = build();

      const identity = await service.resolveSocketIdentity('not-a-uuid', USER);

      expect(identity).toBeNull();
      expect(membershipResolver.resolve).not.toHaveBeenCalled();
    });

    it('refuses a user who is not a member', async () => {
      const { service, membershipResolver } = build();
      membershipResolver.resolve.mockResolvedValueOnce(null);

      const identity = await service.resolveSocketIdentity(ORG, USER);

      expect(identity).toBeNull();
    });

    it('carries the resolved permissions onto the socket', async () => {
      const { service } = build();

      const identity = await service.resolveSocketIdentity(ORG, USER);

      expect(identity).toEqual({
        userId: USER,
        organizationId: ORG,
        permissions: [PERMISSIONS.CHAT_VIEW, PERMISSIONS.CHAT_CREATE],
      });
    });
  });
});
