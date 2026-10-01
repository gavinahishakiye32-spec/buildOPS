import {
  BadRequestException,
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
import { TeamService } from '../team/team.service.js';
import { Subtask } from './subtask.entity.js';
import {
  CreateSubtaskDto,
  SubtaskQueryDto,
  UpdateSubtaskDto,
} from '../task/dto/task.dto.js';
import { Task } from '../task/task.entity.js';

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
    private readonly teamService: TeamService,
  ) {}

  async list(
    organizationId: string,
    taskId: string,
    query: SubtaskQueryDto,
  ): Promise<Paginated<Subtask>> {
    const { page, limit, skip } = resolvePage(query);
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

  async remove(organizationId: string, subtaskId: string): Promise<void> {
    await this.findOne(organizationId, subtaskId);
    await this.subtaskRepo.delete(subtaskId);
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
