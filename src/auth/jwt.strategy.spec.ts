import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { JwtStrategy } from './jwt.strategy.js';
import { UserService } from '../user/user.service.js';
import { SessionService } from './session.service.js';

describe('JwtStrategy', () => {
  let strategy: JwtStrategy;

  let userService: {
    findById: any;
  };

  let sessions: {
    isFamilyActive: any;
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

    sessions = {
      isFamilyActive: jest.fn(async () => true),
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
        {
          provide: SessionService,
          useValue: sessions,
        },
      ],
    }).compile();

    strategy = moduleRef.get(JwtStrategy);
  });

  it('returns the user response plus the session for a verified user', async () => {
    userService.findById.mockResolvedValue(verifiedUser);

    const result = await strategy.validate({
      sub: 'user-1',
      email: 'test@example.com',
      sid: 'family-1',
    });

    expect(result).toEqual({
      id: 'user-1',
      email: 'test@example.com',
      isVerified: true,
      sessionId: 'family-1',
    });
  });

  it('rejects an unverified user', async () => {
    userService.findById.mockResolvedValue(unverifiedUser);

    await expect(
      strategy.validate({
        sub: 'user-2',
        email: 'unverified@example.com',
        sid: 'family-1',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a payload for a missing user', async () => {
    userService.findById.mockResolvedValue(null);

    await expect(
      strategy.validate({
        sub: 'nope',
        email: 'missing@example.com',
        sid: 'family-1',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  // The reason the strategy talks to the session store at all. Without this a
  // token handed out before a logout keeps working until it expires, which is
  // the behaviour that makes "log out everywhere" a lie.
  it('rejects a token whose session has been revoked, before reading the user', async () => {
    sessions.isFamilyActive.mockResolvedValue(false);

    await expect(
      strategy.validate({
        sub: 'user-1',
        email: 'test@example.com',
        sid: 'dead-family',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    // The account is not even looked up: the session is already gone, and
    // skipping the query keeps the common revocation path cheap.
    expect(userService.findById).not.toHaveBeenCalled();
  });

  it('rejects a token with no session claim', async () => {
    // Tokens minted before sessions existed carry no `sid`. They cannot be
    // revoked, so honouring them would leave an unrevocable credential alive.
    await expect(
      strategy.validate({ sub: 'user-1', email: 'test@example.com' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(sessions.isFamilyActive).not.toHaveBeenCalled();
  });
});
