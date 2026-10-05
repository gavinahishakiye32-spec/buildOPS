import { Test } from '@nestjs/testing';
import {
  ConflictException,
  UnauthorizedException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { compare } from 'bcryptjs';
import { createHash } from 'node:crypto';
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { AuthService } from './auth.service.js';
import { UserService } from '../user/user.service.js';
import { MailService } from '../mail/mail.service.js';
import { SessionService } from './session.service.js';

describe('AuthService', () => {
  let authService: AuthService;

  let userService: {
    findByEmail: any;
    findById: any;
    create: any;
    findByVerificationToken: any;
    findByResetToken: any;
    setVerificationToken: any;
    markVerified: any;
    setResetToken: any;
    updatePassword: any;
    updateProfile: any;
  };

  let jwtService: {
    sign: any;
  };

  let mailService: {
    sendVerificationEmail: any;
    sendResetPasswordEmail: any;
  };

  let sessionService: {
    issue: any;
    rotate: any;
    revokeByToken: any;
    revokeAllForUser: any;
    isFamilyActive: any;
    listForUser: any;
  };

  const mockUser = {
    id: 'user-1',
    email: 'test@example.com',
    passwordHash: 'hashed-password',
    name: 'Test User',
    status: 'active',
    organizationId: null,
    isVerified: false,
    verificationToken: null,
    verificationTokenExpires: null,
    resetToken: null,
    resetTokenExpires: null,

    toResponse: () => ({
      id: 'user-1',
      email: 'test@example.com',
      name: 'Test User',
      status: 'active',
      organizationId: null,
      isVerified: false,
    }),
  };

  beforeEach(async () => {
    userService = {
      findByEmail: jest.fn(),
      findById: jest.fn(),
      create: jest.fn(),
      findByVerificationToken: jest.fn(),
      findByResetToken: jest.fn(),
      setVerificationToken: jest.fn(),
      markVerified: jest.fn(),
      setResetToken: jest.fn(),
      updatePassword: jest.fn(),
      updateProfile: jest.fn(),
    };

    jwtService = {
      sign: jest.fn().mockReturnValue('signed-token'),
    };

    mailService = {
      sendVerificationEmail: jest.fn(async () => {}),
      sendResetPasswordEmail: jest.fn(async () => {}),
    };

    sessionService = {
      issue: jest.fn(async () => ({
        token: 'refresh-token',
        familyId: 'family-1',
        expiresAt: new Date(Date.now() + 86_400_000),
      })),
      rotate: jest.fn(),
      revokeByToken: jest.fn(async () => undefined),
      revokeAllForUser: jest.fn(async () => 0),
      isFamilyActive: jest.fn(async () => true),
      listForUser: jest.fn(async () => []),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        {
          provide: UserService,
          useValue: userService,
        },
        {
          provide: JwtService,
          useValue: jwtService,
        },
        {
          provide: MailService,
          useValue: mailService,
        },
        {
          provide: SessionService,
          useValue: sessionService,
        },
      ],
    }).compile();

    authService = moduleRef.get(AuthService);
  });

  describe('register', () => {
    it('creates a user, issues a verification token and returns no access token', async () => {
      userService.findByEmail.mockResolvedValue(null);
      userService.create.mockResolvedValue(mockUser);

      const result = await authService.register({
        email: 'test@example.com',
        password: 'password123',
        name: 'Test User',
      });

      expect(userService.create).toHaveBeenCalledWith(
        'test@example.com',
        'password123',
        'Test User',
      );

      expect(result.message).toBe(
        'Registration successful. Please verify your email before logging in.',
      );

      expect(result.user).not.toHaveProperty('passwordHash');
      expect(result).not.toHaveProperty('access_token');
      expect(jwtService.sign).not.toHaveBeenCalled();

      expect(userService.setVerificationToken).toHaveBeenCalledTimes(1);

      const [userId, storedToken, expires] = userService.setVerificationToken
        .mock.calls[0] as [string, string, Date];

      expect(userId).toBe('user-1');
      expect(storedToken).toMatch(/^[a-f0-9]{64}$/);
      expect(expires).toBeInstanceOf(Date);
      expect(expires.getTime()).toBeGreaterThan(Date.now());

      const sentToken = mailService.sendVerificationEmail.mock
        .calls[0][1] as string;

      expect(storedToken).toBe(
        createHash('sha256').update(sentToken).digest('hex'),
      );
    });

    it('throws ConflictException when email is already registered', async () => {
      userService.findByEmail.mockResolvedValue(mockUser);

      await expect(
        authService.register({
          email: 'test@example.com',
          password: 'password123',
        }),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(userService.create).not.toHaveBeenCalled();
      expect(mailService.sendVerificationEmail).not.toHaveBeenCalled();
    });
  });

  describe('login', () => {
    it('returns a token for valid credentials when the email is verified', async () => {
      userService.findByEmail.mockResolvedValue({
        ...mockUser,
        isVerified: true,
        passwordHash:
          '$2b$10$9..eefpF/TxhmA.ntLxcVO7.LaqDQe7LMA6QwxfqKFDWN4saVicPO',
      });

      const result = await authService.login(
        {
          email: 'test@example.com',
          password: 'password123',
        },
        { userAgent: 'jest', ip: '127.0.0.1' },
      );

      expect(result.access_token).toBe('signed-token');
      expect(userService.setVerificationToken).not.toHaveBeenCalled();
      expect(mailService.sendVerificationEmail).not.toHaveBeenCalled();
    });

    it('rejects unverified users, reissues a verification token and sends a fresh email', async () => {
      userService.findByEmail.mockResolvedValue({
        ...mockUser,
        isVerified: false,
        passwordHash:
          '$2b$10$9..eefpF/TxhmA.ntLxcVO7.LaqDQe7LMA6QwxfqKFDWN4saVicPO',
      });

      await expect(
        authService.login(
          {
            email: 'test@example.com',
            password: 'password123',
          },
          { userAgent: 'jest', ip: '127.0.0.1' },
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(jwtService.sign).not.toHaveBeenCalled();
      expect(userService.setVerificationToken).toHaveBeenCalledTimes(1);

      const [userId, storedToken, expires] = userService.setVerificationToken
        .mock.calls[0] as [string, string, Date];

      expect(userId).toBe('user-1');
      expect(storedToken).toMatch(/^[a-f0-9]{64}$/);
      expect(expires).toBeInstanceOf(Date);

      const sentToken = mailService.sendVerificationEmail.mock
        .calls[0][1] as string;

      expect(storedToken).toBe(
        createHash('sha256').update(sentToken).digest('hex'),
      );
    });

    it('throws UnauthorizedException when user does not exist', async () => {
      userService.findByEmail.mockResolvedValue(null);

      await expect(
        authService.login(
          {
            email: 'missing@example.com',
            password: 'x',
          },
          { userAgent: 'jest', ip: '127.0.0.1' },
        ),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('throws UnauthorizedException when password is invalid', async () => {
      userService.findByEmail.mockResolvedValue(mockUser);

      await expect(
        authService.login(
          {
            email: 'test@example.com',
            password: 'wrong',
          },
          { userAgent: 'jest', ip: '127.0.0.1' },
        ),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      expect(userService.setVerificationToken).not.toHaveBeenCalled();
    });
  });

  describe('getProfile', () => {
    it('returns the user profile', async () => {
      userService.findById.mockResolvedValue(mockUser);

      const result = await authService.getProfile('user-1');

      expect(result).toMatchObject({
        id: 'user-1',
        email: 'test@example.com',
      });

      expect(result).not.toHaveProperty('passwordHash');
      expect(result).not.toHaveProperty('verificationToken');
      expect(result).not.toHaveProperty('resetToken');
    });

    it('throws UnauthorizedException when user is not found', async () => {
      userService.findById.mockResolvedValue(null);

      await expect(authService.getProfile('nope')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });
  });

  describe('updateProfile', () => {
    it('updates the name and returns the updated user', async () => {
      userService.findById.mockResolvedValue(mockUser);
      userService.findByEmail.mockResolvedValue(null);
      const updated = { ...mockUser, name: 'New Name' };
      updated.toResponse = () => ({
        id: 'user-1',
        email: 'test@example.com',
        name: 'New Name',
        status: 'active',
        organizationId: null,
        isVerified: false,
      });
      userService.updateProfile.mockResolvedValue(updated);

      const result = await authService.updateProfile('user-1', {
        name: 'New Name',
      });

      expect(userService.updateProfile).toHaveBeenCalledWith('user-1', {
        name: 'New Name',
      });

      expect(userService.findByEmail).not.toHaveBeenCalled();
      expect(mailService.sendVerificationEmail).not.toHaveBeenCalled();
      expect(result.name).toBe('New Name');
      expect(result).not.toHaveProperty('passwordHash');
    });

    it('changes the email, resets verification and sends a fresh verification link', async () => {
      userService.findById.mockResolvedValue(mockUser);
      userService.findByEmail.mockResolvedValue(null);
      const updated = {
        ...mockUser,
        email: 'new@example.com',
        isVerified: false,
        verificationToken: null,
        verificationTokenExpires: null,
      };
      updated.toResponse = () => ({
        id: 'user-1',
        email: 'new@example.com',
        name: 'Test User',
        status: 'active',
        organizationId: null,
        isVerified: false,
      });
      userService.updateProfile.mockResolvedValue(updated);

      const result = await authService.updateProfile('user-1', {
        email: 'new@example.com',
      });

      expect(userService.findByEmail).toHaveBeenCalledWith('new@example.com');

      expect(userService.updateProfile).toHaveBeenCalledWith('user-1', {
        email: 'new@example.com',
        isVerified: false,
        verificationToken: null,
        verificationTokenExpires: null,
      });

      expect(userService.setVerificationToken).toHaveBeenCalledTimes(1);

      const [userId, storedToken, expires] = userService.setVerificationToken
        .mock.calls[0] as [string, string, Date];

      expect(userId).toBe('user-1');
      expect(storedToken).toMatch(/^[a-f0-9]{64}$/);
      expect(expires).toBeInstanceOf(Date);

      const sentToken = mailService.sendVerificationEmail.mock
        .calls[0][1] as string;

      expect(sentToken).toBeTruthy();
      expect(storedToken).toBe(
        createHash('sha256').update(sentToken).digest('hex'),
      );

      expect(mailService.sendVerificationEmail.mock.calls[0][0]).toBe(
        'new@example.com',
      );

      expect(result.email).toBe('new@example.com');
      expect(result.isVerified).toBe(false);
    });

    it('re-verifies is not triggered when the email is unchanged', async () => {
      userService.findById.mockResolvedValue(mockUser);
      userService.updateProfile.mockResolvedValue(mockUser);

      await authService.updateProfile('user-1', {
        email: 'test@example.com',
      });

      expect(userService.updateProfile).not.toHaveBeenCalled();
      expect(userService.setVerificationToken).not.toHaveBeenCalled();
      expect(mailService.sendVerificationEmail).not.toHaveBeenCalled();
    });

    it('returns the current profile unchanged when nothing is provided', async () => {
      userService.findById.mockResolvedValue(mockUser);

      const result = await authService.updateProfile('user-1', {});

      expect(userService.updateProfile).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        id: 'user-1',
        email: 'test@example.com',
      });
    });

    it('updates the status', async () => {
      userService.findById.mockResolvedValue(mockUser);
      const updated = { ...mockUser, status: 'inactive' };
      updated.toResponse = () => ({
        id: 'user-1',
        email: 'test@example.com',
        name: 'Test User',
        status: 'inactive',
        organizationId: null,
        isVerified: false,
      });
      userService.updateProfile.mockResolvedValue(updated);

      const result = await authService.updateProfile('user-1', {
        status: 'inactive',
      });

      expect(userService.updateProfile).toHaveBeenCalledWith('user-1', {
        status: 'inactive',
      });

      expect(result.status).toBe('inactive');
    });

    it('rejects a non-self-service status', async () => {
      userService.findById.mockResolvedValue(mockUser);

      await expect(
        authService.updateProfile('user-1', {
          status: 'suspended',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(userService.updateProfile).not.toHaveBeenCalled();
    });

    it('changes the password when the current password matches', async () => {
      userService.findById.mockResolvedValue({
        ...mockUser,
        passwordHash:
          '$2b$10$9..eefpF/TxhmA.ntLxcVO7.LaqDQe7LMA6QwxfqKFDWN4saVicPO',
      });
      const updated = {
        ...mockUser,
        passwordHash:
          '$2b$10$9..eefpF/TxhmA.ntLxcVO7.LaqDQe7LMA6QwxfqKFDWN4saVicPO',
      };
      updated.toResponse = () => ({
        id: 'user-1',
        email: 'test@example.com',
        name: 'Test User',
        status: 'active',
        organizationId: null,
        isVerified: false,
      });
      userService.updateProfile.mockResolvedValue(updated);

      const result = await authService.updateProfile('user-1', {
        password: 'new-password',
        currentPassword: 'password123',
      });

      const [, fields] = userService.updateProfile.mock.calls[0] as [
        string,
        { passwordHash: string },
      ];

      expect(fields.passwordHash).toBeDefined();
      expect(fields.passwordHash).not.toBe(
        '$2b$10$9..eefpF/TxhmA.ntLxcVO7.LaqDQe7LMA6QwxfqKFDWN4saVicPO',
      );
      expect(await compare('new-password', fields.passwordHash)).toBe(true);
      expect(result).not.toHaveProperty('passwordHash');
    });

    it('rejects a password change without the current password', async () => {
      userService.findById.mockResolvedValue(mockUser);

      await expect(
        authService.updateProfile('user-1', {
          password: 'new-password',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(userService.updateProfile).not.toHaveBeenCalled();
    });

    it('rejects a password change with an incorrect current password', async () => {
      userService.findById.mockResolvedValue({
        ...mockUser,
        passwordHash:
          '$2b$10$9..eefpF/TxhmA.ntLxcVO7.LaqDQe7LMA6QwxfqKFDWN4saVicPO',
      });

      await expect(
        authService.updateProfile('user-1', {
          password: 'new-password',
          currentPassword: 'wrong-password',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(userService.updateProfile).not.toHaveBeenCalled();
    });

    it('rejects an empty new password', async () => {
      userService.findById.mockResolvedValue(mockUser);

      await expect(
        authService.updateProfile('user-1', {
          password: '',
          currentPassword: 'password123',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(userService.updateProfile).not.toHaveBeenCalled();
    });

    it('throws ConflictException when the new email is already in use', async () => {
      userService.findById.mockResolvedValue(mockUser);
      userService.findByEmail.mockResolvedValue({
        ...mockUser,
        id: 'other-user',
        email: 'taken@example.com',
      });

      await expect(
        authService.updateProfile('user-1', {
          email: 'taken@example.com',
        }),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(userService.updateProfile).not.toHaveBeenCalled();
      expect(mailService.sendVerificationEmail).not.toHaveBeenCalled();
    });

    it('throws UnauthorizedException when the user is not found', async () => {
      userService.findById.mockResolvedValue(null);

      await expect(
        authService.updateProfile('nope', { name: 'X' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      expect(userService.updateProfile).not.toHaveBeenCalled();
    });
  });

  describe('verifyEmail', () => {
    it('verifies the email for a valid token', async () => {
      userService.findByVerificationToken.mockResolvedValue({
        ...mockUser,
        verificationTokenExpires: new Date(Date.now() + 60_000),
      });

      const result = await authService.verifyEmail('raw-verification-token');

      expect(userService.findByVerificationToken).toHaveBeenCalledWith(
        createHash('sha256').update('raw-verification-token').digest('hex'),
      );

      expect(userService.markVerified).toHaveBeenCalledWith('user-1');

      expect(result.message).toBe('Email verified successfully');
    });

    it('throws BadRequestException for an invalid token', async () => {
      userService.findByVerificationToken.mockResolvedValue(null);

      await expect(authService.verifyEmail('bad-token')).rejects.toBeInstanceOf(
        BadRequestException,
      );

      expect(userService.markVerified).not.toHaveBeenCalled();
    });

    it('throws BadRequestException for an expired token', async () => {
      userService.findByVerificationToken.mockResolvedValue({
        ...mockUser,
        verificationTokenExpires: new Date(Date.now() - 1000),
      });

      await expect(
        authService.verifyEmail('expired-token'),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(userService.markVerified).not.toHaveBeenCalled();
    });

    it('returns an already-verified message when the email is already verified', async () => {
      userService.findByVerificationToken.mockResolvedValue({
        ...mockUser,
        isVerified: true,
        verificationTokenExpires: new Date(Date.now() + 60_000),
      });

      const result = await authService.verifyEmail('used-token');

      expect(result.message).toBe('Email already verified');
      expect(userService.markVerified).not.toHaveBeenCalled();
    });
  });

  describe('forgotPassword', () => {
    it('stores a reset token and sends a reset email when the account exists', async () => {
      userService.findByEmail.mockResolvedValue(mockUser);

      const result = await authService.forgotPassword({
        email: 'test@example.com',
      });

      expect(result.message).toBe(
        'If an account with that email exists, a reset link was sent',
      );

      expect(userService.setResetToken).toHaveBeenCalledTimes(1);

      const [userId, storedToken, expires] = userService.setResetToken.mock
        .calls[0] as [string, string, Date];

      expect(userId).toBe('user-1');
      expect(storedToken).toMatch(/^[a-f0-9]{64}$/);
      expect(expires).toBeInstanceOf(Date);

      const sentToken = mailService.sendResetPasswordEmail.mock
        .calls[0][1] as string;

      expect(storedToken).toBe(
        createHash('sha256').update(sentToken).digest('hex'),
      );
    });

    it('does not leak account existence when the email is unknown', async () => {
      userService.findByEmail.mockResolvedValue(null);

      const result = await authService.forgotPassword({
        email: 'missing@example.com',
      });

      expect(result.message).toBe(
        'If an account with that email exists, a reset link was sent',
      );

      expect(userService.setResetToken).not.toHaveBeenCalled();
      expect(mailService.sendResetPasswordEmail).not.toHaveBeenCalled();
    });
  });

  describe('resetPassword', () => {
    it('updates the password for a valid token', async () => {
      userService.findByResetToken.mockResolvedValue({
        ...mockUser,
        resetTokenExpires: new Date(Date.now() + 60_000),
      });

      const result = await authService.resetPassword({
        token: 'raw-reset-token',
        password: 'new-password',
      });

      expect(userService.findByResetToken).toHaveBeenCalledWith(
        createHash('sha256').update('raw-reset-token').digest('hex'),
      );

      expect(userService.updatePassword).toHaveBeenCalledWith(
        'user-1',
        'new-password',
      );

      expect(result.message).toBe('Password reset successfully');
    });

    it('throws BadRequestException for an invalid token', async () => {
      userService.findByResetToken.mockResolvedValue(null);

      await expect(
        authService.resetPassword({
          token: 'bad-token',
          password: 'new-password',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(userService.updatePassword).not.toHaveBeenCalled();
    });

    it('throws BadRequestException for an expired token', async () => {
      userService.findByResetToken.mockResolvedValue({
        ...mockUser,
        resetTokenExpires: new Date(Date.now() - 1000),
      });

      await expect(
        authService.resetPassword({
          token: 'expired-token',
          password: 'new-password',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(userService.updatePassword).not.toHaveBeenCalled();
    });
  });
});
