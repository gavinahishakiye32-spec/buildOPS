import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Not, Repository } from 'typeorm';
import {
  resolvePage,
  toPaginated,
  type Paginated,
} from '../common/pagination.dto.js';
import { PlanLimitService } from '../plan-limit/plan-limit.service.js';
import { Client } from '../client/client.entity.js';
import { Task } from '../task/task.entity.js';
import { Subtask } from '../subtask/subtask.entity.js';
import { TimeEntry } from '../time-entry/time-entry.entity.js';
import { Project } from './project.entity.js';
import {
  CASCADE_CONFIRMATION_REQUIRED,
  restoreBy,
  softDeleteBy,
  type TrashEntryDto,
} from '../common/soft-delete.js';
import {
  CreateProjectDto,
  ProjectQueryDto,
  UpdateProjectDto,
} from './dto/project.dto.js';

/**
 * Projects belong to an organization and are connected to a client (spec §9).
 * Creation is bounded by the plan limit `max_projects`.
 */
@Injectable()
export class ProjectService {
  constructor(
    @InjectRepository(Project)
    private readonly projectRepo: Repository<Project>,
    @InjectRepository(Client)
    private readonly clientRepo: Repository<Client>,
    @InjectRepository(Task)
    private readonly taskRepo: Repository<Task>,
    @InjectRepository(Subtask)
    private readonly subtaskRepo: Repository<Subtask>,
    @InjectRepository(TimeEntry)
    private readonly timeEntryRepo: Repository<TimeEntry>,
    private readonly planLimits: PlanLimitService,
  ) {}

  async list(
    organizationId: string,
    query: ProjectQueryDto,
  ): Promise<Paginated<Project>> {
    const { page, limit, skip } = resolvePage(query);

    const where: Record<string, unknown> = { organizationId };
    if (query.status) {
      where.status = query.status;
    }
    if (query.clientId) {
      where.clientId = query.clientId;
    }

    const [items, total] = await this.projectRepo.findAndCount({
      where,
      order: { name: 'ASC' },
      skip,
      take: limit,
    });

    return toPaginated(items, total, page, limit);
  }

  async findOne(organizationId: string, projectId: string): Promise<Project> {
    const project = await this.projectRepo.findOne({
      where: { id: projectId, organizationId },
    });

    if (!project) {
      throw new NotFoundException('Project not found in this organization');
    }

    return project;
  }

  async create(
    organizationId: string,
    dto: CreateProjectDto,
  ): Promise<Project> {
    const subscription =
      await this.planLimits.requireByOrganizationId(organizationId);

    const clientId = await this.resolveClient(organizationId, dto.clientId);
    this.assertDateOrder(dto.startDate, dto.endDate);

    // The tenant row is locked for the check and the insert together, so
    // concurrent creations cannot both slip past `max_projects`.
    return this.planLimits.locked(
      subscription.id,
      async (limits, current) => {
        await limits.assertCanConsume(current, 'projects');

        const projects = limits.manager.getRepository(Project);
        return projects.save(
          projects.create({
            organizationId,
            clientId,
            name: dto.name.trim(),
            description: dto.description ?? null,
            status: dto.status ?? 'planned',
            startDate: dto.startDate ? new Date(dto.startDate) : null,
            endDate: dto.endDate ? new Date(dto.endDate) : null,
            budget: dto.budget === undefined ? null : dto.budget.toFixed(2),
          }),
        );
      },
    );
  }

  async update(
    organizationId: string,
    projectId: string,
    dto: UpdateProjectDto,
  ): Promise<Project> {
    const project = await this.findOne(organizationId, projectId);

    if (dto.name !== undefined) {
      project.name = dto.name.trim();
    }
    if (dto.description !== undefined) {
      project.description = dto.description;
    }
    if (dto.clientId !== undefined) {
      project.clientId = await this.resolveClient(
        organizationId,
        dto.clientId ?? undefined,
      );
    }
    if (dto.status !== undefined) {
      project.status = dto.status;
    }
    if (dto.startDate !== undefined) {
      project.startDate = dto.startDate ? new Date(dto.startDate) : null;
    }
    if (dto.endDate !== undefined) {
      project.endDate = dto.endDate ? new Date(dto.endDate) : null;
    }
    if (dto.budget !== undefined) {
      project.budget = dto.budget === null ? null : dto.budget.toFixed(2);
    }

    this.assertDateOrder(project.startDate, project.endDate);

    return this.projectRepo.save(project);
  }

