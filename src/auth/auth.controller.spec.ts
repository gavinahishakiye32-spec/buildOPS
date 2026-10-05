import { Test } from '@nestjs/testing';
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { SessionCookies } from './session-cookies.js';
import type { Response } from 'express';

describe('AuthController', () => {
  let controller: AuthController;

  let authService: {
    register: jest.Mock;
    login: jest.Mock;
    verifyEmail: jest.Mock;
    forgotPassword: jest.Mock;
    resetPassword: jest.Mock;
    getProfile: jest.Mock;
    updateProfile: jest.Mock;
    refresh: jest.Mock;
    logout: jest.Mock;
    logoutAll: jest.Mock;
    sessions: jest.Mock;
  };

  let sessionCookies: {
    writeCookies: jest.Mock;
    clearCookies: jest.Mock;
  };

  /**
   * Stand-in for the response object the cookie helpers write to. `status` is
   * read back by the tests, because the pending/settled distinction is a status
   * code and not a body field.
   */
  const fakeResponse = () =>
    ({ status: jest.fn(), cookie: jest.fn(), clearCookie: jest.fn() }) as unknown as Response;

  const accessToken = {
    access_token: 'signed-token',
  };

  beforeEach(async () => {
    authService = {
      register: jest.fn(async () => accessToken),

      login: jest.fn(async () => ({
        access_token: 'signed-token',
        session: {
          token: 'rt',
          familyId: 'family-1',
          expiresAt: new Date(86_400_000),
        },
      })),

      verifyEmail: jest.fn(async () => ({
        message: 'Email verified successfully',
      })),

      forgotPassword: jest.fn(async () => ({
        message: 'If an account with that email exists, a reset link was sent',
      })),

      resetPassword: jest.fn(async () => ({
        message: 'Password reset successfully',
      })),

      getProfile: jest.fn(async () => ({
        id: 'user-1',
      })),

      updateProfile: jest.fn(async () => ({
        id: 'user-1',
        name: 'Updated Name',
      })),

      refresh: jest.fn(async () => ({
        access_token: 'refreshed-token',
        session: { token: 'rt', familyId: 'family-1', expiresAt: new Date() },
      })),

      logout: jest.fn(async () => ({ message: 'Logged out' })),

      logoutAll: jest.fn(async () => ({ message: 'Logged out of 1 session(s)' })),

      sessions: jest.fn(async () => []),
    };

    sessionCookies = {
      writeCookies: jest.fn(),
      clearCookies: jest.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        {
          provide: AuthService,
          useValue: authService,
        },
        {
          provide: SessionCookies,
          useValue: sessionCookies,
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: () => true,
      })
      .compile();

    controller = moduleRef.get(AuthController);
  });

  it('delegates register to the auth service', async () => {
    const dto = {
      email: 'test@example.com',
      password: 'password123',
      name: 'Test User',
    };

    const result = await controller.register(dto);

    expect(authService.register).toHaveBeenCalledWith(dto);
    expect(result).toBe(accessToken);
  });

  it('delegates login to the auth service and sets the session cookies', async () => {
    const dto = {
      email: 'test@example.com',
      password: 'password123',
    };
    const res = fakeResponse();

    const result = await controller.login(dto, res, {
      header: (name: string) =>
        name === 'user-agent' ? 'jest' : undefined,
      ip: '127.0.0.1',
    } as never);

    expect(authService.login).toHaveBeenCalledWith(dto, {
      userAgent: 'jest',
      ip: '127.0.0.1',
    });
    // The session never reaches the client in the body: it is the httpOnly
    // cookie's job, and echoing it here would put the credential in a place
    // JavaScript can read.
    expect(result).toEqual({ access_token: 'signed-token' });
    expect(sessionCookies.writeCookies).toHaveBeenCalledTimes(1);
    expect(sessionCookies.writeCookies).toHaveBeenCalledWith(
      res,
      expect.objectContaining({ token: 'rt' }),
    );
  });

  it('logout is idempotent and clears the cookies even with no session', async () => {
    const res = fakeResponse();

    const result = await controller.logout(res, { cookies: {} } as never);

    expect(authService.logout).toHaveBeenCalledWith(null);
    expect(sessionCookies.clearCookies).toHaveBeenCalledWith(res);
    expect(result).toEqual({ message: 'Logged out' });
  });

  it('logout-all revokes every session and clears the cookies', async () => {
    const res = fakeResponse();

    // These routes run `BearerProfile()` (JWT guard, not `PermissionsGuard`), so
    // what reaches the controller is `request.user`, not `request.authContext`.
    const result = await controller.logoutAll(
      { user: { id: 'user-1', sessionId: 'family-1' } } as never,
      res,
    );

    expect(authService.logoutAll).toHaveBeenCalledWith('user-1');
    expect(sessionCookies.clearCookies).toHaveBeenCalledWith(res);
    expect(result).toEqual({ message: 'Logged out of 1 session(s)' });
  });

  it('marks the current session in the sessions list', async () => {
    await controller.sessions({
      user: { id: 'user-1', sessionId: 'family-1' },
    } as never);

    expect(authService.sessions).toHaveBeenCalledWith('user-1', 'family-1');
  });

  it('delegates verifyEmail to the auth service with the query token', async () => {
    const result = await controller.verifyEmail('verification-token');

    expect(authService.verifyEmail).toHaveBeenCalledWith('verification-token');

    expect(result).toEqual({
      message: 'Email verified successfully',
    });
  });

  it('delegates forgotPassword to the auth service', async () => {
    const dto = {
      email: 'test@example.com',
    };

    const result = await controller.forgotPassword(dto);

    expect(authService.forgotPassword).toHaveBeenCalledWith(dto);

    expect(result).toEqual({
      message: 'If an account with that email exists, a reset link was sent',
    });
  });

  it('delegates resetPassword to the auth service', async () => {
    const dto = {
      token: 'reset-token',
      password: 'new-password',
    };

    const result = await controller.resetPassword(dto);

    expect(authService.resetPassword).toHaveBeenCalledWith(dto);

    expect(result).toEqual({
      message: 'Password reset successfully',
    });
  });

  it('delegates getProfile to the auth service with the request user', async () => {
    const result = await controller.getProfile({
      user: {
        id: 'user-1',
      },
    });

    expect(authService.getProfile).toHaveBeenCalledWith('user-1');

    expect(result).toEqual({
      id: 'user-1',
    });
  });

  it('delegates updateProfile to the auth service with the request user', async () => {
    const dto = {
      name: 'Updated Name',
    };

    const result = await controller.updateProfile(
      {
        user: {
          id: 'user-1',
        },
      },
      dto,
    );

    expect(authService.updateProfile).toHaveBeenCalledWith('user-1', dto);

    expect(result).toEqual({
      id: 'user-1',
      name: 'Updated Name',
    });
  });
});
