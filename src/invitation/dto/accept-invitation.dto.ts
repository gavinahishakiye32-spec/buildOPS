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
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJwdXJwb3NlIjoi…0RQ',
  })
  @IsString()
  @MinLength(10)
  @MaxLength(2048)
  token: string;

  @ApiPropertyOptional({
    example: 'Someone',
    description:
      'Your display name, if you want to be known by something other than your address. Optional: the form only has to show the invited email and ask for a password.',
  })
  @IsOptional()
  @IsString()
  @Length(1, 255)
  name?: string;

  @ApiPropertyOptional({
    example: 'Someone123!',
    minLength: 8,
    description:
      'The password for the account this invitation creates, with the same rules as registration. The only field a new account has to fill in. Not required when the address already has an account -- the invitation token is what authenticates that case.',
  })
  @IsOptional()
  @IsString()
  @MinLength(8)
  @Matches(PASSWORD_PATTERN, { message: PASSWORD_RULE_MESSAGE })
  password?: string;
}
