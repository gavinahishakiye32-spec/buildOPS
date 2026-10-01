import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Client } from '../client/client.entity.js';
import { parseIntervalSeconds } from '../common/duration.js';
import { Project } from '../project/project.entity.js';
import { Subtask } from '../subtask/subtask.entity.js';
import { Task } from '../task/task.entity.js';
import { TimeComplexity } from '../time-complexity/time-complexity.entity.js';
import { TimeEntry } from '../time-entry/time-entry.entity.js';
import { User } from '../user/user.entity.js';
import {
  BreakdownQueryDto,
  ClientSummaryDto,
  DashboardClientListDto,
  DashboardOverviewDto,
  DashboardOverdueDto,
  DashboardProjectListDto,
  DashboardQueryDto,
  OverdueSubtaskDto,
  ProjectProgressDto,
  StatusCountDto,
  TimeGroupDto,
  VarianceSummaryDto,
} from './dto/dashboard.dto.js';

const DEFAULT_RANGE_DAYS = 30;
const MAX_RANGE_DAYS = 366;
const OVERDUE_LIMIT = 50;
const GROUP_LIMIT = 200;
const PROJECT_LIMIT = 100;
const CLOSED_SUBTASK_STATUSES = ['done', 'cancelled'];

interface Range {
  from: Date;
  to: Date;
}

interface Snapshot {
  range: Range;
  projects: Project[];
  tasks: Task[];
  subtasks: Subtask[];
  entries: TimeEntry[];
  secondsBySubtask: Map<string, number>;
}

/**
 * Read-only aggregation layer (roadmap step 12, spec §14.15). Every figure is
 * derived from organization-scoped rows only, joined back through
 * project.organization_id, so nothing here can leak across tenants.
 */
@Injectable()
export class DashboardService {
  constructor(
    @InjectRepository(Project)
    private readonly projectRepo: Repository<Project>,
    @InjectRepository(Task)
    private readonly taskRepo: Repository<Task>,
    @InjectRepository(Subtask)
    private readonly subtaskRepo: Repository<Subtask>,
    @InjectRepository(TimeEntry)
    private readonly timeEntryRepo: Repository<TimeEntry>,
    @InjectRepository(TimeComplexity)
    private readonly timeComplexityRepo: Repository<TimeComplexity>,
    @InjectRepository(Client)
    private readonly clientRepo: Repository<Client>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) {}

  async overview(
    organizationId: string,
    query: DashboardQueryDto,
  ): Promise<DashboardOverviewDto> {
    const snapshot = await this.snapshot(organizationId, query);
    const { tasks, subtasks, entries, secondsBySubtask } = snapshot;
    const totalSeconds = [...secondsBySubtask.values()].reduce(
      (sum, value) => sum + value,
      0,
    );
    const completedTasks = tasks.filter(
      (task) => task.status === 'done',
    ).length;

    return {
      from: snapshot.range.from.toISOString(),
      to: snapshot.range.to.toISOString(),
      projects: snapshot.projects.length,
      tasks: tasks.length,
      subtasks: subtasks.length,
      timeEntries: entries.length,
      totalSeconds,
      tasksByStatus: countBy(tasks, (task) => task.status),
      subtasksByStatus: countBy(subtasks, (subtask) => subtask.status),
      tasksByPriority: countBy(tasks, (task) => task.priority),
      timeByGroup: await this.timeByGroup(snapshot, query.groupBy ?? 'user'),
      variance: await this.varianceSummary(snapshot),
      completionRate: tasks.length ? round2(completedTasks / tasks.length) : 0,
      averageSecondsPerEntry: entries.length
        ? Math.round(totalSeconds / entries.length)
        : 0,
    };
  }

  async projects(
    organizationId: string,
    query: DashboardQueryDto,
  ): Promise<DashboardProjectListDto> {
    const snapshot = await this.snapshot(organizationId, query);

    const items: ProjectProgressDto[] = snapshot.projects.map((project) => {
      const tasks = snapshot.tasks.filter(
        (task) => task.projectId === project.id,
      );
      const taskIds = new Set(tasks.map((task) => task.id));
      const subtasks = snapshot.subtasks.filter((subtask) =>
        taskIds.has(subtask.taskId),
      );
      const subtaskIds = new Set(subtasks.map((subtask) => subtask.id));
      const completedTasks = tasks.filter(
        (task) => task.status === 'done',
      ).length;
      const completedSubtasks = subtasks.filter(
        (subtask) => subtask.status === 'done',
      ).length;

      return {
        projectId: project.id,
        name: project.name,
        status: project.status,
        tasks: tasks.length,
        completedTasks,
        subtasks: subtasks.length,
        completedSubtasks,
        completionRate:
          tasks.length > 0 ? round2(completedTasks / tasks.length) : null,
        totalSeconds: [...subtaskIds].reduce(
          (sum, subtaskId) =>
            sum + (snapshot.secondsBySubtask.get(subtaskId) ?? 0),
          0,
        ),
        startDate: toDateOnly(project.startDate),
        endDate: toDateOnly(project.endDate),
      };
    });

    return { total: items.length, items };
  }

