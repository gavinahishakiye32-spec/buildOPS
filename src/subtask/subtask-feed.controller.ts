import {
  Controller,
  ForbiddenException,
  Get,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
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
import { RoleService } from '../role/role.service.js';
import { AssignableMemberDto } from '../role/dto/assignable-member.dto.js';
import { SubtaskService } from './subtask.service.js';
import {
  AssignedSubtaskResponseDto,
  SubtaskFeedQueryDto,
} from './dto/subtask.dto.js';

const SubtaskFeedPageDto = PaginatedSchema(
  AssignedSubtaskResponseDto,
  'SubtaskFeedPage',
);

/**
 * The organization-wide read side of assignment.
 *
 * Separate from {@link SubtaskController}, which is mounted under a task and so
 * cannot answer a question that spans tasks. Kept apart for the same reason the
 * routes are: these two have different shapes, different filters and different
 * permissions, and folding them together would mean every subtask read taking
 * a `:taskId` it does not have.
 *
 * **The feed answers one question: what am I doing.** It is scoped to the
 * caller's own assigned work, for every role including the Owner. See
 * {@link SubtaskFeedController.feed} for why that is enforced here rather than
 * in the interface.
 */
@ApiRateLimited()
@ApiTags('subtasks')
@Protected()
@Controller()
export class SubtaskFeedController {
  constructor(
    private readonly subtaskService: SubtaskService,
    private readonly roleService: RoleService,
  ) {}

  @Get('subtasks')
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.SUBTASK_VIEW)
  @ApiOperation({
    summary: 'List the subtasks assigned to you',
    description:
      'Your work across every project in the active organization, each row ' +
      'carrying the task and project it belongs to -- a subtask read out of ' +
      'context ("reset the password") cannot be judged or prioritised on its ' +
      'own.\n\n' +
      'This route is scoped to the caller: it always answers with the ' +
      'subtasks assigned to *them*, whatever role they hold. Narrow it further ' +
      'with `status`, `projectId` and `taskId`.\n\n' +
      'Asking for `assigneeId` or for the unassigned backlog is refused with ' +
      '403 rather than quietly answered with your own work: a caller that ' +
      'asked "what has Rex got" and got their own queue back would read the ' +
      'empty result as "Rex has nothing", which is a different and wrong ' +
      'conclusion. Ordered by due date, soonest first, with undated work last.',
  })
  @ApiResponse({
    description: 'One page of the work assigned to the caller',
    status: 200,
    type: SubtaskFeedPageDto,
  })
  @ApiErrors(403)
  async feed(
    @OrgAuth() auth: OrganizationAuthContext,
    @Query() query: SubtaskFeedQueryDto,
  ): Promise<Paginated<AssignedSubtaskResponseDto>> {
    /**
     * Scoped to the caller, for everybody including the Owner.
     *
     * `subtask.view` is the grant to read subtasks, and this route is the one
     * place a person's queue is assembled across projects. It answers "what am
     * I am doing", which has one subject: me. Letting it widen to "what is
     * everyone doing" would make it a different product -- a team roster --
     * wearing the same route, and the two have different audiences.
     *
     * This belongs on the server rather than in the interface. Hiding a filter
     * in the browser is not a boundary: the caller would only have to type
     * `?assigneeId=` by hand. `PageGate`'s own rule -- the link is the
     * invitation, the door is here -- is the same one.
     */
    if (query.assigneeId && query.assigneeId !== auth.userId) {
      throw new ForbiddenException(
        'This route lists your own subtasks. Read another person\'s work from ' +
          'the task they belong to.',
      );
    }

    if (query.assignment && query.assignment !== 'assigned') {
      throw new ForbiddenException(
        'The unassigned backlog is not visible here. Open a task to pick up ' +
          'one of its steps.',
      );
    }

    return this.subtaskService.feed(auth.organizationId, {
      ...query,
      assigneeId: auth.userId,
      assignment: 'assigned',
    });
  }

  @Get('assignees')
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.SUBTASK_ASSIGN)
  @ApiOperation({
    summary: 'List the people work can be assigned to',
    description:
      'Active members of the organization, as the assignment picker needs them: ' +
      'id, name and email, and nothing about their role or permissions. ' +
      'Requires `subtask.assign` rather than `member.view`, so handing work to ' +
      'somebody does not also make the caller an administrator of the member ' +
      'directory.',
  })
  @ApiResponse({
    description: 'Assignable members, by name',
    status: 200,
    type: [AssignableMemberDto],
  })
  @ApiErrors(403)
  async assignees(
    @OrgAuth() auth: OrganizationAuthContext,
  ): Promise<AssignableMemberDto[]> {
    return this.roleService.listAssignableMembers(auth.organizationId);
  }
}