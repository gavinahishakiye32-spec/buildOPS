import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { JwtStrategy } from './jwt.strategy.js';
import { UserService } from '../user/user.service.js';

describe('JwtStrategy', () => {
  let strategy: JwtStrategy;

  let userService: {
    findById: any;
  };

  const verifiedUser = {
    id: 'user-1',
    email: 'test@example.com',
    isVerified: true,
    toResponse: () => ({
      id: 'user-1',
      email: 'test@example.com',
      isVerified: true,
    }),
  };

  const unverifiedUser = {
    id: 'user-2',
    email: 'unverified@example.com',
    isVerified: false,
    toResponse: () => ({
      id: 'user-2',
      email: 'unverified@example.com',
      isVerified: false,
    }),
  };

  beforeEach(async () => {
    userService = {
      findById: jest.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        JwtStrategy,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((_key: string, fallback?: string) => fallback),
          },
        },
        {
          provide: UserService,
          useValue: userService,
        },
      ],
    }).compile();

    strategy = moduleRef.get(JwtStrategy);
  });

  it('returns the user response for a verified user', async () => {
    userService.findById.mockResolvedValue(verifiedUser);

    const result = await strategy.validate({
      sub: 'user-1',
      email: 'test@example.com',
    });

    expect(result).toEqual({
      id: 'user-1',
      email: 'test@example.com',
      isVerified: true,
    });
  });

  it('rejects an unverified user', async () => {
    userService.findById.mockResolvedValue(unverifiedUser);

    await expect(
      strategy.validate({
        sub: 'user-2',
        email: 'unverified@example.com',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a payload for a missing user', async () => {
    userService.findById.mockResolvedValue(null);

    await expect(
      strategy.validate({
        sub: 'nope',
        email: 'missing@example.com',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});