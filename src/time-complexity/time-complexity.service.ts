import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository, SelectQueryBuilder } from 'typeorm';
import { parseIntervalSeconds, secondsToInterval } from '../common/duration.js';
import {
  resolvePage,
  toPaginated,
  type Paginated,
} from '../common/pagination.dto.js';
import { TIME_COMPLEXITY_VARIANCES } from '../common/enums.js';
import { Project } from '../project/project.entity.js';
import { Subtask } from '../subtask/subtask.entity.js';
import { Task } from '../task/task.entity.js';
import { TimeEntry } from '../time-entry/time-entry.entity.js';
import { TimeComplexity } from './time-complexity.entity.js';
import {
  CreateTimeComplexityDto,
  TimeComplexityQueryDto,
  UpdateTimeComplexityDto,
  VarianceRowDto,
} from './dto/time-complexity.dto.js';

type VarianceRow = Omit<VarianceRowDto, 'variance'> & {
  variance: string | null;
};

@Injectable()
export class TimeComplexityService {
  constructor(
    @InjectRepository(TimeComplexity)
    private readonly timeComplexityRepo: Repository<TimeComplexity>,
    @InjectRepository(Task)
    private readonly taskRepo: Repository<Task>,
    @InjectRepository(Subtask)
    private readonly subtaskRepo: Repository<Subtask>,
    @InjectRepository(TimeEntry)
    private readonly timeEntryRepo: Repository<TimeEntry>,
  ) {}

  async list(
    organizationId: string,
    query: TimeComplexityQueryDto,
  ): Promise<Paginated<TimeComplexity>> {
    const { page, limit, skip } = resolvePage(query);
    const qb = this.scopedQuery(organizationId);

    if (query.taskId) {
      qb.andWhere('tc.task_id = :taskId', { taskId: query.taskId });
    }
    if (query.subtaskId) {
      qb.andWhere('tc.subtask_id = :subtaskId', { subtaskId: query.subtaskId });
    }
    if (query.name) {
      qb.andWhere('tc.name = :name', { name: query.name });
    }
    if (query.status) {
      qb.andWhere('tc.status = :status', { status: query.status });
    }

    // `time_complexity` has no timestamp column, so the primary key is the only
    // stable order available; ordering by `created_at` here made every read of
    // this collection fail against a real database.
    const [items, total] = await qb
      .orderBy('tc.id', 'ASC')
      .skip(skip)
      .take(limit)
      .getManyAndCount();

    return toPaginated(items, total, page, limit);
  }

  async findOne(
    organizationId: string,
    complexityId: string,
  ): Promise<TimeComplexity> {
    const complexity = await this.scopedQuery(organizationId)
      .andWhere('tc.id = :complexityId', { complexityId })
      .getOne();

    if (!complexity) {
      throw new NotFoundException(
        'Time complexity not found in this organization',
      );
    }

    return complexity;
  }

  async create(
    organizationId: string,
    dto: CreateTimeComplexityDto,
  ): Promise<TimeComplexity> {
    const task = await this.requireTask(organizationId, dto.taskId);
    const subtaskId = await this.resolveSubtask(task, dto.subtaskId);
    const status = dto.status ?? 'active';

    this.assertEnvelope(dto.minDuration, dto.maxDuration);

    if (status === 'active') {
      await this.assertNoActiveDuplicate(task.id, subtaskId);
    }

    return this.timeComplexityRepo.save(
      this.timeComplexityRepo.create({
        taskId: task.id,
        subtaskId,
        name: dto.name,
        status,
        minDuration: secondsToInterval(dto.minDuration),
        maxDuration: secondsToInterval(dto.maxDuration),
      }),
    );
  }

  async update(
    organizationId: string,
    complexityId: string,
    dto: UpdateTimeComplexityDto,
  ): Promise<TimeComplexity> {
    const complexity = await this.findOne(organizationId, complexityId);

    const minDuration =
      dto.minDuration ?? parseIntervalSeconds(complexity.minDuration);
    const maxDuration =
      dto.maxDuration ?? parseIntervalSeconds(complexity.maxDuration);
    const status = dto.status ?? complexity.status;

    this.assertEnvelope(minDuration, maxDuration);

    if (status === 'active') {
      await this.assertNoActiveDuplicate(
        complexity.taskId,
        complexity.subtaskId,
        complexity.id,
      );
    }

    if (dto.name !== undefined) {
      complexity.name = dto.name;
    }
    complexity.status = status;
    complexity.minDuration = secondsToInterval(minDuration);
    complexity.maxDuration = secondsToInterval(maxDuration);

    await this.timeComplexityRepo.save(complexity);
    return this.findOne(organizationId, complexityId);
  }

