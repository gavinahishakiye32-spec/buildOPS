import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiExcludeController, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { PaginatedSchema } from '../common/dto/paginated-response.dto.js';
import { PERMISSIONS } from '../common/permissions.js';
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
  RequirePermissions,
} from '../common/decorators/protected.decorator.js';
import type { Paginated } from '../common/pagination.dto.js';
import { NotificationService } from './notification.service.js';
import {
  NotificationMessageResponseDto,
  NotificationQueryDto,
  NotificationResponseDto,
  UnreadCountResponseDto,
} from './dto/notification.dto.js';

const NotificationPageDto = PaginatedSchema(
  NotificationResponseDto,
  'NotificationPage',
);

/**
 * The in-app inbox.
 *
 * Deliberately excluded from the OpenAPI document for now (`@ApiExcludeController`):
 * the whole document is published incrementally, one module at a time, so a new
 * module starts hidden from the committed contract. To publish it, drop this
 * decorator, add its tag to `TAGS` in `src/swagger.setup.ts`, add its routes to
 * `DOCUMENTED_OPERATIONS` in `test/openapi.e2e-spec.ts` and regenerate
 * `docs/openapi.json` with `npm run docs:openapi`.
 *
 * Every route reads or writes the caller's own inbox only: `recipientId` is
 * always the authenticated user.
 */
@ApiRateLimited()
@ApiTags('notifications')
@ApiExcludeController()
@Protected()
@Controller('notifications')
export class NotificationController {
  constructor(private readonly notificationService: NotificationService) {}

  @Get()
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.NOTIFICATION_VIEW)
  @ApiOperation({
    summary: 'List notifications',
    description:
      'Paginated notifications of the caller, newest first. With `unread`, only the rows the caller has not read yet.',
  })
  @ApiResponse({
    description: 'One page of notifications',
    status: 200,
    type: NotificationPageDto,
  })
  @ApiErrors(400, 403)
  async list(
    @OrgAuth() auth: OrganizationAuthContext,
    @Query() query: NotificationQueryDto,
  ): Promise<Paginated<NotificationResponseDto>> {
    const page = await this.notificationService.list(
      auth.organizationId,
      auth.userId,
      query,
    );

    return {
      ...page,
      items: page.items.map((notification) => notification.toResponse()),
    };
  }

  /**
   * Declared before the parameterised routes, like the `trash` routes: they are
   * all literal segments, so nothing gets a chance to mistake `unread-count`
   * for an id.
   */
  @Get('unread-count')
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.NOTIFICATION_VIEW)
  @ApiOperation({
    summary: 'Unread notification count',
    description: 'One number: how many notifications the caller has not read. For the badge.',
  })
  @ApiResponse({
    description: 'The unread count',
    status: 200,
    type: UnreadCountResponseDto,
  })
  @ApiErrors(403)
  async unreadCount(
    @OrgAuth() auth: OrganizationAuthContext,
  ): Promise<UnreadCountResponseDto> {
    const unread = await this.notificationService.unreadCount(
      auth.organizationId,
      auth.userId,
    );

    return { unread };
  }

  @Post('read-all')
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.NOTIFICATION_UPDATE)
  @ApiOperation({
    summary: 'Mark all as read',
    description: 'Marks every notification of the caller as read. Idempotent.',
  })
  @ApiResponse({
    description: 'Notifications marked as read',
    status: 201,
    schema: {
      type: 'object',
      required: ['message', 'updated'],
      properties: {
        message: { type: 'string', example: 'Notifications marked as read' },
        updated: { type: 'number', example: 3 },
      },
    },
  })
  @ApiErrors(403)
  async readAll(
    @OrgAuth() auth: OrganizationAuthContext,
  ): Promise<{ message: string; updated: number }> {
    const { updated } = await this.notificationService.markAllRead(
      auth.organizationId,
      auth.userId,
    );

    return { message: 'Notifications marked as read', updated };
  }

  @Post(':notificationId/read')
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.NOTIFICATION_UPDATE)
  @ApiOperation({
    summary: 'Mark one notification as read',
    description: 'Marks a notification of the caller as read. Idempotent: reading an already read notification changes nothing.',
  })
  @ApiResponse({
    description: 'The notification, now marked as read',
    status: 201,
    type: NotificationResponseDto,
  })
  @ApiErrors(403, 404)
  async read(
    @OrgAuth() auth: OrganizationAuthContext,
    @Param('notificationId', ParseUUIDPipe) notificationId: string,
  ): Promise<NotificationResponseDto> {
    const notification = await this.notificationService.markRead(
      auth.organizationId,
      auth.userId,
      notificationId,
    );

    return notification.toResponse();
  }

  @Delete(':notificationId')
  @HttpCode(200)
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.NOTIFICATION_DELETE)
  @ApiOperation({
    summary: 'Delete a notification',
    description:
      'Removes a notification of the caller, read or unread. This is a hard delete: the inbox is the recipient clearing their own rows, so there is no trash to restore from.',
  })
  @ApiResponse({
    description: 'Notification deleted',
    status: 200,
    type: NotificationMessageResponseDto,
  })
  @ApiErrors(403, 404)
  async remove(
    @OrgAuth() auth: OrganizationAuthContext,
    @Param('notificationId', ParseUUIDPipe) notificationId: string,
  ): Promise<NotificationMessageResponseDto> {
    await this.notificationService.remove(
      auth.organizationId,
      auth.userId,
      notificationId,
    );

    return { message: 'Notification deleted' };
  }
}