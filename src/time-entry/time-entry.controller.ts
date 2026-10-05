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
import { TimeEntryService } from './time-entry.service.js';
import {
  CreateTimeEntryDto,
  StartTimerDto,
  StopTimerDto,
  TimeEntryMessageResponseDto,
  TimeEntryQueryDto,
  ActiveTimerResponseDto,
  TimeEntryResponseDto,
  TimerResponseDto,
  UpdateTimeEntryDto,
} from './dto/time-entry.dto.js';
import { TrashEntryDto } from '../common/soft-delete.js';

const TimeEntryPageDto = PaginatedSchema(TimeEntryResponseDto, 'TimeEntryPage');

@ApiExcludeController()
@ApiTags('time-entries')
@Protected()
@Controller('time-entries')
export class TimeEntryController {
  constructor(private readonly timeEntryService: TimeEntryService) {}

  @Post()
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.TIME_ENTRY_CREATE)
  @ApiOperation({
    summary: 'Log time manually',
    description:
      'Creates a completed or running time entry against a subtask. Only one timer may run at a time per user.',
  })
  @ApiResponse({ status: 201, type: TimeEntryResponseDto })
  @ApiErrors(400, 403, 404, 409)
  async create(
    @OrgAuth() auth: OrganizationAuthContext,
    @Body() dto: CreateTimeEntryDto,
  ): Promise<TimeEntryResponseDto> {
    const entry = await this.timeEntryService.create(
      auth.organizationId,
      auth.userId,
      dto,
    );
    return entry.toResponse();
  }

  @Get()
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.TIME_ENTRY_VIEW)
  @ApiOperation({
    summary: 'List time entries',
    description:
      'Without time_entry.view_all a caller sees only their own entries; with it, the whole organization.',
  })
  @ApiResponse({ status: 200, type: TimeEntryPageDto })
  @ApiErrors(403)
  async list(
    @OrgAuth() auth: OrganizationAuthContext,
    @Query() query: TimeEntryQueryDto,
  ): Promise<Paginated<TimeEntryResponseDto>> {
    const page = await this.timeEntryService.list(
      auth.organizationId,
      auth.userId,
      auth.permissions.includes(PERMISSIONS.TIME_ENTRY_VIEW_ALL),
      query,
    );

    return { ...page, items: page.items.map((entry) => entry.toResponse()) };
  }

  @Get('timer/active')
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.TIME_ENTRY_VIEW)
  @ApiOperation({
    summary: 'Get the running timer',
    description:
      'Active timer of the caller wrapped in an envelope, null when nothing is running.',
  })
  @ApiResponse({ status: 200, type: ActiveTimerResponseDto })
  @ApiErrors(403)
  async activeTimer(
    @OrgAuth() auth: OrganizationAuthContext,
  ): Promise<ActiveTimerResponseDto> {
    const entry = await this.timeEntryService.findActive(
      auth.organizationId,
      auth.userId,
    );

    return { entry: entry ? entry.toResponse() : null };
  }

  @Post('timer/start')
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.TIME_ENTRY_START_TIMER)
  @ApiOperation({
    summary: 'Start a timer',
    description:
      'Starts a timer on a subtask: entry_time = now, exit_time = null. Only one timer may run at a time.',
  })
  @ApiResponse({ status: 201, type: TimerResponseDto })
  @ApiErrors(400, 403, 404, 409)
  async startTimer(
    @OrgAuth() auth: OrganizationAuthContext,
    @Body() dto: StartTimerDto,
  ): Promise<TimerResponseDto> {
    const entry = await this.timeEntryService.startTimer(
      auth.organizationId,
      auth.userId,
      dto,
    );

    return {
      message: `Timer started at ${entry.entryTime.toISOString()}`,
      entry: entry.toResponse(),
    };
  }

  @Post('timer/stop')
  @HttpCode(200)
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.TIME_ENTRY_STOP_TIMER)
  @ApiOperation({
    summary: 'Stop a timer',
    description:
      'Stops the caller timer: exit_time = now, validated against entry_time, and returns the computed duration.',
  })
  @ApiResponse({ status: 200, type: TimerResponseDto })
  @ApiErrors(400, 403, 404, 409)
  async stopTimer(
    @OrgAuth() auth: OrganizationAuthContext,
    @Body() dto: StopTimerDto,
  ): Promise<TimerResponseDto> {
    const entry = await this.timeEntryService.stopTimer(
      auth.organizationId,
      auth.userId,
      dto,
    );

    return {
      message: `Timer stopped after ${entry.durationSeconds()} seconds`,
      entry: entry.toResponse(),
    };
  }


  /**
   * Deleted time entries, newest first.
   *
   * Declared before `/timeEntryId` on purpose. A `trash` route registered after a
   * parameterised one is unreachable: the parameter route matches the literal
   * string `trash` first, and the UUID pipe rejects it.
   */
  @Get('trash')
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.TIME_ENTRY_VIEW)
  @ApiOperation({
    summary: 'List deleted time entries',
    description:
      'Soft-deleted time entries, with when each was deleted and who deleted it. ' +
      'These rows are excluded from every ordinary read.',
  })
  @ApiResponse({ status: 200, type: [TrashEntryDto] })
  @ApiErrors(403)
  async trash(
    @OrgAuth() auth: OrganizationAuthContext,
  ): Promise<TrashEntryDto[]> {
    return this.timeEntryService.listDeleted(auth.organizationId, auth.userId);
  }

  @Post(':timeEntryId/restore')
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.TIME_ENTRY_UPDATE)
  @ApiOperation({
    summary: 'Restore a deleted time entry',
    description:
      'Brings a soft-deleted time entry back. ' +
      'Only the records removed by that same delete are restored, so anything ' +
      'deleted on purpose afterwards stays deleted.',
  })
  @ApiResponse({ status: 201, type: TimeEntryResponseDto })
  @ApiErrors(403, 404, 409)
  async restore(
    @OrgAuth() auth: OrganizationAuthContext,
    @Param('timeEntryId', ParseUUIDPipe) timeEntryId: string,
  ): Promise<TimeEntryResponseDto> {
    const entry = await this.timeEntryService.restore(
      auth.organizationId,
      auth.userId,
      timeEntryId,
    );

    return entry.toResponse();
  }

  @Get(':timeEntryId')
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.TIME_ENTRY_VIEW)
  @ApiOperation({
    summary: 'Get a time entry',
    description:
      'One time entry of the active organization. isRunning is true while the timer keeps counting and durationSeconds is live until it stops.',
  })
  @ApiResponse({ status: 200, type: TimeEntryResponseDto })
  @ApiErrors(403, 404)
  async findOne(
    @OrgAuth() auth: OrganizationAuthContext,
    @Param('timeEntryId', ParseUUIDPipe) timeEntryId: string,
  ): Promise<TimeEntryResponseDto> {
    const entry = await this.timeEntryService.findVisible(
      auth.organizationId,
      timeEntryId,
      auth.userId,
      auth.permissions.includes(PERMISSIONS.TIME_ENTRY_VIEW_ALL),
    );

    return entry.toResponse();
  }

  @Patch(':timeEntryId')
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.TIME_ENTRY_UPDATE)
  @ApiOperation({
    summary: 'Update a time entry',
    description:
      'Adjusts entry_time/exit_time of an entry owned by the caller. exit_time = null reopens the timer.',
  })
  @ApiResponse({ status: 200, type: TimeEntryResponseDto })
  @ApiErrors(400, 403, 404)
  async update(
    @OrgAuth() auth: OrganizationAuthContext,
    @Param('timeEntryId', ParseUUIDPipe) timeEntryId: string,
    @Body() dto: UpdateTimeEntryDto,
  ): Promise<TimeEntryResponseDto> {
    const entry = await this.timeEntryService.update(
      auth.organizationId,
      auth.userId,
      timeEntryId,
      dto,
    );
    return entry.toResponse();
  }

  @Delete(':timeEntryId')
  @HttpCode(200)
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.TIME_ENTRY_DELETE)
  @ApiOperation({
    summary: 'Delete a time entry',
    description:
      'Deletes a time entry of the active organization. Only the user who logged it can delete it; other members get a 404.',
  })
  @ApiResponse({ status: 200, type: TimeEntryMessageResponseDto })
  @ApiErrors(403, 404)
  async remove(
    @OrgAuth() auth: OrganizationAuthContext,
    @Param('timeEntryId', ParseUUIDPipe) timeEntryId: string,
  ): Promise<TimeEntryMessageResponseDto> {
    await this.timeEntryService.remove(
      auth.organizationId,
      auth.userId,
      timeEntryId,
    );
    return { message: 'Time entry deleted' };
  }
}
