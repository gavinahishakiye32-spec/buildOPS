import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  PASSWORD_PATTERN,
  PASSWORD_RULE_MESSAGE,
} from '../../common/password.js';

export class RegisterDto {
  @ApiProperty({ example: 'someone@gmail.com', description: 'Email address' })
  @IsEmail()
  @MaxLength(255)
  email: string;

  @ApiProperty({
    example: 'Someone123!',
    minLength: 8,
    description: 'At least 8 characters with one letter and one number',
  })
  @IsString()
  @MinLength(8)
  @Matches(PASSWORD_PATTERN, { message: PASSWORD_RULE_MESSAGE })
  password: string;

  @ApiPropertyOptional({ example: 'Someone' })
  @IsOptional()
  @IsString()
  @Length(1, 255)
  name?: string;
}
