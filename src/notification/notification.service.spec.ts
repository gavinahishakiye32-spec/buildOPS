import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { IsNull, Not } from 'typeorm';
import { NotFoundException } from '@nestjs/common';
import { DEFAULT_USER_SETTINGS } from '../common/enums.js';
import { NotificationService } from './notification.service.js';

const row = (overrides: Record<string, unknown> = {}) => ({
  id: 'notification-1',
  organizationId: 'org-1',
  recipientId: 'recipient-1',
  kind: 'task.assigned',
  title: 'You have been assigned a task',
  body: 'You have been assigned to "Ship it".',
  data: null,
  readAt: null,
  createdAt: new Date(),
  ...overrides,
});

describe('NotificationService', () => {
  let notificationRepo: any;
  let userRepo: any;
  let userSettingsRepo: any;
  let roleRepo: any;
  let mailService: any;
  let service: NotificationService;

  beforeEach(() => {
    notificationRepo = {
      create: jest.fn(),
      save: jest.fn(),
      findOne: jest.fn(),
      findAndCount: jest.fn(),
      count: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    };

    notificationRepo.create.mockImplementation(
      (values: Record<string, unknown>) => row(values),
    );
    notificationRepo.save.mockImplementation(async (record: any) => record);
    notificationRepo.findOne.mockResolvedValue(row());
    notificationRepo.findAndCount.mockResolvedValue([[row()], 1]);
    notificationRepo.count.mockResolvedValue(0);
    notificationRepo.update.mockResolvedValue({ affected: 0 });
    notificationRepo.delete.mockResolvedValue({ affected: 1 });

    userRepo = {
      findOne: jest
        .fn()
        .mockResolvedValue({ id: 'recipient-1', email: 'a@example.com' }),
    };

    userSettingsRepo = {
      findOne: jest.fn().mockResolvedValue(null),
    };

    roleRepo = {
      find: jest.fn().mockResolvedValue([]),
    };

    mailService = {
      sendNotificationEmail: jest.fn().mockResolvedValue(undefined),
    };

    service = new NotificationService(
      notificationRepo as never,
      userRepo as never,
      userSettingsRepo as never,
      roleRepo as never,
      mailService as never,
    );
  });

  describe('create', () => {
    it('persists the row before the best-effort email', async () => {
      await service.create(
        'org-1',
        'recipient-1',
        'task.assigned',
        'You have been assigned a task',
        'Body',
        { taskId: 'task-1' },
      );

      expect(notificationRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: 'org-1',
          recipientId: 'recipient-1',
          kind: 'task.assigned',
          data: { taskId: 'task-1' },
        }),
      );
    });
  });

  describe('broadcast', () => {
    const perm = (name: string) => ({ name });
    const managerRole = (
      userId: string,
      overrides: Record<string, unknown> = {},
    ) => ({
      id: `role-${userId}`,
      userId,
      permissions: [perm('project.update')],
      ...overrides,
    });

    it('delivers to every active member whose role manages projects or milestones', async () => {
      roleRepo.find.mockResolvedValue([
        managerRole('pm-1'),
        managerRole('owner-1', { permissions: [perm('milestone.create')] }),
      ]);

      const delivered = await service.broadcast(
        'org-1',
        'somebody-else',
        'task.created',
        'Task "Ship it" created',
        'A new task "Ship it" was added.',
        { taskId: 'task-1' },
      );

      expect(roleRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            organizationId: 'org-1',
            status: 'active',
            userId: Not(IsNull()),
          }),
          relations: { permissions: true },
        }),
      );
      expect(delivered).toBe(2);
      expect(notificationRepo.save).toHaveBeenCalledTimes(2);
    });

    it('reaches a dynamically-named management role, name aside', async () => {
      roleRepo.find.mockResolvedValue([
        managerRole('lead-1', {
          name: 'Delivery Lead',
          key: null,
        }),
      ]);

      const delivered = await service.broadcast(
        'org-1',
        'somebody-else',
        'milestone.created',
        'T',
        'B',
      );

      expect(delivered).toBe(1);
    });

    it('leaves out a member whose role does not manage projects or milestones', async () => {
      roleRepo.find.mockResolvedValue([
        managerRole('pm-1'),
        { id: 'role-dev', userId: 'dev-1', permissions: [perm('task.view')] },
      ]);

      const delivered = await service.broadcast(
        'org-1',
        'somebody-else',
        'task.created',
        'T',
        'B',
      );

      expect(delivered).toBe(1);
      expect(notificationRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ recipientId: 'pm-1' }),
      );
    });

    it('skips the actor who caused the event', async () => {
      roleRepo.find.mockResolvedValue([
        managerRole('pm-1'),
        managerRole('actor-1'),
      ]);

      const delivered = await service.broadcast(
        'org-1',
        'actor-1',
        'task.updated',
        'T',
        'B',
      );

      expect(delivered).toBe(1);
      expect(notificationRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ recipientId: 'pm-1', kind: 'task.updated' }),
      );
    });

    it('keeps delivering when one recipient row fails', async () => {
      roleRepo.find.mockResolvedValue([
        managerRole('pm-1'),
        managerRole('owner-1'),
      ]);
      notificationRepo.save.mockRejectedValueOnce(new Error('boom'));

      const delivered = await service.broadcast(
        'org-1',
        'actor-1',
        'milestone.created',
        'T',
        'B',
      );

      expect(delivered).toBe(1);
    });
  });

  describe('realtime email', () => {
    it('sends an email when the recipient asked for realtime', async () => {
      userSettingsRepo.findOne.mockResolvedValue(
        row({ digestFrequency: 'realtime' }),
      );

      await service.create('org-1', 'recipient-1', 'task.assigned', 'T', 'B');

      expect(userRepo.findOne).toHaveBeenCalled();
      expect(mailService.sendNotificationEmail).toHaveBeenCalledWith(
        'a@example.com',
        { title: 'T', body: 'B' },
      );
    });

    it('does not email a recipient on the daily digest', async () => {
      userSettingsRepo.findOne.mockResolvedValue(
        row({ digestFrequency: 'daily' }),
      );

      await service.create('org-1', 'recipient-1', 'task.assigned', 'T', 'B');

      expect(mailService.sendNotificationEmail).not.toHaveBeenCalled();
    });

    it('treats a missing settings row as the default digest, not as realtime', async () => {
      expect(DEFAULT_USER_SETTINGS.digestFrequency).toBe('daily');

      await service.create('org-1', 'recipient-1', 'task.assigned', 'T', 'B');

      expect(mailService.sendNotificationEmail).not.toHaveBeenCalled();
    });

    it('never lets an email failure fail the notification itself', async () => {
      userSettingsRepo.findOne.mockResolvedValue(
        row({ digestFrequency: 'realtime' }),
      );
      mailService.sendNotificationEmail.mockRejectedValue(
        new Error('smtp down'),
      );

      await expect(
        service.create('org-1', 'recipient-1', 'task.assigned', 'T', 'B'),
      ).resolves.toBeDefined();
    });
  });

  describe('inbox reads', () => {
    it('filters the unread list with a null read_at', async () => {
      await service.list('org-1', 'recipient-1', { unread: true } as never);

      expect(notificationRepo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            organizationId: 'org-1',
            recipientId: 'recipient-1',
          }),
        }),
      );
    });

    it('counts only rows the recipient has not read', async () => {
      await service.unreadCount('org-1', 'recipient-1');

      expect(notificationRepo.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            organizationId: 'org-1',
            recipientId: 'recipient-1',
          }),
        }),
      );
    });
  });

  describe('read / remove', () => {
    it('marks an unread notification as read', async () => {
      await service.markRead('org-1', 'recipient-1', 'notification-1');

      expect(notificationRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ readAt: expect.any(Date) }),
      );
    });

    it('is idempotent on an already read notification', async () => {
      notificationRepo.findOne.mockResolvedValue(row({ readAt: new Date() }));

      await service.markRead('org-1', 'recipient-1', 'notification-1');

      expect(notificationRepo.save).not.toHaveBeenCalled();
    });

    it('404s on a notification the caller does not own', async () => {
      notificationRepo.findOne.mockResolvedValue(null);

      await expect(
        service.markRead('org-1', 'recipient-1', 'notification-9'),
      ).rejects.toBeInstanceOf(NotFoundException);

      await expect(
        service.remove('org-1', 'recipient-1', 'notification-9'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('marks every unread row of the caller with one update', async () => {
      await service.markAllRead('org-1', 'recipient-1');

      expect(notificationRepo.update).toHaveBeenCalled();
    });
  });
});