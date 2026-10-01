import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { PermissionName } from '../../common/permissions.js';

export class PermissionResponseDto {
  @ApiProperty({ example: 'p1a2b3c4-5d6e-4f70-8a91-b2c3d4e5f607' })
  id: string;

  @ApiProperty({ example: '3e4f5a6b-7c8d-4e9f-8a0b-1c2d3e4f5a6b' })
  roleId: string;

  @ApiProperty({ example: 'task.create', description: 'Permission name' })
  name: string;

  @ApiPropertyOptional({ example: 'Create tasks' })
  description: string | null;

  @ApiProperty({ example: '2026-09-30T10:00:00.000Z' })
  createdAt: Date;
}

export class RoleResponseDto {
  @ApiProperty({ example: 'b6f0e2a1-9f2a-4a6f-8f1e-2c9a5b7d1e33' })
  id: string;

  @ApiProperty({ example: '4c1f5c66-2f9e-4f5c-8b2a-9c0d1e2f3a4b' })
  organizationId: string;

  @ApiPropertyOptional({
    example: '9a2b7c1d-4e5f-4a6b-8c9d-0e1f2a3b4c5d',
    description: 'Assigned member; null while the role is unassigned',
  })
  userId: string | null;

  @ApiProperty({ example: 'Developer' })
  name: string;

  @ApiPropertyOptional({ example: 'Creates and updates development work.' })
  description: string | null;

  @ApiProperty({ type: [PermissionResponseDto] })
  permissions: PermissionResponseDto[];

  @ApiProperty({ example: '2026-09-30T10:00:00.000Z' })
  createdAt: Date;

  @ApiProperty({ example: '2026-09-30T10:00:00.000Z' })
  updatedAt: Date;
}

export class MemberResponseDto {
  @ApiProperty({ example: '9a2b7c1d-4e5f-4a6b-8c9d-0e1f2a3b4c5d' })
  userId: string;

  @ApiProperty({ example: 'dev@example.com' })
  email: string;

  @ApiPropertyOptional({ example: 'Dana' })
  name: string | null;

  @ApiProperty({ example: 'b6f0e2a1-9f2a-4a6f-8f1e-2c9a5b7d1e33' })
  roleId: string;

  @ApiProperty({ example: 'Developer' })
  roleName: string;

  @ApiProperty({ type: [String], example: ['task.create', 'dashboard.view'] })
  permissions: PermissionName[];
}

export class RoleTemplateDto {
  @ApiProperty({ example: 'developer' })
  key: string;

  @ApiProperty({ example: 'Developer' })
  name: string;

  @ApiProperty({ example: 'Creates and updates development tasks.' })
  description: string;

  @ApiProperty({ type: [String], description: 'Permissions the template grants' })
  permissions: PermissionName[];
}

export class RoleMessageResponseDto {
  @ApiProperty({ example: 'Role deleted' })
  message: string;
}