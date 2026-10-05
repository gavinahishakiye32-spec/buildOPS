import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository, SelectQueryBuilder } from 'typeorm';
import {
  resolvePage,
  toPaginated,
  type Paginated,
} from '../common/pagination.dto.js';
import { Project } from '../project/project.entity.js';
import { TeamService } from '../team/team.service.js';
import { Subtask } from './subtask.entity.js';
import {
  CreateSubtaskDto,
  SubtaskQueryDto,
  UpdateSubtaskDto,
} from './dto/subtask.dto.js';
import { Task } from '../task/task.entity.js';
import { TimeEntry } from '../time-entry/time-entry.entity.js';
import {
  CASCADE_CONFIRMATION_REQUIRED,
  restoreBy,
  softDeleteBy,
  type TrashEntryDto,
} from '../common/soft-delete.js';

/**
 * Subtasks are execution items assigned to an individual who must be an active
 * member of the team assigned to the parent task (spec §11).
 */
@Injectable()
export class SubtaskService {
  constructor(
    @InjectRepository(Subtask)
    private readonly subtaskRepo: Repository<Subtask>,
    @InjectRepository(Task)
    private readonly taskRepo: Repository<Task>,
    @InjectRepository(TimeEntry)
    private readonly timeEntryRepo: Repository<TimeEntry>,
    private readonly teamService: TeamService,
  ) {}

  async list(
    organizationId: string,
    taskId: string,
    query: SubtaskQueryDto,
  ): Promise<Paginated<Subtask>> {
    const { page, limit, skip } = resolvePage(query);

    // Without this the route answers an empty page for a task that does not
    // exist, and for one that belongs to another organization: the documented
    // 404 is the only way a caller can tell a typo from an empty list.
    await this.requireTask(organizationId, taskId);

    const qb = this.scopedQuery(organizationId, taskId);

    if (query.status) {
      qb.andWhere('subtask.status = :status', { status: query.status });
    }
    if (query.assignedTo) {
      qb.andWhere('subtask.assigned_to = :assignedTo', {
        assignedTo: query.assignedTo,
      });
    }

    const [items, total] = await qb
      .orderBy('subtask.created_at', 'ASC')
      .skip(skip)
      .take(limit)
      .getManyAndCount();

    return toPaginated(items, total, page, limit);
  }

  async findOne(organizationId: string, subtaskId: string): Promise<Subtask> {
    const subtask = await this.scopedQuery(organizationId)
      .andWhere('subtask.id = :subtaskId', { subtaskId })
      .getOne();

    if (!subtask) {
      throw new NotFoundException('Subtask not found in this organization');
    }

    return subtask;
  }

  async create(
    organizationId: string,
    taskId: string,
    dto: CreateSubtaskDto,
  ): Promise<Subtask> {
    const task = await this.requireTask(organizationId, taskId);

    const assignedTo = await this.resolveAssignee(task, dto.assignedTo);

    return this.subtaskRepo.save(
      this.subtaskRepo.create({
        taskId: task.id,
        assignedTo,
        title: dto.title.trim(),
        description: dto.description ?? null,
        status: dto.status ?? 'todo',
        dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
      }),
    );
  }

  async update(
    organizationId: string,
    subtaskId: string,
    dto: UpdateSubtaskDto,
  ): Promise<Subtask> {
    const subtask = await this.findOne(organizationId, subtaskId);

    if (dto.assignedTo !== undefined) {
      const task = await this.requireTask(organizationId, subtask.taskId);
      subtask.assignedTo = await this.resolveAssignee(
        task,
        dto.assignedTo ?? undefined,
      );
    }
    if (dto.title !== undefined) {
      subtask.title = dto.title.trim();
    }
    if (dto.description !== undefined) {
      subtask.description = dto.description;
    }
    if (dto.status !== undefined) {
      subtask.status = dto.status;
    }
    if (dto.dueDate !== undefined) {
      subtask.dueDate = dto.dueDate ? new Date(dto.dueDate) : null;
    }

    await this.subtaskRepo.save(subtask);
    return this.findOne(organizationId, subtaskId);
  }