  async clients(
    organizationId: string,
    query: DashboardQueryDto,
  ): Promise<DashboardClientListDto> {
    const snapshot = await this.snapshot(organizationId, query);
    const clients = await this.clientRepo.find({
      where: { organizationId },
      order: { name: 'ASC' },
    });

    const items: ClientSummaryDto[] = clients.map((client) => {
      const clientProjects = snapshot.projects.filter(
        (project) => project.clientId === client.id,
      );
      const clientProjectIds = new Set(
        clientProjects.map((project) => project.id),
      );

      const clientSubtaskIds = new Set(
        snapshot.subtasks
          .filter((subtask) => {
            const task = this.taskOfSubtask(snapshot, subtask.id);
            return task ? clientProjectIds.has(task.projectId) : false;
          })
          .map((subtask) => subtask.id),
      );

      return {
        clientId: client.id,
        name: client.name,
        status: client.status,
        projects: clientProjects.length,
        totalSeconds: [...clientSubtaskIds].reduce(
          (sum, subtaskId) =>
            sum + (snapshot.secondsBySubtask.get(subtaskId) ?? 0),
          0,
        ),
      };
    });

    items.sort((a, b) => b.totalSeconds - a.totalSeconds);

    return { total: items.length, items };
  }

  async overdue(
    organizationId: string,
    query: BreakdownQueryDto,
  ): Promise<DashboardOverdueDto> {
    const today = startOfDay(new Date());

    const qb = this.subtaskRepo
      .createQueryBuilder('subtask')
      .innerJoin(Task, 'task', 'task.id = subtask.task_id')
      .innerJoin(Project, 'project', 'project.id = task.project_id')
      .where('project.organization_id = :organizationId', { organizationId })
      .andWhere('subtask.due_date IS NOT NULL')
      .andWhere('subtask.due_date < :today', { today })
      .andWhere('subtask.status NOT IN (:...closed)', {
        closed: CLOSED_SUBTASK_STATUSES,
      });

    if (query.from) {
      qb.andWhere('subtask.due_date >= :from', {
        from: startOfDay(new Date(query.from)),
      });
    }
    if (query.to) {
      qb.andWhere('subtask.due_date <= :to', {
        to: endOfDay(new Date(query.to)),
      });
    }

    const subtasks = await qb
      .orderBy('subtask.due_date', 'ASC')
      .take(OVERDUE_LIMIT)
      .getMany();

    if (subtasks.length === 0) {
      return { total: 0, items: [] };
    }

    const tasks = await this.taskRepo.find({
      where: subtasks.map((subtask) => ({ id: subtask.taskId })),
    });
    const priorityByTask = new Map(
      tasks.map((task) => [task.id, task.priority]),
    );

    const items: OverdueSubtaskDto[] = subtasks.map((subtask) => {
      const dueDate = startOfDay(new Date(subtask.dueDate as Date));
      const dueDateOnly = toDateOnly(subtask.dueDate) ?? '';

      return {
        subtaskId: subtask.id,
        title: subtask.title,
        status: subtask.status,
        dueDate: dueDateOnly,
        daysOverdue: Math.max(
          0,
          Math.floor((today.getTime() - dueDate.getTime()) / 86400000),
        ),
        priority: priorityByTask.get(subtask.taskId) ?? null,
      };
    });

    return { total: items.length, items };
  }

