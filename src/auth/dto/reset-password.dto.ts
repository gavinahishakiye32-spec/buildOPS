import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';
import {
  PASSWORD_PATTERN,
  PASSWORD_RULE_MESSAGE,
} from '../../common/password.js';

export class ResetPasswordDto {
  @ApiProperty({
    description: 'Password reset token received by email',
    example:
      'e04aab9c26ee8d3d4d2e6f8d12f10c9affc4b6de3b8f861e2a3c5d9e7f6a4b1c',
  })
  @IsString()
  @MinLength(10)
  @MaxLength(128)
  token: string;

  @ApiProperty({ example: 'newSecurePass1', minLength: 8 })
  @IsString()
  @MinLength(8)
  @Matches(PASSWORD_PATTERN, { message: PASSWORD_RULE_MESSAGE })
  password: string;
}
