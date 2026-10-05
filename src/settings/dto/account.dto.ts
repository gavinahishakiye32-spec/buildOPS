import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, Matches, MaxLength } from 'class-validator';
import {
  PASSWORD_PATTERN,
  PASSWORD_RULE_MESSAGE,
} from '../../common/password.js';

/**
 * The account surface of the settings area: the identity behind the token, its
 * credentials, its sessions, and the way out.
 *
 * Each mutation is its own route with its own body rather than one
 * "update my account" body with optional fields. `PATCH /auth/profile` can
 * change a password, an email, a name and a status at once, which is convenient
 * for a form that has all of them; it is also how a client ends up sending
 * `password` without `currentPassword` and being told so by a 400. A settings
 * screen asking for one thing at a time gets a body where the required fields
 * cannot be forgotten, and the rules themselves stay in `AuthService` so the two
 * routes cannot drift apart.
 */

/** Change the password. Both fields are required, unlike `PATCH /auth/profile`. */
export class ChangePasswordDto {
  @ApiProperty({
    example: 'Someone123!',
    description: 'The password currently on the account.',
  })
  @IsString()
  @MaxLength(128)
  currentPassword: string;

  @ApiProperty({
    example: 'BrandNew456!',
    description:
      'The replacement. At least 8 characters with at least one letter and one ' +
      'number. Every session is ended by the change, including the one making it.',
  })
  @Matches(PASSWORD_PATTERN, { message: PASSWORD_RULE_MESSAGE })
  newPassword: string;
}

/**
 * Change the address on the account.
 *
 * The change resets verification and sends a fresh link to the new address, so
 * `isVerified` reads false in the response until that link is followed. An
 * address that already belongs to somebody else is a 409.
 */
export class ChangeEmailDto {
  @ApiProperty({
    example: 'new.address@example.com',
    description:
      'Stored normalised, so the address is compared the same way the login is.',
  })
  @IsEmail()
  @MaxLength(255)
  email: string;
}

/**
 * Confirm the deletion with the password.
 *
 * Separate from `?confirm=`, which names the account rather than proving the
 * caller is its owner. A stolen access token is enough to read the address and
 * copy it into the query string; it is not enough to produce this password, and
 * without the password a token that leaked out of a shared machine could end the
 * account it came from.
 */
export class DeleteAccountDto {
  @ApiProperty({
    example: 'Someone123!',
    description: 'The password on the account, asked for again to confirm.',
  })
  @IsString()
  @MaxLength(128)
  password: string;
}

/**
 * Everything an account screen needs, in one response.
 *
 * Deliberately one call rather than three: the identity, whether the address is
 * confirmed, and how many devices are signed in are the three things a user looks
 * at together when they ask "is my account in order". `activeSessions` is the
 * same count `/settings/account/sessions` would list, so the tab can render a
 * summary without fetching rows it is not going to show.
 */
export class AccountResponseDto {
  @ApiProperty({
    format: 'uuid',
    example: '9a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
  })
  id: string;

  @ApiProperty({ example: 'someone@example.com' })
  email: string;

  @ApiProperty({
    example: 'Someone',
    nullable: true,
    type: String,
  })
  name: string | null;

  @ApiProperty({
    example: 'active',
    nullable: true,
    type: String,
    description:
      'Account status. A member may set `active` or `inactive` on their own ' +
      'profile; `suspended` is reachable only by somebody with ' +
      '`member.update`.',
  })
  status: string | null;

  @ApiProperty({
    example: true,
    description:
      'Whether the address is confirmed. Goes back to false after an email ' +
      'change, until the new link is followed.',
  })
  isVerified: boolean;

  @ApiProperty({
    example: 2,
    description:
      'Live sessions, one per device. The same rows ' +
      '`GET /settings/account/sessions` returns.',
  })
  activeSessions: number;

  @ApiProperty({ example: '2026-09-18T11:11:22.041Z' })
  createdAt: Date;

  @ApiProperty({ example: '2026-09-18T11:29:09.099Z' })
  updatedAt: Date;
}
