import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsHexColor, IsOptional, IsString, Length } from 'class-validator';

export class CreateBadgeDto {
  @ApiProperty({ example: 'Regression' })
  @IsString()
  @Length(1, 255)
  name: string;

  @ApiPropertyOptional({ example: 'Introduced by a previous fix.' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({
    example: '#ef4444',
    description: 'Display color as a hex value',
  })
  @IsOptional()
  @IsHexColor()
  @Length(4, 50)
  color?: string;

  @ApiPropertyOptional({ example: 'bug' })
  @IsOptional()
  @IsString()
  @Length(1, 255)
  icon?: string;
}

export class UpdateBadgeDto {
  @ApiPropertyOptional({ example: 'Regression' })
  @IsOptional()
  @IsString()
  @Length(1, 255)
  name?: string;

  @ApiPropertyOptional({ example: 'Introduced by a previous fix.' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ example: '#f97316' })
  @IsOptional()
  @IsHexColor()
  @Length(4, 50)
  color?: string;

  @ApiPropertyOptional({ example: 'alert' })
  @IsOptional()
  @IsString()
  @Length(1, 255)
  icon?: string;
}

export class BadgeResponseDto {
  @ApiProperty({ example: '4c1f5c66-2f9e-4f5c-8b2a-9c0d1e2f3a4b' })
  id: string;

  @ApiProperty({ example: 'b7d8e9f0-1a2b-4c3d-8e4f-5a6b7c8d9e0f' })
  organizationId: string;

  @ApiProperty({ example: 'Regression' })
  name: string;

  @ApiPropertyOptional({ example: 'Introduced by a previous fix.' })
  description: string | null;

  @ApiPropertyOptional({ example: '#ef4444' })
  color: string | null;

  @ApiPropertyOptional({ example: 'bug' })
  icon: string | null;
}

export class BadgeMessageResponseDto {
  @ApiProperty({ example: 'Badge deleted' })
  message: string;
}