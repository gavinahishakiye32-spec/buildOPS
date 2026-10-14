import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository, SelectQueryBuilder } from 'typeorm';
import {
  resolvePage,
  toPaginated,
  type Paginated,
} from '../common/pagination.dto.js';
import { toIsoDate } from '../common/date.js';
import { Badge } from '../badge/badge.entity.js';
import { Project } from '../project/project.entity.js';
import { Team } from '../team/team.entity.js';
import { Subtask } from '../subtask/subtask.entity.js';
import { TimeEntry } from '../time-entry/time-entry.entity.js';
import { TeamService } from '../team/team.service.js';
import { MilestoneService } from '../milestone/milestone.service.js';
import { NotificationService } from '../notification/notification.service.js';
import { Task } from './task.entity.js';
import {
  CASCADE_CONFIRMATION_REQUIRED,
  restoreBy,
  softDeleteBy,
  type TrashEntryDto,
} from '../common/soft-delete.js';
import { CreateTaskDto, TaskQueryDto, UpdateTaskDto } from './dto/task.dto.js';

/** A notification the task flow owes a recipient once a change is persisted. */
interface TaskEvent {
  recipientId: string | null;
  kind: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
}

/**
 * Tasks belong to a project of the organization and are assigned to a team of
 * the same organization, optionally classified by a badge (spec §10). The
 * organization is always derived from the project, never from client input.
 *
 * A task may also be assigned to an individual and scheduled under a milestone
 * of the same project. An assignee has to satisfy the same rule subtasks
 * always had (spec §11): active membership of the team the task is assigned
 * to, which is why a team is a precondition for assigning at all.
 */
@Injectable()
export class TaskService {
  private readonly logger = new Logger(TaskService.name);

  constructor(
    @InjectRepository(Task)
    private readonly taskRepo: Repository<Task>,
    @InjectRepository(Project)
    private readonly projectRepo: Repository<Project>,
    @InjectRepository(Team)
    private readonly teamRepo: Repository<Team>,
    @InjectRepository(Badge)
    private readonly badgeRepo: Repository<Badge>,
    @InjectRepository(Subtask)
    private readonly subtaskRepo: Repository<Subtask>,
    @InjectRepository(TimeEntry)
    private readonly timeEntryRepo: Repository<TimeEntry>,
    private readonly teamService: TeamService,
    private readonly milestoneService: MilestoneService,
    private readonly notificationService: NotificationService,
  ) {}

  async list(
    organizationId: string,
    query: TaskQueryDto,
  ): Promise<Paginated<Task>> {
    const { page, limit, skip } = resolvePage(query);
    const qb = this.scopedQuery(organizationId);

    if (query.projectId) {
      qb.andWhere('task.project_id = :projectId', {
        projectId: query.projectId,
      });
    }
    if (query.status) {
      qb.andWhere('task.status = :status', { status: query.status });
    }
    if (query.priority) {
      qb.andWhere('task.priority = :priority', { priority: query.priority });
    }
    if (query.teamId) {
      qb.andWhere('task.team_id = :teamId', { teamId: query.teamId });
    }
    if (query.badgeId) {
      qb.andWhere('task.badge_id = :badgeId', { badgeId: query.badgeId });
    }
    if (query.assignedTo) {
      qb.andWhere('task.assigned_to = :assignedTo', {
        assignedTo: query.assignedTo,
      });
    }
    if (query.milestoneId) {
      qb.andWhere('task.milestone_id = :milestoneId', {
        milestoneId: query.milestoneId,
      });
    }

    const [items, total] = await qb
      .orderBy('task.created_at', 'DESC')
      .skip(skip)
      .take(limit)
      .getManyAndCount();

    return toPaginated(items, total, page, limit);
  }

  async findOne(organizationId: string, taskId: string): Promise<Task> {
    const task = await this.scopedQuery(organizationId)
      .andWhere('task.id = :taskId', { taskId })
      .getOne();

    if (!task) {
      throw new NotFoundException('Task not found in this organization');
    }

    return task;
  }

  async create(
    organizationId: string,
    actorId: string,
    dto: CreateTaskDto,
  ): Promise<Task> {
    const project = await this.requireProject(organizationId, dto.projectId);
    const teamId = await this.resolveTeam(organizationId, dto.teamId);
    const badgeId = await this.resolveBadge(organizationId, dto.badgeId);
    const milestoneId = await this.resolveMilestone(
      organizationId,
      project.id,
      dto.milestoneId,
    );
    const assignedTo = await this.resolveAssignee(teamId, dto.assignedTo);

    const task = await this.taskRepo.save(
      this.taskRepo.create({
        projectId: project.id,
        teamId,
        badgeId,
        assignedTo,
        milestoneId,
        title: dto.title.trim(),
        description: dto.description ?? null,
        priority: dto.priority ?? 'medium',
        status: dto.status ?? 'todo',
        dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
      }),
    );

    await this.notifyTaskAssigned(organizationId, task, actorId);
    await this.notifyBroadcast(
      organizationId,
      actorId,
      'task.created',
      `Task "${task.title}" created`,
      `A new task "${task.title}" was added.`,
      { taskId: task.id, projectId: task.projectId, title: task.title },
    );

    return task;
  }

