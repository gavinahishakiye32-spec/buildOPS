import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { EntityManager } from 'typeorm';

import { normalizeEmail } from '../common/email.js';
import type { PermissionName } from '../common/permissions.js';
import { AuthService } from '../auth/auth.service.js';
import type { IssuedSession, SessionClient } from '../auth/session.service.js';
import { SignedTokens, hashToken } from '../auth/signed-tokens.js';
import {
  dispatchEmail,
  emailLink,
  exposeEmailTokens,
  type EmailDelivery,
} from '../mail/mail-dispatch.js';
import { MailService } from '../mail/mail.service.js';
import { Organization } from '../organization/organization.entity.js';
import type { Role } from '../role/role.entity.js';
import { RoleService } from '../role/role.service.js';
import { UserService } from '../user/user.service.js';
import { OrganizationInvitation } from './invitation.entity.js';
import { recordActivity } from '../activity/record-activity.js';
import type { AcceptInvitationDto } from './dto/accept-invitation.dto.js';
import type { CreateInvitationDto } from './dto/create-invitation.dto.js';
import type {
  AcceptInvitationResponseDto,
  CreateInvitationResponseDto,
  InvitationPreviewResponseDto,
  InvitationResponseDto,
} from './dto/invitation-response.dto.js';

/** How long an invitation can sit unanswered before the link stops working. */
const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * `23505` is PostgreSQL's unique_violation, which is how a concurrent invite to
 * the same address reaches the partial unique index on `(organization_id, email)`
 * for a `pending` row.
 */
const isUniqueViolation = (error: unknown): boolean => {
  const candidate = error as { code?: string; driverError?: { code?: string } };
  return candidate?.code === '23505' || candidate?.driverError?.code === '23505';
};

/**
 * What `accept` hands back: the report the response documents, plus the
 * refresh record the controller has to turn into an httpOnly cookie. The
 * session never reaches the body -- only the access token does, exactly as
 * `POST /auth/login` answers.
 */
export type AcceptInvitationResult = AcceptInvitationResponseDto & {
  session: IssuedSession;
};

/**
 * Invitations: how somebody who is not a member yet becomes one.
 *
 * The flow exists because the two obvious shortcuts are both wrong. Adding a
 * member by user id only works for people who already have an account, which is
 * why `POST /members` could never reach a new hire (spec §4 also requires a
 * verified email, which a stranger does not have). And creating the role up
 * front would bill a plan seat to somebody who never showed up.
 *
 * So the invitation is a pending row with a hashed token in it, and the role is
 * created at acceptance -- by which point the account exists, the mailbox has
 * been proven by the token itself, and the seat check runs against a real user.
 *
 * The deactivation of a membership lives in `RoleService`, not here: this module
 * owns getting people in, that one owns whether their access is live.
 */
@Injectable()
export class InvitationService {
  constructor(
    @InjectRepository(OrganizationInvitation)
    private readonly invitationRepo: Repository<OrganizationInvitation>,
    @InjectRepository(Organization)
    private readonly organizationRepo: Repository<Organization>,
    private readonly roleService: RoleService,
    private readonly userService: UserService,
    private readonly mailService: MailService,
    private readonly authService: AuthService,
    private readonly config: ConfigService,
    private readonly signed: SignedTokens,
  ) {}

  // --- organization-scoped -------------------------------------------------

