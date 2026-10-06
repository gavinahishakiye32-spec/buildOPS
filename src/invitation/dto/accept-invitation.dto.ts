import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
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

export class AcceptInvitationDto {
  @ApiProperty({
    description:
      'Invitation token received by email. The frontend should read `?token=` from the link and send it back here.',
    example: 'e04aab9c26ee8d3d4d2e6f8d12f10c9affc4b6de3b8f861e2a3c5d9e7f6a4b1c',
  })
  @IsString()
  @MinLength(10)
  @MaxLength(128)
  token: string;

  @ApiPropertyOptional({
    example: 'Someone',
    description:
      'Your name. Required only when the invitation has no account behind it yet: there is nothing to name otherwise.',
  })
  @IsOptional()
  @IsString()
  @Length(1, 255)
  name?: string;

  @ApiPropertyOptional({
    example: 'Someone123!',
    minLength: 8,
    description:
      'Password for the account created with this invitation, with the same rules as registration. Required only for a new account.',
  })
  @IsOptional()
  @IsString()
  @MinLength(8)
  @Matches(PASSWORD_PATTERN, { message: PASSWORD_RULE_MESSAGE })
  password?: string;
}
