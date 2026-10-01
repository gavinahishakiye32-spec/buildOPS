import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsInt,
  IsIn,
  IsOptional,
  IsUUID,
  Min,
} from 'class-validator';
import {
  CLIENT_STATUSES,
  PROJECT_STATUSES,
  SUBTASK_STATUSES,
  TASK_PRIORITIES,
} from '../../common/enums.js';

const GROUP_BY = [
  'user',
  'project',
  'client',
  'task',
  'subtask',
  'day',
] as const;

export class DashboardQueryDto {
  @ApiPropertyOptional({
    example: '2026-09-01',
    description: 'Inclusive lower bound; defaults to 30 days ago',
  })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({
    example: '2026-09-30',
    description: 'Inclusive upper bound; defaults to now',
  })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiPropertyOptional({
    example: '7c1d0a9b-8e7d-4c6b-9a5d-0e1f2a3b4c5d',
    description: 'Restrict the whole dashboard to a single project',
  })
  @IsOptional()
  @IsUUID()
  projectId?: string;

  @ApiPropertyOptional({
    example: 'user',
    enum: GROUP_BY,
    description: 'Grouping used by the time aggregation',
  })
  @IsOptional()
  @IsIn(GROUP_BY)
  groupBy?: (typeof GROUP_BY)[number];

  @ApiPropertyOptional({ example: false, description: 'Ignore running timers' })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  completedOnly?: boolean;
}

export class BreakdownQueryDto {
  @ApiPropertyOptional({ example: '2026-09-01' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ example: '2026-09-30' })
  @IsOptional()
  @IsDateString()
  to?: string;
}

export class StatusCountDto {
  @ApiProperty({ example: 'todo' })
  status: string;

  @ApiProperty({ example: 4 })
  @IsInt()
  @Min(0)
  count: number;
}

export class TimeGroupDto {
  @ApiProperty({
    example: '9a2b7c1d-4e5f-4a6b-8c9d-0e1f2a3b4c5d',
    description: 'Grouping key: id, or an ISO date when groupBy=day',
  })
  key: string;

  @ApiProperty({
    example: 'Ana López',
    nullable: true,
    description:
      'Resolved label when the group is a user, project, client, task or subtask',
  })
  label: string | null;

  @ApiProperty({ example: 5400, description: 'Logged seconds' })
  seconds: number;

  @ApiProperty({ example: 1, description: 'Time entries behind the total' })
  entries: number;
}

export class VarianceSummaryDto {
  @ApiProperty({ example: 3 })
  compared: number;

  @ApiProperty({ example: 1 })
  within: number;

  @ApiProperty({ example: 1 })
  under: number;

  @ApiProperty({ example: 1 })
  over: number;

  @ApiProperty({
    example: 3600,
    description: 'Sum of the overflow beyond max_seconds across subtasks',
  })
  overSeconds: number;
}

export class DashboardOverviewDto {
  @ApiProperty({ example: '2026-09-01T00:00:00.000Z', nullable: true })
  from: string | null;

  @ApiProperty({ example: '2026-09-30T23:59:59.999Z', nullable: true })
  to: string | null;

  @ApiProperty({ example: 8 })
  projects: number;

  @ApiProperty({ example: 42 })
  tasks: number;

  @ApiProperty({ example: 120 })
  subtasks: number;

  @ApiProperty({ example: 37 })
  timeEntries: number;

  @ApiProperty({ example: 126000, description: 'Total logged seconds' })
  totalSeconds: number;

  @ApiProperty({ type: [StatusCountDto], description: 'Tasks per status' })
  tasksByStatus: StatusCountDto[];

  @ApiProperty({ type: [StatusCountDto], description: 'Subtasks per status' })
  subtasksByStatus: StatusCountDto[];

  @ApiProperty({ type: [StatusCountDto], description: 'Tasks per priority' })
  tasksByPriority: StatusCountDto[];

