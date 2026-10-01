import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  IsUrl,
  Length,
} from 'class-validator';
import { CLIENT_STATUSES } from '../../common/enums.js';

export class CreateClientDto {
  @ApiProperty({ example: 'Globex Corporation' })
  @IsString()
  @Length(1, 255)
  name: string;

  @ApiPropertyOptional({
    example: 'contact@globex.com',
    description: 'Contact email; unique at database level (spec §16)',
  })
  @IsOptional()
  @IsEmail()
  @Length(3, 255)
  email?: string;

  @ApiPropertyOptional({ example: '+1 555 0100' })
  @IsOptional()
  @IsString()
  @Length(1, 50)
  phone?: string;

  @ApiPropertyOptional({ example: 'Manufacturing' })
  @IsOptional()
  @IsString()
  @Length(1, 100)
  industry?: string;

  @ApiPropertyOptional({ example: 'https://globex.com' })
  @IsOptional()
  @IsUrl({ require_tld: false })
  @Length(1, 255)
  website?: string;

  @ApiPropertyOptional({ enum: CLIENT_STATUSES, default: 'active' })
  @IsOptional()
  @IsIn(CLIENT_STATUSES)
  status?: string;
}

export class UpdateClientDto {
  @ApiPropertyOptional({ example: 'Globex Corporation' })
  @IsOptional()
  @IsString()
  @Length(1, 255)
  name?: string;

  @ApiPropertyOptional({ example: 'new-contact@globex.com' })
  @IsOptional()
  @IsEmail()
  @Length(3, 255)
  email?: string;

  @ApiPropertyOptional({ example: '+1 555 0199' })
  @IsOptional()
  @IsString()
  @Length(1, 50)
  phone?: string;

  @ApiPropertyOptional({ example: 'Logistics' })
  @IsOptional()
  @IsString()
  @Length(1, 100)
  industry?: string;

  @ApiPropertyOptional({ example: 'https://globex.com' })
  @IsOptional()
  @IsUrl({ require_tld: false })
  @Length(1, 255)
  website?: string;

  @ApiPropertyOptional({ enum: CLIENT_STATUSES })
  @IsOptional()
  @IsIn(CLIENT_STATUSES)
  status?: string;
}

export class ClientResponseDto {
  @ApiProperty({ example: '4c1f5c66-2f9e-4f5c-8b2a-9c0d1e2f3a4b' })
  id: string;

  @ApiProperty({ example: 'b7d8e9f0-1a2b-4c3d-8e4f-5a6b7c8d9e0f' })
  organizationId: string;

  @ApiProperty({ example: 'Globex Corporation' })
  name: string;

  @ApiPropertyOptional({ example: 'contact@globex.com' })
  email: string | null;

  @ApiPropertyOptional({ example: '+1 555 0100' })
  phone: string | null;

  @ApiPropertyOptional({ example: 'Manufacturing' })
  industry: string | null;

  @ApiPropertyOptional({ example: 'https://globex.com' })
  website: string | null;

  @ApiProperty({ enum: CLIENT_STATUSES, example: 'active' })
  status: string;
}

export class ClientMessageResponseDto {
  @ApiProperty({ example: 'Client deleted' })
  message: string;
}