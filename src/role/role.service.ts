import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Membership, MembershipResolver } from '../common/membership.js';
import {
  ALL_PERMISSIONS,
  DEFAULT_ROLE_TEMPLATES,
  isPermissionName,
  type PermissionName,
} from '../common/permissions.js';
import { UserService } from '../user/user.service.js';
import { Permission } from './permission.entity.js';
import { Role } from './role.entity.js';
import {
  AddMemberDto,
  AssignRoleDto,
  CreateRoleDto,
  ReplacePermissionsDto,
  UpdateRoleDto,
} from './dto/role.dto.js';

/**
 * Role and permission management (spec §6) plus organization membership
 * resolution used by `PermissionsGuard` (spec §5).
 */
@Injectable()
export class RoleService extends MembershipResolver {
  constructor(
    @InjectRepository(Role)
    private readonly roleRepo: Repository<Role>,
    @InjectRepository(Permission)
    private readonly permissionRepo: Repository<Permission>,
    private readonly userService: UserService,
  ) {
    super();
  }

  // --- membership -----------------------------------------------------------

  /** Resolves the caller's role and permissions inside an organization. */
  override async resolve(
    organizationId: string,
    userId: string,
  ): Promise<Membership | null> {
    const role = await this.roleRepo.findOne({
      where: { organizationId, userId },
      relations: { permissions: true },
    });

    if (!role) {
      return null;
    }

    return {
      roleId: role.id,
      roleName: role.name,
      permissions: (role.permissions ?? []).map(
        (permission) => permission.name as PermissionName,
      ),
    };
  }

  async listMembers(organizationId: string): Promise<
    {
      userId: string;
      email: string;
      name: string | null;
      roleId: string;
      roleName: string;
      permissions: PermissionName[];
    }[]
  > {
    const roles = await this.roleRepo.find({
      where: { organizationId },
      relations: { permissions: true, user: true },
      order: { createdAt: 'ASC' },
    });

    return roles
      .filter((role) => role.userId !== null && role.user !== null)
      .map((role) => ({
        userId: role.userId as string,
        email: role.user?.email ?? '',
        name: role.user?.name ?? null,
        roleId: role.id,
        roleName: role.name,
        permissions: (role.permissions ?? []).map(
          (permission) => permission.name as PermissionName,
        ),
      }));
  }

  async addMember(
    organizationId: string,
    dto: AddMemberDto,
  ): Promise<Role> {
    if (!dto.userId && !dto.email) {
      throw new BadRequestException('userId or email is required');
    }

    const user = dto.userId
      ? await this.userService.findById(dto.userId)
      : await this.userService.findByEmail(dto.email as string);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const templateKey = dto.templateKey ?? 'viewer';
    const template = this.findTemplate(templateKey);

    return this.assignNewRole(organizationId, {
      name: template.name,
      description: template.description,
      userId: user.id,
      permissions: template.permissions,
    });
  }

  async updateMemberRole(
    organizationId: string,
    userId: string,
    roleId: string,
  ): Promise<Role> {
    const target = await this.requireRoleInOrganization(organizationId, roleId);
    const current = await this.roleRepo.findOne({
      where: { organizationId, userId },
    });

    if (!current) {
      throw new NotFoundException('Member not found in this organization');
    }

    if (current.id === target.id) {
      return this.loadRole(current.id);
    }

    const replacement = await this.loadRole(target.id);
    await this.replacePermissionRows(
      current,
      (replacement.permissions ?? []).map(
        (permission) => permission.name as PermissionName,
      ),
    );
    await this.roleRepo.delete(current.id);

    replacement.userId = userId;
    return this.roleRepo.save(replacement);
  }

  async removeMember(organizationId: string, userId: string): Promise<void> {
    const role = await this.roleRepo.findOne({
      where: { organizationId, userId },
    });

    if (!role) {
      throw new NotFoundException('Member not found in this organization');
    }

    await this.roleRepo.delete(role.id);
  }

  // --- roles ----------------------------------------------------------------

  async listRoles(organizationId: string): Promise<Role[]> {
    return this.roleRepo.find({
      where: { organizationId },
      relations: { permissions: true, user: true },
      order: { createdAt: 'ASC' },
    });
  }

  async findRole(organizationId: string, roleId: string): Promise<Role> {
    const role = await this.roleRepo.findOne({
      where: { id: roleId, organizationId },
      relations: { permissions: true, user: true },
    });

    if (!role) {
      throw new NotFoundException('Role not found in this organization');
    }

    return role;
  }

  async createRole(organizationId: string, dto: CreateRoleDto): Promise<Role> {
    if (dto.userId) {
      await this.assertMemberSlotFree(organizationId, dto.userId);
    }

    const permissions = this.validatePermissions(dto.permissions ?? []);
    const role = this.roleRepo.create({
      organizationId,
      name: dto.name,
      description: dto.description ?? null,
      userId: dto.userId ?? null,
    });

    const saved = await this.roleRepo.save(role);
    await this.replacePermissionRows(saved, permissions);

    return this.findRole(organizationId, saved.id);
  }

  async updateRole(
    organizationId: string,
    roleId: string,
    dto: UpdateRoleDto,
  ): Promise<Role> {
    const role = await this.findRole(organizationId, roleId);

    if (dto.name !== undefined) {
      role.name = dto.name;
    }
    if (dto.description !== undefined) {
      role.description = dto.description;
    }

    await this.roleRepo.save(role);
    return this.findRole(organizationId, roleId);
  }

  async replacePermissions(
    organizationId: string,
    roleId: string,
    dto: ReplacePermissionsDto,
  ): Promise<Role> {
    const role = await this.findRole(organizationId, roleId);
    const permissions = this.validatePermissions(dto.permissions);

    await this.replacePermissionRows(role, permissions);

    return this.findRole(organizationId, roleId);
  }

