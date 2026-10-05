import {
  Controller,
  Post,
  Get,
  Patch,
  Body,
  Query,
  Request,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request as HttpRequest, Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import {
  ApiErrors,
  ApiRateLimited,
} from '../common/decorators/api-errors.decorator.js';
import { ErrorResponseDto } from '../common/dto/error-response.dto.js';
import { AuthService } from './auth.service.js';
import { RegisterDto } from './dto/register.dto.js';
import { LoginDto } from './dto/login.dto.js';
import { ForgotPasswordDto } from './dto/forgot-password.dto.js';
import { ResetPasswordDto } from './dto/reset-password.dto.js';
import { UpdateProfileDto } from './dto/update-profile.dto.js';
import { BearerProfile } from '../common/decorators/protected.decorator.js';
import {
  RegisterResponseDto,
  LoginResponseDto,
  MessageResponseDto,
  SessionResponseDto,
  UserResponseDto,
} from './dto/response.dto.js';
import {
  assertCsrfToken,
  clientOf,
  readRefreshToken,
  SessionCookies,
} from './session-cookies.js';
import type { AuthenticatedRequest } from '../common/types.js';

@ApiRateLimited()
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly sessionCookies: SessionCookies,
  ) {}

  @Post('register')
  @Throttle({ auth: { limit: 5, ttl: 900000 } })
  @ApiOperation({
    summary: 'Register a new user',
    description:
      'Creates a user account and triggers a verification email. No access token is issued until the email is verified.',
  })
  @ApiResponse({
    status: 201,
    description: 'User created, no token until verified',
    type: RegisterResponseDto,
  })
  @ApiErrors(400)
  @ApiResponse({
    status: 409,
    description: 'Email already registered',
    type: ErrorResponseDto,
  })
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Post('login')
  @Throttle({ auth: { limit: 10, ttl: 900000 } })
  @ApiOperation({
    summary: 'Login',
    description:
      'Authenticates a user and returns a JWT access token, and sets an httpOnly refresh cookie. Requires the email to be verified; unverified users are rejected with 403 and receive a fresh verification link.',
  })
  @ApiResponse({
    status: 201,
    description: 'JWT access token returned',
    type: LoginResponseDto,
  })
  @ApiErrors(400)
  @ApiResponse({
    status: 401,
    description: 'Invalid credentials',
    type: ErrorResponseDto,
  })
  @ApiResponse({
    status: 403,
    description:
      'Email not verified. A fresh verification link is sent on every attempt.',
    type: ErrorResponseDto,
  })
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
    @Request() req: HttpRequest,
  ) {
    const session = await this.authService.login(dto, clientOf(req));
    this.sessionCookies.writeCookies(res, session.session);

    return { access_token: session.access_token };
  }

  @Post('refresh')
  @Throttle({ auth: { limit: 60, ttl: 900000 } })
  @ApiOperation({
    summary: 'Refresh the access token',
    description:
      'Exchanges the httpOnly refresh cookie for a fresh access token and a fresh refresh cookie. The presented token is single-use: it is revoked as the new one is issued, and presenting it a second time is treated as a replay and ends the whole session, requiring a new login. Send the `csrf` cookie value in the `x-csrf-token` header.',
  })
  @ApiResponse({
    status: 201,
    description: 'New access token issued',
    type: LoginResponseDto,
  })
  @ApiResponse({
    status: 401,
    description:
      'The refresh cookie is missing, expired, revoked, or was replayed. The session has been ended; log in again.',
    type: ErrorResponseDto,
  })
  @ApiResponse({
    status: 403,
    description: 'CSRF header missing or not matching the csrf cookie',
    type: ErrorResponseDto,
  })
  async refresh(
    @Res({ passthrough: true }) res: Response,
    @Request() req: HttpRequest,
  ) {
    const token = readRefreshToken(req);
    assertCsrfToken(req);

    if (!token) {
      throw new UnauthorizedException(
        'Session expired or revoked. Please log in again.',
      );
    }

    const session = await this.authService.refresh(token, clientOf(req));
    this.sessionCookies.writeCookies(res, session.session);

    return { access_token: session.access_token };
  }

  @Post('logout')
  @ApiOperation({
    summary: 'Log out of this session',
    description:
      'Revokes the session behind the refresh cookie and clears it. The access token already in the client is also rejected from the next request onwards, because it carries the session id. Idempotent: succeeds with no cookie present. Send the `csrf` cookie value in the `x-csrf-token` header.',
  })
  @ApiResponse({
    status: 201,
    description: 'Session ended',
    type: MessageResponseDto,
  })
  @ApiResponse({
    status: 403,
    description: 'CSRF header missing or not matching the csrf cookie',
    type: ErrorResponseDto,
  })
  async logout(
    @Res({ passthrough: true }) res: Response,
    @Request() req: HttpRequest,
  ) {
    const token = readRefreshToken(req);

    // The CSRF check is conditional on there being something to revoke.
    //
    // With a session cookie present, this endpoint destroys state, so a
    // cross-site POST must not be able to end somebody's session for them --
    // that check is the whole reason it is here. With no session cookie there is
    // nothing to destroy, and demanding a CSRF token to do nothing would turn a
    // signed-out page's teardown call into a 403.
    if (token) {
      assertCsrfToken(req);
    }

    const result = await this.authService.logout(token);
    this.sessionCookies.clearCookies(res);

    return result;
  }

  @BearerProfile()
  @Post('logout-all')
  @ApiOperation({
    summary: 'Log out of every session',
    description:
      'Revokes all sessions for the authenticated user, on every device, and clears the refresh cookie. Use this after a password change, or whenever the account may be compromised. Access tokens issued before the call stop being accepted immediately.',
  })
  @ApiResponse({
    status: 201,
    description: 'Every session ended',
    type: MessageResponseDto,
  })
  async logoutAll(
    @Request() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.logoutAll(req.user.id);
    this.sessionCookies.clearCookies(res);

    return result;
  }

  @BearerProfile()
  @Get('sessions')
  @ApiOperation({
    summary: 'List active sessions',
    description:
      'Returns the live sessions for the authenticated user, one entry per device, with `isCurrent` marking the one making the request. Revoked and expired sessions are omitted.',
  })
  @ApiResponse({
    status: 200,
    description: 'Active sessions, one per device, newest first',
    type: [SessionResponseDto],
  })
  sessions(@Request() req: AuthenticatedRequest) {
    // Read from `request.user`, not `@Auth()`: this route uses `BearerProfile()`,
    // which runs the JWT guard but not `PermissionsGuard`, and `authContext` is
    // the latter's output. `request.user.sessionId` is set by the strategy, which
    // has already confirmed the session is still alive.
    return this.authService.sessions(req.user.id, req.user.sessionId);
  }

  @Get('verify-email')
  @Throttle({ auth: { limit: 20, ttl: 900000 } })
  @ApiOperation({
    summary: 'Verify email',
    description:
      'Verifies the email address via a token sent by email. Returns an already-verified message if the email is already verified.',
  })
  @ApiQuery({
    name: 'token',
    required: true,
    description:
      'Verification token received by email. The frontend should read `?token=` and call this endpoint.',
  })
  @ApiResponse({
    status: 200,
    description: 'Email verified successfully / Email already verified',
    type: MessageResponseDto,
  })
  @ApiResponse({
    status: 400,
    description:
      'Missing, invalid or expired verification token. Tokens expire 24 h after they are issued and are single-use.',
    type: ErrorResponseDto,
  })
  verifyEmail(@Query('token') token: string) {
    return this.authService.verifyEmail(token);
  }

  @Post('forgot-password')
  @Throttle({ auth: { limit: 5, ttl: 900000 } })
  @ApiOperation({
    summary: 'Request password reset',
    description:
      'Sends a password reset link by email. Always responds with the same success message whether or not the account exists.',
  })
  @ApiResponse({
    status: 201,
    description: 'Reset link sent',
    type: MessageResponseDto,
  })
  @ApiErrors(400)
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto);
  }

  @Post('reset-password')
  @Throttle({ auth: { limit: 5, ttl: 900000 } })
  @ApiOperation({
    summary: 'Reset password',
    description: 'Resets the password using a token received by email.',
  })
  @ApiResponse({
    status: 201,
    description: 'Password reset successfully',
    type: MessageResponseDto,
  })
  @ApiResponse({
    status: 400,
    description:
      'Invalid or expired reset token, or the new password breaks the password rules. Reset tokens expire 1 h after they are issued.',
    type: ErrorResponseDto,
  })
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto);
  }

  @BearerProfile()
  @Get('profile')
  @ApiOperation({
    summary: 'Get current user profile',
    description: 'Returns the profile of the authenticated user.',
  })
  @ApiResponse({
    status: 200,
    description: 'Current user profile',
    type: UserResponseDto,
  })
  getProfile(@Request() req: { user: { id: string } }) {
    return this.authService.getProfile(req.user.id);
  }

  @BearerProfile()
  @Patch('profile')
  @ApiOperation({
    summary: 'Update current user profile',
    description:
      'Updates the name and/or email of the authenticated user. Changing the email resets verification and sends a fresh verification link.',
  })
  @ApiResponse({
    status: 200,
    description: 'Updated user profile',
    type: UserResponseDto,
  })
  @ApiResponse({
    status: 400,
    description:
      'Invalid field value, an unsupported status, a `password` sent without `currentPassword`, or a wrong `currentPassword`.',
    type: ErrorResponseDto,
  })
  @ApiResponse({
    status: 409,
    description: 'The new email already belongs to another account',
    type: ErrorResponseDto,
  })
  updateProfile(
    @Request() req: { user: { id: string } },
    @Body() dto: UpdateProfileDto,
  ) {
    return this.authService.updateProfile(req.user.id, dto);
  }
}
