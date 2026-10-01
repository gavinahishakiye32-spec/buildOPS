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
import { Subtask } from '../subtask/subtask.entity.js';
import { SubtaskService } from '../subtask/subtask.service.js';
import { TaskService } from './task.service.js';
import {
  CreateSubtaskDto,
  CreateTaskDto,
  SubtaskQueryDto,
  SubtaskResponseDto,
  TaskMessageResponseDto,
  TaskQueryDto,
  TaskResponseDto,
  UpdateSubtaskDto,
  UpdateTaskDto,
} from './dto/task.dto.js';

const TaskPageDto = PaginatedSchema(TaskResponseDto, 'TaskPage');
const SubtaskPageDto = PaginatedSchema(SubtaskResponseDto, 'SubtaskPage');

@ApiTags('tasks')
@Protected()
@Controller('tasks')
export class TaskController {
  constructor(
    private readonly taskService: TaskService,
    private readonly subtaskService: SubtaskService,
  ) {}

  @Post()
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.TASK_CREATE)
  @ApiOperation({
    summary: 'Create a task',
    description:
      'Creates a task in a project of the active organization. Team and badge, when provided, must belong to the same organization.',
  })
  @ApiResponse({ status: 201, type: TaskResponseDto })
  @ApiErrors(400, 403, 404)
  async create(
    @OrgAuth() auth: OrganizationAuthContext,
    @Body() dto: CreateTaskDto,
  ): Promise<TaskResponseDto> {
    const task = await this.taskService.create(auth.organizationId, dto);
    return task.toResponse();
  }

  @Get()
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.TASK_VIEW)
  @ApiOperation({
    summary: 'List tasks',
    description:
      'Paginated tasks of the active organization, filterable by project, team, badge, status and priority.',
  })
  @ApiResponse({ status: 200, type: TaskPageDto })
  @ApiErrors(403)
  async list(
    @OrgAuth() auth: OrganizationAuthContext,
    @Query() query: TaskQueryDto,
  ): Promise<Paginated<TaskResponseDto>> {
    const page = await this.taskService.list(auth.organizationId, query);
    return { ...page, items: page.items.map((task) => task.toResponse()) };
  }

  @Get(':taskId')
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.TASK_VIEW)
  @ApiOperation({ summary: 'Get a task' })
  @ApiResponse({ status: 200, type: TaskResponseDto })
  @ApiErrors(403, 404)
  async findOne(
    @OrgAuth() auth: OrganizationAuthContext,
    @Param('taskId', ParseUUIDPipe) taskId: string,
  ): Promise<TaskResponseDto> {
    const task = await this.taskService.findOne(auth.organizationId, taskId);
    return task.toResponse();
  }

  @Patch(':taskId')
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.TASK_UPDATE)
  @ApiOperation({
    summary: 'Update a task',
    description:
      'Updates title, description, priority, status, due date, team assignment and badge classification.',
  })
  @ApiResponse({ status: 200, type: TaskResponseDto })
  @ApiErrors(400, 403, 404)
  async update(
    @OrgAuth() auth: OrganizationAuthContext,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Body() dto: UpdateTaskDto,
  ): Promise<TaskResponseDto> {
    const task = await this.taskService.update(
      auth.organizationId,
      taskId,
      dto,
    );
    return task.toResponse();
  }

  @Delete(':taskId')
  @HttpCode(200)
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.TASK_DELETE)
  @ApiOperation({
    summary: 'Delete a task',
    description: 'Deletes the task with its subtasks and time entries.',
  })
  @ApiResponse({ status: 200, type: TaskMessageResponseDto })
  @ApiErrors(403, 404)
  async remove(
    @OrgAuth() auth: OrganizationAuthContext,
    @Param('taskId', ParseUUIDPipe) taskId: string,
  ): Promise<TaskMessageResponseDto> {
    await this.taskService.remove(auth.organizationId, taskId);
    return { message: 'Task deleted' };
  }

  @Get(':taskId/subtasks')
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

  @Post(':taskId/subtasks')
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

  @Get(':taskId/subtasks/:subtaskId')
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.SUBTASK_VIEW)
  @ApiOperation({ summary: 'Get a subtask' })
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

  @Patch(':taskId/subtasks/:subtaskId')
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.SUBTASK_UPDATE)
  @ApiOperation({
    summary: 'Update a subtask',
    description: 'Updates fields and reassigns the subtask to another team member.',
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

  @Delete(':taskId/subtasks/:subtaskId')
  @HttpCode(200)
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.SUBTASK_DELETE)
  @ApiOperation({
    summary: 'Delete a subtask',
    description: 'Deletes the subtask with its time entries.',
  })
  @ApiResponse({ status: 200, type: TaskMessageResponseDto })
  @ApiErrors(403, 404)
  async removeSubtask(
    @OrgAuth() auth: OrganizationAuthContext,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Param('subtaskId', ParseUUIDPipe) subtaskId: string,
  ): Promise<TaskMessageResponseDto> {
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