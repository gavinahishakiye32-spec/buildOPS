import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Not, Repository } from 'typeorm';
import {
  resolvePage,
  toPaginated,
  type Paginated,
} from '../common/pagination.dto.js';
import { NotificationService } from '../notification/notification.service.js';
import { Project } from '../project/project.entity.js';
import { Task } from '../task/task.entity.js';
import {
  restoreBy,
  softDeleteBy,
  type TrashEntryDto,
} from '../common/soft-delete.js';
import { Milestone } from './milestone.entity.js';
import {
  CreateMilestoneDto,
  MilestoneQueryDto,
  UpdateMilestoneDto,
} from './dto/milestone.dto.js';

/**
 * Milestones are deadlines a project's tasks are grouped under. They belong to
 * a project of the organization, and the organization is derived from the
 * project, never from client input. Deleting a milestone detaches its tasks
 * (`milestone_id` becomes NULL) instead of hiding them: a milestone is a
 * calendar entry, and removing a calendar entry must not remove the work
 * that was scheduled against it.
 */
@Injectable()
export class MilestoneService {
  private readonly logger = new Logger(MilestoneService.name);

  constructor(
    @InjectRepository(Milestone)
    private readonly milestoneRepo: Repository<Milestone>,
    @InjectRepository(Project)
    private readonly projectRepo: Repository<Project>,
    @InjectRepository(Task)
    private readonly taskRepo: Repository<Task>,
    private readonly notificationService: NotificationService,
  ) {}

