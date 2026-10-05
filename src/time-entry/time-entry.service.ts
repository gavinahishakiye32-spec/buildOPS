import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';
import {
  resolvePage,
  toPaginated,
  type Paginated,
} from '../common/pagination.dto.js';
import { Project } from '../project/project.entity.js';
import { Subtask } from '../subtask/subtask.entity.js';
import { Task } from '../task/task.entity.js';
import { TimeEntry } from './time-entry.entity.js';
import {
  restoreBy,
  softDeleteBy,
  type TrashEntryDto,
} from '../common/soft-delete.js';
import {
  CreateTimeEntryDto,
  StartTimerDto,
  StopTimerDto,
  TimeEntryQueryDto,
  UpdateTimeEntryDto,
} from './dto/time-entry.dto.js';

/**
 * Time logging (spec §12). Entries hang off a subtask; the organization is
 * derived through subtask → task → project, and `time_entry.view_all` widens
 * visibility from "my own entries" to the whole organization.
 */
@Injectable()
export class TimeEntryService {
  constructor(
    @InjectRepository(TimeEntry)
    private readonly timeEntryRepo: Repository<TimeEntry>,
    @InjectRepository(Subtask)
    private readonly subtaskRepo: Repository<Subtask>,
  ) {}

  async list(
    organizationId: string,
    callerId: string,
    canViewAll: boolean,
    query: TimeEntryQueryDto,
  ): Promise<Paginated<TimeEntry>> {
    const { page, limit, skip } = resolvePage(query);
    const qb = this.scopedQuery(organizationId);

    if (!canViewAll && query.userId !== callerId) {
      // Without view_all a caller may only ever inspect their own entries.
      qb.andWhere('entry.user_id = :callerId', { callerId });
    } else if (query.userId) {
      qb.andWhere('entry.user_id = :userId', { userId: query.userId });
    }

    if (query.subtaskId) {
      qb.andWhere('entry.subtask_id = :subtaskId', {
        subtaskId: query.subtaskId,
      });
    }
    if (query.running !== undefined) {
      qb.andWhere(
        query.running
          ? 'entry.exit_time IS NULL'
          : 'entry.exit_time IS NOT NULL',
      );
    }

    const [items, total] = await qb
      .orderBy('entry.entry_time', 'DESC')
      .skip(skip)
      .take(limit)
      .getManyAndCount();

    return toPaginated(items, total, page, limit);
  }

  async findOne(organizationId: string, entryId: string): Promise<TimeEntry> {
    const entry = await this.scopedQuery(organizationId)
      .andWhere('entry.id = :entryId', { entryId })
      .getOne();

    if (!entry) {
      throw new NotFoundException('Time entry not found in this organization');
    }

    return entry;
  }

  /**
   * Single-entry read: own entries are always visible, somebody else's entries
   * require time_entry.view_all and otherwise stay indistinguishable from 404.
   */
  async findVisible(
    organizationId: string,
    entryId: string,
    callerId: string,
    canViewAll: boolean,
  ): Promise<TimeEntry> {
    const entry = await this.findOne(organizationId, entryId);

    if (entry.userId !== callerId && !canViewAll) {
      throw new NotFoundException('Time entry not found in this organization');
    }

    return entry;
  }

  async findActive(
    organizationId: string,
    userId: string,
  ): Promise<TimeEntry | null> {
    return this.scopedQuery(organizationId)
      .andWhere('entry.user_id = :userId', { userId })
      .andWhere('entry.exit_time IS NULL')
      .getOne();
  }

  async startTimer(
    organizationId: string,
    userId: string,
    dto: StartTimerDto,
  ): Promise<TimeEntry> {
    await this.requireSubtaskInOrganization(organizationId, dto.subtaskId);

    const active = await this.findActive(organizationId, userId);
    if (active) {
      throw new ConflictException(
        'A timer is already running; stop it before starting a new one',
      );
    }

    const entryTime = dto.entryTime
      ? this.assertNotInFuture(new Date(dto.entryTime))
      : new Date();

    return this.timeEntryRepo.save(
      this.timeEntryRepo.create({
        subtaskId: dto.subtaskId,
        userId,
        entryTime,
        exitTime: null,
      }),
    );
  }

