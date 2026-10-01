import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
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
import { TaskService } from '../task/task.service.js';
import { Subtask } from './subtask.entity.js';
import { SubtaskService } from './subtask.service.js';
import {
  CreateSubtaskDto,
  SubtaskMessageResponseDto,
  SubtaskQueryDto,
  SubtaskResponseDto,
  UpdateSubtaskDto,
} from './dto/subtask.dto.js';

const SubtaskPageDto = PaginatedSchema(SubtaskResponseDto, 'SubtaskPage');

@ApiTags('subtasks')
@Protected()
@Controller('tasks/:taskId/subtasks')
export class SubtaskController {
  constructor(
    private readonly subtaskService: SubtaskService,
    private readonly taskService: TaskService,
  ) {}

  @Get()
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.SUBTASK_VIEW)
  @ApiOperation({
    summary: 'List subtasks',
    description: 'Paginated subtasks of a task in the active organization.',
  })
  @ApiResponse({ status: 200, type: SubtaskPageDto })
  @ApiErrors(403, 404)
  async listSubtasks(
    @OrgAuth() auth: OrganizationAuthContext,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Query() query: SubtaskQueryDto,
  ): Promise<Paginated<SubtaskResponseDto>> {
    const page = await this.subtaskService.list(
      auth.organizationId,
      taskId,
      query,
    );

    return {
      ...page,
      items: page.items.map((subtask) => subtask.toResponse()),
    };
  }

  @Post()
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.SUBTASK_CREATE, PERMISSIONS.SUBTASK_ASSIGN)
  @ApiOperation({
    summary: 'Create a subtask',
    description:
      'Creates a subtask. When assignedTo is set, the user must be an active member of the team assigned to the task.',
  })
  @ApiResponse({ status: 201, type: SubtaskResponseDto })
  @ApiErrors(400, 403, 404)
  async createSubtask(
    @OrgAuth() auth: OrganizationAuthContext,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Body() dto: CreateSubtaskDto,
  ): Promise<SubtaskResponseDto> {
    const subtask = await this.subtaskService.create(
      auth.organizationId,
      taskId,
      dto,
    );

    return subtask.toResponse();
  }

  @Get(':subtaskId')
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.SUBTASK_VIEW)
  @ApiOperation({
    summary: 'Get a subtask',
    description: 'One subtask of a task of the active organization.',
  })
  @ApiResponse({ status: 200, type: SubtaskResponseDto })
  @ApiErrors(403, 404)
  async findSubtask(
    @OrgAuth() auth: OrganizationAuthContext,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Param('subtaskId', ParseUUIDPipe) subtaskId: string,
  ): Promise<SubtaskResponseDto> {
    const subtask = await this.requireSubtaskOfTask(
      auth.organizationId,
      taskId,
      subtaskId,
    );

    return subtask.toResponse();
  }

  @Patch(':subtaskId')
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.SUBTASK_UPDATE)
  @ApiOperation({
    summary: 'Update a subtask',
    description:
      'Updates fields and reassigns the subtask to another team member.',
  })
  @ApiResponse({ status: 200, type: SubtaskResponseDto })
  @ApiErrors(400, 403, 404)
  async updateSubtask(
    @OrgAuth() auth: OrganizationAuthContext,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Param('subtaskId', ParseUUIDPipe) subtaskId: string,
    @Body() dto: UpdateSubtaskDto,
  ): Promise<SubtaskResponseDto> {
    await this.requireSubtaskOfTask(auth.organizationId, taskId, subtaskId);

    const subtask = await this.subtaskService.update(
      auth.organizationId,
      subtaskId,
      dto,
    );

    return subtask.toResponse();
  }

  @Delete(':subtaskId')
  @HttpCode(200)
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.SUBTASK_DELETE)
  @ApiOperation({
    summary: 'Delete a subtask',
    description: 'Deletes the subtask with its time entries.',
  })
  @ApiResponse({ status: 200, type: SubtaskMessageResponseDto })
  @ApiErrors(403, 404)
  async removeSubtask(
    @OrgAuth() auth: OrganizationAuthContext,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Param('subtaskId', ParseUUIDPipe) subtaskId: string,
  ): Promise<SubtaskMessageResponseDto> {
    await this.requireSubtaskOfTask(auth.organizationId, taskId, subtaskId);
    await this.subtaskService.remove(auth.organizationId, subtaskId);

    return { message: 'Subtask deleted' };
  }

  /** Ensures the subtask really belongs to the task in the route (no id juggling). */
  private async requireSubtaskOfTask(
    organizationId: string,
    taskId: string,
    subtaskId: string,
  ): Promise<Subtask> {
    await this.taskService.findOne(organizationId, taskId);

    const subtask = await this.subtaskService.findOne(
      organizationId,
      subtaskId,
    );

    if (subtask.taskId !== taskId) {
      throw new NotFoundException('Subtask not found in this task');
    }

    return subtask;
  }
}
