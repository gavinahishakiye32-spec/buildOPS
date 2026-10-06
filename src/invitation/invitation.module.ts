import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module.js';
import { MailModule } from '../mail/mail.module.js';
import { Organization } from '../organization/organization.entity.js';
import { RoleModule } from '../role/role.module.js';
import { UserModule } from '../user/user.module.js';
import { InvitationAcceptController } from './invitation-accept.controller.js';
import { InvitationController } from './invitation.controller.js';
import { OrganizationInvitation } from './invitation.entity.js';
import { InvitationService } from './invitation.service.js';

/**
 * Invitations: the pending row, the emailed token, and the acceptance that
 * finally calls `RoleService.addMember`.
 *
 * The module boundary is deliberate. Everything that decides *whether* somebody
 * may enter -- the plan seat, the role template, the membership row -- stays in
 * `RoleModule` and is reached through `RoleService`, so the invitation flow
 * cannot grant anything `POST /members` could not. This module owns only the
 * state machine around the email: issue, preview, revoke, accept.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([OrganizationInvitation, Organization]),
    // `@Protected()` on the organization-scoped controller resolves through
    // `JwtAuthGuard`, which is provided by `AuthModule` the same way
    // `RoleModule` needs it. `RoleModule` supplies the `MembershipResolver`
    // that `PermissionsGuard` enforces with.
    AuthModule,
    RoleModule,
    UserModule,
    MailModule,
  ],
  controllers: [InvitationController, InvitationAcceptController],
  providers: [InvitationService],
})
export class InvitationModule {}
