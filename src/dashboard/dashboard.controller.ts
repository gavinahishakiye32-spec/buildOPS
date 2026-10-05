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
import { DashboardService } from './dashboard.service.js';
import {
  BreakdownQueryDto,
  DashboardClientListDto,
  DashboardOverviewDto,
  DashboardOverdueDto,
  DashboardProjectListDto,
  DashboardQueryDto,
} from './dto/dashboard.dto.js';

@ApiRateLimited()
@ApiTags('dashboard')
@Protected()
@Controller('dashboard')
@RequirePermissions(PERMISSIONS.DASHBOARD_VIEW)
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('overview')
  @OrganizationHeader()
  @ApiOperation({
    summary: 'Operational overview',
    description:
      'Aggregates projects, tasks, subtasks, logged time and estimation variance for the active organization over a date range (default: last 30 days).',
  })
  @ApiResponse({
    description: 'Counts and totals across the organization',
    status: 200,
    type: DashboardOverviewDto,
  })
  @ApiErrors(400, 403)
  async overview(
    @OrgAuth() auth: OrganizationAuthContext,
    @Query() query: DashboardQueryDto,
  ): Promise<DashboardOverviewDto> {
    return this.dashboardService.overview(auth.organizationId, query);
  }

  @Get('projects')
  @OrganizationHeader()
  @ApiOperation({
    summary: 'Project progress',
    description:
      'Per project task/subtask counters, completion rate and logged seconds.',
  })
  @ApiResponse({
    description: 'Per-project progress of the organization',
    status: 200,
    type: DashboardProjectListDto,
  })
  @ApiErrors(400, 403)
  async projects(
    @OrgAuth() auth: OrganizationAuthContext,
    @Query() query: DashboardQueryDto,
  ): Promise<DashboardProjectListDto> {
    return this.dashboardService.projects(auth.organizationId, query);
  }

  @Get('clients')
  @OrganizationHeader()
  @ApiOperation({
    summary: 'Client workload',
    description: 'Projects and logged seconds grouped by client.',
  })
  @ApiResponse({
    description: 'Workload per client of the organization',
    status: 200,
    type: DashboardClientListDto,
  })
  @ApiErrors(400, 403)
  async clients(
    @OrgAuth() auth: OrganizationAuthContext,
    @Query() query: DashboardQueryDto,
  ): Promise<DashboardClientListDto> {
    return this.dashboardService.clients(auth.organizationId, query);
  }

  @Get('overdue')
  @OrganizationHeader()
  @ApiOperation({
    summary: 'Overdue subtasks',
    description:
      'Open subtasks whose due date has passed, with the parent task priority.',
  })
  @ApiResponse({
    description: 'Subtasks past their due date',
    status: 200,
    type: DashboardOverdueDto,
  })
  @ApiErrors(400, 403)
  async overdue(
    @OrgAuth() auth: OrganizationAuthContext,
    @Query() query: BreakdownQueryDto,
  ): Promise<DashboardOverdueDto> {
    return this.dashboardService.overdue(auth.organizationId, query);
  }
}
