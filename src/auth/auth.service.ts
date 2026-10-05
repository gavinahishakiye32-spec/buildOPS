import {
  Injectable,
  ConflictException,
  BadRequestException,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { compare, hash } from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';
import { UserService } from '../user/user.service.js';
import { MailService } from '../mail/mail.service.js';
import { User } from '../user/user.entity.js';
import { RegisterDto } from './dto/register.dto.js';
import { LoginDto } from './dto/login.dto.js';
import { ForgotPasswordDto } from './dto/forgot-password.dto.js';
import { ResetPasswordDto } from './dto/reset-password.dto.js';
import { UpdateProfileDto } from './dto/update-profile.dto.js';
import {
  SELF_EDITABLE_USER_STATUSES,
  isSelfEditableStatus,
} from '../common/enums.js';
import { SessionService } from './session.service.js';
import type { SessionClient } from './session.service.js';

const VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

@Injectable()
export class AuthService {
  constructor(
    private readonly userService: UserService,
    private readonly jwtService: JwtService,
    private readonly mailService: MailService,
    private readonly sessionService: SessionService,
  ) {}

  async register(dto: RegisterDto) {
    const existing = await this.userService.findByEmail(dto.email);
    if (existing) {
      throw new ConflictException('Email already registered');
    }

    const user = await this.userService.create(
      dto.email,
      dto.password,
      dto.name,
    );
    await this.issueVerificationToken(user);

    return {
      message:
        'Registration successful. Please verify your email before logging in.',
      user: user.toResponse(),
    };
  }

  async login(dto: LoginDto, client: SessionClient) {
    const user = await this.userService.findByEmail(dto.email);
    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const passwordValid = await compare(dto.password, user.passwordHash);
    if (!passwordValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (!user.isVerified) {
      await this.issueVerificationToken(user);
      throw new ForbiddenException(
        'Email not verified. Check your inbox for a verification link before logging in.',
      );
    }

    const session = await this.sessionService.issue(user.id, client);
    const token = this.signToken(user.id, user.email, session.familyId);

    return { access_token: token, session };
  }

  /**
   * Exchanges a refresh token for a new access token and a new refresh token.
   *
   * Every failure here is the same 401 with the same message, including reuse
   * detection, because the caller is an opaque cookie to us: the reason a token
   * died is not something an attacker probing the endpoint should be able to
   * read off the response.
   */
  async refresh(token: string, client: SessionClient) {
    const result = await this.sessionService.rotate(token, client);

    if (!result.ok) {
      throw new UnauthorizedException(
        'Session expired or revoked. Please log in again.',
      );
    }

    // The account is re-read on every refresh. The access token is stateless, so
    // this is the one moment a deactivated, unverified or deleted account stops
    // being able to mint new tokens -- and the moment a password change can
    // actually end the attacker's session.
    const user = await this.userService.findById(result.record.userId);

    if (!user || !user.isVerified) {
      await this.sessionService.revokeAllForUser(
        result.record.userId,
        'password_changed',
      );
      throw new UnauthorizedException(
        'Session expired or revoked. Please log in again.',
      );
    }

    return {
      access_token: this.signToken(
        user.id,
        user.email,
        result.record.familyId,
      ),
      session: {
        token: result.token,
        familyId: result.record.familyId,
        expiresAt: result.record.expiresAt,
      },
    };
  }

  /**
   * Ends one session.
   *
   * Idempotent and silent when there is no cookie, because "log out" is often
   * fired by a page whose session has already expired and a 400 there would
   * leave the customer staring at an error instead of a signed-out app.
   */
  async logout(token: string | null): Promise<{ message: string }> {
    if (token) {
      await this.sessionService.revokeByToken(token, 'logout');
    }

    return { message: 'Logged out' };
  }

  /**
   * Ends every session for the user, including the one making the request.
   *
   * This is the "my account might be compromised" control, and it is the reason
   * the access token carries its session id: the tokens already issued stay
   * cryptographically valid until they expire, so without that claim a
   * sign-out-everywhere would not stop anyone holding one.
   */
  async logoutAll(userId: string): Promise<{ message: string }> {
    const revoked = await this.sessionService.revokeAllForUser(userId, 'logout_all');
    return { message: `Logged out of ${revoked} session(s)` };
  }

  /** Live sessions, for the "where am I signed in" screen. */
  async sessions(userId: string, familyId: string | null) {
    const live = await this.sessionService.listForUser(userId, familyId);

    return live.map((session) => ({
      id: session.id,
      userAgent: session.userAgent,
      ip: session.ip,
      createdAt: session.createdAt.toISOString(),
      expiresAt: session.expiresAt.toISOString(),
      isCurrent: session.isCurrent,
    }));
  }

  async getProfile(userId: string) {
    const user = await this.userService.findById(userId);
    if (!user) {
      throw new UnauthorizedException();
    }
    return user.toResponse();
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const user = await this.userService.findById(userId);
    if (!user) {
      throw new UnauthorizedException();
    }

    const name = dto.name;
    const email = dto.email;
    const status = dto.status;
    const password = dto.password;

    const hasName = name !== undefined;
    const hasEmail = email !== undefined && email !== user.email;
    const hasStatus = status !== undefined && status !== user.status;
    const hasPassword = password !== undefined;

    if (!hasName && !hasEmail && !hasStatus && !hasPassword) {
      return user.toResponse();
    }

    if (hasEmail) {
      const existing = await this.userService.findByEmail(email);
      if (existing && existing.id !== userId) {
        throw new ConflictException('Email already registered');
      }
    }

    const fields: {
      name?: string;
      email?: string;
      status?: string;
      passwordHash?: string;
      isVerified?: boolean;
      verificationToken?: null;
      verificationTokenExpires?: null;
    } = {};

    if (hasName) {
      fields.name = name;
    }

    if (hasEmail) {
      fields.email = email;
      fields.isVerified = false;
      fields.verificationToken = null;
      fields.verificationTokenExpires = null;
    }

    if (hasStatus) {
      // The DTO already validated this; the check stays so a non-HTTP caller
      // (or a future admin route) cannot write a status outside the enum.
      if (!isSelfEditableStatus(status)) {
        throw new BadRequestException(
          `Invalid status. Allowed: ${SELF_EDITABLE_USER_STATUSES.join(', ')}`,
        );
      }
      fields.status = status;
    }

    if (hasPassword) {
      if (!password) {
        throw new BadRequestException('New password cannot be empty');
      }
      if (dto.currentPassword === undefined) {
        throw new BadRequestException(
          'Current password is required to change the password',
        );
      }
      const passwordValid = await compare(
        dto.currentPassword,
        user.passwordHash,
      );
      if (!passwordValid) {
        throw new BadRequestException('Incorrect current password');
      }
      fields.passwordHash = await hash(password, 10);
    }

    const updated = await this.userService.updateProfile(userId, fields);
    if (!updated) {
      throw new UnauthorizedException();
    }

    if (hasEmail) {
      await this.issueVerificationToken(updated);
    }

    if (hasPassword) {
      // Every session, including the one making the change: someone who just
      // changed the password because they spotted an intruder should not be
      // sharing a browser session with them.
      await this.sessionService.revokeAllForUser(userId, 'password_changed');
    }

    return updated.toResponse();
  }

  async verifyEmail(token: string) {
    // `hashToken` calls `createHash().update()`, which throws a TypeError on
    // `undefined`. Guarding here keeps a missing `?token=` a documented 400
    // instead of an unhandled 500.
    if (!token) {
      throw new BadRequestException(
        'Verification token is required. Read it from the ?token= link sent by email.',
      );
    }

    const user = await this.userService.findByVerificationToken(
      this.hashToken(token),
    );
    if (
      !user ||
      (user.verificationTokenExpires &&
        user.verificationTokenExpires.getTime() < Date.now())
    ) {
      throw new BadRequestException('Invalid or expired verification token');
    }

    if (user.isVerified) {
      return { message: 'Email already verified' };
    }

    await this.userService.markVerified(user.id);
    return { message: 'Email verified successfully' };
  }

  async forgotPassword(dto: ForgotPasswordDto) {
    const message =
      'If an account with that email exists, a reset link was sent';

    const user = await this.userService.findByEmail(dto.email);
    if (!user) {
      return { message };
    }

    const token = this.generateToken();
    await this.userService.setResetToken(
      user.id,
      this.hashToken(token),
      new Date(Date.now() + RESET_TOKEN_TTL_MS),
    );
    this.mailService
      .sendResetPasswordEmail(user.email, token)
      .catch(() => undefined);

    return { message };
  }

  async resetPassword(dto: ResetPasswordDto) {
    const user = await this.userService.findByResetToken(
      this.hashToken(dto.token),
    );
    if (
      !user ||
      (user.resetTokenExpires && user.resetTokenExpires.getTime() < Date.now())
    ) {
      throw new BadRequestException('Invalid or expired reset token');
    }

    await this.userService.updatePassword(user.id, dto.password);

    // A reset is what a customer reaches for when they think somebody else has
    // their password, so it has to end that somebody's session. Without this the
    // attacker's refresh token keeps working and the reset achieves nothing
    // except locking the legitimate owner out.
    await this.sessionService.revokeAllForUser(user.id, 'password_changed');

    return { message: 'Password reset successfully' };
  }

  private async issueVerificationToken(user: User): Promise<void> {
    const token = this.generateToken();
    await this.userService.setVerificationToken(
      user.id,
      this.hashToken(token),
      new Date(Date.now() + VERIFICATION_TOKEN_TTL_MS),
    );
    this.mailService
      .sendVerificationEmail(user.email, token)
      .catch(() => undefined);
  }

  /**
   * `sid` is the session the token belongs to.
   *
   * It is what makes revocation possible at all: a signed access token stays
   * valid to anybody who holds it until it expires, so the only way "log out
   * everywhere" can stop a token already in the wild is for the server to be
   * able to check whether the session behind it is still alive. The strategy
   * does that on every request.
   */
  private signToken(
    userId: string,
    email: string,
    sid: string,
  ): string {
    return this.jwtService.sign({ sub: userId, email, sid });
  }

  private generateToken(): string {
    return randomBytes(32).toString('hex');
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
