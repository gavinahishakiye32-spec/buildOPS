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

const VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;
const ALLOWED_PROFILE_STATUSES = ['active', 'inactive'] as const;

@Injectable()
export class AuthService {
  constructor(
    private readonly userService: UserService,
    private readonly jwtService: JwtService,
    private readonly mailService: MailService,
  ) {}

  async register(dto: RegisterDto) {
    const existing = await this.userService.findByEmail(dto.email);
    if (existing) {
      throw new ConflictException('Email already registered');
    }

    const user = await this.userService.create(dto.email, dto.password, dto.name);
    await this.issueVerificationToken(user);

    return {
      message: 'Registration successful. Please verify your email before logging in.',
      user: user.toResponse(),
    };
  }

  async login(dto: LoginDto) {
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

    const token = this.signToken(user.id, user.email);
    return { access_token: token };
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
      if (
        !ALLOWED_PROFILE_STATUSES.includes(
          status as (typeof ALLOWED_PROFILE_STATUSES)[number],
        )
      ) {
        throw new BadRequestException(
          `Invalid status. Allowed: ${ALLOWED_PROFILE_STATUSES.join(', ')}`,
        );
      }
      fields.status = status;
    }

    if (hasPassword) {
      if (!password) {
        throw new BadRequestException(
          'New password cannot be empty',
        );
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
        throw new BadRequestException(
          'Incorrect current password',
        );
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

    return updated.toResponse();
  }

  async verifyEmail(token: string) {
    const user = await this.userService.findByVerificationToken(this.hashToken(token));
    if (!user || (user.verificationTokenExpires && user.verificationTokenExpires.getTime() < Date.now())) {
      throw new BadRequestException('Invalid or expired verification token');
    }

    if (user.isVerified) {
      return { message: 'Email already verified' };
    }

    await this.userService.markVerified(user.id);
    return { message: 'Email verified successfully' };
  }

  async forgotPassword(dto: ForgotPasswordDto) {
    const message = 'If an account with that email exists, a reset link was sent';

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
    const user = await this.userService.findByResetToken(this.hashToken(dto.token));
    if (
      !user ||
      (user.resetTokenExpires && user.resetTokenExpires.getTime() < Date.now())
    ) {
      throw new BadRequestException('Invalid or expired reset token');
    }

    await this.userService.updatePassword(user.id, dto.password);
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

  private signToken(userId: string, email: string): string {
    return this.jwtService.sign({ sub: userId, email });
  }

  private generateToken(): string {
    return randomBytes(32).toString('hex');
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}