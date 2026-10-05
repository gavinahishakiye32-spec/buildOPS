import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  Request,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  ApiErrors,
  ApiRateLimited,
} from '../common/decorators/api-errors.decorator.js';
import { BearerProfile } from '../common/decorators/protected.decorator.js';
import type { AuthenticatedRequest } from '../common/types.js';
import {
  MessageResponseDto,
  SessionResponseDto,
} from '../auth/dto/response.dto.js';
import { AccountService } from './account.service.js';
import {
  AccountResponseDto,
  ChangeEmailDto,
  ChangePasswordDto,
  DeleteAccountDto,
} from './dto/account.dto.js';

/**
 * Everything a person can do to their own account, in one place.
 *
 * It sits under `/settings/account` rather than under `/auth` because this is the
 * account *area* of the product -- the tab a settings screen opens -- not the
 * credential machinery. `/auth` keeps the flows that happen before there is a
 * session (register, verify, login, reset) and the two that end one (logout,
 * logout-all); what a signed-in user does to their own profile while browsing the
 * app belongs here, next to `/settings/me`.
 *
 * `/auth/profile` still answers the same profile fields, because published
 * clients are already calling it and an account surface that duplicated it under
 * a second name would be worse than one that leaves it alone. These routes add
 * what it cannot express: a password change on its own, an address change on its
 * own, the devices signed in, one of them ended by id, and the account closed.
 *
 * Every route uses `BearerProfile()`: a JWT, no organization context and no
 * permission check. `BearerProfile` rather than `Protected` because an account
 * has to stay manageable by somebody who belongs to no organization at all, and
 * no `RequirePermissions` because none of this is the organization's business --
 * see `AccountService`.
 *
 * None of these routes read the refresh cookie, so none of them are
 * CSRF-reachable: they authenticate on the `Authorization` header, which a
 * browser will not attach to a cross-site request on its own. The refresh cookie
 * is the one cookie the server reads, and `SameSite=strict` plus the double-submit
 * check on the routes that read it stay the CSRF boundary.
 */
@ApiRateLimited()
@ApiTags('settings')
@Controller('settings/account')
export class AccountController {
  constructor(private readonly accountService: AccountService) {}

  @Get()
  @BearerProfile()
  @ApiOperation({
    summary: 'Get my account',
    description:
      'The account behind the presented token: its address, name, status, ' +
      'whether the address is confirmed, and how many devices are signed in. ' +
      'Enough to render an account tab without a second call.',
  })
  @ApiResponse({
    status: 200,
    description: 'The authenticated account',
    type: AccountResponseDto,
  })
  @ApiErrors(401)
  async getAccount(
    @Request() req: AuthenticatedRequest,
  ): Promise<AccountResponseDto> {
    return this.accountService.overview(req.user.id);
  }

  @Patch('password')
  @BearerProfile()
  @ApiOperation({
    summary: 'Change my password',
    description:
      'Replaces the password after re-checking the current one. Every session ' +
      'is ended by the change, the one making it included, so the access token ' +
      'in hand stops being accepted from the next request onwards and the ' +
      'response reports `activeSessions: 0`. Log in again to continue.',
  })
  @ApiResponse({
    status: 200,
    description: 'The account as updated',
    type: AccountResponseDto,
  })
  @ApiErrors(400, 401)
  async changePassword(
    @Request() req: AuthenticatedRequest,
    @Body() dto: ChangePasswordDto,
  ): Promise<AccountResponseDto> {
    return this.accountService.changePassword(req.user.id, dto);
  }

  @Patch('email')
  @BearerProfile()
  @ApiOperation({
    summary: 'Change my email address',
    description:
      'Moves the account to another address. Verification is reset and a fresh ' +
      'link is sent there, so the response reports `isVerified: false` and the ' +
      'account cannot be signed into again until the link is followed.',
  })
  @ApiResponse({
    status: 200,
    description: 'The account as updated, with verification reset',
    type: AccountResponseDto,
  })
  @ApiErrors(400, 401, 409)
  async changeEmail(
    @Request() req: AuthenticatedRequest,
    @Body() dto: ChangeEmailDto,
  ): Promise<AccountResponseDto> {
    return this.accountService.changeEmail(req.user.id, dto);
  }

  @Get('sessions')
  @BearerProfile()
  @ApiOperation({
    summary: 'List the sessions of my account',
    description:
      'Every device currently signed in, newest first, with `isCurrent` marking ' +
      'the one making this request. Revoked and expired sessions are omitted.',
  })
  @ApiResponse({
    status: 200,
    description: 'Live sessions, one per device',
    type: [SessionResponseDto],
  })
  @ApiErrors(401)
  sessions(@Request() req: AuthenticatedRequest) {
    return this.accountService.sessions(req.user.id, req.user.sessionId);
  }

  @Delete('sessions/:sessionId')
  @BearerProfile()
  @ApiOperation({
    summary: 'End one of my sessions',
    description:
      'Revokes one session by the id the list returns, which is the `sid` claim ' +
      'of its access tokens. The tokens already issued stop being accepted ' +
      'immediately, on this device as much as any other. An id that is unknown, ' +
      "expired or somebody else's is the same 404, so this route cannot be used " +
      "to probe for other people's sessions.",
  })
  @ApiResponse({
    status: 200,
    description: 'The session was live and is now revoked',
    type: MessageResponseDto,
  })
  @ApiErrors(400, 401, 404)
  async revokeSession(
    @Request() req: AuthenticatedRequest,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
  ): Promise<MessageResponseDto> {
    return this.accountService.revokeSession(req.user.id, sessionId);
  }

  @Delete()
  @BearerProfile()
  @ApiOperation({
    summary: 'Delete my account',
    description:
      'Closes the account for good: every session is ended, the preferences are ' +
      'dropped, the organization memberships are released, and the address, name ' +
      'and password are overwritten. The address becomes free for a new ' +
      'registration. The row itself stays, because a hard delete would cascade ' +
      'through `tenants` and take the whole workspace with it; the work logged ' +
      'under the account keeps pointing at the id it always pointed at, and no ' +
      'longer names anybody.\n\n' +
      'Two things are required: `password`, which proves the caller owns the ' +
      'account, and `?confirm=<email>`, which makes the request deliberate. The ' +
      'first attempt answers 409 and repeats the address to type.\n\n' +
      "This is the authenticated user's own account, so it takes no " +
      '`x-organization-id` and no permission.',
  })
  @ApiQuery({
    name: 'confirm',
    required: true,
    description:
      'The address on the account, repeated back to confirm the deletion is ' +
      'deliberate. Anything else is a 409.',
    schema: { type: 'string' },
  })
  @ApiResponse({
    status: 200,
    description: 'The account is deleted and its sessions are ended',
    type: MessageResponseDto,
  })
  @ApiErrors(400, 401, 409)
  async deleteAccount(
    @Request() req: AuthenticatedRequest,
    @Query('confirm') confirmation: string | undefined,
    @Body() dto: DeleteAccountDto,
  ): Promise<MessageResponseDto> {
    return this.accountService.deleteAccount(req.user.id, confirmation, dto);
  }
}
