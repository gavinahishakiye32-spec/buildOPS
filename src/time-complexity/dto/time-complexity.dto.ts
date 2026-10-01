import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { PaginationQueryDto } from '../../common/pagination.dto.js';
import {
  TIME_COMPLEXITY_NAMES,
  TIME_COMPLEXITY_STATUSES,
  TIME_COMPLEXITY_VARIANCES,
} from '../../common/enums.js';

/** Upper bound on a stored duration: one year, in seconds. */
const MAX_SECONDS = 86400 * 365;

const DURATION_PATTERN =
  /^P(?=\d|T)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?$/;

/**
 * Durations are stored as PostgreSQL intervals but travel over the API as a
 * number of seconds (simplest for clients) or an ISO-8601 duration string.
 */
function toSeconds(value: unknown): unknown {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value !== 'string') {
    return value;
  }

  const trimmed = value.trim();

  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }

  const match = DURATION_PATTERN.exec(trimmed);
  if (!match) {
    return value;
  }

  const [, years, months, weeks, days, hours, minutes, seconds] = match;

  return Math.round(
    Number(years ?? 0) * 31536000 +
      Number(months ?? 0) * 2592000 +
      Number(weeks ?? 0) * 604800 +
      Number(days ?? 0) * 86400 +
      Number(hours ?? 0) * 3600 +
      Number(minutes ?? 0) * 60 +
      Number(seconds ?? 0),
  );
}

const Duration = () => Transform(({ value }) => toSeconds(value));

export class CreateTimeComplexityDto {
  @ApiProperty({ example: '7c1d0a9b-8e7d-4c6b-9a5d-0e1f2a3b4c5d' })
  @IsUUID()
  taskId: string;

  @ApiPropertyOptional({
    example: 'a2b3c4d5-6e7f-4a8b-9c0d-1e2f3a4b5c6d',
    description: 'When set, must belong to the referenced task',
  })
  @IsOptional()
  @IsUUID()
  subtaskId?: string;

  @ApiProperty({ example: 'medium', enum: TIME_COMPLEXITY_NAMES })
  @IsIn(TIME_COMPLEXITY_NAMES)
  name: string;

  @ApiPropertyOptional({
    example: 'active',
    enum: TIME_COMPLEXITY_STATUSES,
    default: 'active',
  })
  @IsOptional()
  @IsIn(TIME_COMPLEXITY_STATUSES)
  status?: string;

  @ApiProperty({
    example: 7200,
    description:
      'Minimum expected duration: seconds or ISO-8601 duration (PT2H)',
  })
  @Duration()
  @IsInt({ message: 'minDuration must be seconds or an ISO-8601 duration' })
  @Min(0)
  @Max(MAX_SECONDS)
  minDuration: number;

  @ApiProperty({
    example: 14400,
    description:
      'Maximum expected duration, greater than or equal to minDuration',
  })
  @Duration()
  @IsInt({ message: 'maxDuration must be seconds or an ISO-8601 duration' })
  @Min(0)
  @Max(MAX_SECONDS)
  maxDuration: number;
}

export class UpdateTimeComplexityDto {
  @ApiPropertyOptional({ example: 'high', enum: TIME_COMPLEXITY_NAMES })
  @IsOptional()
  @IsIn(TIME_COMPLEXITY_NAMES)
  name?: string;

  @ApiPropertyOptional({ example: 'archived', enum: TIME_COMPLEXITY_STATUSES })
  @IsOptional()
  @IsIn(TIME_COMPLEXITY_STATUSES)
  status?: string;

  @ApiPropertyOptional({ example: 3600 })
  @IsOptional()
  @Duration()
  @IsInt({ message: 'minDuration must be seconds or an ISO-8601 duration' })
  @Min(0)
  @Max(MAX_SECONDS)
  minDuration?: number;

  @ApiPropertyOptional({ example: 10800 })
  @IsOptional()
  @Duration()
  @IsInt({ message: 'maxDuration must be seconds or an ISO-8601 duration' })
  @Min(0)
  @Max(MAX_SECONDS)
  maxDuration?: number;
}

export class TimeComplexityQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ example: '7c1d0a9b-8e7d-4c6b-9a5d-0e1f2a3b4c5d' })
  @IsOptional()
  @IsUUID()
  taskId?: string;

  @ApiPropertyOptional({ example: 'a2b3c4d5-6e7f-4a8b-9c0d-1e2f3a4b5c6d' })
  @IsOptional()
  @IsUUID()
  subtaskId?: string;

  @ApiPropertyOptional({ example: 'medium', enum: TIME_COMPLEXITY_NAMES })
  @IsOptional()
  @IsIn(TIME_COMPLEXITY_NAMES)
  name?: string;

  @ApiPropertyOptional({ example: 'active', enum: TIME_COMPLEXITY_STATUSES })
  @IsOptional()
  @IsIn(TIME_COMPLEXITY_STATUSES)
  status?: string;
}

export class TimeComplexityResponseDto {
  @ApiProperty({ example: 'd2e3f4a5-b6c7-4d8e-9f0a-1b2c3d4e5f6a' })
  id: string;

  @ApiProperty({ example: '7c1d0a9b-8e7d-4c6b-9a5d-0e1f2a3b4c5d' })
  taskId: string;

  @ApiProperty({
    example: null,
    nullable: true,
    description: 'null for a task-level envelope',
  })
  subtaskId: string | null;

  @ApiProperty({ example: 'medium', enum: TIME_COMPLEXITY_NAMES })
  name: string;

  @ApiProperty({ example: 'active', enum: TIME_COMPLEXITY_STATUSES })
  status: string;

  @ApiProperty({
    example: '02:00:00',
    description:
      'Minimum duration as a PostgreSQL interval literal, rendered from the stored value',
  })
  minDuration: string;

  @ApiProperty({
    example: '04:00:00',
    description:
      'Maximum duration as a PostgreSQL interval literal, rendered from the stored value',
  })
  maxDuration: string;

  @ApiProperty({ example: 7200, description: 'Minimum duration in seconds' })
  minDurationSeconds: number;

  @ApiProperty({ example: 14400, description: 'Maximum duration in seconds' })
  maxDurationSeconds: number;
}

export class TimeComplexityMessageResponseDto {
  @ApiProperty({ example: 'Time complexity deleted' })
  message: string;
}

export class VarianceRowDto {
  @ApiProperty({ example: 'a2b3c4d5-6e7f-4a8b-9c0d-1e2f3a4b5c6d' })
  subtaskId: string;

  @ApiProperty({ example: 'Design database schema' })
  title: string;

  @ApiProperty({
    example: 9000,
    nullable: true,
    description: 'Actual logged seconds (sum of time entries)',
  })
  actualSeconds: number | null;

  @ApiProperty({ example: 7200, nullable: true })
  minSeconds: number | null;

  @ApiProperty({ example: 14400, nullable: true })
  maxSeconds: number | null;

  @ApiProperty({
    example: 'within',
    nullable: true,
    enum: TIME_COMPLEXITY_VARIANCES,
    description: 'Actual duration relative to the envelope',
  })
  variance: string | null;
}
