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
import { SELF_EDITABLE_USER_STATUSES } from '../../common/enums.js';

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

  @ApiPropertyOptional({
    example: 'active',
    enum: SELF_EDITABLE_USER_STATUSES,
  })
  @IsOptional()
  @IsIn(SELF_EDITABLE_USER_STATUSES)
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
