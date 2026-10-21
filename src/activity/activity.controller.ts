import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
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
import { PaginatedSchema } from '../common/dto/paginated-response.dto.js';
import { ActivityService } from './activity.service.js';
import {
  ActivityBreakdownDto,
  ActivityEventDto,
  ActivityEventsQueryDto,
  ActivityLeaderboardDto,
  ActivityLeaderboardQueryDto,
  ActivityTimelineDto,
  ActivityTimelineQueryDto,
} from './dto/activity.dto.js';

const ActivityEventPageDto = PaginatedSchema(
  ActivityEventDto,
  'ActivityEventPage',
);

@ApiRateLimited()
@ApiTags('activity')
@Protected()
@Controller('activity')
@RequirePermissions(PERMISSIONS.ANALYTICS_VIEW)
export class ActivityController {
  constructor(private readonly activityService: ActivityService) {}

  @Get('timeline')
  @OrganizationHeader()
  @ApiOperation({
    summary: 'Activity over time',
    description:
      'Event counts bucketed by day or week for the active organization (default: last 30 days).',
  })
  @ApiResponse({
    description: 'One entry per bucket, oldest first',
    status: 200,
    type: ActivityTimelineDto,
  })
  @ApiErrors(400, 403)
  async timeline(
    @OrgAuth() auth: OrganizationAuthContext,
    @Query() query: ActivityTimelineQueryDto,
  ): Promise<ActivityTimelineDto> {
    return this.activityService.timeline(auth.organizationId, query);
  }

  @Get('leaderboard')
  @OrganizationHeader()
  @ApiOperation({
    summary: 'Most active users',
    description:
      'Users ranked by how many events they performed in the range (default: last 30 days).',
  })
  @ApiResponse({
    description: 'Actors and their event counts, most active first',
    status: 200,
    type: ActivityLeaderboardDto,
  })
  @ApiErrors(400, 403)
  async leaderboard(
    @OrgAuth() auth: OrganizationAuthContext,
    @Query() query: ActivityLeaderboardQueryDto,
  ): Promise<ActivityLeaderboardDto> {
    return this.activityService.leaderboard(auth.organizationId, query);
  }

  @Get('breakdown')
  @OrganizationHeader()
  @ApiOperation({
    summary: 'What kind of activity',
    description:
      'Event counts grouped by entity type and action for the active organization (default: last 30 days).',
  })
  @ApiResponse({
    description: 'Counts per entityType+action, most frequent first',
    status: 200,
    type: ActivityBreakdownDto,
  })
  @ApiErrors(400, 403)
  async breakdown(
    @OrgAuth() auth: OrganizationAuthContext,
    @Query() query: ActivityEventsQueryDto,
  ): Promise<ActivityBreakdownDto> {
    return this.activityService.breakdown(auth.organizationId, query);
  }

  @Get('events')
  @OrganizationHeader()
  @ApiOperation({
    summary: 'Activity feed',
    description:
      'The raw activity trail, newest first, paginated. Supports the same range and filters as the other analytics endpoints.',
  })
  @ApiResponse({
    description: 'A page of activity events',
    status: 200,
    type: ActivityEventPageDto,
  })
  @ApiErrors(400, 403)
  async events(
    @OrgAuth() auth: OrganizationAuthContext,
    @Query() query: ActivityEventsQueryDto,
  ): Promise<{ items: ActivityEventDto[]; total: number; page: number; limit: number; totalPages: number }> {
    return this.activityService.feed(auth.organizationId, query);
  }
}
