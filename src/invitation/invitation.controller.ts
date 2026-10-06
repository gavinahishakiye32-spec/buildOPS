import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { PERMISSIONS } from '../common/permissions.js';
import {
  ApiErrors,
  ApiRateLimited,
} from '../common/decorators/api-errors.decorator.js';
import {
  OrgAuth,
  type OrganizationAuthContext,
} from '../common/decorators/org-auth.decorator.js';
import {
  OrganizationHeader,
  Protected,
  RequirePermissions,
} from '../common/decorators/protected.decorator.js';
import { CreateInvitationDto } from './dto/create-invitation.dto.js';
import {
  CreateInvitationResponseDto,
  InvitationResponseDto,
} from './dto/invitation-response.dto.js';
import { InvitationService } from './invitation.service.js';

/**
 * The administrator's half of the invitation flow.
 *
 * It sits on `/organizations/:organizationId` beside the role and member
 * endpoints because that is what it is: a member operation that happens to
 * start with an email. Acceptance is public (`InvitationAcceptController`),
 * since the person accepting has no membership yet -- and cannot have one,
 * because having one is the thing being granted.
 */
@ApiRateLimited()
@ApiTags('invitations')
@Protected()
@Controller('organizations/:organizationId')
export class InvitationController {
  constructor(private readonly invitationService: InvitationService) {}

  @Post('invitations')
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.MEMBER_INVITE)
  @ApiOperation({
    summary: 'Invite a member by email',
    description:
      'Sends an invitation link to an address and holds it as a pending row until it is accepted, revoked or expires (7 days). The role itself is created on acceptance, so no plan seat is claimed for somebody who never arrives. Answer 409 when that address already has a pending invitation or is already a member. Outside production the response also carries `invitationToken`/`invitationLink` and the `emailSent`/`emailError` outcome of the send.',
  })
  @ApiResponse({
    status: 201,
    description:
      'Invitation created and emailed; outside production also the token, link and send outcome',
    type: CreateInvitationResponseDto,
  })
  @ApiErrors(400, 403, 409)
  async createInvitation(
    @OrgAuth() auth: OrganizationAuthContext,
    @Body() dto: CreateInvitationDto,
  ): Promise<CreateInvitationResponseDto> {
    return this.invitationService.createInvitation(
      auth.organizationId,
      auth.userId,
      dto,
    );
  }

  @Get('invitations')
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.MEMBER_VIEW)
  @ApiOperation({
    summary: 'List invitations',
    description:
      'Invitations of the organization, oldest first, with the ones that were accepted or revoked still listed so the history of who was invited survives. `status` is reported as `expired` for a pending row whose window has closed.',
  })
  @ApiResponse({
    status: 200,
    description: 'Invitations of the organization, including finished ones',
    type: [InvitationResponseDto],
  })
  @ApiErrors(403)
  async listInvitations(
    @OrgAuth() auth: OrganizationAuthContext,
  ): Promise<InvitationResponseDto[]> {
    return this.invitationService.listInvitations(auth.organizationId);
  }

  @Delete('invitations/:invitationId')
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.MEMBER_INVITE)
  @ApiOperation({
    summary: 'Revoke an invitation',
    description:
      'Withdraws a pending invitation: the link stops working and the address can be invited again. Idempotent for one already revoked, and 409 for one that was accepted -- the membership it created is removed with DELETE /organizations/:organizationId/members/:userId, not here.',
  })
  @ApiResponse({
    status: 200,
    description: 'Invitation revoked, or already revoked',
    type: InvitationResponseDto,
  })
  @ApiErrors(403, 404, 409)
  async revokeInvitation(
    @OrgAuth() auth: OrganizationAuthContext,
    @Param('invitationId', ParseUUIDPipe) invitationId: string,
  ): Promise<InvitationResponseDto> {
    return this.invitationService.revokeInvitation(
      auth.organizationId,
      invitationId,
    );
  }
}
