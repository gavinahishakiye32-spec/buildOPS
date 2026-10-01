import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsISO8601, IsOptional, IsUUID } from 'class-validator';
import { PaginationQueryDto } from '../../common/pagination.dto.js';

export class StartTimerDto {
  @ApiProperty({
    example: 'a2b3c4d5-6e7f-4a8b-9c0d-1e2f3a4b5c6d',
    description: 'Subtask the timer runs against',
  })
  @IsUUID()
  subtaskId: string;

  @ApiPropertyOptional({
    example: '2026-09-30T09:00:00.000Z',
    description: 'Defaults to now; must not be in the future',
  })
  @IsOptional()
  @IsISO8601()
  entryTime?: string;
}

export class StopTimerDto {
  @ApiPropertyOptional({
    example: 'a2b3c4d5-6e7f-4a8b-9c0d-1e2f3a4b5c6d',
    description: 'Timer to stop; defaults to the active timer of the caller',
  })
  @IsOptional()
  @IsUUID()
  timeEntryId?: string;

  @ApiPropertyOptional({
    example: '2026-09-30T11:30:00.000Z',
    description: 'Defaults to now; must be after entry_time',
  })
  @IsOptional()
  @IsISO8601()
  exitTime?: string;
}

export class CreateTimeEntryDto {
  @ApiProperty({
    example: 'a2b3c4d5-6e7f-4a8b-9c0d-1e2f3a4b5c6d',
    description: 'Subtask the time is logged against',
  })
  @IsUUID()
  subtaskId: string;

  @ApiProperty({ example: '2026-09-30T09:00:00.000Z' })
  @IsISO8601()
  entryTime: string;

  @ApiPropertyOptional({
    example: '2026-09-30T11:30:00.000Z',
    description: 'Leave empty for a running timer',
  })
  @IsOptional()
  @IsISO8601()
  exitTime?: string;
}

export class UpdateTimeEntryDto {
  @ApiPropertyOptional({ example: '2026-09-30T09:30:00.000Z' })
  @IsOptional()
  @IsISO8601()
  entryTime?: string;

  @ApiPropertyOptional({
    example: '2026-09-30T12:00:00.000Z',
    nullable: true,
    description: 'null reopens the timer',
  })
  @IsOptional()
  exitTime?: string | null;
}

export class TimeEntryQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ example: 'a2b3c4d5-6e7f-4a8b-9c0d-1e2f3a4b5c6d' })
  @IsOptional()
  @IsUUID()
  subtaskId?: string;

  @ApiPropertyOptional({
    example: '9a2b7c1d-4e5f-4a6b-8c9d-0e1f2a3b4c5d',
    description: 'Filter by user (requires time_entry.view_all)',
  })
  @IsOptional()
  @IsUUID()
  userId?: string;

  @ApiPropertyOptional({
    example: true,
    description: 'True returns only running timers, false only stopped ones',
  })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  running?: boolean;
}

export class TimeEntryResponseDto {
  @ApiProperty({ example: 'b3c4d5e6-7f8a-4b9c-8d0e-2f3a4b5c6d7e' })
  id: string;

  @ApiProperty({ example: 'a2b3c4d5-6e7f-4a8b-9c0d-1e2f3a4b5c6d' })
  subtaskId: string;

  @ApiProperty({ example: '9a2b7c1d-4e5f-4a6b-8c9d-0e1f2a3b4c5d' })
  userId: string;

  @ApiProperty({ example: '2026-09-30T09:00:00.000Z' })
  entryTime: Date;

  @ApiPropertyOptional({
    example: '2026-09-30T11:30:00.000Z',
    nullable: true,
    description: 'null while the timer runs',
  })
  exitTime: Date | null;

  @ApiProperty({
    example: 9000,
    description: 'Duration in seconds; live while the timer runs',
  })
  durationSeconds: number;

  @ApiProperty({
    example: false,
    description: 'True while the timer is running',
  })
  isRunning: boolean;

  @ApiProperty({ example: '2026-09-30T09:00:00.000Z' })
  createdAt: Date;
}

export class TimerResponseDto {
  @ApiProperty({ type: TimeEntryResponseDto })
  entry: TimeEntryResponseDto;

  @ApiProperty({ example: 'Timer started at 2026-09-30T09:00:00.000Z' })
  message: string;
}

export class ActiveTimerResponseDto {
  @ApiProperty({
    type: TimeEntryResponseDto,
    nullable: true,
    description: 'The running timer of the caller, or null when nothing runs',
  })
  entry: TimeEntryResponseDto | null;
}

export class TimeEntryMessageResponseDto {
  @ApiProperty({ example: 'Time entry deleted' })
  message: string;
}
