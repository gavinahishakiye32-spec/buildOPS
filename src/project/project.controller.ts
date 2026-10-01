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
import { ProjectService } from './project.service.js';
import {
  CreateProjectDto,
  ProjectMessageResponseDto,
  ProjectQueryDto,
  ProjectResponseDto,
  UpdateProjectDto,
} from './dto/project.dto.js';

const ProjectPageDto = PaginatedSchema(ProjectResponseDto, 'ProjectPage');

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
    const project = await this.projectService.create(
      auth.organizationId,
      dto,
    );
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

  @Get(':projectId')
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.PROJECT_VIEW)
  @ApiOperation({ summary: 'Get a project' })
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
  @ApiOperation({ summary: 'Update a project' })
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
    description: 'Deletes the project with its tasks, subtasks and time entries.',
  })
  @ApiResponse({ status: 200, type: ProjectMessageResponseDto })
  @ApiErrors(403, 404)
  async remove(
    @OrgAuth() auth: OrganizationAuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ): Promise<ProjectMessageResponseDto> {
    await this.projectService.remove(auth.organizationId, projectId);
    return { message: 'Project deleted' };
  }
}