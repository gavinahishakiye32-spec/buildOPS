import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
} from 'class-validator';
import { TASK_PRIORITIES, TASK_STATUSES } from '../../common/enums.js';
import { PaginationQueryDto } from '../../common/pagination.dto.js';

export class CreateTaskDto {
  @ApiProperty({ example: 'b6f0e2a1-9f2a-4a6f-8f1e-2c9a5b7d1e33' })
  @IsUUID()
  projectId: string;

  @ApiProperty({ example: 'Implement invoicing endpoint' })
  @IsString()
  @Length(1, 255)
  title: string;

  @ApiPropertyOptional({ example: 'Add the invoice generation endpoint.' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({
    example: '4c1f5c66-2f9e-4f5c-8b2a-9c0d1e2f3a4b',
    description: 'Team of the same organization the task is assigned to',
  })
  @IsOptional()
  @IsUUID()
  teamId?: string;

  @ApiPropertyOptional({
    example: '7e8f9a0b-1c2d-4e3f-8a4b-5c6d7e8f9a0b',
    description:
      'Optional badge of the same organization (classification, spec §10)',
  })
  @IsOptional()
  @IsUUID()
  badgeId?: string;

  @ApiPropertyOptional({ enum: TASK_PRIORITIES, default: 'medium' })
  @IsOptional()
  @IsIn(TASK_PRIORITIES)
  priority?: string;

  @ApiPropertyOptional({ enum: TASK_STATUSES, default: 'todo' })
  @IsOptional()
  @IsIn(TASK_STATUSES)
  status?: string;

  @ApiPropertyOptional({
    example: '2026-11-01',
    description: 'Due date (DATE)',
  })
  @IsOptional()
  @IsDateString()
  dueDate?: string;
}

export class UpdateTaskDto {
  @ApiPropertyOptional({ example: 'Implement invoicing endpoint' })
  @IsOptional()
  @IsString()
  @Length(1, 255)
  title?: string;

  @ApiPropertyOptional({ example: 'Add the invoice generation endpoint.' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({
    example: '4c1f5c66-2f9e-4f5c-8b2a-9c0d1e2f3a4b',
    description: 'Team of the same organization (null detaches the team)',
  })
  @IsOptional()
  teamId?: string | null;

  @ApiPropertyOptional({
    example: '7e8f9a0b-1c2d-4e3f-8a4b-5c6d7e8f9a0b',
    description:
      'Badge of the same organization (null clears the classification)',
  })
  @IsOptional()
  badgeId?: string | null;

  @ApiPropertyOptional({ enum: TASK_PRIORITIES })
  @IsOptional()
  @IsIn(TASK_PRIORITIES)
  priority?: string;

  @ApiPropertyOptional({ enum: TASK_STATUSES })
  @IsOptional()
  @IsIn(TASK_STATUSES)
  status?: string;

  @ApiPropertyOptional({ example: '2026-11-01', nullable: true })
  @IsOptional()
  @IsDateString()
  dueDate?: string | null;
}

export class TaskQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: TASK_STATUSES, description: 'Filter by status' })
  @IsOptional()
  @IsIn(TASK_STATUSES)
  status?: string;

  @ApiPropertyOptional({
    enum: TASK_PRIORITIES,
    description: 'Filter by priority',
  })
  @IsOptional()
  @IsIn(TASK_PRIORITIES)
  priority?: string;

  @ApiPropertyOptional({ example: 'b6f0e2a1-9f2a-4a6f-8f1e-2c9a5b7d1e33' })
  @IsOptional()
  @IsUUID()
  projectId?: string;

  @ApiPropertyOptional({ example: '4c1f5c66-2f9e-4f5c-8b2a-9c0d1e2f3a4b' })
  @IsOptional()
  @IsUUID()
  teamId?: string;

  @ApiPropertyOptional({ example: '7e8f9a0b-1c2d-4e3f-8a4b-5c6d7e8f9a0b' })
  @IsOptional()
  @IsUUID()
  badgeId?: string;
}

export class TaskResponseDto {
  @ApiProperty({ example: 'd1e2f3a4-5b6c-4d7e-8f90-a1b2c3d4e5f6' })
  id: string;

  @ApiProperty({ example: 'b6f0e2a1-9f2a-4a6f-8f1e-2c9a5b7d1e33' })
  projectId: string;

  @ApiPropertyOptional({
    example: '4c1f5c66-2f9e-4f5c-8b2a-9c0d1e2f3a4b',
    nullable: true,
  })
  teamId: string | null;

  @ApiPropertyOptional({
    example: '7e8f9a0b-1c2d-4e3f-8a4b-5c6d7e8f9a0b',
    nullable: true,
  })
  badgeId: string | null;

  @ApiProperty({ example: 'Implement invoicing endpoint' })
  title: string;

  @ApiPropertyOptional({ example: 'Add the invoice generation endpoint.' })
  description: string | null;

  @ApiProperty({ enum: TASK_PRIORITIES, example: 'medium' })
  priority: string;

  @ApiProperty({ enum: TASK_STATUSES, example: 'todo' })
  status: string;

  @ApiPropertyOptional({ example: '2026-11-01', nullable: true })
  dueDate: Date | null;

  @ApiProperty({ example: '2026-09-30T10:00:00.000Z' })
  createdAt: Date;

  @ApiProperty({ example: '2026-09-30T10:00:00.000Z' })
  updatedAt: Date;
}

export class TaskMessageResponseDto {
  @ApiProperty({ example: 'Task deleted' })
  message: string;
}