  async list(
    organizationId: string,
    query: MilestoneQueryDto,
  ): Promise<Paginated<Milestone>> {
    const { page, limit, skip } = resolvePage(query);

    const where: Record<string, unknown> = { organizationId };
    if (query.status) {
      where.status = query.status;
    }
    if (query.projectId) {
      where.projectId = query.projectId;
    }

    const [items, total] = await this.milestoneRepo.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      skip,
      take: limit,
    });

    return toPaginated(items, total, page, limit);
  }

  async findOne(organizationId: string, milestoneId: string): Promise<Milestone> {
    const milestone = await this.milestoneRepo.findOne({
      where: { id: milestoneId, organizationId },
    });

    if (!milestone) {
      throw new NotFoundException('Milestone not found in this organization');
    }

    return milestone;
  }

  async create(
    organizationId: string,
    actorId: string,
    dto: CreateMilestoneDto,
  ): Promise<Milestone> {
    const project = await this.requireProject(organizationId, dto.projectId);

    const milestone = await this.milestoneRepo.save(
      this.milestoneRepo.create({
        organizationId,
        projectId: project.id,
        name: dto.name.trim(),
        description: dto.description ?? null,
        status: dto.status ?? 'planned',
        dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
      }),
    );

    await this.notifyBroadcast(
      organizationId,
      actorId,
      'milestone.created',
      `Milestone "${milestone.name}" created`,
      `A new milestone "${milestone.name}" was added to the project.`,
      {
        milestoneId: milestone.id,
        projectId: milestone.projectId,
        name: milestone.name,
        status: milestone.status,
      },
    );

    return milestone;
  }

  async update(
    organizationId: string,
    milestoneId: string,
    actorId: string,
    dto: UpdateMilestoneDto,
  ): Promise<Milestone> {
    const milestone = await this.findOne(organizationId, milestoneId);

    if (dto.name !== undefined) {
      milestone.name = dto.name.trim();
    }
    if (dto.description !== undefined) {
      milestone.description = dto.description;
    }
    if (dto.status !== undefined) {
      milestone.status = dto.status;
    }
    if (dto.dueDate !== undefined) {
      milestone.dueDate = dto.dueDate ? new Date(dto.dueDate) : null;
    }

    await this.milestoneRepo.save(milestone);

    await this.notifyBroadcast(
      organizationId,
      actorId,
      'milestone.updated',
      `Milestone "${milestone.name}" updated`,
      `Milestone "${milestone.name}" was changed.`,
      {
        milestoneId: milestone.id,
        projectId: milestone.projectId,
        name: milestone.name,
        status: milestone.status,
      },
    );

    return this.findOne(organizationId, milestoneId);
  }

  /**
   * Soft-deletes a milestone and detaches the tasks scheduled against it.
   *
   * No cascade confirmation here, unlike tasks and projects: nothing is
   * destroyed. Tasks keep their `milestone_id` value only while the milestone
   * is alive -- for the trash and the restore both, a task stays in whatever
   * milestone its latest edit left it in, because detaching is not a deletion
   * and the restore must not relink work the caller may have repointed since.
   */
  async remove(
    organizationId: string,
    milestoneId: string,
    actorId: string,
  ): Promise<{ deleted: number }> {
    const milestone = await this.findOne(organizationId, milestoneId);

    const at = new Date();

    const result = await this.milestoneRepo.manager.transaction(async (manager) => {
      const milestoneRepo = manager.getRepository(Milestone);
      const taskRepo = manager.getRepository(Task);

      // Only live tasks are detached. A task that was already deleted is
      // untouched: nothing it holds a reference to should be relinked later.
      const taskIds = (
        await taskRepo.find({ where: { milestoneId, deletedAt: IsNull() } })
      ).map((task) => task.id);

      if (taskIds.length) {
        await taskRepo.update({ id: In(taskIds) }, { milestoneId: null });
      }

      await softDeleteBy(
        milestoneRepo,
        'id = :milestoneId',
        { milestoneId },
        actorId,
        at,
      );

      return { deleted: taskIds.length + 1 };
    });

    await this.notifyBroadcast(
      organizationId,
      actorId,
      'milestone.deleted',
      `Milestone "${milestone.name}" deleted`,
      `Milestone "${milestone.name}" was deleted.`,
      {
        milestoneId: milestone.id,
        projectId: milestone.projectId,
        name: milestone.name,
        status: milestone.status,
      },
    );

    return result;
  }

  /** Restores a soft-deleted milestone. Tasks it was detached from stay as they are. */
  async restore(
    organizationId: string,
    milestoneId: string,
    actorId: string,
  ): Promise<Milestone> {
    const milestone = await this.milestoneRepo.findOne({
      where: { id: milestoneId, organizationId },
      withDeleted: true,
    });

    if (!milestone) {
      throw new NotFoundException('Milestone not found');
    }

    if (!milestone.deletedAt) {
      throw new ConflictException('Milestone is not deleted');
    }

    // Same reasoning as the task level: a live milestone under a flagged
    // project cannot be seen by any read, and a row the user cannot see is
    // worse than one still in the trash. The project is the unit the user
    // deleted, so it is the unit they restore.
    if (milestone.organizationId === organizationId) {
      const project = await this.projectRepo.findOne({
        where: { id: milestone.projectId },
        withDeleted: true,
      });

      if (project?.deletedAt) {
        throw new ConflictException(
          'The project this milestone belongs to is still deleted. Restore the ' +
            'project instead, which brings back everything that went with it.',
        );
      }
    }

    await restoreBy(this.milestoneRepo, 'id = :milestoneId', { milestoneId });

    const restored = await this.findOne(organizationId, milestoneId);

    await this.notifyBroadcast(
      organizationId,
      actorId,
      'milestone.restored',
      `Milestone "${restored.name}" restored`,
      `Milestone "${restored.name}" was brought back from the trash.`,
      {
        milestoneId: restored.id,
        projectId: restored.projectId,
        name: restored.name,
        status: restored.status,
      },
    );

    return restored;
  }

  async listDeleted(organizationId: string): Promise<TrashEntryDto[]> {
    const rows = await this.milestoneRepo.find({
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

  /** A milestone the task references must exist in the organization AND the project. */
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

  /**
   * Broadcasts a lifecycle event to the organization's owners and project
   * managers, best-effort. The broadcast guards each recipient; this guard
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
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Broadcast not delivered kind=${kind}: ${message}`);
    }
  }
}