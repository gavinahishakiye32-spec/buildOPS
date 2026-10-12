import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
} from 'class-validator';
import { AssigneeSummaryDto } from '../../common/dto/assignee-response.dto.js';
import {
  SUBTASK_STATUSES,
  TASK_PRIORITIES,
  TASK_STATUSES,
} from '../../common/enums.js';
import { PaginationQueryDto } from '../../common/pagination.dto.js';

export class CreateSubtaskDto {
  @ApiProperty({ example: 'Write invoice templates' })
  @IsString()
  @Length(1, 255)
  title: string;

  @ApiPropertyOptional({ example: 'Cover all invoice templates.' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({
    example: '9a2b7c1d-4e5f-4a6b-8c9d-0e1f2a3b4c5d',
    description:
      'Who does this. Must be an active member of the organization the ' +
      'parent task belongs to. Omit to leave it in the unassigned backlog.',
  })
  @IsOptional()
  @IsUUID()
  assignedTo?: string;

  @ApiPropertyOptional({ enum: SUBTASK_STATUSES, default: 'todo' })
  @IsOptional()
  @IsIn(SUBTASK_STATUSES)
  status?: string;

  @ApiPropertyOptional({ example: '2026-10-20' })
  @IsOptional()
  @IsDateString()
  dueDate?: string;
}

export class UpdateSubtaskDto {
  @ApiPropertyOptional({ example: 'Write invoice templates' })
  @IsOptional()
  @IsString()
  @Length(1, 255)
  title?: string;

  @ApiPropertyOptional({ example: 'Cover all invoice templates.' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({
    example: '9a2b7c1d-4e5f-4a6b-8c9d-0e1f2a3b4c5d',
    nullable: true,
    description:
      'New assignee; must be an active member of the organization. ' +
      'Null puts the subtask back on the unassigned backlog.',
  })
  @IsOptional()
  @IsUUID()
  assignedTo?: string | null;

  @ApiPropertyOptional({ enum: SUBTASK_STATUSES })
  @IsOptional()
  @IsIn(SUBTASK_STATUSES)
  status?: string;

  @ApiPropertyOptional({ example: '2026-10-20', nullable: true })
  @IsOptional()
  @IsDateString()
  dueDate?: string | null;
}

export class SubtaskQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: SUBTASK_STATUSES })
  @IsOptional()
  @IsIn(SUBTASK_STATUSES)
  status?: string;

  @ApiPropertyOptional({ example: '9a2b7c1d-4e5f-4a6b-8c9d-0e1f2a3b4c5d' })
  @IsOptional()
  @IsUUID()
  assignedTo?: string;
}

/**
 * The organization-wide subtask feed -- "what is assigned to me" across every
 * project.
 *
 * A separate DTO from {@link SubtaskQueryDto} rather than a shared one with
 * optional fields: this route reads across projects and therefore has to say
 * which project each row came from, and a field that is required here and
 * absent there would be a lie in one direction or the other.
 */
export class SubtaskFeedQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: SUBTASK_STATUSES })
  @IsOptional()
  @IsIn(SUBTASK_STATUSES)
  status?: string;

  @ApiPropertyOptional({
    example: '9a2b7c1d-4e5f-4a6b-8c9d-0e1f2a3b4c5d',
    description: 'Restrict to work assigned to this user.',
  })
  @IsOptional()
  @IsUUID()
  assigneeId?: string;

  @ApiPropertyOptional({
    enum: ['assigned', 'unassigned'],
    description:
      'Restrict to work that has an assignee, or to the unassigned backlog.',
  })
  @IsOptional()
  @IsIn(['assigned', 'unassigned'])
  assignment?: string;

  @ApiPropertyOptional({ example: 'b6f0e2a1-9f2a-4a6f-8f1e-2c9a5b7d1e33' })
  @IsOptional()
  @IsUUID()
  projectId?: string;

  @ApiPropertyOptional({ example: 'd1e2f3a4-5b6c-4d7e-8f90-a1b2c3d4e5f6' })
  @IsOptional()
  @IsUUID()
  taskId?: string;
}

