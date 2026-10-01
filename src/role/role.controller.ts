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
  Put,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '../common/permissions.js';
import {
  OrgAuth,
  type OrganizationAuthContext,
} from '../common/decorators/org-auth.decorator.js';
import { ApiErrors } from '../common/decorators/api-errors.decorator.js';
import {
  OrganizationHeader,
  Protected,
  RequirePermissions,
} from '../common/decorators/protected.decorator.js';
import { RoleService } from './role.service.js';
import {
  AddMemberDto,
  AssignRoleDto,
  CreateRoleDto,
  ReplacePermissionsDto,
  UpdateMemberDto,
  UpdateRoleDto,
} from './dto/role.dto.js';
import {
  MemberResponseDto,
  RoleMessageResponseDto,
  RoleResponseDto,
  RoleTemplateDto,
} from './dto/role-response.dto.js';
import { ROLE_TEMPLATES } from './role.service.js';

@ApiTags('roles')
@Protected()
@Controller('organizations/:organizationId')
export class RoleController {
  constructor(private readonly roleService: RoleService) {}

  @Get('roles')
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.ROLE_VIEW)
  @ApiOperation({
    summary: 'List roles',
    description:
      'Roles of the organization with their attached permissions. Rows without userId are role definitions not assigned to a member yet.',
  })
  @ApiResponse({ status: 200, type: [RoleResponseDto] })
  @ApiErrors(403)
  async listRoles(
    @OrgAuth() auth: OrganizationAuthContext,
  ): Promise<RoleResponseDto[]> {
    const roles = await this.roleService.listRoles(auth.organizationId);
    return roles.map((role) => role.toResponseWithPermissions());
  }

  @Get('role-templates')
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.ROLE_VIEW)
  @ApiOperation({
    summary: 'List role templates',
    description:
      'Reusable default role templates (owner, project_manager, developer, tester, viewer) and the full permission catalog.',
  })
  @ApiResponse({ status: 200, type: [RoleTemplateDto] })
  @ApiErrors(403)
  roleTemplates(): RoleTemplateDto[] {
    return ROLE_TEMPLATES;
  }

  @Get('members')
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.MEMBER_VIEW)
  @ApiOperation({
    summary: 'List organization members',
    description:
      'Members with the role that grants their organization access and its permissions.',
  })
  @ApiResponse({ status: 200, type: [MemberResponseDto] })
  @ApiErrors(403)
  async listMembers(
    @OrgAuth() auth: OrganizationAuthContext,
  ): Promise<MemberResponseDto[]> {
    return this.roleService.listMembers(auth.organizationId);
  }

  @Post('members')
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.MEMBER_INVITE)
  @ApiOperation({
    summary: 'Add a member',
    description:
      'Grants an existing user access to the organization through a default role template.',
  })
  @ApiResponse({ status: 201, type: MemberResponseDto })
  @ApiErrors(400, 403, 404, 409)
  async addMember(
    @OrgAuth() auth: OrganizationAuthContext,
    @Body() dto: AddMemberDto,
  ): Promise<MemberResponseDto> {
    const role = await this.roleService.addMember(auth.organizationId, dto);
    const membership = await this.roleService.resolve(
      auth.organizationId,
      role.userId as string,
    );

    return {
      userId: role.userId as string,
      email: role.user?.email ?? '',
      name: role.user?.name ?? null,
      roleId: role.id,
      roleName: role.name,
      permissions: membership?.permissions ?? [],
    };
  }

  @Patch('members/:userId')
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.MEMBER_UPDATE)
  @ApiOperation({
    summary: "Change a member's role",
    description:
      'Replaces the role a member accesses the organization with; their old role assignment is removed.',
  })
  @ApiResponse({ status: 200, type: MemberResponseDto })
  @ApiErrors(403, 404)
  async updateMember(
    @OrgAuth() auth: OrganizationAuthContext,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: UpdateMemberDto,
  ): Promise<MemberResponseDto> {
    const role = await this.roleService.updateMemberRole(
      auth.organizationId,
      userId,
      dto.roleId as string,
    );
    const membership = await this.roleService.resolve(
      auth.organizationId,
      userId,
    );

    return {
      userId,
      email: role.user?.email ?? '',
      name: role.user?.name ?? null,
      roleId: role.id,
      roleName: role.name,
      permissions: membership?.permissions ?? [],
    };
  }

  @Delete('members/:userId')
  @HttpCode(200)
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.MEMBER_REMOVE)
  @ApiOperation({
    summary: 'Remove a member',
    description: 'Revokes the member access to the organization.',
  })
  @ApiResponse({ status: 200, type: RoleMessageResponseDto })
  @ApiErrors(403, 404)
  async removeMember(
    @OrgAuth() auth: OrganizationAuthContext,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<RoleMessageResponseDto> {
    await this.roleService.removeMember(auth.organizationId, userId);
    return { message: 'Member removed from the organization' };
  }

  @Post('roles')
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.ROLE_CREATE)
  @ApiOperation({
    summary: 'Create a role',
    description:
      'Creates a role definition, optionally assigns it to a member and attaches permissions from the catalog.',
  })
  @ApiResponse({ status: 201, type: RoleResponseDto })
  @ApiErrors(400, 403, 404, 409)
  async createRole(
    @OrgAuth() auth: OrganizationAuthContext,
    @Body() dto: CreateRoleDto,
  ): Promise<RoleResponseDto> {
    const role = await this.roleService.createRole(auth.organizationId, dto);
    return role.toResponseWithPermissions();
  }

  @Get('roles/:roleId')
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.ROLE_VIEW)
  @ApiOperation({
    summary: 'Get a role',
    description: 'One role of the organization with its attached permissions.',
  })
  @ApiResponse({ status: 200, type: RoleResponseDto })
  @ApiErrors(403, 404)
  async findRole(
    @OrgAuth() auth: OrganizationAuthContext,
    @Param('roleId', ParseUUIDPipe) roleId: string,
  ): Promise<RoleResponseDto> {
    const role = await this.roleService.findRole(auth.organizationId, roleId);
    return role.toResponseWithPermissions();
  }

  @Patch('roles/:roleId')
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.ROLE_UPDATE)
  @ApiOperation({
    summary: 'Update a role',
    description:
      'Renames a role or updates its description. Replace the permission set with PUT /organizations/{organizationId}/roles/{roleId}/permissions.',
  })
  @ApiResponse({ status: 200, type: RoleResponseDto })
  @ApiErrors(403, 404)
  async updateRole(
    @OrgAuth() auth: OrganizationAuthContext,
    @Param('roleId', ParseUUIDPipe) roleId: string,
    @Body() dto: UpdateRoleDto,
  ): Promise<RoleResponseDto> {
    const role = await this.roleService.updateRole(
      auth.organizationId,
      roleId,
      dto,
    );
    return role.toResponseWithPermissions();
  }

  @Delete('roles/:roleId')
  @HttpCode(200)
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.ROLE_DELETE)
  @ApiOperation({
    summary: 'Delete a role',
    description: 'Deletes the role and the permissions attached to it.',
  })
  @ApiResponse({ status: 200, type: RoleMessageResponseDto })
  @ApiErrors(403, 404)
  async deleteRole(
    @OrgAuth() auth: OrganizationAuthContext,
    @Param('roleId', ParseUUIDPipe) roleId: string,
  ): Promise<RoleMessageResponseDto> {
    await this.roleService.deleteRole(auth.organizationId, roleId);
    return { message: 'Role deleted' };
  }

  @Put('roles/:roleId/permissions')
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.ROLE_UPDATE)
  @ApiOperation({
    summary: 'Replace role permissions',
    description:
      'Replaces the whole permission set attached to the role. Unknown permission names are rejected.',
  })
  @ApiResponse({ status: 200, type: RoleResponseDto })
  @ApiErrors(400, 403, 404)
  async replacePermissions(
    @OrgAuth() auth: OrganizationAuthContext,
    @Param('roleId', ParseUUIDPipe) roleId: string,
    @Body() dto: ReplacePermissionsDto,
  ): Promise<RoleResponseDto> {
    const role = await this.roleService.replacePermissions(
      auth.organizationId,
      roleId,
      dto,
    );
    return role.toResponseWithPermissions();
  }

  @Post('roles/:roleId/assign')
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.ROLE_ASSIGN)
  @ApiOperation({
    summary: 'Assign a role to a member',
    description:
      'Assigns an unassigned role to a member. A member holds a single role per organization.',
  })
  @ApiResponse({ status: 201, type: RoleResponseDto })
  @ApiErrors(400, 403, 404, 409)
  async assignRole(
    @OrgAuth() auth: OrganizationAuthContext,
    @Param('roleId', ParseUUIDPipe) roleId: string,
    @Body() dto: AssignRoleDto,
  ): Promise<RoleResponseDto> {
    const role = await this.roleService.assignRole(
      auth.organizationId,
      roleId,
      dto,
    );
    return role.toResponseWithPermissions();
  }

  @Delete('roles/:roleId/assign')
  @HttpCode(200)
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.ROLE_ASSIGN)
  @ApiOperation({
    summary: 'Unassign a role',
    description: 'Removes the member currently holding the role.',
  })
  @ApiResponse({ status: 200, type: RoleResponseDto })
  @ApiErrors(403, 404)
  async unassignRole(
    @OrgAuth() auth: OrganizationAuthContext,
    @Param('roleId', ParseUUIDPipe) roleId: string,
  ): Promise<RoleResponseDto> {
    const role = await this.roleService.unassignRole(
      auth.organizationId,
      roleId,
    );
    return role.toResponseWithPermissions();
  }
}