  async remove(organizationId: string, complexityId: string): Promise<void> {
    await this.findOne(organizationId, complexityId);
    await this.timeComplexityRepo.delete(complexityId);
  }

  /**
   * Compares actual logged time per subtask with the applicable estimation
   * envelope (spec §13 / §14.16): subtask-level record first, then task-level.
   */
  async variance(
    organizationId: string,
    taskId: string,
  ): Promise<VarianceRow[]> {
    const task = await this.requireTask(organizationId, taskId);

    const subtasks = await this.subtaskRepo.find({
      where: { taskId: task.id },
      order: { createdAt: 'ASC' },
    });

    if (subtasks.length === 0) {
      return [];
    }

    const subtaskIds = subtasks.map((subtask) => subtask.id);

    const entries = await this.timeEntryRepo.find({
      where: subtaskIds.map((subtaskId) => ({ subtaskId })),
    });

    const actualBySubtask = new Map<string, number>();
    for (const entry of entries) {
      actualBySubtask.set(
        entry.subtaskId,
        (actualBySubtask.get(entry.subtaskId) ?? 0) + entry.durationSeconds(),
      );
    }

    const envelopes = await this.timeComplexityRepo.find({
      where: [
        { taskId: task.id, status: 'active' },
        { taskId: task.id, subtaskId: In(subtaskIds), status: 'active' },
      ],
    });

    const envelopeBySubtask = new Map<string, TimeComplexity>();
    let taskEnvelope: TimeComplexity | null = null;

    for (const envelope of envelopes) {
      if (envelope.subtaskId) {
        envelopeBySubtask.set(envelope.subtaskId, envelope);
      } else if (!taskEnvelope) {
        taskEnvelope = envelope;
      }
    }

    return subtasks.map((subtask) => {
      const envelope =
        envelopeBySubtask.get(subtask.id) ?? taskEnvelope ?? undefined;
      const actualSeconds = actualBySubtask.get(subtask.id) ?? 0;

      if (!envelope) {
        return {
          subtaskId: subtask.id,
          title: subtask.title,
          actualSeconds,
          minSeconds: null,
          maxSeconds: null,
          variance: null,
        };
      }

      const minSeconds = parseIntervalSeconds(envelope.minDuration);
      const maxSeconds = parseIntervalSeconds(envelope.maxDuration);

      return {
        subtaskId: subtask.id,
        title: subtask.title,
        actualSeconds,
        minSeconds,
        maxSeconds,
        variance: this.compareVariance(actualSeconds, minSeconds, maxSeconds),
      };
    });
  }

  private compareVariance(
    actualSeconds: number,
    minSeconds: number,
    maxSeconds: number,
  ): (typeof TIME_COMPLEXITY_VARIANCES)[number] {
    if (actualSeconds < minSeconds) {
      return 'under';
    }
    if (actualSeconds > maxSeconds) {
      return 'over';
    }
    return 'within';
  }

  private assertEnvelope(minDuration: number, maxDuration: number): void {
    if (minDuration > maxDuration) {
      throw new BadRequestException(
        'min_duration must be less than or equal to max_duration',
      );
    }
  }

  private async assertNoActiveDuplicate(
    taskId: string,
    subtaskId: string | null,
    ignoreId?: string,
  ): Promise<void> {
    const existing = await this.timeComplexityRepo
      .createQueryBuilder('tc')
      .where('tc.task_id = :taskId', { taskId })
      .andWhere('tc.status = :status', { status: 'active' })
      .andWhere(
        subtaskId ? 'tc.subtask_id = :subtaskId' : 'tc.subtask_id IS NULL',
        { subtaskId },
      )
      .getOne();

    if (existing && existing.id !== ignoreId) {
      throw new ConflictException(
        'An active time complexity already exists for this task/subtask combination',
      );
    }
  }

  private async resolveSubtask(
    task: Task,
    subtaskId?: string,
  ): Promise<string | null> {
    if (!subtaskId) {
      return null;
    }

    const subtask = await this.subtaskRepo.findOne({
      where: { id: subtaskId, taskId: task.id },
    });

    if (!subtask) {
      throw new BadRequestException(
        'Subtask does not belong to the referenced task',
      );
    }

    return subtask.id;
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

  private scopedQuery(
    organizationId: string,
  ): SelectQueryBuilder<TimeComplexity> {
    return this.timeComplexityRepo
      .createQueryBuilder('tc')
      .innerJoin(Task, 'task', 'task.id = tc.task_id')
      .innerJoin(Project, 'project', 'project.id = task.project_id')
      .where('project.organization_id = :organizationId', { organizationId });
  }
}
