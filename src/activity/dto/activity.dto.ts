import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { type Paginated } from '../../common/pagination.dto.js';
import {
  ACTIVITY_ACTIONS,
  ACTIVITY_ENTITY_TYPES,
} from '../activity.entity.js';

const GROUP_BY = ['day', 'week'] as const;

/** Inclusive lower/upper bound on `created_at`; same shape the dashboard uses. */
export class ActivityRangeQueryDto {
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
    description:
      'Restrict to events about one project. Events without a project (teams, clients, members, most chat rooms) never match a projectId filter.',
  })
  @IsOptional()
  @IsUUID()
  projectId?: string;

  @ApiPropertyOptional({
    example: 'task',
    enum: ACTIVITY_ENTITY_TYPES,
    description: 'Restrict to one kind of row',
  })
  @IsOptional()
  @IsIn(ACTIVITY_ENTITY_TYPES)
  entityType?: (typeof ACTIVITY_ENTITY_TYPES)[number];

  @ApiPropertyOptional({
    example: 'created',
    enum: ACTIVITY_ACTIONS,
    description: 'Restrict to one kind of change',
  })
  @IsOptional()
  @IsIn(ACTIVITY_ACTIONS)
  action?: (typeof ACTIVITY_ACTIONS)[number];

  @ApiPropertyOptional({
    example: '9a2b7c1d-4e5f-4a6b-8c9d-0e1f2a3b4c5d',
    description: 'Restrict to events performed by one user',
  })
  @IsOptional()
  @IsUUID()
  actorId?: string;
}

export class ActivityTimelineQueryDto extends ActivityRangeQueryDto {
  @ApiPropertyOptional({
    example: 'day',
    enum: GROUP_BY,
    description: 'Bucket size; defaults to day',
  })
  @IsOptional()
  @IsIn(GROUP_BY)
  groupBy?: (typeof GROUP_BY)[number];
}

export class ActivityLeaderboardQueryDto extends ActivityRangeQueryDto {
  @ApiPropertyOptional({
    example: 10,
    minimum: 1,
    maximum: 100,
    description: 'How many actors to return; defaults to 10',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class ActivityEventsQueryDto extends ActivityRangeQueryDto {
  @ApiPropertyOptional({
    minimum: 1,
    default: 1,
    description: 'Page number (1-based)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 100,
    default: 20,
    description: 'Items per page',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

// --- responses --------------------------------------------------------------

export class ActivityTimelineBucketDto {
  @ApiProperty({
    example: '2026-09-01T00:00:00.000Z',
    description: 'Bucket start, ISO 8601',
  })
  bucket: string;

  @ApiProperty({ example: 12, description: 'Events in the bucket' })
  count: number;
}

export class ActivityTimelineDto {
  @ApiProperty({ example: '2026-09-01T00:00:00.000Z' })
  from: string;

  @ApiProperty({ example: '2026-09-30T23:59:59.999Z' })
  to: string;

  @ApiProperty({ example: 'day', enum: GROUP_BY })
  groupBy: 'day' | 'week';

  @ApiProperty({ type: [ActivityTimelineBucketDto] })
  buckets: ActivityTimelineBucketDto[];
}

export class ActivityLeaderboardEntryDto {
  @ApiProperty({
    example: '9a2b7c1d-4e5f-4a6b-8c9d-0e1f2a3b4c5d',
    description: 'The user; `null` for events whose actor was removed',
  })
  actorId: string | null;

  @ApiProperty({ example: 'Ana López', nullable: true })
  name: string | null;

  @ApiProperty({ example: 47, description: 'Events performed in the range' })
  count: number;
}

export class ActivityLeaderboardDto {
  @ApiProperty({ example: '2026-09-01T00:00:00.000Z' })
  from: string;

  @ApiProperty({ example: '2026-09-30T23:59:59.999Z' })
  to: string;

  @ApiProperty({ type: [ActivityLeaderboardEntryDto] })
  entries: ActivityLeaderboardEntryDto[];
}

export class ActivityBreakdownEntryDto {
  @ApiProperty({ example: 'task', enum: ACTIVITY_ENTITY_TYPES })
  entityType: string;

  @ApiProperty({ example: 'created', enum: ACTIVITY_ACTIONS })
  action: string;

  @ApiProperty({ example: 23, description: 'Events of this kind' })
  count: number;
}

export class ActivityBreakdownDto {
  @ApiProperty({ example: '2026-09-01T00:00:00.000Z' })
  from: string;

  @ApiProperty({ example: '2026-09-30T23:59:59.999Z' })
  to: string;

  @ApiProperty({ example: 156, description: 'All events in the range' })
  total: number;

  @ApiProperty({
    type: [ActivityBreakdownEntryDto],
    description: 'Counts per entityType+action, most frequent first',
  })
  items: ActivityBreakdownEntryDto[];
}

export class ActivityActorDto {
  @ApiProperty({ example: '9a2b7c1d-4e5f-4a6b-8c9d-0e1f2a3b4c5d' })
  id: string;

  @ApiProperty({ example: 'Ana López', nullable: true })
  name: string | null;
}

export class ActivityEventDto {
  @ApiProperty({
    example: 'f3e2d1c0-b9a8-4c7d-8e6f-5a4b3c2d1e0f',
    description: 'Event id',
  })
  id: string;

  @ApiProperty({ example: 'task', enum: ACTIVITY_ENTITY_TYPES })
  entityType: string;

  @ApiProperty({ example: 'created', enum: ACTIVITY_ACTIONS })
  action: string;

  @ApiProperty({
    example: '1b2c3d4e-5f6a-4b7c-8d9e-0a1b2c3d4e5f',
    description: 'Id of the row this event is about',
  })
  entityId: string;

  @ApiProperty({
    example: '7c1d0a9b-8e7d-4c6b-9a5d-0e1f2a3b4c5d',
    nullable: true,
    description: 'Project the event belongs to, when one is known',
  })
  projectId: string | null;

  @ApiProperty({
    type: ActivityActorDto,
    nullable: true,
    description: 'Who did it; `null` when the user was removed',
  })
  actor: ActivityActorDto | null;

  @ApiProperty({
    nullable: true,
    example: { name: 'Ship the beta' },
    description: 'Small extras a feed line needs, never required to render it',
  })
  metadata: Record<string, unknown> | null;

  @ApiProperty({ example: '2026-09-14T10:32:11.482Z' })
  createdAt: string;
}

export type ActivityEventPage = Paginated<ActivityEventDto>;
