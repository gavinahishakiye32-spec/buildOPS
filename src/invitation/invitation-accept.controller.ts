import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';

import {
  ApiErrors,
  ApiRateLimited,
} from '../common/decorators/api-errors.decorator.js';
import { AcceptInvitationDto } from './dto/accept-invitation.dto.js';
import {
  AcceptInvitationResponseDto,
  InvitationPreviewResponseDto,
} from './dto/invitation-response.dto.js';
import { InvitationService } from './invitation.service.js';

/**
 * The public half of the invitation flow: the destination of the link that was
 * emailed, reachable before the invitee has an account or a token of any kind.
 *
 * No `@Protected()`, because there is nothing to protect yet -- the invitation
 * token *is* the credential, and it is what stops this from being an open
 * membership endpoint. Both routes take the stricter `auth` throttle bucket
 * for the same reason the credential routes do: one of them can create an
 * account, and neither should be a place to guess tokens from.
 */
@ApiRateLimited()
@ApiTags('invitations')
@Controller('invitations')
export class InvitationAcceptController {
  constructor(private readonly invitationService: InvitationService) {}

  @Get('accept')
  @Throttle({ auth: { limit: 5, ttl: 900000 } })
  @ApiOperation({
    summary: 'Preview an invitation',
    description:
      'Reads the invitation behind an emailed `?token=` without consuming it, so opening the link in a browser answers 200 and can show who invited whom, under which role, with which permissions. 400 for a missing, unknown or expired token, 409 for one that was already accepted or has been revoked.',
  })
  @ApiQuery({
    name: 'token',
    required: true,
    description:
      'Invitation token received by email. The frontend should read `?token=` and call this endpoint.',
  })
  @ApiResponse({
    status: 200,
    description: 'The invitation, with what accepting it would grant',
    type: InvitationPreviewResponseDto,
  })
  @ApiErrors(400, 409)
  preview(@Query('token') token: string): Promise<InvitationPreviewResponseDto> {
    return this.invitationService.preview(token);
  }

  @Post('accept')
  @Throttle({ auth: { limit: 5, ttl: 900000 } })
  @ApiOperation({
    summary: 'Accept an invitation',
    description:
      'Creates the membership the invitation promises. When no account exists for the address, `name` and `password` are required and the account is created already verified -- the token is the proof that the mailbox belongs to the caller. When an account does exist it is signed in as usual afterwards; an unverified one is verified here for the same reason. 400 for a missing, unknown or expired token or for a new account without a name and password, 409 for one already accepted, revoked, or already a member.',
  })
  @ApiResponse({
    status: 201,
    description: 'Invitation accepted and membership created',
    type: AcceptInvitationResponseDto,
  })
  @ApiErrors(400, 409)
  accept(
    @Body() dto: AcceptInvitationDto,
  ): Promise<AcceptInvitationResponseDto> {
    return this.invitationService.accept(dto.token, dto);
  }
}
