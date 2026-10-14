import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import {
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Task } from '../task/task.entity.js';
import { MilestoneService } from './milestone.service.js';

const row = (overrides: Record<string, unknown> = {}) => {
  const record = {
    id: 'milestone-1',
    organizationId: 'org-1',
    projectId: 'project-1',
    name: 'MVP release',
    description: null,
    status: 'planned',
    dueDate: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    deletedBy: null,
    ...overrides,
  };
  return { ...record, toResponse: () => record };
};

/**
 * `softDeleteBy` flags through a query-builder chain, so the milestone repo
 * mocks that chain. A bare `update` mock would make the delete silently do
 * nothing.
 */
const qb = () => {
  const chain: any = {
    update: jest.fn(() => chain),
    set: jest.fn(() => chain),
    where: jest.fn(() => chain),
    execute: jest.fn(async () => ({ affected: 1 })),
  };
  return chain;
};

describe('MilestoneService', () => {
  let milestoneRepo: any;
  let projectRepo: any;
  let taskRepo: any;
  let notificationService: any;
  let service: MilestoneService;

  beforeEach(() => {
    milestoneRepo = {
      manager: { transaction: jest.fn() },
      create: jest.fn(),
      save: jest.fn(),
      findOne: jest.fn(),
      find: jest.fn(),
      findAndCount: jest.fn(),
      update: jest.fn(),
      createQueryBuilder: jest.fn(),
    };

    milestoneRepo.manager.transaction.mockImplementation(
      async (work: (tx: any) => unknown) => {
        const tx = {
          getRepository: (entity: unknown) =>
            entity === Task ? taskRepo : milestoneRepo,
          create: milestoneRepo.create,
          save: milestoneRepo.save,
          findOne: milestoneRepo.findOne,
          find: milestoneRepo.find,
          update: milestoneRepo.update,
          createQueryBuilder: milestoneRepo.createQueryBuilder,
        };
        return work(tx);
      },
    );
    milestoneRepo.create.mockImplementation((values: Record<string, unknown>) =>
      row(values),
    );
    milestoneRepo.save.mockImplementation(async (record: any) => record);
    milestoneRepo.findOne.mockResolvedValue(row());
    milestoneRepo.find.mockResolvedValue([]);
    milestoneRepo.findAndCount.mockResolvedValue([[row()], 1]);
    milestoneRepo.update.mockResolvedValue({ affected: 0 });
    milestoneRepo.createQueryBuilder.mockReturnValue(qb());

    projectRepo = {
      findOne: jest.fn().mockResolvedValue(row({ id: 'project-1' })),
    };

    taskRepo = {
      find: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({ affected: 0 }),
    };

    notificationService = {
      broadcast: jest.fn().mockResolvedValue(0),
    };

    service = new MilestoneService(
      milestoneRepo as never,
      projectRepo as never,
      taskRepo as never,
      notificationService as never,
    );
  });

  describe('create', () => {
    it('refuses a project that is not in the organization', async () => {
      projectRepo.findOne.mockResolvedValue(null);

      await expect(
        service.create('org-1', 'actor-1', { projectId: 'other', name: 'Release' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('stores the milestone under the organization and the project', async () => {
      await service.create('org-1', 'actor-1', {
        projectId: 'project-1',
        name: '  MVP release  ',
        status: 'in_progress',
      });

      expect(milestoneRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: 'org-1',
          projectId: 'project-1',
          name: 'MVP release',
          status: 'in_progress',
          dueDate: null,
        }),
      );
      expect(milestoneRepo.save).toHaveBeenCalled();
      expect(notificationService.broadcast).toHaveBeenCalledWith(
        'org-1',
        'actor-1',
        'milestone.created',
        expect.any(String),
        expect.any(String),
        expect.objectContaining({ milestoneId: 'milestone-1' }),
      );
    });
  });

  describe('remove', () => {
    it('detaches every live task under the milestone and flags the milestone', async () => {
      taskRepo.find.mockResolvedValue([
        row({ id: 'task-1', title: 'Ship' }),
        row({ id: 'task-2', title: 'Land' }),
      ]);

      const result = await service.remove('org-1', 'milestone-1', 'actor-1');

      expect(taskRepo.update).toHaveBeenCalledWith(
        expect.anything(),
        { milestoneId: null },
      );
      expect(milestoneRepo.createQueryBuilder).toHaveBeenCalled();
      expect(result).toEqual({ deleted: 3 });
      expect(notificationService.broadcast).toHaveBeenCalledWith(
        'org-1',
        'actor-1',
        'milestone.deleted',
        expect.any(String),
        expect.any(String),
        expect.objectContaining({ milestoneId: 'milestone-1' }),
      );
    });

    it('detaches nothing when the milestone has no tasks', async () => {
      const result = await service.remove('org-1', 'milestone-1', 'actor-1');

      expect(taskRepo.update).not.toHaveBeenCalled();
      expect(result).toEqual({ deleted: 1 });
    });
  });

  describe('restore', () => {
    it('refuses to restore a milestone whose project is still deleted', async () => {
      milestoneRepo.findOne.mockResolvedValue(row({ deletedAt: new Date() }));
      projectRepo.findOne.mockResolvedValue(
        row({ id: 'project-1', deletedAt: new Date() }),
      );

      await expect(
        service.restore('org-1', 'milestone-1', 'actor-1'),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('restores a milestone whose project is back', async () => {
      milestoneRepo.findOne
        .mockResolvedValueOnce(row({ deletedAt: new Date() }))
        .mockResolvedValueOnce(row());

      const restored = await service.restore('org-1', 'milestone-1', 'actor-1');

      expect(milestoneRepo.createQueryBuilder).toHaveBeenCalled();
      expect(restored.deletedAt).toBeNull();
      expect(notificationService.broadcast).toHaveBeenCalledWith(
        'org-1',
        'actor-1',
        'milestone.restored',
        expect.any(String),
        expect.any(String),
        expect.objectContaining({ milestoneId: 'milestone-1' }),
      );
    });
  });

  describe('listDeleted', () => {
    it('reports who deleted each milestone and when', async () => {
      milestoneRepo.find.mockResolvedValue([
        row({
          id: 'gone-1',
          deletedAt: new Date('2026-10-01T00:00:00.000Z'),
          deletedBy: 'actor-9',
        }),
      ]);

      const trash = await service.listDeleted('org-1');

      expect(trash).toEqual([
        expect.objectContaining({
          id: 'gone-1',
          deletedBy: 'actor-9',
        }),
      ]);
    });
  });
});