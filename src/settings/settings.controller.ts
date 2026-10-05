import { Body, Controller, Get, Patch, Request } from '@nestjs/common';
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
  BearerProfile,
  OrganizationHeader,
  Protected,
  RequirePermissions,
} from '../common/decorators/protected.decorator.js';
import type { AuthenticatedRequest } from '../common/types.js';
import { SettingsService } from './settings.service.js';
import {
  OrganizationSettingsResponseDto,
  UpdateOrganizationSettingsDto,
  UpdateUserSettingsDto,
  UserSettingsResponseDto,
} from './dto/settings.dto.js';

/**
 * Two independent kinds of setting, on two independent routes.
 *
 * `/settings/me` belongs to the authenticated user and needs no organization and
 * no permission: a person's own preferences are not the organization's business,
 * and gating them would mean a member who lost a role suddenly cannot choose
 * their own date format. It uses `BearerProfile()` for exactly the reason
 * `/auth/profile` does.
 *
 * `/settings/organization` is shared by everyone in the organization, so it
 * takes the organization header and the permission check. Read is `settings.view`
 * and write is `settings.update`, and the templates hand the second only to roles
 * that run the organization -- a developer can read the conventions they work to
 * but cannot change them for everybody else.
 */
@ApiRateLimited()
@ApiTags('settings')
@Controller('settings')
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  @Get('me')
  @BearerProfile()
  @ApiOperation({
    summary: 'Get my settings',
    description:
      'Preferences of the authenticated user. Created with defaults on the first ' +
      'read, so this always returns a complete object -- a client never has to ' +
      'substitute its own defaults for a field that has not been set.',
  })
  @ApiResponse({
    status: 200,
    description: 'The authenticated user settings',
    type: UserSettingsResponseDto,
  })
  // No 404: `JwtStrategy` resolves the user on every request and answers 401 for
  // an account that does not exist, so a request carrying a valid token is
  // always for a user that is there. Documenting 404 would be a status the
  // server cannot return.
  @ApiErrors(401)
  async getMine(
    @Request() req: AuthenticatedRequest,
  ): Promise<UserSettingsResponseDto> {
    // Read from `request.user`, not `@Auth()`: this route runs the JWT guard but
    // not `PermissionsGuard`, so `authContext` -- the latter's output -- is absent.
    const settings = await this.settingsService.getUserSettings(req.user.id);
    return settings.toResponse();
  }

  @Patch('me')
  @BearerProfile()
  @ApiOperation({
    summary: 'Update my settings',
    description:
      'Updates the preferences of the authenticated user. Only the fields sent ' +
      'are changed, so a form can submit one preference without resending the ' +
      'rest. These are personal settings; changing them affects nobody else, ' +
      'which is why this route is not permission-gated.',
  })
  @ApiResponse({
    status: 200,
    description: 'The settings as updated',
    type: UserSettingsResponseDto,
  })
  @ApiErrors(400, 401)
  async updateMine(
    @Request() req: AuthenticatedRequest,
    @Body() dto: UpdateUserSettingsDto,
  ): Promise<UserSettingsResponseDto> {
    const settings = await this.settingsService.updateUserSettings(
      req.user.id,
      dto,
    );
    return settings.toResponse();
  }

  @Get('organization')
  @Protected()
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.SETTINGS_VIEW)
  @ApiOperation({
    summary: 'Get the organization settings',
    description:
      'Settings shared by every member of the active organization: reporting ' +
      'time zone, week start, default clock and the working-hours window. ' +
      'Created with defaults on the first read.',
  })
  @ApiResponse({
    status: 200,
    description: 'The active organization settings',
    type: OrganizationSettingsResponseDto,
  })
  @ApiErrors(403, 404)
  async getOrganization(
    @OrgAuth() auth: OrganizationAuthContext,
  ): Promise<OrganizationSettingsResponseDto> {
    const settings = await this.settingsService.getOrganizationSettings(
      auth.organizationId,
    );
    return settings.toResponse();
  }

  @Patch('organization')
  @Protected()
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.SETTINGS_UPDATE)
  @ApiOperation({
    summary: 'Update the organization settings',
    description:
      'Changes the settings every member sees. Only the fields sent are changed. ' +
      'Members may still override the time zone and clock in their own settings; ' +
      'the organization value is what applies when they have not.',
  })
  @ApiResponse({
    status: 200,
    description: 'The organization settings as updated',
    type: OrganizationSettingsResponseDto,
  })
  // 400 covers both the field validation and a working window that would end
  // before it starts, which is a rule about the pair rather than either bound.
  @ApiErrors(400, 403, 404)
  async updateOrganization(
    @OrgAuth() auth: OrganizationAuthContext,
    @Body() dto: UpdateOrganizationSettingsDto,
  ): Promise<OrganizationSettingsResponseDto> {
    const settings = await this.settingsService.updateOrganizationSettings(
      auth.organizationId,
      dto,
    );
    return settings.toResponse();
  }
}
