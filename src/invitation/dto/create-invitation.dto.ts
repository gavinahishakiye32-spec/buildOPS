import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, MaxLength } from 'class-validator';
import { ROLE_TEMPLATE_KEYS } from '../../common/permissions.js';

export class CreateInvitationDto {
  @ApiProperty({
    example: 'dev@example.com',
    description:
      'Address the invitation is sent to. Compared in normalized form, so `Dev@Example.com` and `dev@example.com` are the same invitation.',
  })
  @IsEmail()
  @MaxLength(255)
  email: string;

  @ApiPropertyOptional({
    example: 'developer',
    enum: ROLE_TEMPLATE_KEYS,
    description:
      'Default role template the invitee receives when they accept. Defaults to "viewer", matching POST /organizations/:organizationId/members.',
  })
  @IsOptional()
  @IsString()
  templateKey?: string;
}
