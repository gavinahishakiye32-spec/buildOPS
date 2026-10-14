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
import { TrashEntryDto } from '../common/soft-delete.js';
import { MilestoneService } from './milestone.service.js';
import {
  CreateMilestoneDto,
  MilestoneMessageResponseDto,
  MilestoneQueryDto,
  MilestoneResponseDto,
  UpdateMilestoneDto,
} from './dto/milestone.dto.js';

const MilestonePageDto = PaginatedSchema(MilestoneResponseDto, 'MilestonePage');

/**
 * Milestones group a project's deliveries under target dates.
 *
 * Deliberately excluded from the OpenAPI document for now (`@ApiExcludeController`):
 * the whole document is published incrementally, one module at a time, so a new
 * module starts hidden from the committed contract. To publish it, drop this
 * decorator, add its tag to `TAGS` in `src/swagger.setup.ts`, add its routes to
 * `DOCUMENTED_OPERATIONS` in `test/openapi.e2e-spec.ts` and regenerate
 * `docs/openapi.json` with `npm run docs:openapi`.
 */
@ApiRateLimited()
@ApiTags('milestones')
@ApiExcludeController()
@Protected()
@Controller('milestones')
export class MilestoneController {
  constructor(private readonly milestoneService: MilestoneService) {}

  @Post()
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.MILESTONE_CREATE)
  @ApiOperation({
    summary: 'Create a milestone',
    description:
      'Creates a milestone in a project of the active organization. The project is derived from the client input and validated against the organization.',
  })
  @ApiResponse({
    description: 'Milestone created',
    status: 201,
    type: MilestoneResponseDto,
  })
  @ApiErrors(400, 403, 404)
  async create(
    @OrgAuth() auth: OrganizationAuthContext,
    @Body() dto: CreateMilestoneDto,
  ): Promise<MilestoneResponseDto> {
    const milestone = await this.milestoneService.create(
      auth.organizationId,
      auth.userId,
      dto,
    );

    return milestone.toResponse();
  }

  @Get()
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.MILESTONE_VIEW)
  @ApiOperation({
    summary: 'List milestones',
    description:
      'Paginated milestones of the active organization, filterable by project and status.',
  })
  @ApiResponse({
    description: 'One page of milestones',
    status: 200,
    type: MilestonePageDto,
  })
  @ApiErrors(400, 403)
  async list(
    @OrgAuth() auth: OrganizationAuthContext,
    @Query() query: MilestoneQueryDto,
  ): Promise<Paginated<MilestoneResponseDto>> {
    const page = await this.milestoneService.list(auth.organizationId, query);

    return {
      ...page,
      items: page.items.map((milestone) => milestone.toResponse()),
    };
  }

  /**
   * Deleted milestones, newest first.
   *
   * Declared before `/milestoneId` on purpose, like the other `trash` routes: a
   * parameter route registered earlier would match the literal string `trash`
   * first and the UUID pipe would reject it.
   */
  @Get('trash')
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.MILESTONE_VIEW)
  @ApiOperation({
    summary: 'List deleted milestones',
    description:
      'Soft-deleted milestones, with when each was deleted and who deleted it. ' +
      'These rows are excluded from every ordinary read.',
  })
  @ApiResponse({
    description: 'Milestones moved to trash',
    status: 200,
    type: [TrashEntryDto],
  })
  @ApiErrors(403)
  async trash(
    @OrgAuth() auth: OrganizationAuthContext,
  ): Promise<TrashEntryDto[]> {
    return this.milestoneService.listDeleted(auth.organizationId);
  }

  @Post(':milestoneId/restore')
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.MILESTONE_UPDATE)
  @ApiOperation({
    summary: 'Restore a deleted milestone',
    description:
      'Brings a soft-deleted milestone back. Tasks detached when it was deleted ' +
      'stay detached: detaching was not a deletion, so there is no linkage to ' +
      'reassemble, and the caller may have repointed the work since.',
  })
  @ApiResponse({
    description: 'Milestone restored, no longer in the trash',
    status: 201,
    type: MilestoneResponseDto,
  })
  @ApiErrors(403, 404, 409)
  async restore(
    @OrgAuth() auth: OrganizationAuthContext,
    @Param('milestoneId', ParseUUIDPipe) milestoneId: string,
  ): Promise<MilestoneResponseDto> {
    const restored = await this.milestoneService.restore(
      auth.organizationId,
      milestoneId,
      auth.userId,
    );

    return restored.toResponse();
  }

  @Get(':milestoneId')
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.MILESTONE_VIEW)
  @ApiOperation({
    summary: 'Get a milestone',
    description: 'One milestone of the active organization.',
  })
  @ApiResponse({
    description: 'The milestone',
    status: 200,
    type: MilestoneResponseDto,
  })
  @ApiErrors(403, 404)
  async findOne(
    @OrgAuth() auth: OrganizationAuthContext,
    @Param('milestoneId', ParseUUIDPipe) milestoneId: string,
  ): Promise<MilestoneResponseDto> {
    const milestone = await this.milestoneService.findOne(
      auth.organizationId,
      milestoneId,
    );

    return milestone.toResponse();
  }

  @Patch(':milestoneId')
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.MILESTONE_UPDATE)
  @ApiOperation({
    summary: 'Update a milestone',
    description: 'Updates name, description, status and due date.',
  })
  @ApiResponse({
    description: 'The milestone as updated',
    status: 200,
    type: MilestoneResponseDto,
  })
  @ApiErrors(400, 403, 404)
  async update(
    @OrgAuth() auth: OrganizationAuthContext,
    @Param('milestoneId', ParseUUIDPipe) milestoneId: string,
    @Body() dto: UpdateMilestoneDto,
  ): Promise<MilestoneResponseDto> {
    const milestone = await this.milestoneService.update(
      auth.organizationId,
      milestoneId,
      auth.userId,
      dto,
    );

    return milestone.toResponse();
  }

  @Delete(':milestoneId')
  @HttpCode(200)
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.MILESTONE_DELETE)
  @ApiOperation({
    summary: 'Delete a milestone',
    description:
      'Moves the milestone to the trash and detaches the tasks scheduled ' +
      'against it. Nothing is destroyed: the tasks keep their content, and ' +
      '`deleted` reports how many tasks were detached. No cascade confirmation ' +
      'is needed because there is no cascade to confirm.',
  })
  @ApiResponse({
    description: 'Milestone moved to trash',
    status: 200,
    type: MilestoneMessageResponseDto,
  })
  @ApiErrors(403, 404)
  async remove(
    @OrgAuth() auth: OrganizationAuthContext,
    @Param('milestoneId', ParseUUIDPipe) milestoneId: string,
  ): Promise<MilestoneMessageResponseDto> {
    const result = await this.milestoneService.remove(
      auth.organizationId,
      milestoneId,
      auth.userId,
    );

    return { message: 'Milestone deleted', deleted: result.deleted };
  }
}