  async assignRole(
    organizationId: string,
    roleId: string,
    dto: AssignRoleDto,
  ): Promise<Role> {
    const role = await this.findRole(organizationId, roleId);

    if (role.userId === dto.userId) {
      return role;
    }
    if (role.userId !== null) {
      throw new ConflictException(
        'Role is already assigned to another member; unassign it first',
      );
    }

    await this.assertMemberSlotFree(organizationId, dto.userId);
    await this.assertUserExists(dto.userId);

    role.userId = dto.userId;
    await this.roleRepo.save(role);

    await this.syncUserOrganization(dto.userId, organizationId);

    return this.findRole(organizationId, roleId);
  }

  async unassignRole(organizationId: string, roleId: string): Promise<Role> {
    const role = await this.findRole(organizationId, roleId);

    if (role.userId === null) {
      return role;
    }

    role.userId = null;
    await this.roleRepo.save(role);

    return this.findRole(organizationId, roleId);
  }

  async deleteRole(organizationId: string, roleId: string): Promise<void> {
    await this.findRole(organizationId, roleId);
    await this.roleRepo.delete(roleId);
  }

  /** Grants the tenant creator full access to a freshly created organization. */
  async bootstrapOwner(organizationId: string, userId: string): Promise<Role> {
    const owner = this.findTemplate('owner');
    const existing = await this.roleRepo.findOne({
      where: { organizationId, userId },
    });

    if (existing) {
      return existing;
    }

    return this.assignNewRole(organizationId, {
      name: owner.name,
      description: owner.description,
      userId,
      permissions: owner.permissions,
    });
  }

  // --- helpers --------------------------------------------------------------

  private async assignNewRole(
    organizationId: string,
    input: {
      name: string;
      description: string;
      userId: string;
      permissions: PermissionName[];
    },
  ): Promise<Role> {
    await this.assertUserExists(input.userId);
    await this.assertMemberSlotFree(organizationId, input.userId);

    const role = await this.roleRepo.save(
      this.roleRepo.create({
        organizationId,
        name: input.name,
        description: input.description,
        userId: input.userId,
      }),
    );

    await this.replacePermissionRows(role, this.validatePermissions(input.permissions));
    await this.syncUserOrganization(input.userId, organizationId);

    return this.findRole(organizationId, role.id);
  }

  private async assertUserExists(userId: string): Promise<void> {
    const user = await this.userService.findById(userId);
    if (!user) {
      throw new NotFoundException('User not found');
    }
    if (!user.isVerified) {
      throw new BadRequestException(
        'Only users with a verified email can join an organization',
      );
    }
  }

  private async assertMemberSlotFree(
    organizationId: string,
    userId: string,
  ): Promise<void> {
    const existing = await this.roleRepo.findOne({
      where: { organizationId, userId },
    });

    if (existing) {
      throw new ConflictException(
        'Member already has a role in this organization',
      );
    }
  }

  private async syncUserOrganization(
    userId: string,
    organizationId: string,
  ): Promise<void> {
    const user = await this.userService.findById(userId);
    if (!user) {
      throw new NotFoundException('User not found');
    }
    if (user.organizationId === null) {
      await this.userService.updateProfile(userId, { organizationId });
    }
  }

  private findTemplate(key: string) {
    const template = DEFAULT_ROLE_TEMPLATES.find(
      (candidate) => candidate.key === key,
    );

    if (!template) {
      throw new BadRequestException(
        `Unknown role template "${key}". Allowed: ${DEFAULT_ROLE_TEMPLATES.map(
          (candidate) => candidate.key,
        ).join(', ')}`,
      );
    }

    return template;
  }

  private validatePermissions(names: string[]): PermissionName[] {
    const invalid = names.filter((name) => !isPermissionName(name));

    if (invalid.length) {
      throw new BadRequestException(
        `Unknown permission(s): ${invalid.join(', ')}. See GET /role-templates for the catalog.`,
      );
    }

    return [...new Set(names)] as PermissionName[];
  }

  private async replacePermissionRows(
    role: Role,
    permissions: PermissionName[],
  ): Promise<void> {
    await this.permissionRepo.delete({ roleId: role.id });

    if (!permissions.length) {
      return;
    }

    await this.permissionRepo.save(
      permissions.map((name) =>
        this.permissionRepo.create({
          roleId: role.id,
          name,
          description: this.describePermission(name),
        }),
      ),
    );
  }

  private describePermission(name: string): string {
    const resource = name.split('.')[0].replace(/_/g, ' ');
    const action = name.split('.')[1] ?? '';
    return `${action.replace(/_/g, ' ')} ${resource}`.trim();
  }

  private async loadRole(roleId: string): Promise<Role> {
    const role = await this.roleRepo.findOne({
      where: { id: roleId },
      relations: { permissions: true },
    });

    if (!role) {
      throw new NotFoundException('Role not found');
    }

    return role;
  }

  private async requireRoleInOrganization(
    organizationId: string,
    roleId: string,
  ): Promise<Role> {
    const role = await this.roleRepo.findOne({
      where: { id: roleId, organizationId },
    });

    if (!role) {
      throw new NotFoundException('Role not found in this organization');
    }

    return role;
  }
}

/** Public catalog of the default role templates and every known permission. */
export const ROLE_TEMPLATES = DEFAULT_ROLE_TEMPLATES.map((template) => ({
  key: template.key,
  name: template.name,
  description: template.description,
  permissions: template.permissions,
}));

export const PERMISSION_CATALOG: PermissionName[] = ALL_PERMISSIONS;