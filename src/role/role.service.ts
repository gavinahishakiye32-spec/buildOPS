import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { Membership, MembershipResolver } from '../common/membership.js';
import {
  DEFAULT_ROLE_TEMPLATES,
  isPermissionName,
  ROLE_TEMPLATE_KEYS,
  type PermissionName,
  type RoleTemplate,
} from '../common/permissions.js';
import {
  PlanLimitService,
  type PlanLimits,
} from '../plan-limit/plan-limit.service.js';
import { Subscription } from '../subscription/subscription.entity.js';
import { User } from '../user/user.entity.js';
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

/** One organization member as the member endpoints report them. */
export interface MemberSummary {
  userId: string;
  email: string;
  name: string | null;
  roleId: string;
  roleName: string;
  permissions: PermissionName[];
  status: string;
}

/** A role row that is assigned to somebody, with that somebody loaded. */
const hasMember = (role: Role): boolean =>
  role.userId !== null && role.user !== null;

/**
 * The member view of a role row. Callers pass an assigned row; `userId` is
 * cast rather than re-checked because every caller has already established it
 * (`hasMember`, or a `null` guard that throws).
 */
const describeMember = (role: Role): MemberSummary => ({
  userId: role.userId as string,
  email: role.user?.email ?? '',
  name: role.user?.name ?? null,
  roleId: role.id,
  roleName: role.name,
  permissions: (role.permissions ?? []).map(
    (permission) => permission.name as PermissionName,
  ),
  status: role.status,
});