  async createInvitation(
    organizationId: string,
    actorUserId: string,
    dto: CreateInvitationDto,
  ): Promise<CreateInvitationResponseDto> {
    const email = normalizeEmail(dto.email);
    // Validated here rather than by `@IsIn`, so an unknown template answers one
    // message that lists what is allowed instead of a generic validation error.
    const template = this.roleService.templateFor(dto.templateKey ?? 'viewer');
    const organization = await this.requireOrganization(organizationId);

    /**
     * The role this invitation grants, when one was named.
     *
     * Resolved now rather than at acceptance so the inviter finds out
     * immediately that the role they picked is taken or belongs to somebody
     * else, rather than the invitee discovering it days later. The invitation
     * keeps the id either way, and acceptance falls back to the template if the
     * role is gone by then.
     */
    const role = dto.roleId
      ? await this.requireGrantableRole(organizationId, dto.roleId)
      : null;

    const invitee = await this.userService.findByEmail(email);
    if (invitee) {
      const membership = await this.roleService.findMembership(
        organizationId,
        invitee.id,
      );

      if (membership) {
        throw new ConflictException(
          membership.status === 'active'
            ? 'Member already has a role in this organization'
            : 'Member is deactivated in this organization; activate them instead of inviting them again',
        );
      }
    }

    await this.replaceLapsedPending(organizationId, email);

    const signed = this.signed.sign('invitation', {}, INVITATION_TTL_MS);
    const invitation = await this.invitationRepo.manager.transaction(
      async (manager) => {
        const saved = await this.save(
          manager.getRepository(OrganizationInvitation).create({
            organizationId,
            email,
            templateKey: template.key,
            roleName: role ? role.name : template.name,
            roleId: role ? role.id : null,
            tokenHash: signed.hash,
            status: 'pending',
            expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
            invitedBy: actorUserId,
          }),
          'An invitation for that email is already pending. Revoke it first to send a new one.',
          manager,
        );

        await recordActivity(manager, {
          organizationId,
          entityType: 'invitation',
          action: 'created',
          entityId: saved.id,
          actorId: actorUserId,
          metadata: { email: saved.email, roleName: saved.roleName },
        });

        return saved;
      },
    );

    const delivery = await dispatchEmail(this.config, () =>
      this.mailService.sendInvitationEmail(invitation.email, signed.token, {
        organizationName: organization.name,
        roleName: invitation.roleName,
      }),
    );

    return {
      ...invitation.toResponse(),
      ...this.invitationExtras(signed.token, delivery),
    };
  }

  async listInvitations(
    organizationId: string,
  ): Promise<InvitationResponseDto[]> {
    const invitations = await this.invitationRepo.find({
      where: { organizationId },
      order: { createdAt: 'ASC' },
    });

    return invitations.map((invitation) => invitation.toResponse());
  }

  /**
   * Withdraws an invitation so its address can be invited again.
   *
   * Already-revoked answers 200 rather than a conflict: two administrators
   * clicking the same button is a race, not an error. An accepted invitation is
   * the one real conflict -- the membership it created is no longer this row's
   * to undo, which is what `DELETE /members/:userId` is for.
   */
  async revokeInvitation(
    organizationId: string,
    invitationId: string,
  ): Promise<InvitationResponseDto> {
    const invitation = await this.invitationRepo.findOne({
      where: { id: invitationId, organizationId },
    });

    if (!invitation) {
      throw new NotFoundException('Invitation not found in this organization');
    }

    if (invitation.status === 'accepted') {
      throw new ConflictException(
        'Invitation already accepted; remove the member instead',
      );
    }

    if (invitation.status !== 'revoked') {
      invitation.status = 'revoked';
      await this.invitationRepo.manager.transaction(async (manager) => {
        await manager.getRepository(OrganizationInvitation).save(invitation);

        await recordActivity(manager, {
          organizationId,
          entityType: 'invitation',
          action: 'deleted',
          entityId: invitation.id,
          metadata: { email: invitation.email },
        });
      });
    }

    return invitation.toResponse();
  }

  // --- acceptance (public) -------------------------------------------------

  /**
   * What the emailed link shows before anything changes, so a browser opening
   * `?token=` can say who invited whom and under which role instead of landing
   * on a bare form. Nothing is consumed: following the link twice is fine.
   */
  async preview(token: string): Promise<InvitationPreviewResponseDto> {
    const invitation = await this.requirePending(token);
    const organization = await this.requireOrganization(
      invitation.organizationId,
    );
    const invitee = await this.userService.findByEmail(invitation.email);

    // What the invitee will actually be granted, not what the fallback template
    // would grant. These differ whenever the inviter named a role, and a preview
    // that promises the wrong permissions is worse than no preview.
    const permissions = await this.grantedPermissions(invitation);

    return {
      email: invitation.email,
      organizationId: invitation.organizationId,
      organizationName: organization.name,
      roleName: invitation.roleName,
      permissions,
      status: invitation.reportedStatus(),
      expiresAt: invitation.expiresAt,
      accountExists: invitee !== null,
    };
  }

