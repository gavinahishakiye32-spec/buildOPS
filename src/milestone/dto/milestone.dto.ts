import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
} from 'class-validator';
import { MILESTONE_STATUSES } from '../../common/enums.js';
import { PaginationQueryDto } from '../../common/pagination.dto.js';

export class CreateMilestoneDto {
  @ApiProperty({ example: 'b6f0e2a1-9f2a-4a6f-8f1e-2c9a5b7d1e33' })
  @IsUUID()
  projectId: string;

  @ApiProperty({ example: 'MVP release' })
  @IsString()
  @Length(1, 255)
  name: string;

  @ApiPropertyOptional({ example: 'The integrations that make it usable.' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ enum: MILESTONE_STATUSES, default: 'planned' })
  @IsOptional()
  @IsIn(MILESTONE_STATUSES)
  status?: string;

  @ApiPropertyOptional({ example: '2026-11-01', description: 'Due date (DATE)' })
  @IsOptional()
  @IsDateString()
  dueDate?: string;
}

export class UpdateMilestoneDto {
  @ApiPropertyOptional({ example: 'MVP release' })
  @IsOptional()
  @IsString()
  @Length(1, 255)
  name?: string;

  @ApiPropertyOptional({ example: 'The integrations that make it usable.' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ enum: MILESTONE_STATUSES })
  @IsOptional()
  @IsIn(MILESTONE_STATUSES)
  status?: string;

  @ApiPropertyOptional({ example: '2026-11-01', nullable: true })
  @IsOptional()
  @IsDateString()
  dueDate?: string | null;
}

export class MilestoneQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: MILESTONE_STATUSES, description: 'Filter by status' })
  @IsOptional()
  @IsIn(MILESTONE_STATUSES)
  status?: string;

  @ApiPropertyOptional({ example: 'b6f0e2a1-9f2a-4a6f-8f1e-2c9a5b7d1e33' })
  @IsOptional()
  @IsUUID()
  projectId?: string;
}

export class MilestoneResponseDto {
  @ApiProperty({ example: 'd1e2f3a4-5b6c-4d7e-8f90-a1b2c3d4e5f6' })
  id: string;

  @ApiProperty({ example: 'b6f0e2a1-9f2a-4a6f-8f1e-2c9a5b7d1e33' })
  projectId: string;

  @ApiProperty({ example: 'MVP release' })
  name: string;

  @ApiPropertyOptional({ example: 'The integrations that make it usable.' })
  description: string | null;

  @ApiProperty({ enum: MILESTONE_STATUSES, example: 'planned' })
  status: string;

  @ApiPropertyOptional({ example: '2026-11-01', nullable: true })
  dueDate: Date | null;

  @ApiProperty({ example: '2026-09-30T10:00:00.000Z' })
  createdAt: Date;

  @ApiProperty({ example: '2026-09-30T10:00:00.000Z' })
  updatedAt: Date;
}

export class MilestoneMessageResponseDto {
  @ApiProperty({ example: 'Milestone deleted' })
  message: string;

  /**
   * How many rows this request affected, including the milestone itself.
   *
   * Deleting a milestone detaches the tasks under it rather than taking them,
   * so the number is `1 + tasks detached`. It matters the same way the task
   * delete's number does: a caller that expected one row and reads six should
   * be told its assumption was wrong.
   */
  @ApiPropertyOptional({
    description:
      'Rows affected by this request: the milestone itself plus any tasks that were detached from it.',
    example: 4,
  })
  deleted?: number;
}