  async update(
    organizationId: string,
    taskId: string,
    actorId: string,
    dto: UpdateTaskDto,
  ): Promise<Task> {
    const task = await this.findOne(organizationId, taskId);
    const events: TaskEvent[] = [];

    if (dto.title !== undefined) {
      task.title = dto.title.trim();
    }
    if (dto.description !== undefined) {
      task.description = dto.description;
    }
    if (dto.teamId !== undefined) {
      const teamId = await this.resolveTeam(
        organizationId,
        dto.teamId ?? undefined,
      );

      // A task reassigned to another team may outlive its assignee's
      // membership on that team. Refusing instead of silently dropping the
      // assignee: an assignment somebody has to notice and repoint is a moment
      // to make a decision, not a reference that is allowed to quietly vanish.
      //
      // Skipped when the same request also changes the assignee: that is the
      // moment of decision, and the assignee block below re-validates the new
      // value (or clears it) against the team chosen here.
      if (
        task.assignedTo &&
        task.teamId !== teamId &&
        dto.assignedTo === undefined
      ) {
        await this.assertAssignable(teamId, task.assignedTo);
      }

      task.teamId = teamId;
    }
    if (dto.milestoneId !== undefined) {
      task.milestoneId = await this.resolveMilestone(
        organizationId,
        task.projectId,
        dto.milestoneId,
      );
    }
    if (dto.badgeId !== undefined) {
      task.badgeId = await this.resolveBadge(
        organizationId,
        dto.badgeId ?? undefined,
      );
    }
    if (dto.assignedTo !== undefined) {
      const assignedTo = await this.resolveAssignee(
        task.teamId,
        dto.assignedTo ?? undefined,
      );

      if (task.assignedTo !== assignedTo) {
        if (assignedTo) {
          events.push(this.taskAssignedEvent(task, assignedTo));
        }
        task.assignedTo = assignedTo;
      }
    }
    if (dto.priority !== undefined) {
      task.priority = dto.priority;
    }
    if (dto.status !== undefined) {
      if (task.status !== dto.status) {
        if (task.assignedTo && task.assignedTo !== actorId) {
          events.push(
            this.taskStatusEvent(task, task.status, dto.status, task.assignedTo),
          );
        }
        task.status = dto.status;
      }
    }
    if (dto.dueDate !== undefined) {
      task.dueDate = dto.dueDate ? new Date(dto.dueDate) : null;
    }

    await this.taskRepo.save(task);
    await this.fireEvents(organizationId, events, actorId);
    await this.notifyBroadcast(
      organizationId,
      actorId,
      'task.updated',
      `Task "${task.title}" updated`,
      `Task "${task.title}" was changed.`,
      { taskId: task.id, projectId: task.projectId, title: task.title },
    );

    return this.findOne(organizationId, taskId);
  }

  /**
   * Soft-deletes a task, its subtasks, and the time logged against them.
   *
   * Confirmation is required because logged time is a business record. It is
   * still only flagged rather than removed, so the restore is exact -- but
   * recoverable is not a reason to destroy hours without asking first.
   */
  async remove(
    organizationId: string,
    taskId: string,
    actorId: string,
    confirmed: boolean,
  ): Promise<{ deleted: number }> {
    const task = await this.findOne(organizationId, taskId);

    if (!confirmed) {
      throw new ConflictException(CASCADE_CONFIRMATION_REQUIRED);
    }

    const at = new Date();

    // One transaction for the whole tree. Flagging the time entries and then
    // failing on the subtasks would leave a task whose hours have silently
    // vanished, and the shared timestamp that makes restore exact would be
    // describing a half-finished delete.
    const result = await this.taskRepo.manager.transaction(async (manager) => {
      const taskRepo = manager.getRepository(Task);
      const subtaskRepo = manager.getRepository(Subtask);
      const timeEntryRepo = manager.getRepository(TimeEntry);

      // Re-read inside the transaction: a subtask created a moment ago must be
      // part of the delete or explicitly excluded, never raced against it.
      const subtaskIds = (
        await subtaskRepo.find({ where: { taskId, deletedAt: IsNull() } })
      ).map((subtask) => subtask.id);

      const entries = subtaskIds.length
        ? await timeEntryRepo.count({
            where: { subtaskId: In(subtaskIds), deletedAt: IsNull() },
          })
        : 0;

      if (subtaskIds.length) {
        await softDeleteBy(
          timeEntryRepo,
          'subtask_id IN (:...subtaskIds) AND deleted_at IS NULL',
          { subtaskIds },
          actorId,
          at,
        );
        await softDeleteBy(
          subtaskRepo,
          'id IN (:...subtaskIds)',
          { subtaskIds },
          actorId,
          at,
        );
      }

      await softDeleteBy(taskRepo, 'id = :taskId', { taskId }, actorId, at);

      return { deleted: entries + subtaskIds.length + 1 };
    });

    await this.notifyBroadcast(
      organizationId,
      actorId,
      'task.deleted',
      `Task "${task.title}" deleted`,
      `Task "${task.title}" was deleted.`,
      { taskId: task.id, projectId: task.projectId, title: task.title },
    );

    return result;
  }

