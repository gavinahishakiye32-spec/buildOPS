import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { ROLE_TEMPLATE_KEYS } from '../../common/permissions.js';

export class CreateInvitationDto {
  @ApiProperty({
    example: 'dev@example.com',
    description:
      'Address the invitation is sent to. Compared in normalized form, so `Dev@Example.com` and `dev@example.com` is the same invitation.',
  })
  @IsEmail()
  @MaxLength(255)
  email: string;

  @ApiPropertyOptional({
    example: 'developer',
    enum: ROLE_TEMPLATE_KEYS,
    description:
      'Fallback role template, used when no `roleId` is given or when the named role is gone by the time the invitation is accepted. Defaults to "viewer", matching POST /organizations/:organizationId/members.',
  })
  @IsOptional()
  @IsString()
  templateKey?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'The role the invitee receives on acceptance: a `roles` row of this organization that nobody holds yet. Naming it here is what lets a role an administrator built travel with the invitation, instead of the invitee receiving whichever built-in template shares its name. Must belong to this organization and must be unassigned.',
  })
  @IsOptional()
  @IsUUID()
  roleId?: string;
}
