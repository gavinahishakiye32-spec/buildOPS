import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class UserResponseDto {
  @ApiProperty({ example: '2555ee7d-be5d-473d-a481-2488bf329544' })
  id: string;

  @ApiPropertyOptional({ example: null })
  organizationId: string | null;

  @ApiProperty({ example: 'someone@gmail.com' })
  email: string;

  @ApiPropertyOptional({ example: 'Someone' })
  name: string | null;

  @ApiPropertyOptional({ example: 'active' })
  status: string | null;

  @ApiProperty({
    example: true,
    description:
      'Whether the email address has been confirmed. False right after registration, true after GET /auth/verify-email.',
  })
  isVerified: boolean;

  @ApiProperty({ example: '2026-09-18T11:11:22.041Z' })
  createdAt: Date;

  @ApiProperty({ example: '2026-09-18T11:29:09.099Z' })
  updatedAt: Date;
}

export class RegisterResponseDto {
  @ApiProperty({
    example:
      'Registration successful. Please verify your email before logging in.',
  })
  message: string;

  @ApiProperty({ type: UserResponseDto })
  user: UserResponseDto;

  /**
   * The three fields below exist outside production only (NODE_ENV !==
   * 'production'), where they let a local flow be driven without a working
   * SMTP server. A production response never contains a token: there it lives
   * only in the email.
   */
  @ApiPropertyOptional({
    description:
      'Raw verification token. Present outside production only; the same value is hashed at rest and delivered by email.',
    example: '3f2a1b8c9d0e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a',
  })
  verificationToken?: string;

  @ApiPropertyOptional({
    description:
      'The full verification link, ready to open. Present outside production only.',
    example: 'http://localhost:3000/api/v1/auth/verify-email?token=3f2a1b8c…',
  })
  verificationLink?: string;

  @ApiPropertyOptional({
    description:
      'Whether the verification email was actually handed to the SMTP server. Present outside production only; production sends are fire-and-forget and logged instead.',
    example: true,
  })
  emailSent?: boolean;

  @ApiPropertyOptional({
    description:
      'Why the send failed, when `emailSent` is false. Present outside production only.',
    example: 'Failed to send email: SMTP connection failed',
  })
  emailError?: string;
}

export class ForgotPasswordResponseDto {
  @ApiProperty({
    example: 'If an account with that email exists, a reset link was sent',
  })
  message: string;

  /** Present outside production only, and only for an existing account. */
  @ApiPropertyOptional({
    description:
      'Raw reset token. Present outside production only, for an existing account; never for an unknown email, which keeps the response indistinguishable.',
    example: '9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c',
  })
  resetToken?: string;

  @ApiPropertyOptional({
    description:
      'The full reset link, ready to open. Present outside production only.',
    example: 'http://localhost:3000/api/v1/auth/reset-password?token=9b8c7d6e…',
  })
  resetLink?: string;

  @ApiPropertyOptional({
    description:
      'Whether the reset email was actually handed to the SMTP server. Present outside production only.',
    example: true,
  })
  emailSent?: boolean;

  @ApiPropertyOptional({
    description:
      'Why the send failed, when `emailSent` is false. Present outside production only.',
    example: 'Failed to send email: SMTP connection failed',
  })
  emailError?: string;
}

export class LoginResponseDto {
  /**
   * snake_case, unlike every other field in the API. Published this way from
   * the start and documented in the frontend guide, so renaming it would be a
   * breaking change for existing clients.
   */
  @ApiProperty({
    example:
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIiwiaWF0IjoxNTAwMDAwMDAwLCJleHAiOjE1MDAwMDAwMDB9.example',
  })
  access_token: string;
}

export class MessageResponseDto {
  @ApiProperty({ example: 'Operation completed successfully' })
  message: string;
}

/** One live session, as shown on a "where am I signed in" screen. */
export class SessionResponseDto {
  @ApiProperty({
    description: 'Session id. Matches the `sid` claim of the current access token.',
  })
  id: string;

  @ApiProperty({
    description: 'User agent of the client that created the session, as reported by that client.',
    nullable: true,
    type: String,
  })
  userAgent: string | null;

  @ApiProperty({
    description: 'IP the session was created from, or null when it could not be determined.',
    nullable: true,
    type: String,
  })
  ip: string | null;

  @ApiProperty({ description: 'When this device signed in.' })
  createdAt: string;

  @ApiProperty({
    description:
      'When this session stops being refreshable. Absolute, not sliding: a session does not extend itself by being used.',
  })
  expiresAt: string;

  @ApiProperty({ description: 'True for the session making this request.' })
  isCurrent: boolean;
}