  /** Restores a task and exactly the subtasks and time that went down with it. */
  async restore(organizationId: string, taskId: string): Promise<Task> {
    const { task, at } = await this.findDeletedTask(organizationId, taskId);

    // A task under a project that is still flagged would be invisible to every
    // read: the project filter hides it, and a row nothing can see is worse
    // than one still in the trash. The project is the unit the user deleted, so
    // it is the unit they restore.
    const project = await this.projectRepo.findOne({
      where: { id: task.projectId },
      withDeleted: true,
    });

    if (project?.deletedAt) {
      throw new ConflictException(
        'The project this task belongs to is still deleted. Restore the ' +
          'project instead, which brings back everything that went with it.',
      );
    }

    // Same reasoning as the delete: the restore either reassembles the set that
    // shared a timestamp or it does not. A partial restore would leave a task
    // back with no subtasks, which reads as data loss even though the rows are
    // still flagged.
    await this.taskRepo.manager.transaction(async (manager) => {
      const taskRepo = manager.getRepository(Task);
      const subtaskRepo = manager.getRepository(Subtask);
      const timeEntryRepo = manager.getRepository(TimeEntry);

      const subtaskIds = (
        await subtaskRepo.find({
          where: { taskId, deletedAt: at },
          withDeleted: true,
        })
      ).map((subtask) => subtask.id);

      if (subtaskIds.length) {
        await restoreBy(
          timeEntryRepo,
          'subtask_id IN (:...subtaskIds) AND deleted_at = :at',
          { subtaskIds, at },
        );
        await restoreBy(subtaskRepo, 'id IN (:...subtaskIds)', { subtaskIds });
      }

      await restoreBy(taskRepo, 'id = :taskId', { taskId });
    });

    return this.findOne(organizationId, taskId);
  }

  async listDeleted(organizationId: string): Promise<TrashEntryDto[]> {
    // A subquery rather than a join on purpose. `withDeleted()` only clears the
    // soft-delete filter for the root alias -- TypeORM still writes
    // `project.deleted_at IS NULL` into the ON clause of a joined alias -- so a
    // join would hide every task whose project went down with it, which is
    // precisely the task a person opens the trash to find. A subquery has no
    // alias to be filtered, so it sees the rows as they really are.
    const rows = await this.taskRepo
      .createQueryBuilder('task')
      .withDeleted()
      .where(
        'task.project_id IN (SELECT id FROM projects WHERE organization_id = :organizationId)',
        { organizationId },
      )
      .andWhere('task.deleted_at IS NOT NULL')
      .orderBy('task.deleted_at', 'DESC')
      .getMany();

    return rows.map((row) => ({
      id: row.id,
      deletedAt: row.deletedAt as Date,
      deletedBy: row.deletedBy,
      resource: row.toResponse(),
    }));
  }

  /**
   * A flagged task in this organization, plus the timestamp it was flagged at.
   *
   * The timestamp comes back with it because it is not a detail of the lookup:
   * it is the key the restore uses to find the descendants that went down in
   * the same delete and nothing else.
   */
  private async findDeletedTask(
    organizationId: string,
    taskId: string,
  ): Promise<{ task: Task; at: Date }> {
    const task = await this.taskRepo
      .createQueryBuilder('task')
      .withDeleted()
      .where(
        'task.project_id IN (SELECT id FROM projects WHERE organization_id = :organizationId)',
        { organizationId },
      )
      .andWhere('task.id = :taskId', { taskId })
      .getOne();

    if (!task) {
      throw new NotFoundException('Task not found');
    }

    const at = task.deletedAt;

    if (!at) {
      throw new ConflictException('Task is not deleted');
    }

    return { task, at };
  }

  private scopedQuery(organizationId: string): SelectQueryBuilder<Task> {
    return this.taskRepo
      .createQueryBuilder('task')
      .innerJoin(Project, 'project', 'project.id = task.project_id')
      .where('project.organization_id = :organizationId', { organizationId });
  }

