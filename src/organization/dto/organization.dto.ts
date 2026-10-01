import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Length } from 'class-validator';
import { ORGANIZATION_STATUSES } from '../../common/enums.js';

export class CreateOrganizationDto {
  @ApiProperty({ example: 'Acme Delivery', description: 'Organization name' })
  @IsString()
  @Length(1, 255)
  name: string;

  @ApiPropertyOptional({
    enum: ORGANIZATION_STATUSES,
    default: 'active',
    description: 'Lifecycle status',
  })
  @IsOptional()
  @IsIn(ORGANIZATION_STATUSES)
  status?: string;
}

export class UpdateOrganizationDto {
  @ApiPropertyOptional({ example: 'Acme Delivery EU' })
  @IsOptional()
  @IsString()
  @Length(1, 255)
  name?: string;

  @ApiPropertyOptional({ enum: ORGANIZATION_STATUSES })
  @IsOptional()
  @IsIn(ORGANIZATION_STATUSES)
  status?: string;
}

export class OrganizationResponseDto {
  @ApiProperty({ example: '4c1f5c66-2f9e-4f5c-8b2a-9c0d1e2f3a4b' })
  id: string;

  @ApiProperty({ example: 'b7d8e9f0-1a2b-4c3d-8e4f-5a6b7c8d9e0f' })
  tenantId: string;

  @ApiProperty({ example: 'Acme Delivery' })
  name: string;

  @ApiProperty({ enum: ORGANIZATION_STATUSES, example: 'active' })
  status: string;

  @ApiProperty({ example: '2026-09-30T10:00:00.000Z' })
  createdAt: Date;
}

export class OrganizationMessageResponseDto {
  @ApiProperty({ example: 'Organization deleted' })
  message: string;
}
