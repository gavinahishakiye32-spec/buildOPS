import { Module } from '@nestjs/common';
import { PermissionsGuard } from '../common/guards/permissions.guard.js';
import { MembershipResolver } from '../common/membership.js';
import { RoleModule } from '../role/role.module.js';
import { RoleService } from '../role/role.service.js';
import { AuthModule } from './auth.module.js';

/**
 * Wires the permission half of the authorization pipeline (spec §5). Feature
 * modules import `AuthModule` (for `JwtAuthGuard`) and `AuthorizationModule`
 * (for `PermissionsGuard` and the membership resolver) used by `@Protected()`.
 *
 * `MembershipResolver` is re-bound here instead of re-exported from RoleModule
 * so the guard always resolves it from its own module context.
 */
@Module({
  imports: [AuthModule, RoleModule],
  providers: [
    PermissionsGuard,
    { provide: MembershipResolver, useExisting: RoleService },
  ],
  exports: [PermissionsGuard, MembershipResolver],
})
export class AuthorizationModule {}