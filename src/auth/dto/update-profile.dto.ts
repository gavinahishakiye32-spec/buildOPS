import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';
import {
  PASSWORD_PATTERN,
  PASSWORD_RULE_MESSAGE,
} from '../../common/password.js';

export class UpdateProfileDto {
  @ApiPropertyOptional({ example: 'Someone' })
  @IsOptional()
  @IsString()
  @Length(1, 255)
  name?: string;

  @ApiPropertyOptional({ example: 'someone@example.com' })
  @IsOptional()
  @IsEmail()
  @MaxLength(255)
  email?: string;

  @ApiPropertyOptional({ example: 'active', enum: ['active', 'inactive'] })
  @IsOptional()
  @IsIn(['active', 'inactive'])
  status?: string;

  @ApiPropertyOptional({
    example: 'Someone123!',
    description: 'New password. Requires the current password.',
  })
  @IsOptional()
  @Matches(PASSWORD_PATTERN, { message: PASSWORD_RULE_MESSAGE })
  password?: string;

  @ApiPropertyOptional({
    example: 'Someone123!',
    description: 'Current password, required when changing the password.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  currentPassword?: string;
}
