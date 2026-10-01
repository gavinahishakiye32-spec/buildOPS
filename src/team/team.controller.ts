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
import { PERMISSIONS } from '../common/permissions.js';
import { PaginatedSchema } from '../common/dto/paginated-response.dto.js';
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
import {
  PaginationQueryDto,
  type Paginated,
} from '../common/pagination.dto.js';
import { TeamService } from './team.service.js';
import {
  AddTeamMemberDto,
  CreateTeamDto,
  TeamMemberResponseDto,
  TeamMessageResponseDto,
  TeamResponseDto,
  UpdateTeamDto,
  UpdateTeamMemberDto,
} from './dto/team.dto.js';

const TeamPageDto = PaginatedSchema(TeamResponseDto, 'TeamPage');

@ApiTags('teams')
@Protected()
@Controller('teams')
export class TeamController {
  constructor(private readonly teamService: TeamService) {}

  @Post()
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.TEAM_CREATE)
  @ApiOperation({
    summary: 'Create a team',
    description: 'Creates a team inside the active organization.',
  })
  @ApiResponse({ status: 201, type: TeamResponseDto })
  @ApiErrors(400, 403)
  async create(
    @OrgAuth() auth: OrganizationAuthContext,
    @Body() dto: CreateTeamDto,
  ): Promise<TeamResponseDto> {
    const team = await this.teamService.create(auth.organizationId, dto);
    return team.toResponse();
  }

  @Get()
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.TEAM_VIEW)
  @ApiOperation({
    summary: 'List teams',
    description: 'Paginated teams of the active organization.',
  })
  @ApiResponse({ status: 200, type: TeamPageDto })
  @ApiErrors(403)
  async list(
    @OrgAuth() auth: OrganizationAuthContext,
    @Query() query: PaginationQueryDto,
  ): Promise<Paginated<TeamResponseDto>> {
    const page = await this.teamService.list(auth.organizationId, query);
    return { ...page, items: page.items.map((team) => team.toResponse()) };
  }

  @Get(':teamId')
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.TEAM_VIEW)
  @ApiOperation({
    summary: 'Get a team',
    description: 'One team of the active organization.',
  })
  @ApiResponse({ status: 200, type: TeamResponseDto })
  @ApiErrors(403, 404)
  async findOne(
    @OrgAuth() auth: OrganizationAuthContext,
    @Param('teamId', ParseUUIDPipe) teamId: string,
  ): Promise<TeamResponseDto> {
    const team = await this.teamService.findOne(auth.organizationId, teamId);
    return team.toResponse();
  }

  @Patch(':teamId')
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.TEAM_UPDATE)
  @ApiOperation({
    summary: 'Update a team',
    description: 'Renames a team or updates its description and status.',
  })
  @ApiResponse({ status: 200, type: TeamResponseDto })
  @ApiErrors(400, 403, 404)
  async update(
    @OrgAuth() auth: OrganizationAuthContext,
    @Param('teamId', ParseUUIDPipe) teamId: string,
    @Body() dto: UpdateTeamDto,
  ): Promise<TeamResponseDto> {
    const team = await this.teamService.update(
      auth.organizationId,
      teamId,
      dto,
    );
    return team.toResponse();
  }

  @Delete(':teamId')
  @HttpCode(200)
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.TEAM_DELETE)
  @ApiOperation({
    summary: 'Delete a team',
    description:
      'Deletes the team, its memberships and its task assignments. Historical time entries are kept.',
  })
  @ApiResponse({ status: 200, type: TeamMessageResponseDto })
  @ApiErrors(403, 404)
  async remove(
    @OrgAuth() auth: OrganizationAuthContext,
    @Param('teamId', ParseUUIDPipe) teamId: string,
  ): Promise<TeamMessageResponseDto> {
    await this.teamService.remove(auth.organizationId, teamId);
    return { message: 'Team deleted' };
  }

  @Get(':teamId/members')
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.TEAM_VIEW)
  @ApiOperation({
    summary: 'List team members',
    description:
      'Membership records with the team-scoped role and status (spec §7).',
  })
  @ApiResponse({ status: 200, type: [TeamMemberResponseDto] })
  @ApiErrors(403, 404)
  async listMembers(
    @OrgAuth() auth: OrganizationAuthContext,
    @Param('teamId', ParseUUIDPipe) teamId: string,
  ): Promise<TeamMemberResponseDto[]> {
    const members = await this.teamService.listMembers(
      auth.organizationId,
      teamId,
    );
    return members.map((member) => member.toResponse());
  }

  @Post(':teamId/members')
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.TEAM_MEMBER_ADD)
  @ApiOperation({
    summary: 'Add a team member',
    description:
      'Adds an existing organization member to the team. Membership in the organization is required.',
  })
  @ApiResponse({ status: 201, type: TeamMemberResponseDto })
  @ApiErrors(400, 403, 404, 409)
  async addMember(
    @OrgAuth() auth: OrganizationAuthContext,
    @Param('teamId', ParseUUIDPipe) teamId: string,
    @Body() dto: AddTeamMemberDto,
  ): Promise<TeamMemberResponseDto> {
    const member = await this.teamService.addMember(
      auth.organizationId,
      teamId,
      dto,
    );
    return member.toResponse();
  }

  @Patch(':teamId/members/:memberId')
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.TEAM_MEMBER_ADD)
  @ApiOperation({
    summary: 'Update a team membership',
    description: 'Changes the team-scoped role or the membership status.',
  })
  @ApiResponse({ status: 200, type: TeamMemberResponseDto })
  @ApiErrors(400, 403, 404)
  async updateMember(
    @OrgAuth() auth: OrganizationAuthContext,
    @Param('teamId', ParseUUIDPipe) teamId: string,
    @Param('memberId', ParseUUIDPipe) memberId: string,
    @Body() dto: UpdateTeamMemberDto,
  ): Promise<TeamMemberResponseDto> {
    const member = await this.teamService.updateMember(
      auth.organizationId,
      teamId,
      memberId,
      dto,
    );
    return member.toResponse();
  }

  @Delete(':teamId/members/:memberId')
  @HttpCode(200)
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.TEAM_MEMBER_REMOVE)
  @ApiOperation({
    summary: 'Remove a team member',
    description:
      'Removes a membership from a team. The user keeps their organization access and their assigned tasks.',
  })
  @ApiResponse({ status: 200, type: TeamMessageResponseDto })
  @ApiErrors(403, 404)
  async removeMember(
    @OrgAuth() auth: OrganizationAuthContext,
    @Param('teamId', ParseUUIDPipe) teamId: string,
    @Param('memberId', ParseUUIDPipe) memberId: string,
  ): Promise<TeamMessageResponseDto> {
    await this.teamService.removeMember(auth.organizationId, teamId, memberId);
    return { message: 'Team member removed' };
  }
}
