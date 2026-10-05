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
import { TaskService } from './task.service.js';
import {
  CreateTaskDto,
  TaskMessageResponseDto,
  TaskQueryDto,
  TaskResponseDto,
  UpdateTaskDto,
} from './dto/task.dto.js';
import {
  CASCADE_CONFIRMATION,
  ConfirmCascadeDto,
  TrashEntryDto,
} from '../common/soft-delete.js';

const TaskPageDto = PaginatedSchema(TaskResponseDto, 'TaskPage');

@ApiExcludeController()
@ApiTags('tasks')
@Protected()
@Controller('tasks')
export class TaskController {
  constructor(private readonly taskService: TaskService) {}

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


  /**
   * Deleted tasks, newest first.
   *
   * Declared before `/taskId` on purpose. A `trash` route registered after a
   * parameterised one is unreachable: the parameter route matches the literal
   * string `trash` first, and the UUID pipe rejects it.
   */
  @Get('trash')
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.TASK_VIEW)
  @ApiOperation({
    summary: 'List deleted tasks',
    description:
      'Soft-deleted tasks, with when each was deleted and who deleted it. ' +
      'These rows are excluded from every ordinary read.',
  })
  @ApiResponse({ status: 200, type: [TrashEntryDto] })
  @ApiErrors(403)
  async trash(
    @OrgAuth() auth: OrganizationAuthContext,
  ): Promise<TrashEntryDto[]> {
    return this.taskService.listDeleted(auth.organizationId);
  }

  @Post(':taskId/restore')
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.TASK_UPDATE)
  @ApiOperation({
    summary: 'Restore a deleted task',
    description:
      'Brings a soft-deleted task back., together with the subtasks and time entries that were deleted with it. ' +
      'Only the records removed by that same delete are restored, so anything ' +
      'deleted on purpose afterwards stays deleted.',
  })
  @ApiResponse({ status: 201, type: TaskResponseDto })
  @ApiErrors(403, 404, 409)
  async restore(
    @OrgAuth() auth: OrganizationAuthContext,
    @Param('taskId', ParseUUIDPipe) taskId: string,
  ): Promise<TaskResponseDto> {
    const restored = await this.taskService.restore(
      auth.organizationId,
      taskId,
    );

    return restored.toResponse();
  }

  @Get(':taskId')
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.TASK_VIEW)
  @ApiOperation({
    summary: 'Get a task',
    description:
      'One task of the active organization, with its project, team and badge references.',
  })
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
  @ApiErrors(400, 403, 404, 409)
  async remove(
    @OrgAuth() auth: OrganizationAuthContext,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Query() query: ConfirmCascadeDto,
  ): Promise<TaskMessageResponseDto> {
    const result = await this.taskService.remove(
      auth.organizationId,
      taskId,
      auth.userId,
      query.confirm === CASCADE_CONFIRMATION,
    );

    // `deleted` is always present, including the 1 for a bare task: a
    // consistent shape beats an optional one, and a caller that only
    // wants the message can ignore it.
    return { message: 'Task deleted', deleted: result.deleted };
  }
}
