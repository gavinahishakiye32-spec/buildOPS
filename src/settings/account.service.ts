import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { compare, hash } from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { AuthService } from '../auth/auth.service.js';
import { SessionService } from '../auth/session.service.js';
import { User } from '../user/user.entity.js';
import { Role } from '../role/role.entity.js';
import { TeamMember } from '../team/team-member.entity.js';
import { UserSettings } from './user-settings.entity.js';
import type { SessionResponseDto } from '../auth/dto/response.dto.js';
import type {
  ChangeEmailDto,
  ChangePasswordDto,
  DeleteAccountDto,
} from './dto/account.dto.js';

/** What the account surface exposes about the identity, plus its session count. */
export interface AccountOverview {
  id: string;
  email: string;
  name: string | null;
  status: string | null;
  isVerified: boolean;
  createdAt: Date;
  updatedAt: Date;
  activeSessions: number;
}

interface AccountIdentity {
  id: string;
  email: string;
  name: string | null;
  status: string | null;
  isVerified: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Self-service account management: the identity behind the token, its
 * credentials, its sessions, and deleting it.
 *
 * Nothing here is permission-gated, because none of it is an organization's
 * business. A person's own password, address and devices belong to that person,
 * and gating them on a role would mean a member who lost their role suddenly
 * cannot change a password they may need to change precisely because of it. The
 * routes use `BearerProfile()` for the same reason `/settings/me` and
 * `/auth/profile` do.
 *
 * The credential rules are not restated here. `changePassword` and `changeEmail`
 * delegate to `AuthService.updateProfile`, which is already the single place that
 * knows a password change has to re-check the current password and end every
 * session, and that an address change has to reset verification and send a fresh
 * link. Two implementations of those rules would be two places to get the
 * session revocation wrong.
 */
@Injectable()
export class AccountService {
  private readonly logger = new Logger(AccountService.name);

  constructor(
    private readonly authService: AuthService,
    private readonly sessionService: SessionService,
    @InjectRepository(User) private readonly userRepo: Repository<User>,
  ) {}

  /** The account, its verification state and how many devices are signed in. */
  async overview(userId: string): Promise<AccountOverview> {
    const user = await this.requireUser(userId);
    return this.present(user, userId);
  }

  /**
   * Replaces the password, and ends every session including this one.
   *
   * The response is therefore already the truth about the sessions: the caller's
   * access token is refused from the next request onwards, because the family
   * behind it is gone. A client that wants to stay signed in has to log in again
   * with the new password.
   */
  async changePassword(
    userId: string,
    dto: ChangePasswordDto,
  ): Promise<AccountOverview> {
    const updated = await this.authService.updateProfile(userId, {
      password: dto.newPassword,
      currentPassword: dto.currentPassword,
    });

    // `present` rather than a spread: `updateProfile` answers with the whole
    // profile, and this response is documented as the account shape, so the two
    // are shaped in one place instead of drifting into each other's fields.
    return this.present(updated, userId);
  }

  /**
   * Moves the account to another address.
   *
   * Verification is reset by `updateProfile`, so the response reports
   * `isVerified: false` and the new address has to be confirmed before the
   * account can mint tokens again.
   */
  async changeEmail(
    userId: string,
    dto: ChangeEmailDto,
  ): Promise<AccountOverview> {
    const updated = await this.authService.updateProfile(userId, {
      email: dto.email,
    });

    return this.present(updated, userId);
  }

  /** Live sessions, one row per device, the current one flagged. */
  async sessions(
    userId: string,
    familyId: string,
  ): Promise<SessionResponseDto[]> {
    return this.authService.sessions(userId, familyId);
  }

  /**
   * Ends one session by its id, which is the `sid` claim of its access token.
   *
   * A `false` from the session service means either "no such session" or "not
   * yours", and both are answered with the same 404: a caller enumerating session
   * ids learns nothing about which ids belong to somebody else.
   */
  async revokeSession(
    userId: string,
    sessionId: string,
  ): Promise<{ message: string }> {
    const revoked = await this.sessionService.revokeFamilyForUser(
      sessionId,
      userId,
      'session_revoked',
    );

    if (!revoked) {
      throw new NotFoundException('Session not found');
    }

    return { message: 'Session revoked' };
  }