  private async snapshot(
    organizationId: string,
    query: DashboardQueryDto,
  ): Promise<Snapshot> {
    const range = this.resolveRange(query);

    const projects = await this.projectRepo.find({
      where: {
        organizationId,
        ...(query.projectId ? { id: query.projectId } : {}),
      },
      take: PROJECT_LIMIT,
    });

    const tasks =
      projects.length > 0
        ? await this.taskRepo.find({
            where: projects.map((project) => ({ projectId: project.id })),
          })
        : [];

    const subtasks =
      tasks.length > 0
        ? await this.subtaskRepo.find({
            where: tasks.map((task) => ({ taskId: task.id })),
          })
        : [];

    const entries =
      subtasks.length > 0
        ? await this.timeEntryRepo
            .createQueryBuilder('entry')
            .where('entry.subtask_id IN (:...subtaskIds)', {
              subtaskIds: subtasks.map((subtask) => subtask.id),
            })
            .andWhere('entry.entry_time >= :from', { from: range.from })
            .andWhere('entry.entry_time <= :to', { to: range.to })
            .getMany()
        : [];

    const secondsBySubtask = new Map<string, number>();
    for (const entry of entries) {
      secondsBySubtask.set(
        entry.subtaskId,
        (secondsBySubtask.get(entry.subtaskId) ?? 0) + entry.durationSeconds(),
      );
    }

    return {
      range,
      projects,
      tasks,
      subtasks,
      entries,
      secondsBySubtask,
    };
  }

  private async timeByGroup(
    snapshot: Snapshot,
    groupBy: NonNullable<DashboardQueryDto['groupBy']>,
  ): Promise<TimeGroupDto[]> {
    const { entries } = snapshot;
    if (entries.length === 0) {
      return [];
    }

    if (groupBy === 'day') {
      const buckets = new Map<string, { seconds: number; entries: number }>();
      for (const entry of entries) {
        const day = entry.entryTime.toISOString().slice(0, 10);
        const bucket = buckets.get(day) ?? { seconds: 0, entries: 0 };
        bucket.seconds += entry.durationSeconds();
        bucket.entries += 1;
        buckets.set(day, bucket);
      }
      return toGroups(buckets, (key) => key);
    }

    if (groupBy === 'user') {
      const users = await this.userRepo.find({
        where: { id: In(entries.map((entry) => entry.userId)) },
      });
      const labels = new Map(
        users.map((user) => [user.id, user.name ?? user.id]),
      );
      return groupEntries(
        entries,
        (entry) => entry.userId,
        (key) => labels.get(key) ?? null,
      );
    }

    if (groupBy === 'project') {
      const labels = new Map(
        snapshot.projects.map((project) => [project.id, project.name]),
      );
      return groupEntries(
        entries,
        (entry) => this.projectIdOfSubtask(snapshot, entry.subtaskId),
        (key) => labels.get(key) ?? null,
      );
    }

    if (groupBy === 'client') {
      const clientIds = [
        ...new Set(snapshot.projects.map((project) => project.clientId)),
      ];
      const clients = clientIds.length
        ? await this.clientRepo.find({ where: { id: In(clientIds) } })
        : [];
      const labels = new Map(clients.map((client) => [client.id, client.name]));
      return groupEntries(
        entries,
        (entry) => this.clientIdOfSubtask(snapshot, entry.subtaskId),
        (key) => labels.get(key) ?? null,
      );
    }

    if (groupBy === 'subtask') {
      const labels = new Map(
        snapshot.subtasks.map((subtask) => [subtask.id, subtask.title]),
      );
      return groupEntries(
        entries,
        (entry) => entry.subtaskId,
        (key) => labels.get(key) ?? null,
      );
    }

    const labels = new Map(snapshot.tasks.map((task) => [task.id, task.title]));
    return groupEntries(
      entries,
      (entry) => this.taskIdOfSubtask(snapshot, entry.subtaskId),
      (key) => labels.get(key) ?? null,
    );
  }

  private projectIdOfSubtask(snapshot: Snapshot, subtaskId: string): string {
    const task = this.taskOfSubtask(snapshot, subtaskId);
    return task ? task.projectId : 'unknown';
  }

  private clientIdOfSubtask(snapshot: Snapshot, subtaskId: string): string {
    const task = this.taskOfSubtask(snapshot, subtaskId);
    const project = task
      ? snapshot.projects.find((item) => item.id === task.projectId)
      : undefined;
    return project?.clientId ?? 'unknown';
  }

  private taskIdOfSubtask(snapshot: Snapshot, subtaskId: string): string {
    return this.taskOfSubtask(snapshot, subtaskId)?.id ?? 'unknown';
  }

  private taskOfSubtask(snapshot: Snapshot, subtaskId: string): Task | null {
    const subtask = snapshot.subtasks.find((item) => item.id === subtaskId);
    if (!subtask) {
      return null;
    }
    return snapshot.tasks.find((task) => task.id === subtask.taskId) ?? null;
  }

