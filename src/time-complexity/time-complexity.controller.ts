import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { PaginatedSchema } from '../common/dto/paginated-response.dto.js';
import { PERMISSIONS } from '../common/permissions.js';
import { ApiErrors } from '../common/decorators/api-errors.decorator.js';
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
import { TimeComplexityService } from './time-complexity.service.js';
import {
  CreateTimeComplexityDto,
  TimeComplexityMessageResponseDto,
  TimeComplexityQueryDto,
  TimeComplexityResponseDto,
  UpdateTimeComplexityDto,
  VarianceRowDto,
} from './dto/time-complexity.dto.js';

const TimeComplexityPageDto = PaginatedSchema(
  TimeComplexityResponseDto,
  'TimeComplexityPage',
);

@ApiTags('time-complexity')
@Protected()
@Controller('time-complexity')
export class TimeComplexityController {
  constructor(private readonly timeComplexityService: TimeComplexityService) {}

  @Post()
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.TIME_COMPLEXITY_CREATE)
  @ApiOperation({
    summary: 'Define a time complexity envelope',
    description:
      'Creates an estimation envelope for a task or subtask. minDuration must be <= maxDuration, the task must belong to the active organization, a provided subtask must belong to that task, and only one active record may exist per task/subtask combination.',
  })
  @ApiResponse({ status: 201, type: TimeComplexityResponseDto })
  @ApiErrors(400, 403, 404, 409)
  async create(
    @OrgAuth() auth: OrganizationAuthContext,
    @Body() dto: CreateTimeComplexityDto,
  ): Promise<TimeComplexityResponseDto> {
    const complexity = await this.timeComplexityService.create(
      auth.organizationId,
      dto,
    );
    return complexity.toResponse();
  }

  @Get()
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.TIME_COMPLEXITY_VIEW)
  @ApiOperation({
    summary: 'List time complexity envelopes',
    description:
      'Paginated envelopes of the active organization, filterable by task, subtask, name and status.',
  })
  @ApiResponse({ status: 200, type: TimeComplexityPageDto })
  @ApiErrors(403)
  async list(
    @OrgAuth() auth: OrganizationAuthContext,
    @Query() query: TimeComplexityQueryDto,
  ): Promise<Paginated<TimeComplexityResponseDto>> {
    const page = await this.timeComplexityService.list(
      auth.organizationId,
      query,
    );

    return {
      ...page,
      items: page.items.map((complexity) => complexity.toResponse()),
    };
  }

  @Get('variance/:taskId')
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.TIME_COMPLEXITY_VIEW)
  @ApiOperation({
    summary: 'Variance for a task',
    description:
      'Compares actual logged time per subtask with its envelope (subtask-level first, then task-level): under, within or over.',
  })
  @ApiResponse({ status: 200, type: [VarianceRowDto] })
  @ApiErrors(403, 404)
  async variance(
    @OrgAuth() auth: OrganizationAuthContext,
    @Param('taskId', ParseUUIDPipe) taskId: string,
  ): Promise<VarianceRowDto[]> {
    return this.timeComplexityService.variance(auth.organizationId, taskId);
  }

  @Get(':complexityId')
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.TIME_COMPLEXITY_VIEW)
  @ApiOperation({
    summary: 'Get a time complexity envelope',
    description:
      'One time-complexity envelope attached to a task or subtask of the active organization.',
  })
  @ApiResponse({ status: 200, type: TimeComplexityResponseDto })
  @ApiErrors(403, 404)
  async findOne(
    @OrgAuth() auth: OrganizationAuthContext,
    @Param('complexityId', ParseUUIDPipe) complexityId: string,
  ): Promise<TimeComplexityResponseDto> {
    const complexity = await this.timeComplexityService.findOne(
      auth.organizationId,
      complexityId,
    );
    return complexity.toResponse();
  }

  @Patch(':complexityId')
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.TIME_COMPLEXITY_UPDATE)
  @ApiOperation({
    summary: 'Update a time complexity envelope',
    description: 'Re-validates minDuration <= maxDuration on every update.',
  })
  @ApiResponse({ status: 200, type: TimeComplexityResponseDto })
  @ApiErrors(400, 403, 404, 409)
  async update(
    @OrgAuth() auth: OrganizationAuthContext,
    @Param('complexityId', ParseUUIDPipe) complexityId: string,
    @Body() dto: UpdateTimeComplexityDto,
  ): Promise<TimeComplexityResponseDto> {
    const complexity = await this.timeComplexityService.update(
      auth.organizationId,
      complexityId,
      dto,
    );
    return complexity.toResponse();
  }

  @Delete(':complexityId')
  @HttpCode(200)
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.TIME_COMPLEXITY_DELETE)
  @ApiOperation({
    summary: 'Delete a time complexity envelope',
    description:
      'Deletes an envelope. The parent task or subtask keeps its records, it only loses the envelope.',
  })
  @ApiResponse({ status: 200, type: TimeComplexityMessageResponseDto })
  @ApiErrors(403, 404)
  async remove(
    @OrgAuth() auth: OrganizationAuthContext,
    @Param('complexityId', ParseUUIDPipe) complexityId: string,
  ): Promise<TimeComplexityMessageResponseDto> {
    await this.timeComplexityService.remove(auth.organizationId, complexityId);
    return { message: 'Time complexity deleted' };
  }
}
