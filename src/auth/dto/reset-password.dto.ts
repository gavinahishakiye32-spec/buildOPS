import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';
import {
  PASSWORD_PATTERN,
  PASSWORD_RULE_MESSAGE,
} from '../../common/password.js';

export class ResetPasswordDto {
  @ApiProperty({
    description: 'Password reset token received by email',
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI0MmQ…c5Vw',
  })
  @IsString()
  @MinLength(10)
  @MaxLength(2048)
  token: string;

  @ApiProperty({ example: 'newSecurePass1', minLength: 8 })
  @IsString()
  @MinLength(8)
  @Matches(PASSWORD_PATTERN, { message: PASSWORD_RULE_MESSAGE })
  password: string;
}
