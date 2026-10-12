import {
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { PaginatedSchema } from '../common/dto/paginated-response.dto.js';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ApiErrors,
  ApiRateLimited,
} from '../common/decorators/api-errors.decorator.js';
import {
  OrgAuth,
  type OrganizationAuthContext,
} from '../common/decorators/org-auth.decorator.js';
import {
  OrganizationHeader,
  Protected,
} from '../common/decorators/protected.decorator.js';
import { PaginationQueryDto, type Paginated } from '../common/pagination.dto.js';
import { NOTIFICATION_TYPES, Notification } from './notification.entity.js';
import { NotificationService } from './notification.service.js';

class NotificationActorDto {
  @ApiProperty({ example: '9a2b7c1d-4e5f-4a6b-8c9d-0e1f2a3b4c5d' })
  id: string;

  @ApiPropertyOptional({ example: 'Ada Login', nullable: true })
  name: string | null;
}

export class NotificationResponseDto {
  @ApiProperty({ example: 'a2b3c4d5-6e7f-4a8b-9c0d-1e2f3a4b5c6d' })
  id: string;

  @ApiProperty({ enum: NOTIFICATION_TYPES, example: 'subtask_assigned' })
  type: string;

  @ApiProperty({ example: 'Ada Login assigned you "Build the login form"' })
  title: string;

  @ApiPropertyOptional({
    example: 'A subtask of "Authentication" in Acme Delivery.',
    nullable: true,
  })
  body: string | null;

  @ApiPropertyOptional({
    example: 'd1e2f3a4-5b6c-4d7e-8f90-a1b2c3d4e5f6',
    nullable: true,
    description: 'The task, for a deep link. Null once that task is deleted.',
  })
  taskId: string | null;

  @ApiPropertyOptional({
    example: 'b6f0e2a1-9f2a-4a6f-8f1e-2c9a5b7d1e33',
    nullable: true,
    description: 'The subtask, for a deep link.',
  })
  subtaskId: string | null;

  @ApiPropertyOptional({ type: NotificationActorDto, nullable: true })
  actor: NotificationActorDto | null;

  @ApiPropertyOptional({
    example: null,
    nullable: true,
    description: 'When it was read. Null is what the unread badge counts.',
  })
  readAt: Date | null;

  @ApiProperty({ example: '2026-09-30T10:00:00.000Z' })
  createdAt: Date;
}

export class UnreadCountDto {
  @ApiProperty({ example: 3, description: 'Notifications the caller has not read.' })
  unread: number;
}

export class ReadResultDto {
  @ApiProperty({ example: 1 })
  updated: number;

  @ApiPropertyOptional({
    example: true,
    description: 'Present on the single-notification route; whether it was the caller’s.',
  })
  read?: boolean;
}

const NotificationPageDto = PaginatedSchema(
  NotificationResponseDto,
  'NotificationPage',
);

/**
 * The caller's own notifications.
 *
 * Every route here resolves its recipient from the authenticated caller rather
 * than from the path or the body, so there is no URL in this API that can
 * return another member's notifications -- the question the routes ask is not
 * even expressible, let alone authorised.
 */
@ApiRateLimited()
@ApiTags('notifications')
@Protected()
@Controller('notifications')
export class NotificationController {
  constructor(private readonly notificationService: NotificationService) {}

  @Get()
  @OrganizationHeader()
  @ApiOperation({
    summary: 'List your notifications',
    description:
      'Your notifications in this organization, newest first. Only ever your ' +
      'own: the recipient is the authenticated caller, so there is no request ' +
      'that reaches another member\'s.',
  })
  @ApiResponse({ description: 'One page of notifications', status: 200, type: NotificationPageDto })
  @ApiErrors(401, 403)
  async list(
    @OrgAuth() auth: OrganizationAuthContext,
    @Query() query: PaginationQueryDto,
  ): Promise<Paginated<ReturnType<Notification['toResponse']>>> {
    const page = await this.notificationService.list(
      auth.organizationId,
      auth.userId,
      query,
    );

    return { ...page, items: page.items.map((item) => item.toResponse()) };
  }

  @Get('unread-count')
  @OrganizationHeader()
  @ApiOperation({
    summary: 'How many notifications you have not read',
    description: 'Drives the badge on the bell. Separate from the list so the header does not have to page the whole thing to render one number.',
  })
  @ApiResponse({ description: 'The unread count', status: 200, type: UnreadCountDto })
  @ApiErrors(401, 403)
  async unread(
    @OrgAuth() auth: OrganizationAuthContext,
  ): Promise<UnreadCountDto> {
    return {
      unread: await this.notificationService.unreadCount(
        auth.organizationId,
        auth.userId,
      ),
    };
  }

  @Post('read-all')
  @OrganizationHeader()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Mark every notification read',
    description:
      'Clears the badge. Only unread rows are touched, so the timestamp on ' +
      'something read last month is not rewritten.',
  })
  @ApiResponse({ description: 'How many were marked read', status: 200, type: ReadResultDto })
  @ApiErrors(401, 403)
  async readAll(
    @OrgAuth() auth: OrganizationAuthContext,
  ): Promise<ReadResultDto> {
    return {
      updated: await this.notificationService.markAllRead(
        auth.organizationId,
        auth.userId,
      ),
    };
  }

  @Post(':notificationId/read')
  @OrganizationHeader()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Mark one notification read',
    description:
      'Scoped to the caller as well as the id, so a notification id from ' +
      'somebody else answers 404 rather than clearing their badge.',
  })
  @ApiResponse({ description: 'The notification is now read', status: 200, type: ReadResultDto })
  @ApiErrors(401, 403, 404)
  async readOne(
    @OrgAuth() auth: OrganizationAuthContext,
    @Param('notificationId', ParseUUIDPipe) notificationId: string,
  ): Promise<ReadResultDto> {
    const read = await this.notificationService.markRead(
      auth.organizationId,
      auth.userId,
      notificationId,
    );

    if (!read) {
      throw new NotFoundException('Notification not found');
    }

    return { updated: 1, read: true };
  }
}