  /**
   * Turns the invitation into a membership.
   *
   * The token is what proves the caller controls the mailbox the invitation was
   * sent to, so an invitee who had no account gets one here and it is created
   * already verified -- no second email, no login refused for being unverified.
   * An existing unverified account is verified for the same reason. The only
   * field that account has to supply is the password: the address is already
   * known to the invitation, and the name is optional.
   *
   * The role is assigned through `RoleService`, which means the plan seat check,
   * the "already a member" refusal and the tenant lock all run here exactly as
   * they do for `POST /members`.
   *
   * **When the invitation names a role, that role is handed over** rather than
   * rebuilt. It used to be rebuilt: acceptance called `addMember`, which creates
   * a new `roles` row from `template_key`, so an administrator's own role could
   * not travel with the email — the invitee got the built-in template instead,
   * and the organization ended up with two roles of the same name. `roleId` is
   * the row itself, and a `roles` row with no `user_id` is this product's own
   * definition of a role waiting to be handed out.
   *
   * The invitation is marked accepted only after that succeeds, so a refused
   * acceptance leaves it pending and retryable.
   *
   * Accepting also signs the invitee in. The click has just proven control of
   * the mailbox, which is the same thing the password would have proven, so
   * making them retype it on the next screen would only add a step between the
   * email and the workspace they were invited into. They keep the account, and
   * from then on they sign in with the address and the password they set here.
   */
  async accept(
    token: string,
    dto: AcceptInvitationDto,
    client: SessionClient,
  ): Promise<AcceptInvitationResult> {
    const invitation = await this.requirePending(token);
    const organization = await this.requireOrganization(
      invitation.organizationId,
    );

    const invitee = await this.userService.findByEmail(invitation.email);
    const user = await this.ensureAccount(invitation, dto, invitee);

    const role = await this.grantInvitationRole(invitation, user.id);

    invitation.status = 'accepted';
    invitation.acceptedAt = new Date();
    await this.invitationRepo.manager.transaction(async (manager) => {
      await manager.getRepository(OrganizationInvitation).save(invitation);

      await recordActivity(manager, {
        organizationId: invitation.organizationId,
        entityType: 'invitation',
        action: 'accepted',
        entityId: invitation.id,
        actorId: user.id,
        metadata: { email: invitation.email, roleName: invitation.roleName },
      });
    });

    const issued = await this.authService.establishSession(user, client);

    return {
      message: 'Invitation accepted',
      access_token: issued.access_token,
      organizationId: invitation.organizationId,
      organizationName: organization.name,
      roleId: role.id,
      roleName: role.name,
      permissions: (role.permissions ?? []).map(
        (permission) => permission.name as PermissionName,
      ),
      session: issued.session,
    };
  }

  // --- helpers -------------------------------------------------------------

  /**
   * The role named by an invitation, if it can still be granted.
   *
   * Returns `null` rather than throwing when the role has gone, because by the
   * time an invitation is accepted it may be days old and the organization may
   * have moved on. A deleted role nulls the column (the FK is `SET NULL`), and
   * a role given to somebody else in the meantime is no longer a definition
   * waiting to be handed out. Both fall back to the template, which is exactly
   * what every invitation did before `role_id` existed — never a failure to
   * accept, and never a silent grant of something nobody chose.
   */
  private async grantableRoleOf(
    invitation: OrganizationInvitation,
  ): Promise<Role | null> {
    if (!invitation.roleId) {
      return null;
    }

    const role = await this.roleService.findRoleOrNull(
      invitation.organizationId,
      invitation.roleId,
    );

    return role && role.userId === null ? role : null;
  }

  /** What accepting this invitation would grant, today. */
  private async grantedPermissions(
    invitation: OrganizationInvitation,
  ): Promise<PermissionName[]> {
    const role = await this.grantableRoleOf(invitation);

    if (role) {
      return (role.permissions ?? []).map(
        (permission) => permission.name as PermissionName,
      );
    }

    return this.roleService.templateFor(invitation.templateKey).permissions;
  }

  /**
   * Turn the invitation into a membership.
   *
   * The named role is handed over when there is one; otherwise the role is
   * built from the template, which is what every invitation did before
   * `role_id` and is still the fallback for an old row or a deleted role.
   */
  private async grantInvitationRole(
    invitation: OrganizationInvitation,
    userId: string,
  ): Promise<Role> {
    const role = await this.grantableRoleOf(invitation);

    if (role) {
      return this.roleService.assignRole(invitation.organizationId, role.id, {
        userId,
      });
    }

    return this.roleService.addMember(invitation.organizationId, {
      userId,
      templateKey: invitation.templateKey,
    });
  }

  /**
   * Resolve the role an inviter named, refusing the two ways it can be wrong.
   *
   * Checked at invitation time so the inviter finds out now rather than the
   * invitee finding out on acceptance: the role has to belong to *this*
   * organization (an id from another tenant is not a role this invitation can
   * grant), and it has to be unassigned (a role row *is* somebody's access, so
   * promising one that is already held would silently take it away from them).
   */
  private async requireGrantableRole(
    organizationId: string,
    roleId: string,
  ): Promise<Role> {
    const role = await this.roleService.findRoleOrNull(organizationId, roleId);

    if (!role) {
      throw new NotFoundException(
        'Role not found in this organization. Create the role here before inviting somebody into it.',
      );
    }

    if (role.userId !== null) {
      throw new ConflictException(
        `"${role.name}" is already held by a member. Unassign it first, or create another role with the same permissions.`,
      );
    }

    return role;
  }

