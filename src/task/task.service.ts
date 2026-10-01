import {
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
import { Badge } from '../badge/badge.entity.js';
import { Project } from '../project/project.entity.js';
import { Team } from '../team/team.entity.js';
import { Task } from './task.entity.js';
import { CreateTaskDto, TaskQueryDto, UpdateTaskDto } from './dto/task.dto.js';

/**
 * Tasks belong to a project of the organization and are assigned to a team of
 * the same organization, optionally classified by a badge (spec §10). The
 * organization is always derived from the project, never from client input.
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

  async create(organizationId: string, dto: CreateTaskDto): Promise<Task> {
    const project = await this.requireProject(organizationId, dto.projectId);
    const teamId = await this.resolveTeam(organizationId, dto.teamId);
    const badgeId = await this.resolveBadge(organizationId, dto.badgeId);

    return this.taskRepo.save(
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

  async remove(organizationId: string, taskId: string): Promise<void> {
    await this.findOne(organizationId, taskId);
    await this.taskRepo.delete(taskId);
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