  /**
   * Soft-deletes a subtask, and the time logged against it.
   *
   * This is the smallest delete in the app that can lose a business record, so
   * it needs the explicit confirmation: logged hours are not something a user can
   * retype. Everything is flagged rather than removed, so a mistake is a restore
   * away, but "recoverable" is not a reason to delete without asking.
   */
  async remove(
    organizationId: string,
    subtaskId: string,
    actorId: string,
    confirmed: boolean,
  ): Promise<{ deleted: number }> {
    await this.findOne(organizationId, subtaskId);

    if (!confirmed) {
      throw new ConflictException(CASCADE_CONFIRMATION_REQUIRED);
    }

    const at = new Date();

    // One transaction, one timestamp, deepest rows first. The timestamp is what
    // the restore keys off, and the transaction is what stops a failure between
    // the two statements from producing a subtask whose hours are already gone.
    return this.subtaskRepo.manager.transaction(async (manager) => {
      const subtaskRepo = manager.getRepository(Subtask);
      const timeEntryRepo = manager.getRepository(TimeEntry);

      const entries = await timeEntryRepo.count({
        where: { subtaskId, deletedAt: IsNull() },
      });

      await softDeleteBy(
        timeEntryRepo,
        'subtask_id = :subtaskId AND deleted_at IS NULL',
        { subtaskId },
        actorId,
        at,
      );
      await softDeleteBy(
        subtaskRepo,
        'id = :subtaskId',
        { subtaskId },
        actorId,
        at,
      );

      return { deleted: entries + 1 };
    });
  }

  /**
   * Restores a subtask and exactly the time logged against it when it was
   * deleted.
   */
  async restore(
    organizationId: string,
    taskId: string,
    subtaskId: string,
  ): Promise<Subtask> {
    const { at } = await this.findDeletedSubtask(
      organizationId,
      taskId,
      subtaskId,
    );

    // Refusing here is the same reasoning as the task level: a live subtask
    // under a flagged task cannot be read, listed or worked on, and a row the
    // user cannot see is a worse outcome than one still in the trash.
    const task = await this.taskRepo.findOne({
      where: { id: taskId },
      withDeleted: true,
    });

    if (task?.deletedAt) {
      throw new ConflictException(
        'The task this subtask belongs to is still deleted. Restore the task ' +
          'instead, which brings back everything that went with it.',
      );
    }

    // The exact timestamp, not a time window: an entry logged under this subtask
    // a minute *after* the cascade was someone deliberately re-adding work, and
    // it must stay deleted.
    //
    // One transaction, so the subtask never comes back without the hours that
    // were filed against it.
    await this.subtaskRepo.manager.transaction(async (manager) => {
      await restoreBy(
        manager.getRepository(TimeEntry),
        'subtask_id = :subtaskId AND deleted_at = :at',
        { subtaskId, at },
      );
      await restoreBy(manager.getRepository(Subtask), 'id = :subtaskId', {
        subtaskId,
      });
    });

    return this.findOne(organizationId, subtaskId);
  }

