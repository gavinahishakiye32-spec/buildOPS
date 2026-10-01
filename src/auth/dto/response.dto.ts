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
      'Whether the email has been verified. Example reflects the recorded state of someone@gmail.com, which is verified in this system.',
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
}

export class LoginResponseDto {
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