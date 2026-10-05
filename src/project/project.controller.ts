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
import {
  ApiExcludeController,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
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
import { ProjectService } from './project.service.js';
import {
  CreateProjectDto,
  ProjectMessageResponseDto,
  ProjectQueryDto,
  ProjectResponseDto,
  UpdateProjectDto,
} from './dto/project.dto.js';
import {
  CASCADE_CONFIRMATION,
  ConfirmCascadeDto,
  TrashEntryDto,
} from '../common/soft-delete.js';

const ProjectPageDto = PaginatedSchema(ProjectResponseDto, 'ProjectPage');

@ApiExcludeController()
@ApiTags('projects')
@Protected()
@Controller('projects')
export class ProjectController {
  constructor(private readonly projectService: ProjectService) {}

  @Post()
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.PROJECT_CREATE)
  @ApiOperation({
    summary: 'Create a project',
    description:
      'Creates a project in the active organization. The client, when given, must belong to the same organization, and the plan limit max_projects is enforced.',
  })
  @ApiResponse({ status: 201, type: ProjectResponseDto })
  @ApiErrors(400, 403, 404)
  async create(
    @OrgAuth() auth: OrganizationAuthContext,
    @Body() dto: CreateProjectDto,
  ): Promise<ProjectResponseDto> {
    const project = await this.projectService.create(auth.organizationId, dto);
    return project.toResponse();
  }

  @Get()
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.PROJECT_VIEW)
  @ApiOperation({
    summary: 'List projects',
    description:
      'Paginated projects of the active organization, optionally filtered by status or client.',
  })
  @ApiResponse({ status: 200, type: ProjectPageDto })
  @ApiErrors(403)
  async list(
    @OrgAuth() auth: OrganizationAuthContext,
    @Query() query: ProjectQueryDto,
  ): Promise<Paginated<ProjectResponseDto>> {
    const page = await this.projectService.list(auth.organizationId, query);
    return {
      ...page,
      items: page.items.map((project) => project.toResponse()),
    };
  }


  /**
   * Deleted projects, newest first.
   *
   * Declared before `/projectId` on purpose. A `trash` route registered after a
   * parameterised one is unreachable: the parameter route matches the literal
   * string `trash` first, and the UUID pipe rejects it.
   */
  @Get('trash')
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.PROJECT_VIEW)
  @ApiOperation({
    summary: 'List deleted projects',
    description:
      'Soft-deleted projects, with when each was deleted and who deleted it. ' +
      'These rows are excluded from every ordinary read.',
  })
  @ApiResponse({ status: 200, type: [TrashEntryDto] })
  @ApiErrors(403)
  async trash(
    @OrgAuth() auth: OrganizationAuthContext,
  ): Promise<TrashEntryDto[]> {
    return this.projectService.listDeleted(auth.organizationId);
  }

  @Post(':projectId/restore')
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.PROJECT_UPDATE)
  @ApiOperation({
    summary: 'Restore a deleted project',
    description:
      'Brings a soft-deleted project back., together with the subtasks and time entries that were deleted with it. ' +
      'Only the records removed by that same delete are restored, so anything ' +
      'deleted on purpose afterwards stays deleted.',
  })
  @ApiResponse({ status: 201, type: ProjectResponseDto })
  @ApiErrors(403, 404, 409)
  async restore(
    @OrgAuth() auth: OrganizationAuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ): Promise<ProjectResponseDto> {
    const restored = await this.projectService.restore(
      auth.organizationId,
      projectId,
    );

    return restored.toResponse();
  }

  @Get(':projectId')
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.PROJECT_VIEW)
  @ApiOperation({
    summary: 'Get a project',
    description:
      'One project of the active organization, with its client reference when linked to a client.',
  })
  @ApiResponse({ status: 200, type: ProjectResponseDto })
  @ApiErrors(403, 404)
  async findOne(
    @OrgAuth() auth: OrganizationAuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ): Promise<ProjectResponseDto> {
    const project = await this.projectService.findOne(
      auth.organizationId,
      projectId,
    );
    return project.toResponse();
  }

  @Patch(':projectId')
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.PROJECT_UPDATE)
  @ApiOperation({
    summary: 'Update a project',
    description:
      'Updates name, description, client link, status, dates and budget. Only fields you send are modified, and startDate must stay before or equal to endDate.',
  })
  @ApiResponse({ status: 200, type: ProjectResponseDto })
  @ApiErrors(400, 403, 404)
  async update(
    @OrgAuth() auth: OrganizationAuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: UpdateProjectDto,
  ): Promise<ProjectResponseDto> {
    const project = await this.projectService.update(
      auth.organizationId,
      projectId,
      dto,
    );
    return project.toResponse();
  }

  @Delete(':projectId')
  @HttpCode(200)
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.PROJECT_DELETE)
  @ApiOperation({
    summary: 'Delete a project',
    description:
      'Deletes the project with its tasks, subtasks and time entries.',
  })
  @ApiResponse({ status: 200, type: ProjectMessageResponseDto })
  @ApiErrors(400, 403, 404, 409)
  async remove(
    @OrgAuth() auth: OrganizationAuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query() query: ConfirmCascadeDto,
  ): Promise<ProjectMessageResponseDto> {
    const result = await this.projectService.remove(
      auth.organizationId,
      projectId,
      auth.userId,
      query.confirm === CASCADE_CONFIRMATION,
    );

    // `deleted` is always present, including the 1 for a bare project: a
    // consistent shape beats an optional one, and a caller that only
    // wants the message can ignore it.
    return { message: 'Project deleted', deleted: result.deleted };
  }
}
