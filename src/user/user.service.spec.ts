import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { compare } from 'bcryptjs';
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { UserService } from './user.service.js';
import { User } from './user.entity.js';

describe('UserService', () => {
  let userService: UserService;

  let repo: {
    findOne: any;
    update: any;
    create: any;
    save: any;
  };

  const mockUser = {
    id: 'user-1',
    email: 'test@example.com',
    isVerified: false,
  };

  beforeEach(async () => {
    repo = {
      findOne: jest.fn(),
     update: jest.fn(async () => ({ affected: 1 })),

      create: jest.fn(),
      save: jest.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        UserService,
        {
          provide: getRepositoryToken(User),
          useValue: repo,
        },
      ],
    }).compile();

    userService = moduleRef.get(UserService);
  });

  it('finds a user by verification token', async () => {
    repo.findOne.mockResolvedValue(mockUser);

    const user = await userService.findByVerificationToken('token-hash');

    expect(repo.findOne).toHaveBeenCalledWith({
      where: {
        verificationToken: 'token-hash',
      },
    });

    expect(user).toBe(mockUser);
  });

  it('finds a user by reset token', async () => {
    repo.findOne.mockResolvedValue(mockUser);

    const user = await userService.findByResetToken('token-hash');

    expect(repo.findOne).toHaveBeenCalledWith({
      where: {
        resetToken: 'token-hash',
      },
    });

    expect(user).toBe(mockUser);
  });

  it('stores a verification token with an expiry', async () => {
    const expires = new Date();

    await userService.setVerificationToken(
      'user-1',
      'token-hash',
      expires,
    );

    expect(repo.update).toHaveBeenCalledWith('user-1', {
      verificationToken: 'token-hash',
      verificationTokenExpires: expires,
    });
  });

  it('marks a user verified and clears verification fields', async () => {
    await userService.markVerified('user-1');

    expect(repo.update).toHaveBeenCalledWith('user-1', {
      isVerified: true,
      verificationToken: null,
      verificationTokenExpires: null,
    });
  });

  it('stores a reset token with an expiry', async () => {
    const expires = new Date();

    await userService.setResetToken(
      'user-1',
      'token-hash',
      expires,
    );

    expect(repo.update).toHaveBeenCalledWith('user-1', {
      resetToken: 'token-hash',
      resetTokenExpires: expires,
    });
  });

  it('updates the password with a hash and clears reset fields', async () => {
    await userService.updatePassword('user-1', 'new-password');

    const [, fields] = repo.update.mock.calls[0] as [
      string,
      {
        passwordHash: string;
        resetToken: null;
        resetTokenExpires: null;
      },
    ];

    expect(repo.update).toHaveBeenCalledWith('user-1', {
      passwordHash: fields.passwordHash,
      resetToken: null,
      resetTokenExpires: null,
    });

    expect(
      await compare('new-password', fields.passwordHash),
    ).toBe(true);
  });

  it('updates profile fields and returns the refreshed user', async () => {
    const updatedUser = {
      ...mockUser,
      name: 'New Name',
      email: 'new@example.com',
      status: 'inactive',
      isVerified: false,
    };

    repo.update.mockResolvedValue({ affected: 1 });
    repo.findOne.mockResolvedValue(updatedUser);

    const user = await userService.updateProfile('user-1', {
      name: 'New Name',
      email: 'new@example.com',
      status: 'inactive',
      passwordHash: 'hashed-new-password',
      isVerified: false,
      verificationToken: null,
      verificationTokenExpires: null,
    });

    expect(repo.update).toHaveBeenCalledWith('user-1', {
      name: 'New Name',
      email: 'new@example.com',
      status: 'inactive',
      passwordHash: 'hashed-new-password',
      isVerified: false,
      verificationToken: null,
      verificationTokenExpires: null,
    });

    expect(repo.findOne).toHaveBeenCalledWith({
      where: { id: 'user-1' },
    });

    expect(user).toBe(updatedUser);
  });

  it('omits undefined profile fields from the update', async () => {
    await userService.updateProfile('user-1', {
      name: 'Just Name',
    });

    expect(repo.update).toHaveBeenCalledWith('user-1', {
      name: 'Just Name',
    });
  });
});
