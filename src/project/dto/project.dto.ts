import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
} from 'class-validator';
import { PROJECT_STATUSES } from '../../common/enums.js';
import { PaginationQueryDto } from '../../common/pagination.dto.js';

export class CreateProjectDto {
  @ApiProperty({ example: 'Delivery Platform Rollout' })
  @IsString()
  @Length(1, 255)
  name: string;

  @ApiPropertyOptional({ example: 'Replace the legacy delivery tooling.' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({
    example: '4c1f5c66-2f9e-4f5c-8b2a-9c0d1e2f3a4b',
    description: 'Client of the same organization the project is delivered for',
  })
  @IsOptional()
  @IsUUID()
  clientId?: string;

  @ApiPropertyOptional({
    enum: PROJECT_STATUSES,
    default: 'planned',
    description: 'Lifecycle status',
  })
  @IsOptional()
  @IsIn(PROJECT_STATUSES)
  status?: string;

  @ApiPropertyOptional({ example: '2026-10-01', description: 'Delivery start (DATE)' })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({ example: '2026-12-31', description: 'Delivery end (DATE)' })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional({
    example: 125000.5,
    description: 'Financial scope, DECIMAL(10,2)',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(99999999.99)
  budget?: number;
}

export class UpdateProjectDto {
  @ApiPropertyOptional({ example: 'Delivery Platform Rollout' })
  @IsOptional()
  @IsString()
  @Length(1, 255)
  name?: string;

  @ApiPropertyOptional({ example: 'Replace the legacy delivery tooling.' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({
    example: '4c1f5c66-2f9e-4f5c-8b2a-9c0d1e2f3a4b',
    description: 'Client of the same organization (null detaches the client)',
  })
  @IsOptional()
  clientId?: string | null;

  @ApiPropertyOptional({ enum: PROJECT_STATUSES })
  @IsOptional()
  @IsIn(PROJECT_STATUSES)
  status?: string;

  @ApiPropertyOptional({ example: '2026-10-01' })
  @IsOptional()
  @IsDateString()
  startDate?: string | null;

  @ApiPropertyOptional({ example: '2026-12-31' })
  @IsOptional()
  @IsDateString()
  endDate?: string | null;

  @ApiPropertyOptional({ example: 125000.5 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(99999999.99)
  budget?: number | null;
}

export class ProjectResponseDto {
  @ApiProperty({ example: 'b6f0e2a1-9f2a-4a6f-8f1e-2c9a5b7d1e33' })
  id: string;

  @ApiProperty({ example: '9a2b7c1d-4e5f-4a6b-8c9d-0e1f2a3b4c5d' })
  organizationId: string;

  @ApiPropertyOptional({
    example: '4c1f5c66-2f9e-4f5c-8b2a-9c0d1e2f3a4b',
    nullable: true,
  })
  clientId: string | null;

  @ApiProperty({ example: 'Delivery Platform Rollout' })
  name: string;

  @ApiPropertyOptional({ example: 'Replace the legacy delivery tooling.' })
  description: string | null;

  @ApiProperty({ enum: PROJECT_STATUSES, example: 'planned' })
  status: string;

  @ApiPropertyOptional({ example: '2026-10-01', nullable: true })
  startDate: Date | null;

  @ApiPropertyOptional({ example: '2026-12-31', nullable: true })
  endDate: Date | null;

  @ApiPropertyOptional({
    example: '125000.50',
    nullable: true,
    description: 'DECIMAL(10,2) returned as a string to preserve precision',
  })
  budget: string | null;
}

export class ProjectQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    enum: PROJECT_STATUSES,
    description: 'Filter by lifecycle status',
  })
  @IsOptional()
  @IsIn(PROJECT_STATUSES)
  status?: string;

  @ApiPropertyOptional({
    example: '4c1f5c66-2f9e-4f5c-8b2a-9c0d1e2f3a4b',
    description: 'Filter by client',
  })
  @IsOptional()
  @IsUUID()
  clientId?: string;
}
export class ProjectMessageResponseDto {
  @ApiProperty({ example: 'Project deleted' })
  message: string;
}
