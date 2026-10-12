import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Length } from 'class-validator';
import {
  DEFAULT_ORGANIZATION_CURRENCY,
  ORGANIZATION_CURRENCIES,
  ORGANIZATION_STATUSES,
} from '../../common/enums.js';

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

  /**
   * Optional so an existing client keeps working unchanged: a caller that does
   * not send it gets `DEFAULT_ORGANIZATION_CURRENCY`, which is the currency its
   * amounts have always been read in.
   */
  @ApiPropertyOptional({
    enum: ORGANIZATION_CURRENCIES,
    default: DEFAULT_ORGANIZATION_CURRENCY,
    example: 'RWF',
    description:
      'ISO 4217 code the amounts in this organization are read in. Asked once ' +
      'when the organization is created and shared by every member. Choosing it ' +
      'does not convert any amount already stored.',
  })
  @IsOptional()
  @IsIn(ORGANIZATION_CURRENCIES)
  currency?: string;
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

  @ApiProperty({
    enum: ORGANIZATION_CURRENCIES,
    example: 'RWF',
    description:
      'ISO 4217 code this organization reads its amounts in. Carried on every ' +
      'response so a client can format money without a second request.',
  })
  currency: string;

  @ApiProperty({ example: '2026-09-30T10:00:00.000Z' })
  createdAt: Date;
}

export class OrganizationMessageResponseDto {
  @ApiProperty({ example: 'Organization deleted' })
  message: string;
}
