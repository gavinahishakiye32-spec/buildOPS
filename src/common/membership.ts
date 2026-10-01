import type { PermissionName } from './permissions.js';

export interface Membership {
  roleId: string;
  roleName: string;
  permissions: PermissionName[];
}

/**
 * Abstraction over "does this user belong to this organization, and with what
 * permissions". Implemented by the role module so `PermissionsGuard` does not
 * depend on it directly (avoids a circular module dependency).
 */
export abstract class MembershipResolver {
  abstract resolve(
    organizationId: string,
    userId: string,
  ): Promise<Membership | null>;
}
