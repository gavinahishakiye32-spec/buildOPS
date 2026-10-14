import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional } from 'class-validator';
import { NOTIFICATION_KINDS } from '../../common/enums.js';
import { PaginationQueryDto } from '../../common/pagination.dto.js';
import { Transform } from 'class-transformer';

export class NotificationQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description:
      'Only the notifications still unread. Defaults to all (read and unread).',
  })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  unread?: boolean;

  @ApiPropertyOptional({
    enum: NOTIFICATION_KINDS,
    description:
      'Only notifications of this kind (e.g. `task.assigned` or `task.created`).',
  })
  @IsOptional()
  @IsIn(NOTIFICATION_KINDS)
  kind?: string;
}

export class NotificationResponseDto {
  @ApiProperty({ example: 'd1e2f3a4-5b6c-4d7e-8f90-a1b2c3d4e5f6' })
  id: string;

  @ApiProperty({ enum: NOTIFICATION_KINDS, example: 'task.assigned' })
  kind: string;

  @ApiProperty({ example: 'You have been assigned a task' })
  title: string;

  @ApiProperty({ example: 'Checkout API must reject a zero amount' })
  body: string;

  @ApiPropertyOptional({
    description:
      'Structured context the notification refers to (task id, project id, status, ...).',
    example: { taskId: 'b6f0e2a1-9f2a-4a6f-8f1e-2c9a5b7d1e33' },
  })
  data: Record<string, unknown> | null;

  @ApiPropertyOptional({
    example: '7f8a9b0c-1d2e-4f3a-8b4c-5d6e7f8a9b0c',
    nullable: true,
    description: 'The member whose action produced the notification, if still present.',
  })
  actorId: string | null;

  @ApiPropertyOptional({ example: '2026-09-30T10:00:00.000Z', nullable: true })
  readAt: Date | null;

  @ApiProperty({ example: '2026-09-30T09:59:00.000Z' })
  createdAt: Date;
}

export class UnreadCountResponseDto {
  @ApiProperty({ example: 3, description: 'Notifications still unread' })
  unread: number;
}

export class NotificationMessageResponseDto {
  @ApiProperty({ example: 'Notification deleted' })
  message: string;
}