  private async ensureAccount(
    invitation: OrganizationInvitation,
    dto: AcceptInvitationDto,
    invitee: Awaited<ReturnType<UserService['findByEmail']>>,
  ) {
    if (invitee) {
      if (!invitee.isVerified) {
        await this.userService.markVerified(invitee.id);
      }

      return invitee;
    }

    if (!dto.password) {
      throw new BadRequestException(
        'Choose a password to create your account: this invitation has no account behind it yet',
      );
    }

    try {
      const created = await this.userService.create(
        invitation.email,
        dto.password,
        dto.name,
      );
      await this.userService.markVerified(created.id);
      return created;
    } catch (error) {
      // `UQ_users_email` still holds rows that were soft-deleted, so a re-invite
      // to a deleted address reaches the constraint rather than the lookup. The
      // answer the caller can act on is the one registration gives.
      if (isUniqueViolation(error)) {
        throw new ConflictException('Email already registered');
      }

      throw error;
    }
  }

  /**
   * The invitation behind a token, still able to be accepted.
   *
   * The token has to be one this server signed as an invitation first, then
   * match a row: a signature alone proves nothing about whether the invitation
   * is still pending. Three refusals after that, in the order a caller meets
   * them: no row behind the token is a 400 because the token itself is
   * worthless, a row that has already been used or withdrawn is a 409 because
   * the invitation is real but finished, and a pending row past `expires_at` is
   * a 400 that says so plainly -- the one answer that tells the recipient to ask
   * for a new link instead of retrying.
   */
  private async requirePending(token: string): Promise<OrganizationInvitation> {
    if (!token) {
      throw new BadRequestException(
        'Invitation token is required. Read it from the ?token= link sent by email.',
      );
    }

    if (!this.signed.verify('invitation', token)) {
      throw new BadRequestException('Invalid or expired invitation token');
    }

    const invitation = await this.invitationRepo.findOne({
      where: { tokenHash: hashToken(token) },
    });

    if (!invitation) {
      throw new BadRequestException('Invalid or expired invitation token');
    }

    if (invitation.status === 'accepted') {
      throw new ConflictException('This invitation has already been accepted');
    }

    if (invitation.status === 'revoked') {
      throw new ConflictException('This invitation was revoked');
    }

    if (!invitation.isLive()) {
      throw new BadRequestException(
        'This invitation has expired. Ask an administrator to send a new one.',
      );
    }

    return invitation;
  }

  private async requireOrganization(
    organizationId: string,
  ): Promise<Organization> {
    const organization = await this.organizationRepo.findOne({
      where: { id: organizationId },
    });

    if (!organization) {
      throw new NotFoundException('Organization not found');
    }

    return organization;
  }

  /**
   * Drops a pending row whose window has closed, so its address can be invited
   * again instead of being held by an invitation nobody can accept. The partial
   * unique index covers `status = 'pending'` regardless of expiry, which is what
   * makes this necessary rather than merely tidy.
   */
  private async replaceLapsedPending(
    organizationId: string,
    email: string,
  ): Promise<void> {
    const pending = await this.invitationRepo.findOne({
      where: { organizationId, email, status: 'pending' },
    });

    if (pending && !pending.isLive()) {
      await this.invitationRepo.delete(pending.id);
    }
  }

  private async save(
    invitation: OrganizationInvitation,
    conflictMessage: string,
    manager?: EntityManager,
  ): Promise<OrganizationInvitation> {
    const repo = manager
      ? manager.getRepository(OrganizationInvitation)
      : this.invitationRepo;

    try {
      return await repo.save(invitation);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(conflictMessage);
      }

      throw error;
    }
  }

  /**
   * The token, the link and the delivery report, as they belong in a JSON
   * response. An empty object in production, which is what keeps the token out
   * of production bodies.
   */
  private invitationExtras(
    token: string,
    delivery: EmailDelivery,
  ): Partial<{
    invitationToken: string;
    invitationLink: string;
    emailSent: boolean;
    emailError: string;
  }> {
    if (!exposeEmailTokens(this.config)) {
      return {};
    }

    return {
      invitationToken: token,
      invitationLink: emailLink(this.config, 'accept-invitation', token),
      ...delivery,
    };
  }
}