/** The parent task, as the feed reports it. Enough to place the row. */
export class FeedTaskDto {
  @ApiProperty({ example: 'd1e2f3a4-5b6c-4d7e-8f90-a1b2c3d4e5f6' })
  id: string;

  @ApiProperty({ example: 'Implement invoicing endpoint' })
  title: string;

  @ApiProperty({ enum: TASK_STATUSES, example: 'in_progress' })
  status: string;

  @ApiProperty({ enum: TASK_PRIORITIES, example: 'medium' })
  priority: string;

  @ApiPropertyOptional({ example: '2026-11-01', nullable: true })
  dueDate: Date | null;
}

/** The project the parent task belongs to. */
export class FeedProjectDto {
  @ApiProperty({ example: 'b6f0e2a1-9f2a-4a6f-8f1e-2c9a5b7d1e33' })
  id: string;

  @ApiProperty({ example: 'FinTech Cloud Migration' })
  name: string;
}

export class SubtaskResponseDto {
  @ApiProperty({ example: 'a2b3c4d5-6e7f-4a8b-9c0d-1e2f3a4b5c6d' })
  id: string;

  @ApiProperty({ example: 'd1e2f3a4-5b6c-4d7e-8f90-a1b2c3d4e5f6' })
  taskId: string;

  @ApiPropertyOptional({
    example: '9a2b7c1d-4e5f-4a6b-8c9d-0e1f2a3b4c5d',
    nullable: true,
  })
  assignedTo: string | null;

  @ApiPropertyOptional({
    type: AssigneeSummaryDto,
    nullable: true,
    description:
      'The assignee, resolved. Null when unassigned, or when the read did ' +
      'not join the relation -- `assignedTo` is the durable fact.',
  })
  assignee: AssigneeSummaryDto | null;

  @ApiProperty({ example: 'Write invoice templates' })
  title: string;

  @ApiPropertyOptional({ example: 'Cover all invoice templates.' })
  description: string | null;

  @ApiProperty({ enum: SUBTASK_STATUSES, example: 'todo' })
  status: string;

  @ApiPropertyOptional({ example: '2026-10-20', nullable: true })
  dueDate: Date | null;

  @ApiProperty({ example: '2026-09-30T10:00:00.000Z' })
  createdAt: Date;

  @ApiProperty({ example: '2026-09-30T10:00:00.000Z' })
  updatedAt: Date;
}

/**
 * A subtask in the feed, with the context needed to act on it.
 *
 * A subtask on its own ("reset the password") is not actionable -- the person
 * has to see which part of which project it belongs to before they can judge
 * how to do it or when.
 *
 * Declared after {@link SubtaskResponseDto} for a mechanical reason worth
 * knowing: `extends` evaluates its base at class-definition time, so a subclass
 * written above its base throws the moment this module is loaded.
 */
export class AssignedSubtaskResponseDto extends SubtaskResponseDto {
  @ApiPropertyOptional({ type: FeedTaskDto, nullable: true })
  task: FeedTaskDto | null;

  @ApiPropertyOptional({ type: FeedProjectDto, nullable: true })
  project: FeedProjectDto | null;
}

export class SubtaskMessageResponseDto {
  @ApiProperty({ example: 'Subtask deleted' })
  message: string;

  /**
   * How many records went with the subtask, including the one requested.
   *
   * The number matters more than it looks: a project that takes forty tasks and
   * a hundred hours with it should say so, and a caller that expected one row
   * and reads four is being told its assumption was wrong.
   */
  @ApiPropertyOptional({
    description:
      'Records soft-deleted by this request, including the subtask itself. ' +
      'Absent when the subtask stood alone and took nothing else with it.',
    example: 4,
  })
  deleted?: number;
}
