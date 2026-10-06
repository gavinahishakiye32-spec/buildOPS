import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { INVITATION_STATUSES } from '../../common/enums.js';
import type { PermissionName } from '../../common/permissions.js';

/** One invitation as the organization endpoints report it. */
export class InvitationResponseDto {
  @ApiProperty({ example: '3f1d0a2c-6b1e-4a86-9f7a-1c2b3d4e5f60' })
  id: string;

  @ApiProperty({ example: '9a2b7c1d-4e5f-4a6b-8c9d-0e1f2a3b4c5d' })
  organizationId: string;

  @ApiProperty({ example: 'dev@example.com' })
  email: string;

  @ApiProperty({ example: 'developer' })
  templateKey: string;

  @ApiProperty({ example: 'Developer' })
  roleName: string;

  @ApiProperty({
    enum: INVITATION_STATUSES,
    example: 'pending',
    description:
      'Lifecycle of the invitation. `expired` is never stored: a pending row whose `expiresAt` has passed reports `expired` on read, so nothing has to sweep the table.',
  })
  status: string;

  @ApiProperty({
    example: '2026-10-13T09:00:00.000Z',
    description: 'When the token stops being acceptable. Seven days after issue.',
  })
  expiresAt: Date;

  @ApiPropertyOptional({
    example: '9a2b7c1d-4e5f-4a6b-8c9d-0e1f2a3b4c5d',
    description: 'The member who sent the invitation.',
  })
  invitedBy: string | null;

  @ApiPropertyOptional({
    example: '2026-10-06T09:00:00.000Z',
    description: 'When the invitation was accepted.',
  })
  acceptedAt: Date | null;

  @ApiProperty({ example: '2026-10-06T09:00:00.000Z' })
  createdAt: Date;
}

/**
 * The invitation as `POST /organizations/:organizationId/invitations` returns
 * it, plus the fields a local flow needs outside production.
 */
export class CreateInvitationResponseDto extends InvitationResponseDto {
  @ApiPropertyOptional({
    description:
      'The raw invitation token. Absent in production, where the token exists only in the email it was hashed from.',
  })
  invitationToken?: string;

  @ApiPropertyOptional({
    description:
      'The link that was emailed, ready to open. Absent in production.',
  })
  invitationLink?: string;

  @ApiPropertyOptional({
    description:
      'Whether the send completed while the request waited. Outside production only.',
  })
  emailSent?: boolean;

  @ApiPropertyOptional({
    description: 'Why the send failed, when it did. Outside production only.',
  })
  emailError?: string;
}

/** What `GET /invitations/accept?token=` reveals before anything is changed. */
export class InvitationPreviewResponseDto {
  @ApiProperty({ example: 'dev@example.com' })
  email: string;

  @ApiProperty({ example: '9a2b7c1d-4e5f-4a6b-8c9d-0e1f2a3b4c5d' })
  organizationId: string;

  @ApiProperty({ example: 'Globex' })
  organizationName: string;

  @ApiProperty({ example: 'Developer' })
  roleName: string;

  @ApiProperty({
    type: [String],
    example: ['task.create', 'dashboard.view'],
    description: 'The permissions the role grants once the invitation is accepted.',
  })
  permissions: PermissionName[];

  @ApiProperty({
    enum: INVITATION_STATUSES,
    example: 'pending',
  })
  status: string;

  @ApiProperty({ example: '2026-10-13T09:00:00.000Z' })
  expiresAt: Date;

  @ApiProperty({
    type: Boolean,
    example: false,
    description:
      'Whether an account already exists for this address. False is the answer that makes the next step ask for a name and a password.',
  })
  accountExists: boolean;
}

/** What accepting an invitation hands to the caller. */
export class AcceptInvitationResponseDto {
  @ApiProperty({ example: 'Invitation accepted' })
  message: string;

  @ApiProperty({ example: '9a2b7c1d-4e5f-4a6b-8c9d-0e1f2a3b4c5d' })
  organizationId: string;

  @ApiProperty({ example: 'Globex' })
  organizationName: string;

  @ApiProperty({ example: 'b6f0e2a1-9f2a-4a6f-8f1e-2c9a5b7d1e33' })
  roleId: string;

  @ApiProperty({ example: 'Developer' })
  roleName: string;

  @ApiProperty({
    type: [String],
    example: ['task.create', 'dashboard.view'],
  })
  permissions: PermissionName[];
}
