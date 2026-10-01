import { Test } from '@nestjs/testing';
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';

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
  };

  const accessToken = {
    access_token: 'signed-token',
  };

  beforeEach(async () => {
    authService = {
      register: jest.fn(async () => accessToken),

      login: jest.fn(async () => accessToken),

      verifyEmail: jest.fn(async () => ({
        message: 'Email verified successfully',
      })),

      forgotPassword: jest.fn(async () => ({
        message:
          'If an account with that email exists, a reset link was sent',
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
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        {
          provide: AuthService,
          useValue: authService,
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

  it('delegates login to the auth service', async () => {
    const dto = {
      email: 'test@example.com',
      password: 'password123',
    };

    const result = await controller.login(dto);

    expect(authService.login).toHaveBeenCalledWith(dto);
    expect(result).toBe(accessToken);
  });

  it('delegates verifyEmail to the auth service with the query token', async () => {
    const result = await controller.verifyEmail('verification-token');

    expect(authService.verifyEmail).toHaveBeenCalledWith(
      'verification-token',
    );

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
      message:
        'If an account with that email exists, a reset link was sent',
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

    expect(authService.updateProfile).toHaveBeenCalledWith(
      'user-1',
      dto,
    );

    expect(result).toEqual({
      id: 'user-1',
      name: 'Updated Name',
    });
  });
});
