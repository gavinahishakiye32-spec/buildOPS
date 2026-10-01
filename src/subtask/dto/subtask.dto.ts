import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
} from 'class-validator';
import { SUBTASK_STATUSES } from '../../common/enums.js';
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
      'Assignee; must be an active member of the team assigned to the task (spec §11)',
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
    description: 'New assignee; must be an active member of the task team',
  })
  @IsOptional()
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

export class SubtaskMessageResponseDto {
  @ApiProperty({ example: 'Subtask deleted' })
  message: string;
}
