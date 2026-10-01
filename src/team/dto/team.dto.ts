import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
} from 'class-validator';
import {
  TEAM_MEMBER_ROLES,
  TEAM_MEMBER_STATUSES,
  TEAM_STATUSES,
} from '../../common/enums.js';

export class CreateTeamDto {
  @ApiProperty({ example: 'Backend Guild' })
  @IsString()
  @Length(1, 255)
  name: string;

  @ApiPropertyOptional({ example: 'Services and integrations squad.' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ enum: TEAM_STATUSES, default: 'active' })
  @IsOptional()
  @IsIn(TEAM_STATUSES)
  status?: string;
}

export class UpdateTeamDto {
  @ApiPropertyOptional({ example: 'Platform Guild' })
  @IsOptional()
  @IsString()
  @Length(1, 255)
  name?: string;

  @ApiPropertyOptional({ example: 'Platform and infrastructure squad.' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ enum: TEAM_STATUSES })
  @IsOptional()
  @IsIn(TEAM_STATUSES)
  status?: string;
}

export class AddTeamMemberDto {
  @ApiPropertyOptional({
    example: '9a2b7c1d-4e5f-4a6b-8c9d-0e1f2a3b4c5d',
    description: 'Existing organization member (by id)',
  })
  @IsOptional()
  @IsUUID()
  userId?: string;

  @ApiPropertyOptional({
    example: 'dev@example.com',
    description: 'Existing organization member (by email)',
  })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({
    enum: TEAM_MEMBER_ROLES,
    default: 'member',
    description: 'Team-scoped role (never an organization-level access source)',
  })
  @IsOptional()
  @IsIn(TEAM_MEMBER_ROLES)
  role?: string;

  @ApiPropertyOptional({
    enum: TEAM_MEMBER_STATUSES,
    default: 'active',
    description: 'Membership status',
  })
  @IsOptional()
  @IsIn(TEAM_MEMBER_STATUSES)
  status?: string;
}

export class UpdateTeamMemberDto {
  @ApiPropertyOptional({ enum: TEAM_MEMBER_ROLES })
  @IsOptional()
  @IsIn(TEAM_MEMBER_ROLES)
  role?: string;

  @ApiPropertyOptional({ enum: TEAM_MEMBER_STATUSES })
  @IsOptional()
  @IsIn(TEAM_MEMBER_STATUSES)
  status?: string;
}

export class TeamResponseDto {
  @ApiProperty({ example: '4c1f5c66-2f9e-4f5c-8b2a-9c0d1e2f3a4b' })
  id: string;

  @ApiProperty({ example: 'b7d8e9f0-1a2b-4c3d-8e4f-5a6b7c8d9e0f' })
  organizationId: string;

  @ApiProperty({ example: 'Backend Guild' })
  name: string;

  @ApiPropertyOptional({ example: 'Services and integrations squad.' })
  description: string | null;

  @ApiProperty({ enum: TEAM_STATUSES, example: 'active' })
  status: string;

  @ApiProperty({ example: '2026-09-30T10:00:00.000Z' })
  createdAt: Date;
}

export class TeamMemberResponseDto {
  @ApiProperty({ example: '7e8f9a0b-1c2d-4e3f-8a4b-5c6d7e8f9a0b' })
  id: string;

  @ApiProperty({ example: '4c1f5c66-2f9e-4f5c-8b2a-9c0d1e2f3a4b' })
  teamId: string;

  @ApiProperty({ example: '9a2b7c1d-4e5f-4a6b-8c9d-0e1f2a3b4c5d' })
  userId: string;

  @ApiPropertyOptional({
    type: 'object',
    nullable: true,
    properties: {
      id: { type: 'string' },
      name: { type: 'string', nullable: true },
      email: { type: 'string' },
    },
  })
  user: { id: string; name: string | null; email: string } | null;

  @ApiProperty({ enum: TEAM_MEMBER_ROLES, example: 'member' })
  role: string;

  @ApiProperty({ enum: TEAM_MEMBER_STATUSES, example: 'active' })
  status: string;

  @ApiProperty({ example: '2026-09-30T10:00:00.000Z' })
  joinedAt: Date;
}

export class TeamMessageResponseDto {
  @ApiProperty({ example: 'Team deleted' })
  message: string;
}