  /**
   * Soft-deletes a project and everything under it.
   *
   * This is the widest delete in the app: tasks, their subtasks, and every hour
   * logged against those subtasks. Before soft deletion that was a single
   * `DELETE FROM projects` and fourteen cascading foreign keys, with no record
   * that it had happened. Now it is a flag, the work comes back with the
   * project, and the confirmation makes the caller state plainly that it means
   * to take the contents.
   *
   * `planLimits` is consulted on the way in because deleting a project frees a
   * quota slot. That check is not the reason for the confirmation, but a
   * downgrade immediately after a mass delete should be refused rather than
   * quietly allowed.
   */
  async remove(
    organizationId: string,
    projectId: string,
    actorId: string,
    confirmed: boolean,
  ): Promise<{ deleted: number }> {
    await this.findOne(organizationId, projectId);

    if (!confirmed) {
      throw new ConflictException(CASCADE_CONFIRMATION_REQUIRED);
    }

    const at = new Date();

    // One transaction for the whole tree, deepest rows first. A partial cascade
    // is worse than no cascade: the flag is what restore keys off, so a
    // half-applied delete would restore a project with missing hours and nobody
    // would be able to say which ones went missing.
    return this.projectRepo.manager.transaction(async (manager) => {
      const projectRepo = manager.getRepository(Project);
      const taskRepo = manager.getRepository(Task);
      const subtaskRepo = manager.getRepository(Subtask);
      const timeEntryRepo = manager.getRepository(TimeEntry);

      // Collected inside the transaction so the ids and the flagging see the
      // same snapshot; a task created mid-delete belongs to one side or the
      // other, never to both.
      const taskIds = (
        await taskRepo.find({ where: { projectId, deletedAt: IsNull() } })
      ).map((task) => task.id);

      const subtaskIds = taskIds.length
        ? (
            await subtaskRepo.find({
              where: { taskId: In(taskIds), deletedAt: IsNull() },
            })
          ).map((subtask) => subtask.id)
        : [];

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

      if (taskIds.length) {
        await softDeleteBy(taskRepo, 'id IN (:...taskIds)', { taskIds }, actorId, at);
      }

      await softDeleteBy(
        projectRepo,
        'id = :projectId',
        { projectId },
        actorId,
        at,
      );

      return { deleted: entries + subtaskIds.length + taskIds.length + 1 };
    });
  }

  /**
   * Restores a project and exactly the descendants that went down with it.
   *
   * The shared timestamp is what makes this safe. Restoring "everything under
   * this project" by parent id alone would also bring back a task somebody
   * deleted deliberately a week later, which is the kind of bug that makes
   * people stop trusting a restore button.
   */
  async restore(organizationId: string, projectId: string): Promise<Project> {
    const project = await this.projectRepo.findOne({
      where: { id: projectId, organizationId },
      withDeleted: true,
    });

    if (!project) {
      throw new NotFoundException('Project not found');
    }

    if (!project.deletedAt) {
      throw new ConflictException('Project is not deleted');
    }

    const at = project.deletedAt;

    // Same reasoning as the delete, and the reason for a transaction: a restore
    // either reassembles the set that shared a timestamp or it does not. Four
    // separate writes would leave a project live with no tasks if the third one
    // failed, which is a broken tree rather than a recoverable one.
    await this.projectRepo.manager.transaction(async (manager) => {
      const projectRepo = manager.getRepository(Project);
      const taskRepo = manager.getRepository(Task);
      const subtaskRepo = manager.getRepository(Subtask);
      const timeEntryRepo = manager.getRepository(TimeEntry);

      const taskIds = (
        await taskRepo.find({
          where: { projectId, deletedAt: at },
          withDeleted: true,
        })
      ).map((task) => task.id);

      const subtaskIds = taskIds.length
        ? (
            await subtaskRepo.find({
              where: { taskId: In(taskIds), deletedAt: at },
              withDeleted: true,
            })
          ).map((subtask) => subtask.id)
        : [];

      if (subtaskIds.length) {
        await restoreBy(
          timeEntryRepo,
          'subtask_id IN (:...subtaskIds) AND deleted_at = :at',
          { subtaskIds, at },
        );
        await restoreBy(subtaskRepo, 'id IN (:...subtaskIds)', { subtaskIds });
      }

      if (taskIds.length) {
        await restoreBy(taskRepo, 'id IN (:...taskIds)', { taskIds });
      }

      await restoreBy(projectRepo, 'id = :projectId', { projectId });
    });

    return this.findOne(organizationId, projectId);
  }

  async listDeleted(organizationId: string): Promise<TrashEntryDto[]> {
    const rows = await this.projectRepo.find({
      where: { organizationId, deletedAt: Not(IsNull()) },
      order: { deletedAt: 'DESC' },
      withDeleted: true,
    });

    return rows.map((row) => ({
      id: row.id,
      deletedAt: row.deletedAt as Date,
      deletedBy: row.deletedBy,
      resource: row.toResponse(),
    }));
  }

  /** Client ownership is validated in the service layer even with a FK (spec §16). */
  private async resolveClient(
    organizationId: string,
    clientId?: string,
  ): Promise<string | null> {
    if (!clientId) {
      return null;
    }

    const client = await this.clientRepo.findOne({
      where: { id: clientId, organizationId },
    });

    if (!client) {
      throw new NotFoundException('Client not found in this organization');
    }

    return client.id;
  }

  private assertDateOrder(
    startDate: Date | string | null | undefined,
    endDate: Date | string | null | undefined,
  ): void {
    if (!startDate || !endDate) {
      return;
    }

    const start = new Date(startDate).getTime();
    const end = new Date(endDate).getTime();

    if (start > end) {
      throw new BadRequestException(
        'startDate must be before or equal to endDate',
      );
    }
  }
}