  @ApiProperty({
    type: [TimeGroupDto],
    description: 'Time aggregated by the requested grouping',
  })
  timeByGroup: TimeGroupDto[];

  @ApiProperty({ type: VarianceSummaryDto })
  variance: VarianceSummaryDto;

  @ApiProperty({ example: 0.25, description: 'Share of tasks in done status' })
  completionRate: number;

  @ApiProperty({ example: 9000, description: 'Average seconds per time entry' })
  averageSecondsPerEntry: number;
}

export class ProjectProgressDto {
  @ApiProperty({ example: '7c1d0a9b-8e7d-4c6b-9a5d-0e1f2a3b4c5d' })
  projectId: string;

  @ApiProperty({ example: 'Website redesign' })
  name: string;

  @ApiProperty({ example: 'active', enum: PROJECT_STATUSES })
  status: string;

  @ApiProperty({ example: 12 })
  tasks: number;

  @ApiProperty({ example: 7 })
  completedTasks: number;

  @ApiProperty({ example: 20 })
  subtasks: number;

  @ApiProperty({ example: 13 })
  completedSubtasks: number;

  @ApiProperty({ example: 0.58, nullable: true })
  completionRate: number | null;

  @ApiProperty({ example: 36000, description: 'Logged seconds on the project' })
  totalSeconds: number;

  @ApiProperty({ example: '2026-09-30', nullable: true })
  startDate: string | null;

  @ApiProperty({ example: '2026-11-30', nullable: true })
  endDate: string | null;
}

export class DashboardProjectListDto {
  @ApiProperty({ example: 3 })
  total: number;

  @ApiProperty({ type: [ProjectProgressDto] })
  items: ProjectProgressDto[];
}

export class ClientSummaryDto {
  @ApiProperty({ example: '4b5c6d7e-8f9a-4b0c-9d1e-2f3a4b5c6d7e' })
  clientId: string;

  @ApiProperty({ example: 'Acme Corp' })
  name: string;

  @ApiProperty({ example: 'active', enum: CLIENT_STATUSES })
  status: string;

  @ApiProperty({ example: 4 })
  projects: number;

  @ApiProperty({
    example: 96000,
    description: 'Logged seconds across projects',
  })
  totalSeconds: number;
}

export class DashboardClientListDto {
  @ApiProperty({ example: 2 })
  total: number;

  @ApiProperty({ type: [ClientSummaryDto] })
  items: ClientSummaryDto[];
}

export class OverdueSubtaskDto {
  @ApiProperty({ example: 'a2b3c4d5-6e7f-4a8b-9c0d-1e2f3a4b5c6d' })
  subtaskId: string;

  @ApiProperty({ example: 'Review migration script' })
  title: string;

  @ApiProperty({ example: 'todo', enum: SUBTASK_STATUSES })
  status: string;

  @ApiProperty({ example: '2026-09-01' })
  dueDate: string;

  @ApiProperty({ example: 29, description: 'Days overdue at query time' })
  daysOverdue: number;

  @ApiProperty({ example: 'critical', enum: TASK_PRIORITIES, nullable: true })
  priority: string | null;
}

export class DashboardOverdueDto {
  @ApiProperty({ example: 3 })
  total: number;

  @ApiProperty({ type: [OverdueSubtaskDto] })
  items: OverdueSubtaskDto[];
}

export class BudgetUsageDto {
  @ApiProperty({ example: '7c1d0a9b-8e7d-4c6b-9a5d-0e1f2a3b4c5d' })
  projectId: string;

  @ApiProperty({ example: 'Website redesign' })
  name: string;

  @ApiProperty({ example: 12000, nullable: true, description: 'Budget' })
  budget: number | null;

  @ApiProperty({ example: 36000, description: 'Logged seconds' })
  totalSeconds: number;

  @ApiProperty({
    example: null,
    nullable: true,
    description: 'Estimated cost if a cost per hour were known; null otherwise',
  })
  estimatedCost: number | null;
}