  async listDeleted(
    organizationId: string,
    taskId: string,
  ): Promise<TrashEntryDto[]> {
    // The task may well be flagged -- a project cascade takes the task and its
    // subtasks down together, and the trash is where the user is looking for
    // them. Requiring a *live* task here would hide exactly the rows the route
    // exists to show. The tenant check still has to hold, so this accepts a
    // flagged task but not somebody else's.
    await this.requireTaskIncludingDeleted(organizationId, taskId);

    // Subqueries, not joins: `withDeleted()` clears the soft-delete filter for
    // the root alias only, and TypeORM still adds `deleted_at IS NULL` to the
    // ON clause of every joined alias. A join would therefore hide exactly the
    // subtasks whose task went down with it.
    const rows = await this.subtaskRepo
      .createQueryBuilder('subtask')
      .withDeleted()
      .where(
        `subtask.task_id IN (
           SELECT id FROM tasks
            WHERE project_id IN (
              SELECT id FROM projects WHERE organization_id = :organizationId
            )
         )`,
        { organizationId },
      )
      .andWhere('subtask.task_id = :taskId', { taskId })
      .andWhere('subtask.deleted_at IS NOT NULL')
      .orderBy('subtask.deleted_at', 'DESC')
      .getMany();

    return rows.map((row) => ({
      id: row.id,
      deletedAt: row.deletedAt as Date,
      deletedBy: row.deletedBy,
      resource: row.toResponse(),
    }));
  }

  /**
   * A flagged subtask in this organization, plus the timestamp it was flagged
   * at -- the key the restore uses to find the time entries that went down with
   * it and nothing else.
   */
  private async findDeletedSubtask(
    organizationId: string,
    taskId: string,
    subtaskId: string,
  ): Promise<{ subtask: Subtask; at: Date }> {
    // A subquery for the same reason as the trash listing: the task and project
    // are frequently still flagged, and a join would filter the row out.
    const subtask = await this.subtaskRepo
      .createQueryBuilder('subtask')
      .withDeleted()
      .where(
        `subtask.task_id IN (
           SELECT id FROM tasks
            WHERE project_id IN (
              SELECT id FROM projects WHERE organization_id = :organizationId
            )
         )`,
        { organizationId },
      )
      .andWhere('subtask.task_id = :taskId', { taskId })
      .andWhere('subtask.id = :subtaskId', { subtaskId })
      .getOne();

    if (!subtask) {
      throw new NotFoundException('Subtask not found');
    }

    const at = subtask.deletedAt;

    if (!at) {
      throw new ConflictException('Subtask is not deleted');
    }

    return { subtask, at };
  }

  /** The task, live or flagged, as long as it belongs to this organization. */
  private async requireTaskIncludingDeleted(
    organizationId: string,
    taskId: string,
  ): Promise<Task> {
    const task = await this.taskRepo
      .createQueryBuilder('task')
      .withDeleted()
      .where(
        `task.project_id IN (
           SELECT id FROM projects WHERE organization_id = :organizationId
         )`,
        { organizationId },
      )
      .andWhere('task.id = :taskId', { taskId })
      .getOne();

    if (!task) {
      throw new NotFoundException('Task not found in this organization');
    }

    return task;
  }

  private scopedQuery(
    organizationId: string,
    taskId?: string,
  ): SelectQueryBuilder<Subtask> {
    const qb = this.subtaskRepo
      .createQueryBuilder('subtask')
      .innerJoin(Task, 'task', 'task.id = subtask.task_id')
      .innerJoin(Project, 'project', 'project.id = task.project_id')
      .where('project.organization_id = :organizationId', { organizationId });

    if (taskId) {
      qb.andWhere('subtask.task_id = :taskId', { taskId });
    }

    return qb;
  }

  private async requireTask(
    organizationId: string,
    taskId: string,
  ): Promise<Task> {
    const task = await this.taskRepo
      .createQueryBuilder('task')
      .innerJoin(Project, 'project', 'project.id = task.project_id')
      .where('task.id = :taskId', { taskId })
      .andWhere('project.organization_id = :organizationId', {
        organizationId,
      })
      .getOne();

    if (!task) {
      throw new NotFoundException('Task not found in this organization');
    }

    return task;
  }

  private async resolveAssignee(
    task: Task,
    assignedTo?: string,
  ): Promise<string | null> {
    if (!assignedTo) {
      return null;
    }

    if (!task.teamId) {
      throw new BadRequestException(
        'The task has no team assigned; a subtask cannot be assigned to an individual',
      );
    }

    await this.teamService.assertActiveMember(task.teamId, assignedTo);
    return assignedTo;
  }
}
