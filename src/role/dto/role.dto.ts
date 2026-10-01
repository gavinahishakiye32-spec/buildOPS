import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayNotEmpty,
  IsArray,
  IsEmail,
  IsOptional,
  IsString,
  IsUUID,
  Length,
} from 'class-validator';
import { ALL_PERMISSIONS } from '../../common/permissions.js';

export class CreateRoleDto {
  @ApiProperty({ example: 'Developer', description: 'Role name' })
  @IsString()
  @Length(1, 255)
  name: string;

  @ApiPropertyOptional({
    example: 'Creates and updates development tasks and their own time.',
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({
    type: [String],
    enum: ALL_PERMISSIONS,
    description:
      'Permissions attached to the role. Names come from the permission catalog (GET /organizations/:organizationId/role-templates).',
    example: ['task.create', 'task.update', 'dashboard.view'],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  permissions?: string[];

  @ApiPropertyOptional({
    example: '9a2b7c1d-4e5f-4a6b-8c9d-0e1f2a3b4c5d',
    description: 'Member the role is assigned to (spec §6 assignment step)',
  })
  @IsOptional()
  @IsUUID()
  userId?: string;
}

export class UpdateRoleDto {
  @ApiPropertyOptional({ example: 'Developer' })
  @IsOptional()
  @IsString()
  @Length(1, 255)
  name?: string;

  @ApiPropertyOptional({ example: 'Builds and ships development work.' })
  @IsOptional()
  @IsString()
  description?: string;
}

export class ReplacePermissionsDto {
  @ApiProperty({
    type: [String],
    enum: ALL_PERMISSIONS,
    description: 'Complete permission set the role grants after this call',
    example: ['task.view', 'task.create', 'dashboard.view'],
  })
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  permissions: string[];
}

export class AssignRoleDto {
  @ApiProperty({
    example: '9a2b7c1d-4e5f-4a6b-8c9d-0e1f2a3b4c5d',
    description: 'Member receiving the role',
  })
  @IsUUID()
  userId: string;
}

export class AddMemberDto {
  @ApiPropertyOptional({
    example: '9a2b7c1d-4e5f-4a6b-8c9d-0e1f2a3b4c5d',
    description: 'Existing user id',
  })
  @IsOptional()
  @IsUUID()
  userId?: string;

  @ApiPropertyOptional({
    example: 'dev@example.com',
    description: 'Existing user email, used when userId is omitted',
  })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({
    example: 'developer',
    enum: ['owner', 'project_manager', 'developer', 'tester', 'viewer'],
    description:
      'Default role template to grant. Defaults to "viewer" when neither roleId nor templateKey is given.',
  })
  @IsOptional()
  @IsString()
  templateKey?: string;
}

export class AddMemberFromTemplateDto {
  @ApiProperty({
    example: 'developer',
    enum: ['owner', 'project_manager', 'developer', 'tester', 'viewer'],
    description: 'Default role template to apply',
  })
  @IsString()
  templateKey: string;
}

export class UpdateMemberDto {
  @ApiPropertyOptional({
    example: 'b6f0e2a1-9f2a-4a6f-8f1e-2c9a5b7d1e33',
    description: 'Role the member keeps access through',
  })
  @IsOptional()
  @IsUUID()
  roleId?: string;
}