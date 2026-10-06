import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  Request,
  Res,
} from '@nestjs/common';
import type { Request as HttpRequest, Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';

import {
  ApiErrors,
  ApiRateLimited,
} from '../common/decorators/api-errors.decorator.js';
import { clientOf, SessionCookies } from '../auth/session-cookies.js';
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
 * for the same reason the credential routes do: one of them creates an account
 * and signs somebody in, and neither should be a place to guess tokens from.
 */
@ApiRateLimited()
@ApiTags('invitations')
@Controller('invitations')
export class InvitationAcceptController {
  constructor(
    private readonly invitationService: InvitationService,
    private readonly sessionCookies: SessionCookies,
  ) {}

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
      'Creates the membership the invitation promises, in one step and without a registration form in front of it. When no account exists for the address, the only field to send is `password` -- the invited email is already known to the invitation and comes back in the preview, so the form has nothing else to ask for -- and the account is created already verified: the token is the proof that the mailbox belongs to the caller. `name` is optional. When an account does exist it is used as it is, and an unverified one is verified for the same reason. Either way the invitee is signed in the way `POST /auth/login` signs them in, so the response carries `access_token` and sets the httpOnly refresh cookie. 400 for a missing, unknown or expired token or for a new account without a password, 409 for one already accepted or revoked.',
  })
  @ApiResponse({
    status: 201,
    description:
      'Invitation accepted: membership created, invitee signed in (access token in the body, refresh token in a cookie)',
    type: AcceptInvitationResponseDto,
  })
  @ApiErrors(400, 409)
  async accept(
    @Body() dto: AcceptInvitationDto,
    @Res({ passthrough: true }) res: Response,
    @Request() req: HttpRequest,
  ): Promise<AcceptInvitationResponseDto> {
    const { session, ...body } = await this.invitationService.accept(
      dto.token,
      dto,
      clientOf(req),
    );

    this.sessionCookies.writeCookies(res, session);

    return body;
  }
}