  private async requireProject(
    organizationId: string,
    projectId: string,
  ): Promise<Project> {
    const project = await this.projectRepo.findOne({
      where: { id: projectId, organizationId },
    });

    if (!project) {
      throw new NotFoundException('Project not found in this organization');
    }

    return project;
  }

  private async resolveTeam(
    organizationId: string,
    teamId?: string,
  ): Promise<string | null> {
    if (!teamId) {
      return null;
    }

    const team = await this.teamRepo.findOne({
      where: { id: teamId, organizationId },
    });

    if (!team) {
      throw new NotFoundException('Team not found in this organization');
    }

    return team.id;
  }

  private async resolveBadge(
    organizationId: string,
    badgeId?: string,
  ): Promise<string | null> {
    if (!badgeId) {
      return null;
    }

    const badge = await this.badgeRepo.findOne({
      where: { id: badgeId, organizationId },
    });

    if (!badge) {
      throw new NotFoundException('Badge not found in this organization');
    }

    return badge.id;
  }

  /**
   * A milestone must exist in the organization *and* belong to the same project
   * as the task: a milestone of a sibling project is a different schedule, and
   * mixing schedules is how a "release" target silently ends up under a task of
   * the wrong plan.
   */
  private async resolveMilestone(
    organizationId: string,
    projectId: string,
    milestoneId?: string | null,
  ): Promise<string | null> {
    if (!milestoneId) {
      return null;
    }

    const milestone = await this.milestoneService.findOne(
      organizationId,
      milestoneId,
    );

    if (milestone.projectId !== projectId) {
      throw new BadRequestException(
        'Milestone does not belong to this project',
      );
    }

    return milestone.id;
  }

  private async resolveAssignee(
    teamId: string | null,
    assignedTo?: string,
  ): Promise<string | null> {
    if (!assignedTo) {
      return null;
    }

    await this.assertAssignable(teamId, assignedTo);
    return assignedTo;
  }

  private async assertAssignable(
    teamId: string | null,
    assignee: string,
  ): Promise<void> {
    if (!teamId) {
      throw new BadRequestException(
        'The task has no team assigned; a task cannot be assigned to an individual',
      );
    }

    await this.teamService.assertActiveMember(teamId, assignee);
  }

  // --- notifications --------------------------------------------------------

  private async notifyTaskAssigned(
    organizationId: string,
    task: Task,
    actorId: string,
  ): Promise<void> {
    if (task.assignedTo && task.assignedTo !== actorId) {
      await this.fireEvents(
        organizationId,
        [this.taskAssignedEvent(task, task.assignedTo)],
        actorId,
      );
    }
  }

  private taskAssignedEvent(task: Task, assignee: string): TaskEvent {
    return {
      recipientId: assignee,
      kind: 'task.assigned',
      title: 'You have been assigned a task',
      body: `You have been assigned to "${task.title}".`,
      data: {
        taskId: task.id,
        projectId: task.projectId,
        title: task.title,
        dueDate: toIsoDate(task.dueDate),
      },
    };
  }

  private taskStatusEvent(
    task: Task,
    from: string,
    to: string,
    recipientId: string,
  ): TaskEvent {
    return {
      recipientId,
      kind: 'task.status_changed',
      title: `Task "${task.title}" moved to ${to}`,
      body: `"${task.title}" moved from ${from} to ${to}.`,
      data: {
        taskId: task.id,
        projectId: task.projectId,
        title: task.title,
        status: to,
      },
    };
  }

  /**
   * Writes the notification rows produced by a change, best-effort.
   *
   * The task change is the operation the caller asked for; a notification that
   * fails to persist (or whose email fails) must not roll the change back, so
   * each write is guarded. The email side is already guarded inside
   * `NotificationService`; this is the guard for the row itself.
   */
  private async fireEvents(
    organizationId: string,
    events: TaskEvent[],
    actorId: string,
  ): Promise<void> {
    for (const event of events) {
      if (!event.recipientId) {
        continue;
      }

      try {
        await this.notificationService.create(
          organizationId,
          event.recipientId,
          event.kind,
          event.title,
          event.body,
          event.data,
          actorId,
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `Notification not delivered kind=${event.kind} recipient=${event.recipientId}: ${message}`,
        );
      }
    }
  }

  /**
   * Broadcasts a lifecycle event to the organization's owners and project
   * managers, best-effort, so the inbox doubles as the "what's new" feed.
   * The broadcast itself is guarded against unrelated recipients; this guard
   * covers the audience lookup.
   */
  private async notifyBroadcast(
    organizationId: string,
    actorId: string,
    kind: string,
    title: string,
    body: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.notificationService.broadcast(
        organizationId,
        actorId,
        kind,
        title,
        body,
        data,
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      this.logger.warn(`Broadcast not delivered kind=${kind}: ${message}`);
    }
  }
}