  /**
   * Closes the account: no more sessions, no more seat, no more identity.
   *
   * Three things have to be asked for, and the order matters. `?confirm=` names
   * the account, which proves nobody deleted it by accident and gives the 409
   * something to repeat back; the password proves the caller owns it, which a
   * leaked access token does not. Both are checked before anything is written.
   *
   * The writes that follow are one transaction because they are one intent: a
   * release that half-happened would leave either a seat occupied by an account
   * nobody can reach, or a membership pointing at a tombstone.
   *
   * What it deliberately does *not* do is remove the row. `tenants.user_id` and
   * `organizations.tenant_id` cascade, so deleting a user who holds a
   * subscription would take every organization, project and logged hour with it
   * -- see `AccountDeletion1700000000005`. Instead the account is anonymised and
   * flagged:
   *
   *  - the role assignments are detached rather than deleted, so the roles
   *    themselves survive and stop counting against `max_users`, which is what
   *    frees the seat for whoever is added next;
   *  - team memberships are removed, because `uq_team_members_team_user` would
   *    otherwise reserve the (team, user) pair for an account that can never be
   *    added again;
   *  - the preferences row goes with it, since it only ever meant something to
   *    somebody who exists;
   *  - the address is rewritten to a per-row tombstone, which releases it for a
   *    new registration without turning the global unique constraint into a
   *    partial index, and `name`, the tokens and the password hash are
   *    overwritten so nothing identifying is left to read.
   *
   * Time entries keep their `user_id`. The hours are a business record and the
   * user is not part of them; the row still resolves, it just no longer names
   * anybody, which is what was asked for.
   */
  async deleteAccount(
    userId: string,
    confirmation: string | undefined,
    dto: DeleteAccountDto,
  ): Promise<{ message: string }> {
    const user = await this.requireUser(userId);

    if (!confirmation || confirmation.trim() !== user.email) {
      throw new ConflictException(
        'Deleting an account is permanent and cannot be undone. Repeat the ' +
          'request with ?confirm=' +
          user.email +
          ' to confirm.',
      );
    }

    if (!(await compare(dto.password, user.passwordHash))) {
      throw new BadRequestException('Incorrect password');
    }

    // Before the writes, not after: the tokens this account holds stop being
    // accepted at the earliest moment that does not depend on the transaction
    // committing. A failure below costs the customer a login, not a session that
    // outlived the account it belonged to.
    const revoked = await this.sessionService.revokeAllForUser(
      userId,
      'account_deleted',
    );
    await this.sessionService.deleteForUsers([userId]);

    // Nothing that hashes a usable password is left behind. A random string
    // hashed here means `compare` can never succeed against it, whatever a later
    // code path forgets to check the `deleted_at` flag for.
    const unusablePasswordHash = await hash(
      randomBytes(32).toString('hex'),
      10,
    );

    await this.userRepo.manager.transaction(async (manager) => {
      await manager.getRepository(Role).update({ userId }, { userId: null });
      await manager.getRepository(TeamMember).delete({ userId });
      await manager.getRepository(UserSettings).delete({ userId });

      const users = manager.getRepository(User);

      await users.update(userId, {
        email: `deleted+${userId}@deleted.invalid`,
        name: null,
        passwordHash: unusablePasswordHash,
        organizationId: null,
        verificationToken: null,
        verificationTokenExpires: null,
        resetToken: null,
        resetTokenExpires: null,
        isVerified: false,
      });

      await users.softDelete(userId);
    });

    this.logger.log(
      `Deleted account ${userId}, ended ${revoked} session(s) and released its seats`,
    );

    return { message: 'Account deleted' };
  }

  /**
   * Loads the account behind a valid token.
   *
   * `JwtStrategy` has already resolved it on this request, so the `null` branch is
   * only reachable by a non-HTTP caller. It is answered the way `AuthService`
   * answers it rather than as a 404, so nothing here can turn a stale token into
   * a different status than every other authenticated route.
   */
  private async requireUser(userId: string): Promise<User> {
    const user = await this.userRepo.findOne({ where: { id: userId } });

    if (!user) {
      throw new UnauthorizedException();
    }

    return user;
  }

  private async present(
    user: AccountIdentity,
    userId: string,
  ): Promise<AccountOverview> {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      status: user.status,
      isVerified: user.isVerified,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      activeSessions: await this.countSessions(userId),
    };
  }

  /**
   * Live sessions as a number.
   *
   * `listForUser` collapses a rotation family into one row, so this counts
   * devices rather than tokens: refreshing a hundred times is still one signed-in
   * device, and counting the tokens would report a growing number of sessions
   * every time the client did the right thing.
   */
  private async countSessions(userId: string): Promise<number> {
    return (await this.sessionService.listForUser(userId, null)).length;
  }
}
