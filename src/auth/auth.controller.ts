import {
  Controller,
  Post,
  Get,
  Patch,
  Body,
  Query,
  UseGuards,
  Request,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiQuery,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { AuthService } from './auth.service.js';
import { RegisterDto } from './dto/register.dto.js';
import { LoginDto } from './dto/login.dto.js';
import { ForgotPasswordDto } from './dto/forgot-password.dto.js';
import { ResetPasswordDto } from './dto/reset-password.dto.js';
import { UpdateProfileDto } from './dto/update-profile.dto.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import {
  RegisterResponseDto,
  LoginResponseDto,
  MessageResponseDto,
  UserResponseDto,
} from './dto/response.dto.js';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @Throttle({ auth: { limit: 5, ttl: 900000 } })
  @ApiOperation({ summary: 'Register a new user', description: 'Creates a user account and triggers a verification email. No access token is issued until the email is verified.' })
  @ApiResponse({ status: 201, description: 'User created, no token until verified', type: RegisterResponseDto })
  @ApiResponse({ status: 409, description: 'Email already registered' })
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Post('login')
  @Throttle({ auth: { limit: 10, ttl: 900000 } })
  @ApiOperation({ summary: 'Login', description: 'Authenticates a user and returns a JWT access token. Requires the email to be verified; unverified users are rejected with 403 and receive a fresh verification link.' })
  @ApiResponse({ status: 201, description: 'JWT access token returned', type: LoginResponseDto })
  @ApiResponse({ status: 401, description: 'Invalid credentials' })
  @ApiResponse({ status: 403, description: 'Email not verified' })
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Get('verify-email')
  @Throttle({ auth: { limit: 20, ttl: 900000 } })
  @ApiOperation({ summary: 'Verify email', description: 'Verifies the email address via a token sent by email. Returns an already-verified message if the email is already verified.' })
  @ApiQuery({ name: 'token', required: true, description: 'Verification token received by email (printed to the server console)' })
  @ApiResponse({ status: 200, description: 'Email verified successfully / Email already verified', type: MessageResponseDto })
  @ApiResponse({ status: 400, description: 'Invalid or expired verification token' })
  verifyEmail(@Query('token') token: string) {
    return this.authService.verifyEmail(token);
  }

  @Post('forgot-password')
  @Throttle({ auth: { limit: 5, ttl: 900000 } })
  @ApiOperation({ summary: 'Request password reset', description: 'Sends a password reset link by email. Always responds with the same success message whether or not the account exists.' })
  @ApiResponse({ status: 201, description: 'Reset link sent', type: MessageResponseDto })
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto);
  }

  @Post('reset-password')
  @Throttle({ auth: { limit: 5, ttl: 900000 } })
  @ApiOperation({ summary: 'Reset password', description: 'Resets the password using a token received by email.' })
  @ApiResponse({ status: 201, description: 'Password reset successfully', type: MessageResponseDto })
  @ApiResponse({ status: 400, description: 'Invalid or expired reset token' })
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('profile')
  @ApiOperation({ summary: 'Get current user profile', description: 'Returns the profile of the authenticated user.' })
  @ApiResponse({ status: 200, description: 'Current user profile', type: UserResponseDto })
  @ApiResponse({ status: 401, description: 'Missing or invalid token' })
  getProfile(@Request() req: { user: { id: string } }) {
    return this.authService.getProfile(req.user.id);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Patch('profile')
  @ApiOperation({ summary: 'Update current user profile', description: 'Updates the name and/or email of the authenticated user. Changing the email resets verification and sends a fresh verification link.' })
  @ApiResponse({ status: 200, description: 'Updated user profile', type: UserResponseDto })
  @ApiResponse({ status: 400, description: 'Invalid profile update or current password' })
  @ApiResponse({ status: 401, description: 'Missing or invalid token' })
  @ApiResponse({ status: 409, description: 'Email already registered' })
  updateProfile(
    @Request() req: { user: { id: string } },
    @Body() dto: UpdateProfileDto,
  ) {
    return this.authService.updateProfile(req.user.id, dto);
  }
}
