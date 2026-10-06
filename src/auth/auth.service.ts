import {
  Injectable,
  ConflictException,
  BadRequestException,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { compare, hash } from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';
import { UserService } from '../user/user.service.js';
import { MailService } from '../mail/mail.service.js';
import { buildEmailLink } from '../mail/mail.links.js';
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

/** What one email attempt did, reported outside production only. */
type EmailDelivery = Partial<{ emailSent: boolean; emailError: string }>;

/**
 * The fields a non-production response adds: the raw token, the matching link
 * and the delivery report. Every one of them is absent in production.
 */
type EmailExtras = Partial<{
  verificationToken: string;
  verificationLink: string;
  resetToken: string;
  resetLink: string;
  emailSent: boolean;
  emailError: string;
}>;

@Injectable()
export class AuthService {
  constructor(
    private readonly userService: UserService,
    private readonly jwtService: JwtService,
    private readonly mailService: MailService,
    private readonly sessionService: SessionService,
    private readonly config: ConfigService,
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
    const issued = await this.issueVerificationToken(user);

    return {
      message:
        'Registration successful. Please verify your email before logging in.',
      user: user.toResponse(),
      ...this.emailExtras('verification', issued.token, issued.delivery),
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
      const issued = await this.issueVerificationToken(user);
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        message:
          'Email not verified. Check your inbox for a verification link before logging in.',
        ...this.emailExtras('verification', issued.token, issued.delivery),
      });
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

  async forgotPassword(
    dto: ForgotPasswordDto,
  ): Promise<{ message: string } & EmailExtras> {
    const message =
      'If an account with that email exists, a reset link was sent';

    const user = await this.userService.findByEmail(dto.email);
    if (!user) {
      // The same answer either way: a caller must not be able to tell an
      // address that exists from one that does not, so this branch can never
      // carry a token.
      return { message };
    }

    const token = this.generateToken();
    await this.userService.setResetToken(
      user.id,
      this.hashToken(token),
      new Date(Date.now() + RESET_TOKEN_TTL_MS),
    );
    const delivery = await this.dispatchEmail(() =>
      this.mailService.sendResetPasswordEmail(user.email, token),
    );

    return { message, ...this.emailExtras('reset', token, delivery) };
  }

  /**
   * Checks a reset token without consuming it, so following the emailed link
   * in a browser answers `200` while the token is still usable rather than
   * `404`. The password change itself stays on `POST /auth/reset-password`.
   */
  async validateResetToken(token: string) {
    if (!token) {
      throw new BadRequestException(
        'Reset token is required. Read it from the ?token= link sent by email.',
      );
    }

    const user = await this.userService.findByResetToken(
      this.hashToken(token),
    );
    if (
      !user ||
      (user.resetTokenExpires && user.resetTokenExpires.getTime() < Date.now())
    ) {
      throw new BadRequestException('Invalid or expired reset token');
    }

    return {
      message:
        'Reset token is valid. POST a new password with this token to /auth/reset-password to choose one.',
    };
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

  private async issueVerificationToken(
    user: User,
  ): Promise<{ token: string; delivery: EmailDelivery }> {
    const token = this.generateToken();
    await this.userService.setVerificationToken(
      user.id,
      this.hashToken(token),
      new Date(Date.now() + VERIFICATION_TOKEN_TTL_MS),
    );
    const delivery = await this.dispatchEmail(() =>
      this.mailService.sendVerificationEmail(user.email, token),
    );

    return { token, delivery };
  }

  /**
   * True outside production: there the API answers with the raw token and link
   * and reports the SMTP outcome, so a local flow can be driven without a
   * working mail server. Production never includes them -- there the token
   * exists only in the email, which is the whole point of hashing it at rest.
   */
  private get exposeEmailTokens(): boolean {
    return this.config.get<string>('NODE_ENV') !== 'production';
  }

  /**
   * Sends one email and reports what happened, outside production only.
   *
   * Outside production the send is awaited, so the response can say whether the
   * mail actually left (`emailSent` / `emailError`) instead of claiming success
   * while SMTP quietly refused it -- the failure mode that leaves a caller
   * staring at a `201` and an empty inbox. In production the send stays
   * fire-and-forget: registering must not wait on, or be failed by, the mail
   * server, and MailService has already logged the error. Production therefore
   * gets no delivery report at all.
   */
  private async dispatchEmail(
    send: () => Promise<void>,
  ): Promise<EmailDelivery> {
    if (!this.exposeEmailTokens) {
      void send().catch(() => undefined);
      return {};
    }

    try {
      await send();
      return { emailSent: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { emailSent: false, emailError: message };
    }
  }

  /**
   * The token, the link and the delivery report, as they belong in a JSON
   * response. An empty object in production, which is what keeps the token out
   * of production bodies.
   */
  private emailExtras(
    kind: 'verification' | 'reset',
    token: string,
    delivery: EmailDelivery,
  ): EmailExtras {
    if (!this.exposeEmailTokens) {
      return {};
    }

    const link = buildEmailLink(
      this.config.get<string>('APP_BASE_URL'),
      kind === 'verification' ? 'verify-email' : 'reset-password',
      token,
    );

    return kind === 'verification'
      ? { verificationToken: token, verificationLink: link, ...delivery }
      : { resetToken: token, resetLink: link, ...delivery };
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