  async stopTimer(
    organizationId: string,
    userId: string,
    dto: StopTimerDto,
  ): Promise<TimeEntry> {
    const entry = dto.timeEntryId
      ? await this.findOwnedEntry(organizationId, dto.timeEntryId, userId)
      : await this.findActive(organizationId, userId);

    if (!entry) {
      throw new NotFoundException('No running timer found for this user');
    }

    if (entry.exitTime) {
      throw new ConflictException('This timer is already stopped');
    }

    const exitTime = dto.exitTime
      ? this.assertNotInFuture(new Date(dto.exitTime))
      : new Date();

    if (exitTime.getTime() < entry.entryTime.getTime()) {
      throw new BadRequestException('exit_time must be after entry_time');
    }

    entry.exitTime = exitTime;
    return this.timeEntryRepo.save(entry);
  }

  async create(
    organizationId: string,
    userId: string,
    dto: CreateTimeEntryDto,
  ): Promise<TimeEntry> {
    await this.requireSubtaskInOrganization(organizationId, dto.subtaskId);

    const entryTime = this.assertNotInFuture(new Date(dto.entryTime));
    let exitTime: Date | null = null;

    if (dto.exitTime) {
      exitTime = this.assertNotInFuture(new Date(dto.exitTime));
      if (exitTime.getTime() < entryTime.getTime()) {
        throw new BadRequestException('exit_time must be after entry_time');
      }
    } else {
      const active = await this.findActive(organizationId, userId);
      if (active) {
        throw new ConflictException(
          'A timer is already running; stop it before logging a manual entry',
        );
      }
    }

    return this.timeEntryRepo.save(
      this.timeEntryRepo.create({
        subtaskId: dto.subtaskId,
        userId,
        entryTime,
        exitTime,
      }),
    );
  }

  async update(
    organizationId: string,
    userId: string,
    entryId: string,
    dto: UpdateTimeEntryDto,
  ): Promise<TimeEntry> {
    const entry = await this.findOwnedEntry(organizationId, entryId, userId);

    const entryTime = dto.entryTime
      ? this.assertNotInFuture(new Date(dto.entryTime))
      : entry.entryTime;
    let exitTime = entry.exitTime;

    if (dto.exitTime === null) {
      exitTime = null;
    } else if (dto.exitTime) {
      exitTime = this.assertNotInFuture(new Date(dto.exitTime));
    }

    if (exitTime && exitTime.getTime() < entryTime.getTime()) {
      throw new BadRequestException('exit_time must be after entry_time');
    }

    entry.entryTime = entryTime;
    entry.exitTime = exitTime;

    return this.timeEntryRepo.save(entry);
  }

  /**
   * Soft-deletes one of the caller's own time entries.
   *
   * No confirmation: an entry is a leaf, it belongs to the person deleting it,
   * and it is the correction of a mistake rather than shared content. The
   * ownership check is unchanged, and the row is flagged so a mis-click is a
   * restore away.
   */
  async remove(
    organizationId: string,
    userId: string,
    entryId: string,
  ): Promise<void> {
    await this.findOwnedEntry(organizationId, entryId, userId);
    await softDeleteBy(
      this.timeEntryRepo,
      'id = :entryId',
      { entryId },
      userId,
      new Date(),
    );
  }

  /** Restores one of the caller's own deleted entries. */
  async restore(
    organizationId: string,
    userId: string,
    entryId: string,
  ): Promise<TimeEntry> {
    const entry = await this.findOwnedEntry(
      organizationId,
      entryId,
      userId,
      true,
    );

    const at = entry.deletedAt;

    if (!at) {
      throw new ConflictException('Time entry is not deleted');
    }

    // A live entry under a flagged subtask cannot be read: the subtask filter
    // hides it. Restoring the parent is the action that actually makes the work
    // visible again, so point the caller at that rather than producing a row
    // that looks restored and is not.
    const subtask = await this.subtaskRepo.findOne({
      where: { id: entry.subtaskId },
      withDeleted: true,
    });

    if (subtask?.deletedAt) {
      throw new ConflictException(
        'The subtask this entry was logged against is still deleted. Restore ' +
          'the subtask instead, which brings back the time logged against it.',
      );
    }

    await restoreBy(this.timeEntryRepo, 'id = :entryId', { entryId });

    return this.findOwnedEntry(organizationId, entryId, userId);
  }