  private async varianceSummary(
    snapshot: Snapshot,
  ): Promise<VarianceSummaryDto> {
    const { tasks, subtasks } = snapshot;

    if (tasks.length === 0 || subtasks.length === 0) {
      return { compared: 0, within: 0, under: 0, over: 0, overSeconds: 0 };
    }

    const taskIds = tasks.map((task) => task.id);
    const subtaskIds = subtasks.map((subtask) => subtask.id);
    const envelopes = await this.timeComplexityRepo.find({
      where: [
        { taskId: In(taskIds), status: 'active' },
        {
          taskId: In(taskIds),
          subtaskId: In(subtaskIds),
          status: 'active',
        },
      ],
    });

    const envelopeBySubtask = new Map<string, TimeComplexity>();
    const envelopeByTask = new Map<string, TimeComplexity>();

    for (const envelope of envelopes) {
      if (envelope.subtaskId) {
        envelopeBySubtask.set(envelope.subtaskId, envelope);
      } else if (!envelopeByTask.has(envelope.taskId)) {
        envelopeByTask.set(envelope.taskId, envelope);
      }
    }

    const summary: VarianceSummaryDto = {
      compared: 0,
      within: 0,
      under: 0,
      over: 0,
      overSeconds: 0,
    };

    for (const subtask of subtasks) {
      const envelope =
        envelopeBySubtask.get(subtask.id) ??
        envelopeByTask.get(subtask.taskId) ??
        undefined;
      if (!envelope) {
        continue;
      }

      const actual = snapshot.secondsBySubtask.get(subtask.id) ?? 0;
      const min = parseIntervalSeconds(envelope.minDuration);
      const max = parseIntervalSeconds(envelope.maxDuration);

      summary.compared += 1;
      if (actual < min) {
        summary.under += 1;
      } else if (actual > max) {
        summary.over += 1;
        summary.overSeconds += actual - max;
      } else {
        summary.within += 1;
      }
    }

    return summary;
  }

  private resolveRange(query: BreakdownQueryDto): Range {
    const to = query.to ? endOfDay(new Date(query.to)) : new Date();
    const from = query.from
      ? startOfDay(new Date(query.from))
      : new Date(to.getTime() - DEFAULT_RANGE_DAYS * 86400000);

    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new BadRequestException('Invalid date range');
    }
    if (from.getTime() > to.getTime()) {
      throw new BadRequestException('from must be before to');
    }
    if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * 86400000) {
      throw new BadRequestException(
        `The range cannot exceed ${MAX_RANGE_DAYS} days`,
      );
    }

    return { from, to };
  }
}

function groupEntries(
  entries: TimeEntry[],
  keyOf: (entry: TimeEntry) => string,
  labelOf: (key: string) => string | null,
): TimeGroupDto[] {
  const buckets = new Map<string, { seconds: number; entries: number }>();

  for (const entry of entries) {
    const key = keyOf(entry);
    const bucket = buckets.get(key) ?? { seconds: 0, entries: 0 };
    bucket.seconds += entry.durationSeconds();
    bucket.entries += 1;
    buckets.set(key, bucket);
  }

  return toGroups(buckets, labelOf);
}

function toGroups(
  buckets: Map<string, { seconds: number; entries: number }>,
  labelOf: (key: string) => string | null,
): TimeGroupDto[] {
  return [...buckets.entries()]
    .sort((a, b) => b[1].seconds - a[1].seconds)
    .slice(0, GROUP_LIMIT)
    .map(([key, bucket]) => ({ key, label: labelOf(key), ...bucket }));
}

function countBy<T>(items: T[], keyOf: (item: T) => string): StatusCountDto[] {
  const counts = new Map<string, number>();

  for (const item of items) {
    const key = keyOf(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([status, count]) => ({ status, count }));
}

function toDateOnly(date: Date | null | undefined): string | null {
  if (!date) {
    return null;
  }
  const value = new Date(date);
  return Number.isNaN(value.getTime())
    ? null
    : value.toISOString().slice(0, 10);
}

function startOfDay(date: Date): Date {
  const value = new Date(date);
  value.setHours(0, 0, 0, 0);
  return value;
}

function endOfDay(date: Date): Date {
  const value = new Date(date);
  value.setHours(23, 59, 59, 999);
  return value;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
