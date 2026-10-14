import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { BadRequestException } from '@nestjs/common';
import { TaskService } from './task.service.js';

const task = (overrides: Record<string, unknown> = {}) => ({
  id: 'task-1',
  projectId: 'project-1',
  teamId: 'team-1',
  badgeId: null,
  assignedTo: null,
  milestoneId: null,
  title: 'Ship it',
  description: null,
  priority: 'medium',
  status: 'todo',
  dueDate: null,
  ...overrides,
});

describe('TaskService assignee rules', () => {
  let taskRepo: any;
  let projectRepo: any;
  let teamRepo: any;
  let badgeRepo: any;
  let teamService: any;
  let milestoneService: any;
  let notificationService: any;
  let qb: any;
  let service: TaskService;

  beforeEach(() => {
    qb = {
      innerJoin: jest.fn(() => qb),
      where: jest.fn(() => qb),
      andWhere: jest.fn(() => qb),
      orderBy: jest.fn(() => qb),
      skip: jest.fn(() => qb),
      take: jest.fn(() => qb),
      getOne: jest.fn(),
      getManyAndCount: jest.fn(),
    };

    taskRepo = {
      create: jest.fn((values: Record<string, unknown>) => task(values)),
      save: jest.fn(async (record: unknown) => record),
      createQueryBuilder: jest.fn(() => qb),
    };
    projectRepo = {
      findOne: jest.fn().mockResolvedValue({ id: 'project-1' }),
    };
    teamRepo = { findOne: jest.fn().mockResolvedValue({ id: 'team-1' }) };
    badgeRepo = { findOne: jest.fn() };
    teamService = {
      assertActiveMember: jest.fn().mockResolvedValue(undefined),
    };
    milestoneService = { findOne: jest.fn() };
    notificationService = {
      create: jest.fn().mockResolvedValue(undefined),
      broadcast: jest.fn().mockResolvedValue(0),
    };

    service = new TaskService(
      taskRepo as never,
      projectRepo as never,
      teamRepo as never,
      badgeRepo as never,
      {} as never,
      {} as never,
      teamService as never,
      milestoneService as never,
      notificationService as never,
    );
  });

  it('rejects a create whose assignee is not an active team member', async () => {
    teamService.assertActiveMember.mockRejectedValue(
      new BadRequestException('not a member'),
    );

    await expect(
      service.create('org-1', 'actor-1', {
        projectId: 'project-1',
        teamId: 'team-1',
        assignedTo: 'outsider',
        title: 'T',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(taskRepo.save).not.toHaveBeenCalled();
  });

  it('refuses an assignee when the task has no team to validate against', async () => {
    await expect(
      service.create('org-1', 'actor-1', {
        projectId: 'project-1',
        assignedTo: 'someone',
        title: 'T',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(teamService.assertActiveMember).not.toHaveBeenCalled();
    expect(taskRepo.save).not.toHaveBeenCalled();
  });

  it('assigns an active team member and notifies them, not the actor', async () => {
    const saved = await service.create('org-1', 'actor-1', {
      projectId: 'project-1',
      teamId: 'team-1',
      assignedTo: 'member-1',
      title: 'T',
    });

    expect(saved.assignedTo).toBe('member-1');
    expect(notificationService.create).toHaveBeenCalledWith(
      'org-1',
      'member-1',
      'task.assigned',
      expect.any(String),
      expect.any(String),
      expect.any(Object),
      'actor-1',
    );
  });

  it('carries a Date or a column string due date into the assignment', async () => {
    // A `date` column comes back from PostgreSQL as 'YYYY-MM-DD' even though the
    // entity declares Date, while the create path builds a real Date. Both must
    // reach the notification without a `.toISOString()` blow-up.
    qb.getOne.mockResolvedValue(
      task({ assignedTo: null, dueDate: '2026-12-01' }),
    );
    await service.update('org-1', 'task-1', 'actor-1', {
      assignedTo: 'member-1',
    });
    expect(notificationService.create).toHaveBeenCalledWith(
      'org-1',
      'member-1',
      'task.assigned',
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ dueDate: '2026-12-01' }),
      'actor-1',
    );

    notificationService.create.mockClear();
    qb.getOne.mockResolvedValue(
      task({ assignedTo: null, dueDate: new Date('2026-12-01T00:00:00.000Z') }),
    );
    await service.update('org-1', 'task-1', 'actor-1', {
      assignedTo: 'member-1',
    });
    expect(notificationService.create).toHaveBeenCalledWith(
      'org-1',
      'member-1',
      'task.assigned',
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ dueDate: '2026-12-01' }),
      'actor-1',
    );
  });

  it('rejects repointing a task to a team the assignee is not active in', async () => {
    qb.getOne.mockResolvedValue(task({ assignedTo: 'member-1' }));
    teamRepo.findOne.mockResolvedValue({ id: 'team-2' });
    teamService.assertActiveMember.mockRejectedValue(
      new BadRequestException('not a member'),
    );

    await expect(
      service.update('org-1', 'task-1', 'actor-1', { teamId: 'team-2' }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(taskRepo.save).not.toHaveBeenCalled();
  });

  it('moves a task to another team and clears the assignee in one request', async () => {
    const record = task({ assignedTo: 'member-1' });
    qb.getOne.mockResolvedValue(record);
    teamRepo.findOne.mockResolvedValue({ id: 'team-2' });

    await service.update('org-1', 'task-1', 'actor-1', {
      teamId: 'team-2',
      assignedTo: null,
    });

    // The assignee is being changed in the same request, so the old value is
    // not validated against the new team -- it is replaced.
    expect(teamService.assertActiveMember).not.toHaveBeenCalled();
    expect(record.assignedTo).toBeNull();
    expect(taskRepo.save).toHaveBeenCalled();
  });

  it('validates a new assignee against the team the same request selects', async () => {
    const record = task({ assignedTo: 'member-1' });
    qb.getOne.mockResolvedValue(record);
    teamRepo.findOne.mockResolvedValue({ id: 'team-2' });

    await service.update('org-1', 'task-1', 'actor-1', {
      teamId: 'team-2',
      assignedTo: 'member-2',
    });

    expect(teamService.assertActiveMember).toHaveBeenCalledWith(
      'team-2',
      'member-2',
    );
    expect(record.assignedTo).toBe('member-2');
  });
});