@Injectable()
export class RoleService extends MembershipResolver {
  constructor(
    @InjectRepository(Role)
    private readonly roleRepo: Repository<Role>,
    @InjectRepository(Permission)
    private readonly permissionRepo: Repository<Permission>,
    private readonly userService: UserService,
    private readonly planLimits: PlanLimitService,
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
      where: { organizationId, userId, status: 'active' },
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

  /**
   * One member of the organization, with the status of their membership.
   *
   * Reads by `userId` rather than by role id because that is how the member
   * endpoints address people, and it deliberately includes a deactivated
   * membership: the admin reaching for `activate` has to be able to find the
   * row they are reactivating.
   */
  async member(organizationId: string, userId: string): Promise<MemberSummary> {
    const role = await this.roleRepo.findOne({
      where: { organizationId, userId },
      relations: { permissions: true, user: true },
    });

    if (!role || role.userId === null || role.user === null) {
      throw new NotFoundException('Member not found in this organization');
    }

    return describeMember(role);
  }

  async listMembers(organizationId: string): Promise<MemberSummary[]> {
    const roles = await this.roleRepo.find({
      where: { organizationId },
      relations: { permissions: true, user: true },
      order: { createdAt: 'ASC' },
    });

    return roles.filter(hasMember).map(describeMember);
  }

  /**
   * Suspends or restores a member's access to this organization.
   *
   * Idempotent on purpose: a member list with two admins on it will have both
   * of them firing the same action, and answering the second one a 400 would
   * turn a race into an error the caller cannot do anything about.
   *
   * The one refusal is self-deactivation. It is a footgun rather than a
   * feature -- the member locks themselves out of the organization and needs
   * another admin to notice -- so it is refused while the actor still has the
   * `member.remove` permission to be refused on.
   */
  async setMemberStatus(
    organizationId: string,
    userId: string,
    status: string,
    actorUserId: string,
  ): Promise<MemberSummary> {
    const role = await this.roleRepo.findOne({
      where: { organizationId, userId },
      relations: { permissions: true, user: true },
    });

    if (!role || role.userId === null || role.user === null) {
      throw new NotFoundException('Member not found in this organization');
    }

    if (status === 'deactivated' && userId === actorUserId) {
      throw new BadRequestException(
        'You cannot deactivate your own membership. Ask another administrator to do it.',
      );
    }

    if (role.status !== status) {
      role.status = status;
      await this.roleRepo.save(role);
    }

    return describeMember(role);
  }

  async addMember(organizationId: string, dto: AddMemberDto): Promise<Role> {
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
    const subscription =
      await this.planLimits.requireByOrganizationId(organizationId);

    return this.planLimits.locked(subscription.id, (limits, current) =>
      this.assignNewRole(
        organizationId,
        {
          name: template.name,
          description: template.description,
          userId: user.id,
          permissions: template.permissions,
        },
        limits,
        current,
      ),
    );
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

  /**
   * The membership row for this member, deactivated or not, or `null` when they
   * are not in this organization.
   *
   * Deliberately does not throw and does not load the user: the caller -- the
   * invitation flow, before it emails anybody -- already knows the address it is
   * asking about and only needs to know whether a seat is already held.
   */
  async findMembership(
    organizationId: string,
    userId: string,
  ): Promise<Role | null> {
    return this.roleRepo.findOne({ where: { organizationId, userId } });
  }

  // --- roles ----------------------------------------------------------------

  async listRoles(organizationId: string): Promise<Role[]> {
    return this.roleRepo.find({
      where: { organizationId },
      relations: { permissions: true, user: true },
      order: { createdAt: 'ASC' },
    });
  }

  async findRole(
    organizationId: string,
    roleId: string,
    manager?: EntityManager,
  ): Promise<Role> {
    const role = await this.repos(manager).roles.findOne({
      where: { id: roleId, organizationId },
      relations: { permissions: true, user: true },
    });

    if (!role) {
      throw new NotFoundException('Role not found in this organization');
    }

    return role;
  }

  async createRole(organizationId: string, dto: CreateRoleDto): Promise<Role> {
    const subscription =
      await this.planLimits.requireByOrganizationId(organizationId);

    return this.planLimits.locked(subscription.id, (limits, current) =>
      this.createRoleRow(organizationId, dto, limits, current),
    );
  }

  private async createRoleRow(
    organizationId: string,
    dto: CreateRoleDto,
    limits: PlanLimits,
    subscription: Subscription,
  ): Promise<Role> {
    const roles = limits.manager.getRepository(Role);

    if (dto.userId) {
      // The user has to exist and be verified before the seat is counted:
      // assigning to an unknown id would otherwise reach the foreign key and
      // surface as a 500 rather than the 404 the caller can act on.
      await this.assertUserExists(dto.userId);
      await this.assertMemberSlotFree(
        organizationId,
        dto.userId,
        limits.manager,
      );
      await limits.assertUserSeat(subscription, dto.userId);
    }

    const permissions = this.validatePermissions(dto.permissions ?? []);
    const saved = await roles.save(
      roles.create({
        organizationId,
        name: dto.name,
        description: dto.description ?? null,
        userId: dto.userId ?? null,
      }),
    );

    await this.replacePermissionRows(saved, permissions, limits.manager);

    return this.findRole(organizationId, saved.id, limits.manager);
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

    const subscription =
      await this.planLimits.requireByOrganizationId(organizationId);

    return this.planLimits.locked(subscription.id, async (limits, current) => {
      await this.assertMemberSlotFree(
        organizationId,
        dto.userId,
        limits.manager,
      );
      await this.assertUserExists(dto.userId);
      await limits.assertUserSeat(current, dto.userId);

      role.userId = dto.userId;
      await limits.manager.getRepository(Role).save(role);
      await this.syncUserOrganization(
        dto.userId,
        organizationId,
        limits.manager,
      );

      return this.findRole(organizationId, roleId, limits.manager);
    });
  }

  async unassignRole(organizationId: string, roleId: string): Promise<Role> {
    const role = await this.findRole(organizationId, roleId);

    if (role.userId === null) {
      return role;
    }

    role.userId = null;
    // `findRole` loads the `user` relation, and TypeORM writes the foreign key
    // back from that relation on save: clearing only `userId` left the holder
    // in place and answered the unassign with the member it was meant to drop.
    role.user = null;
    await this.roleRepo.save(role);

    return this.findRole(organizationId, roleId);
  }

  async deleteRole(organizationId: string, roleId: string): Promise<void> {
    await this.findRole(organizationId, roleId);
    await this.roleRepo.delete(roleId);
  }

  /**
   * Grants the subscription creator full access to a freshly created
   * organization. Runs inside the caller's tenant lock so the creator's member
   * seat is checked and claimed atomically with the organization insert.
   */
  async bootstrapOwner(
    organizationId: string,
    userId: string,
    limits: PlanLimits,
    subscription: Subscription,
  ): Promise<Role> {
    const owner = this.findTemplate('owner');
    const existing = await limits.manager.getRepository(Role).findOne({
      where: { organizationId, userId },
    });

    if (existing) {
      return existing;
    }

    return this.assignNewRole(
      organizationId,
      {
        name: owner.name,
        description: owner.description,
        userId,
        permissions: owner.permissions,
      },
      limits,
      subscription,
    );
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
    limits: PlanLimits,
    subscription: Subscription,
  ): Promise<Role> {
    await this.assertUserExists(input.userId);
    await this.assertMemberSlotFree(
      organizationId,
      input.userId,
      limits.manager,
    );
    await limits.assertUserSeat(subscription, input.userId);

    const roles = limits.manager.getRepository(Role);
    const role = await roles.save(
      roles.create({
        organizationId,
        name: input.name,
        description: input.description,
        userId: input.userId,
      }),
    );

    await this.replacePermissionRows(
      role,
      this.validatePermissions(input.permissions),
      limits.manager,
    );
    await this.syncUserOrganization(
      input.userId,
      organizationId,
      limits.manager,
    );

    return this.findRole(organizationId, role.id, limits.manager);
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

  /**
   * Repositories bound to the transaction manager when one is supplied, so a
   * capacity check and the member write run on the same locked snapshot.
   */
  private repos(manager?: EntityManager) {
    return {
      roles: manager ? manager.getRepository(Role) : this.roleRepo,
      permissions: manager
        ? manager.getRepository(Permission)
        : this.permissionRepo,
    };
  }

  private async assertMemberSlotFree(
    organizationId: string,
    userId: string,
    manager?: EntityManager,
  ): Promise<void> {
    const existing = await this.repos(manager).roles.findOne({
      where: { organizationId, userId },
    });

    if (!existing) {
      return;
    }

    // A deactivated member already holds the row this would create, so the
    // honest answer names the action that actually works instead of a generic
    // conflict that sends the caller round the loop to try `activate` anyway.
    if (existing.status !== 'active') {
      throw new ConflictException(
        'Member is deactivated in this organization; activate them instead of adding them again',
      );
    }

    throw new ConflictException(
      'Member already has a role in this organization',
    );
  }

  private async syncUserOrganization(
    userId: string,
    organizationId: string,
    manager: EntityManager,
  ): Promise<void> {
    const users = manager.getRepository(User);
    const user = await users.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    if (user.organizationId === null) {
      await users.update(userId, { organizationId });
    }
  }

  /**
   * The default role template `templateKey` names, or a 400 listing the keys
   * that do exist.
   *
   * Public because two callers outside this service resolve a template before
   * they can write anything: `addMember`, and the invitation flow, which needs
   * the template's display name and permissions while the invitation is still
   * only an email that has not been sent yet.
   */
  templateFor(templateKey: string): RoleTemplate {
    return this.findTemplate(templateKey);
  }

  private findTemplate(key: string) {
    const template = DEFAULT_ROLE_TEMPLATES.find(
      (candidate) => candidate.key === key,
    );

    if (!template) {
      throw new BadRequestException(
        `Unknown role template "${key}". Allowed: ${ROLE_TEMPLATE_KEYS.join(', ')}`,
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
    manager?: EntityManager,
  ): Promise<void> {
    const repo = this.repos(manager).permissions;
    await repo.delete({ roleId: role.id });

    if (!permissions.length) {
      return;
    }

    await repo.save(
      permissions.map((name) =>
        repo.create({
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

  private async loadRole(
    roleId: string,
    manager?: EntityManager,
  ): Promise<Role> {
    const role = await this.repos(manager).roles.findOne({
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
    manager?: EntityManager,
  ): Promise<Role> {
    const role = await this.repos(manager).roles.findOne({
      where: { id: roleId, organizationId },
    });

    if (!role) {
      throw new NotFoundException('Role not found in this organization');
    }

    return role;
  }
}

/** The default templates as served by `GET /role-templates`. */
export const ROLE_TEMPLATES: RoleTemplate[] = DEFAULT_ROLE_TEMPLATES;
