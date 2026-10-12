import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository, SelectQueryBuilder } from 'typeorm';
import {
  resolvePage,
  toPaginated,
  type Paginated,
} from '../common/pagination.dto.js';
import { EMPTY_ROLLUP, type TaskRollup } from '../common/assignee.js';
import { Badge } from '../badge/badge.entity.js';
import { Project } from '../project/project.entity.js';
import { Team } from '../team/team.entity.js';
import { Subtask } from '../subtask/subtask.entity.js';
import { TimeEntry } from '../time-entry/time-entry.entity.js';
import { Task } from './task.entity.js';
import {
  CASCADE_CONFIRMATION_REQUIRED,
  restoreBy,
  softDeleteBy,
  type TrashEntryDto,
} from '../common/soft-delete.js';
import { CreateTaskDto, TaskQueryDto, UpdateTaskDto } from './dto/task.dto.js';

/** A task plus the subtask totals the board renders on its card. */
export interface TaskWithRollup {
  task: Task;
  rollup: TaskRollup;
}

/**
 * Tasks belong to a project of the organization and are assigned to a team of
 * the same organization, optionally classified by a badge (spec §10). The
 * organization is always derived from the project, never from client input.
 *
 * A task also has one owner, and subtasks have theirs. Both are members of the
 * organization -- not members of the task's team: which team a task sits on
 * and who does its work are separate questions, and the second one is the one
 * a person actually needs answered.
 */
@Injectable()
export class TaskService {
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
  ) {}

  async list(
    organizationId: string,
    query: TaskQueryDto,
  ): Promise<Paginated<TaskWithRollup>> {
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

    const [tasks, total] = await qb
      .orderBy('task.created_at', 'DESC')
      .skip(skip)
      .take(limit)
      .getManyAndCount();

    const rollups = await this.rollupsFor(tasks.map((task) => task.id));

    return toPaginated(
      tasks.map((task) => ({ task, rollup: rollups.get(task.id) ?? EMPTY_ROLLUP })),
      total,
      page,
      limit,
    );
  }

  /**
   * The subtask totals for a set of tasks, from one query.
   *
   * A board renders "3 of 7 done" and a stack of faces on every card, so doing
   * this per task would be one extra round trip each -- twenty tasks, twenty
   * queries. One grouped aggregate over the ids of the page keeps it at one.
   *
   * Rows are read through the raw table rather than the `Subtask` entity on
   * purpose: this is a count, and hydrating full entities to throw all but two
   * fields away would move far more data across the wire for the same answer.
   */
  private async rollupsFor(taskIds: string[]): Promise<Map<string, TaskRollup>> {
    const rollups = new Map<string, TaskRollup>();

    if (taskIds.length === 0) {
      return rollups;
    }

    const rows = await this.subtaskRepo.manager.query(
      `
        SELECT
          s.task_id                                    AS "taskId",
          COUNT(*)                                     AS "total",
          COUNT(*) FILTER (WHERE s.status = 'done')    AS "done",
          s.assigned_to                                AS "assigneeId",
          u.name                                       AS "assigneeName"
        FROM subtasks s
        LEFT JOIN users u ON u.id = s.assigned_to
        WHERE s.task_id = ANY($1::uuid[]) AND s.deleted_at IS NULL
        GROUP BY s.task_id, s.assigned_to, u.name
      `,
      [taskIds],
    );

    for (const row of rows as {
      taskId: string;
      total: string;
      done: string;
      assigneeId: string | null;
      assigneeName: string | null;
    }[]) {
      const current = rollups.get(row.taskId) ?? EMPTY_ROLLUP;

      const total = Number(row.total);
      const done = Number(row.done);

      const assignees =
        row.assigneeId && !current.assignees.some((a) => a.id === row.assigneeId)
          ? [
              ...current.assignees,
              { id: row.assigneeId, name: row.assigneeName },
            ]
          : current.assignees;

      rollups.set(row.taskId, {
        subtaskTotal: current.subtaskTotal + total,
        subtaskDone: current.subtaskDone + done,
        assignees,
      });
    }

    return rollups;
  }

  /** One task, with the totals its detail view shows. */
  async findOneDetailed(
    organizationId: string,
    taskId: string,
  ): Promise<TaskWithRollup> {
    const task = await this.findOne(organizationId, taskId);
    const rollups = await this.rollupsFor([task.id]);

    return { task, rollup: rollups.get(task.id) ?? EMPTY_ROLLUP };
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

  async create(organizationId: string, dto: CreateTaskDto): Promise<Task> {
    const project = await this.requireProject(organizationId, dto.projectId);
    const teamId = await this.resolveTeam(organizationId, dto.teamId);
    const badgeId = await this.resolveBadge(organizationId, dto.badgeId);

    const created = await this.taskRepo.save(
      this.taskRepo.create({
        projectId: project.id,
        teamId,
        badgeId,
        title: dto.title.trim(),
        description: dto.description ?? null,
        priority: dto.priority ?? 'medium',
        status: dto.status ?? 'todo',
        dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
      }),
    );

    // Re-read rather than answering from the insert: the row just written has
    // no owner relation loaded, so `create` would report a task assigned on the
    // way in as unassigned.
    return this.findOne(organizationId, created.id);
  }

  async update(
    organizationId: string,
    taskId: string,
    dto: UpdateTaskDto,
  ): Promise<Task> {
    const task = await this.findOne(organizationId, taskId);

    if (dto.title !== undefined) {
      task.title = dto.title.trim();
    }
    if (dto.description !== undefined) {
      task.description = dto.description;
    }
    if (dto.teamId !== undefined) {
      task.teamId = await this.resolveTeam(
        organizationId,
        dto.teamId ?? undefined,
      );
    }
    if (dto.badgeId !== undefined) {
      task.badgeId = await this.resolveBadge(
        organizationId,
        dto.badgeId ?? undefined,
      );
    }
    if (dto.priority !== undefined) {
      task.priority = dto.priority;
    }
    if (dto.status !== undefined) {
      task.status = dto.status;
    }
    if (dto.dueDate !== undefined) {
      task.dueDate = dto.dueDate ? new Date(dto.dueDate) : null;
    }

    await this.taskRepo.save(task);
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
    await this.findOne(organizationId, taskId);

    if (!confirmed) {
      throw new ConflictException(CASCADE_CONFIRMATION_REQUIRED);
    }

    const at = new Date();

    // One transaction for the whole tree. Flagging the time entries and then
    // failing on the subtasks would leave a task whose hours have silently
    // vanished, and the shared timestamp that makes restore exact would be
    // describing a half-finished delete.
    return this.taskRepo.manager.transaction(async (manager) => {
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

  /**
   * Soft-deletes a task, its subtasks, and the time logged against them.
   *
   * Confirmation is required because logged time is a business record. It is
   * still only flagged rather than removed, so the restore is exact -- but
   * recoverable is not a reason to destroy hours without asking first.
   */
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
}