  /** The caller's own deleted entries, newest first. */
  async listDeleted(
    organizationId: string,
    userId: string,
  ): Promise<TrashEntryDto[]> {
    // Subqueries, not joins: `withDeleted()` clears the soft-delete filter for
    // the root alias only, and TypeORM still writes `deleted_at IS NULL` into
    // the ON clause of each joined alias. A join would hide precisely the
    // entries whose subtask, task and project all went down together.
    const rows = await this.timeEntryRepo
      .createQueryBuilder('entry')
      .withDeleted()
      .where(
        `entry.subtask_id IN (
           SELECT id FROM subtasks
            WHERE task_id IN (
              SELECT id FROM tasks
               WHERE project_id IN (
                 SELECT id FROM projects WHERE organization_id = :organizationId
               )
            )
         )`,
        { organizationId },
      )
      .andWhere('entry.user_id = :userId', { userId })
      .andWhere('entry.deleted_at IS NOT NULL')
      .orderBy('entry.deleted_at', 'DESC')
      .getMany();

    return rows.map((row) => ({
      id: row.id,
      deletedAt: row.deletedAt as Date,
      deletedBy: row.deletedBy,
      resource: row.toResponse(),
    }));
  }

  /**
   * @param includeDeleted set by the restore path, where the row is expected to
   *   be flagged -- otherwise the lookup would 404 on the very row it is trying
   *   to bring back.
   */
  private async findOwnedEntry(
    organizationId: string,
    entryId: string,
    userId: string,
    includeDeleted = false,
  ): Promise<TimeEntry> {
    // The flagged lookup cannot use the join-based `scopedQuery`. `withDeleted()`
    // only clears the filter for the root alias, and TypeORM still writes
    // `deleted_at IS NULL` into the ON clause of every joined alias -- so a
    // restore would 404 on exactly the entry it is trying to bring back, since
    // its subtask, task and project are all flagged. Subqueries have no alias to
    // be filtered and see the rows as they are.
    const query = includeDeleted
      ? this.timeEntryRepo
          .createQueryBuilder('entry')
          .withDeleted()
          .where(
            `entry.subtask_id IN (
               SELECT id FROM subtasks
                WHERE task_id IN (
                  SELECT id FROM tasks
                   WHERE project_id IN (
                     SELECT id FROM projects
                      WHERE organization_id = :organizationId
                   )
                )
             )`,
            { organizationId },
          )
          .andWhere('entry.id = :entryId', { entryId })
      : this.scopedQuery(organizationId).andWhere('entry.id = :entryId', {
          entryId,
        });

    const entry = await query.getOne();

    if (!entry) {
      throw new NotFoundException('Time entry not found in this organization');
    }

    if (entry.userId !== userId) {
      throw new NotFoundException('Time entry not found in this organization');
    }

    return entry;
  }

  private scopedQuery(organizationId: string): SelectQueryBuilder<TimeEntry> {
    return this.timeEntryRepo
      .createQueryBuilder('entry')
      .innerJoin(Subtask, 'subtask', 'subtask.id = entry.subtask_id')
      .innerJoin(Task, 'task', 'task.id = subtask.task_id')
      .innerJoin(Project, 'project', 'project.id = task.project_id')
      .where('project.organization_id = :organizationId', { organizationId });
  }

  private async requireSubtaskInOrganization(
    organizationId: string,
    subtaskId: string,
  ): Promise<Subtask> {
    const subtask = await this.subtaskRepo
      .createQueryBuilder('subtask')
      .innerJoin(Task, 'task', 'task.id = subtask.task_id')
      .innerJoin(Project, 'project', 'project.id = task.project_id')
      .where('subtask.id = :subtaskId', { subtaskId })
      .andWhere('project.organization_id = :organizationId', {
        organizationId,
      })
      .getOne();

    if (!subtask) {
      throw new NotFoundException('Subtask not found in this organization');
    }

    return subtask;
  }

  private assertNotInFuture(date: Date): Date {
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException('Invalid date');
    }
    if (date.getTime() > Date.now()) {
      throw new BadRequestException('Timestamps cannot be in the future');
    }
    return date;
  }
}
