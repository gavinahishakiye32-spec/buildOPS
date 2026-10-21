import {
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
import { NotificationService } from '../notification/notification.service.js';
import { User } from '../user/user.entity.js';
import { Project } from '../project/project.entity.js';
import { RoleService } from '../role/role.service.js';
import { Subtask } from './subtask.entity.js';
import {
  AssignedSubtaskResponseDto,
  CreateSubtaskDto,
  SubtaskFeedQueryDto,
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
import { recordActivity } from '../activity/record-activity.js';

/**
 * Subtasks are the execution items of a task, and each one is handed to a
 * person.
 *
 * The assignee is a member of the organization, not necessarily a member of the
 * task's team. Which team a task sits on and who does its work are separate
 * questions, and an organization whose members all belong to one team could not
 * express that: the rule made an assignment impossible rather than merely
 * unadvisable, and it had no way to say "nobody has picked this up yet".
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
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(Project)
    private readonly projectRepo: Repository<Project>,
    private readonly roleService: RoleService,
    private readonly notifications: NotificationService,
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

    this.joinAssignee(qb);

    const [items, total] = await qb
      .orderBy('subtask.created_at', 'ASC')
      .skip(skip)
      .take(limit)
      .getManyAndCount();

    return toPaginated(items, total, page, limit);
  }

  /**
   * Every subtask of the organization, across all projects.
   *
   * The nested route answers "the subtasks of this task", which is the wrong
   * question for the screen a person opens when they want to know what they owe
   * today: their work is spread over whatever projects they contribute to, and
   * making them walk to each one in turn is what makes an assignment list
   * useless.
   *
   * Each row carries the task and project it belongs to, because a subtask read
   * out of context ("reset the password") is not actionable -- the person has to
   * see which part of which project it is part of to judge it.
   */
  async feed(
    organizationId: string,
    query: SubtaskFeedQueryDto,
  ): Promise<Paginated<AssignedSubtaskResponseDto>> {
    const { page, limit, skip } = resolvePage(query);
    const qb = this.scopedQuery(organizationId, query.taskId, true);

    if (query.status) {
      qb.andWhere('subtask.status = :status', { status: query.status });
    }
    if (query.projectId) {
      qb.andWhere('task.project_id = :projectId', { projectId: query.projectId });
    }
    if (query.assigneeId) {
      qb.andWhere('subtask.assigned_to = :assigneeId', {
        assigneeId: query.assigneeId,
      });
    }
    if (query.assignment === 'unassigned') {
      qb.andWhere('subtask.assigned_to IS NULL');
    } else if (query.assignment === 'assigned') {
      qb.andWhere('subtask.assigned_to IS NOT NULL');
    }

    this.joinAssignee(qb);

    const [items, total] = await qb
      // Overdue work first, then the nearest deadline. A feed sorted by
      // creation date shows a task from last month above one due today, which
      // is the opposite of what the person opened it for.
      .orderBy('subtask.due_date', 'ASC', 'NULLS LAST')
      .addOrderBy('subtask.created_at', 'DESC')
      .skip(skip)
      .take(limit)
      .getManyAndCount();

    return toPaginated(
      items.map((subtask) => ({
        ...subtask.toResponse(),
        task: subtask.task
          ? {
              id: subtask.task.id,
              title: subtask.task.title,
              status: subtask.task.status,
              priority: subtask.task.priority,
              dueDate: subtask.task.dueDate ?? null,
            }
          : null,
        project: subtask.task?.project
          ? {
              id: subtask.task.project.id,
              name: subtask.task.project.name,
            }
          : null,
      })),
      total,
      page,
      limit,
    );
  }

  async findOne(organizationId: string, subtaskId: string): Promise<Subtask> {
    const qb = this.scopedQuery(organizationId).andWhere(
      'subtask.id = :subtaskId',
      { subtaskId },
    );

    this.joinAssignee(qb);

    const subtask = await qb.getOne();

    if (!subtask) {
      throw new NotFoundException('Subtask not found in this organization');
    }

    return subtask;
  }

  async create(
    organizationId: string,
    taskId: string,
    actorId: string,
    dto: CreateSubtaskDto,
  ): Promise<Subtask> {
    const task = await this.requireTask(organizationId, taskId);

    const assignedTo = await this.resolveAssignee(
      organizationId,
      dto.assignedTo,
    );

    const created = await this.subtaskRepo.manager.transaction(async (manager) => {
      const subtaskRepo = manager.getRepository(Subtask);
      const saved = await subtaskRepo.save(
        subtaskRepo.create({
          taskId: task.id,
          assignedTo,
          title: dto.title.trim(),
          description: dto.description ?? null,
          status: dto.status ?? 'todo',
          dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
        }),
      );

      await recordActivity(manager, {
        organizationId,
        entityType: 'subtask',
        action: 'created',
        entityId: saved.id,
        actorId,
        projectId: task.projectId,
        metadata: { title: saved.title, taskId: task.id },
      });

      return saved;
    });

    await this.announceAssignment({
      organizationId,
      actorId,
      subtaskId: created.id,
      title: created.title,
      taskId: task.id,
      taskTitle: task.title,
      projectId: task.projectId,
      assigneeId: created.assignedTo,
      previous: null,
    });

    // Re-read rather than answering from the insert. The insert hands back the
    // row it wrote with no relation loaded, so `create` would report every new
    // subtask as unassigned -- including one that was assigned on the way in.
    return this.findOne(organizationId, created.id);
  }

  /**
   * Tells the assignee that a subtask is theirs.
   *
   * Addressed to one person -- whoever `subtask.assignedTo` names -- and to
   * nobody else. There is deliberately no broadcast: a member being handed work
   * is a fact about that member, and the rest of the organization finds out by
   * looking at the board.
   *
   * The project name is resolved here rather than left to the reader because
   * "Ada assigned you 'reset the password'" does not say enough on its own to
   * be worth interrupting somebody for; the project does.
   *
   * Best-effort by construction: `NotificationService.notify` swallows its own
   * failure, so a notification that cannot be written never rolls back the
   * assignment that caused it.
   */
  private async announceAssignment(input: {
    organizationId: string;
    actorId: string;
    subtaskId: string;
    title: string;
    taskId: string;
    taskTitle: string;
    projectId: string;
    assigneeId: string | null;
    /** Who had it before, for the "moved to you" wording. Null on create. */
    previous: string | null;
  }): Promise<void> {
    const {
      organizationId,
      actorId,
      subtaskId,
      title,
      taskId,
      taskTitle,
      projectId,
      assigneeId,
      previous,
    } = input;

    if (!assigneeId) {
      return;
    }

    const actor = await this.loadUser(actorId);
    const projectName = await this.loadProjectName(projectId);

    const context = [
      `part of "${taskTitle}"`,
      projectName ? `in ${projectName}` : null,
    ]
      .filter(Boolean)
      .join(', ');

    await this.notifications.notify({
      organizationId,
      userId: assigneeId,
      actorId,
      type: previous ? 'subtask_reassigned' : 'subtask_assigned',
      title: previous
        ? `${actor?.name ?? 'Someone'} moved "${title}" to you`
        : `${actor?.name ?? 'Someone'} assigned you "${title}"`,
      body: `A subtask ${context}.`,
      taskId,
      subtaskId,
    });
  }

  /** The actor's display name, or null when the account is gone. */
  private async loadUser(userId: string): Promise<{ name: string | null } | null> {
    const user = await this.userRepo.findOne({
      where: { id: userId },
      select: { id: true, name: true },
    });

    return user ?? null;
  }

  /** Best-effort: a notification with no project name is still a true one. */
  private async loadProjectName(projectId: string): Promise<string | null> {
    const project = await this.projectRepo.findOne({
      where: { id: projectId },
      select: { id: true, name: true },
    });

    return project?.name ?? null;
  }

  async update(
    organizationId: string,
    subtaskId: string,
    actorId: string,
    dto: UpdateSubtaskDto,
  ): Promise<Subtask> {
    const subtask = await this.findOne(organizationId, subtaskId);
    const previousAssignee = subtask.assignedTo;

    /**
     * What this update assigned, kept beside the entity rather than read back
     * off it.
     *
     * `save()` mutates the entity it was given: it reconciles the foreign key
     * against the relation, so an entity written here with `assignedTo = <new>`
     * and `assignee = null` comes back with `assignedTo = null` even though the
     * row in the database is correct. Reading the assignee off the entity after
     * the save is therefore how this quietly notified nobody -- the comparison
     * said "changed", and the address was gone. `undefined` means the request
     * did not touch assignment at all, which is not the same as assigning null.
     */
    let assignedTo: string | null | undefined;

    if (dto.assignedTo !== undefined) {
      assignedTo = await this.resolveAssignee(
        organizationId,
        dto.assignedTo ?? undefined,
      );
      subtask.assignedTo = assignedTo;

      // The loaded `assignee` has to be dropped alongside the id. TypeORM
      // derives the foreign key from a relation that is present on the entity,
      // so leaving the previous assignee in place makes the save write *them*
      // back: the update reports success and the subtask never changed hands.
      subtask.assignee = null;
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

    await this.subtaskRepo.manager.transaction(async (manager) => {
      const subtaskRepo = manager.getRepository(Subtask);
      await subtaskRepo.save(subtask);

      await recordActivity(manager, {
        organizationId,
        entityType: 'subtask',
        action: 'updated',
        entityId: subtaskId,
        actorId,
        metadata: { title: subtask.title, taskId: subtask.taskId },
      });
    });

    // Only when the work actually changed hands. Saving a status or a title is
    // not an assignment, and telling somebody their work moved when it did not
    // is the kind of notification that trains people to ignore the bell.
    if (assignedTo !== undefined && assignedTo !== previousAssignee) {
      const task = await this.requireTask(organizationId, subtask.taskId);

      await this.announceAssignment({
        organizationId,
        actorId,
        subtaskId: subtask.id,
        title: subtask.title,
        taskId: task.id,
        taskTitle: task.title,
        projectId: task.projectId,
        assigneeId: assignedTo,
        previous: previousAssignee,
      });
    }

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

      await recordActivity(manager, {
        organizationId,
        entityType: 'subtask',
        action: 'deleted',
        entityId: subtaskId,
        actorId,
        metadata: { deleted: entries + 1 },
      });

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

      await recordActivity(manager, {
        organizationId,
        entityType: 'subtask',
        action: 'restored',
        entityId: subtaskId,
        metadata: { taskId },
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

  /**
   * Joins the assignee onto a subtask query, two columns only.
   *
   * Written as a relation *path* rather than as `leftJoin(User, 'assignee', ...)`:
   * TypeORM maps a joined alias back onto the entity property only when the join
   * is declared through the relation, so the entity-class form silently returns
   * an unset `assignee` while the raw row is sitting right there in the result.
   *
   * `leftJoin` + `addSelect` rather than `leftJoinAndSelect`, because the latter
   * pulls every column of the user -- the password hash, reset token and
   * verification token included -- across the wire for a task list.
   */
  private joinAssignee(qb: SelectQueryBuilder<Subtask>): void {
    qb
      .leftJoin(
        'subtask.assignee',
        'assignee',
        'assignee.id = subtask.assigned_to',
      )
      .addSelect(['assignee.id', 'assignee.name']);
  }

  private scopedQuery(
    organizationId: string,
    taskId?: string,
    /**
     * Load the parent task and its project onto the rows.
     *
     * Only the feed needs them -- the nested route already knows which task it
     * asked about, and selecting the whole `tasks` and `projects` rows there
     * would ship the description and the budget of every task to a client that
     * asked for its subtasks.
     */
    withContext = false,
  ): SelectQueryBuilder<Subtask> {
    const qb = this.subtaskRepo
      .createQueryBuilder('subtask');

    if (withContext) {
      // Relation paths, `innerJoin` + `addSelect` rather than
      // `innerJoinAndSelect`: the latter pulls every column of the task and the
      // project -- the task description and the project budget -- into a list of
      // subtasks that needs neither.
      //
      // The project join is written as `task.project`, relative to the alias
      // joined above, rather than `subtask.task.project`: TypeORM cannot resolve
      // the full path once `task` has been bound to an alias, and rejects the
      // query with "Relation with property path task.project in entity was not
      // found".
      qb
        .innerJoin('subtask.task', 'task', 'task.id = subtask.task_id')
        .addSelect([
          'task.id',
          'task.title',
          'task.status',
          'task.priority',
          'task.due_date',
        ]);
      qb
        .innerJoin('task.project', 'project', 'project.id = task.project_id')
        .addSelect(['project.id', 'project.name']);
    } else {
      qb.innerJoin(Task, 'task', 'task.id = subtask.task_id');
      qb.innerJoin(Project, 'project', 'project.id = task.project_id');
    }

    qb.where('project.organization_id = :organizationId', { organizationId });

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

  /**
   * Validates a subtask assignee against the organization's membership.
   *
   * Returns `null` for an absent id rather than refusing: an unassigned subtask
   * is the normal state of a piece of work nobody has picked up yet, and a task
   * whose steps are still being written should not need a name on each of them
   * before it can be saved.
   */
  private async resolveAssignee(
    organizationId: string,
    assignedTo?: string,
  ): Promise<string | null> {
    if (!assignedTo) {
      return null;
    }

    await this.roleService.assertAssignableMember(organizationId, assignedTo);
    return assignedTo;
  }
}
