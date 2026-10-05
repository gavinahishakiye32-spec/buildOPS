import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '../common/permissions.js';
import { ConfirmOrganizationDeletionDto } from '../common/soft-delete.js';
import { Auth, SkipOrganization } from '../common/decorators/auth.decorator.js';
import {
  ApiErrors,
  ApiRateLimited,
} from '../common/decorators/api-errors.decorator.js';
import {
  OrganizationHeader,
  Protected,
  RequirePermissions,
} from '../common/decorators/protected.decorator.js';
import {
  PaginationQueryDto,
  type Paginated,
} from '../common/pagination.dto.js';
import type { AuthContext } from '../common/types.js';
import { OrganizationService } from './organization.service.js';
import {
  CreateOrganizationDto,
  OrganizationMessageResponseDto,
  OrganizationResponseDto,
  UpdateOrganizationDto,
} from './dto/organization.dto.js';
import { PaginatedSchema } from '../common/dto/paginated-response.dto.js';

const OrganizationPageDto = PaginatedSchema(
  OrganizationResponseDto,
  'OrganizationPage',
);

@ApiRateLimited()
@ApiTags('organizations')
@Protected()
@Controller('organizations')
export class OrganizationController {
  constructor(private readonly organizationService: OrganizationService) {}

  @Post()
  @SkipOrganization()
  @ApiOperation({
    summary: 'Create an organization',
    description:
      'Creates an organization for the subscription of the authenticated user. Subject to the plan limit max_organizations. The creator receives the Owner role with full permissions.',
  })
  @ApiResponse({
    status: 201,
    description: 'Organization created',
    type: OrganizationResponseDto,
  })
  @ApiErrors(400, 404)
  async create(
    @Auth() auth: AuthContext,
    @Body() dto: CreateOrganizationDto,
  ): Promise<OrganizationResponseDto> {
    const organization = await this.organizationService.create(
      auth.userId,
      dto,
    );
    return organization.toResponse();
  }

  @Get()
  @SkipOrganization()
  @ApiOperation({
    summary: 'List organizations',
    description:
      'Organizations owned by the subscription of the authenticated user (tenant isolation, spec §4.3).',
  })
  @ApiResponse({
    status: 200,
    description: 'Page of organizations owned by the subscription',
    type: OrganizationPageDto,
  })
  // 400 is the query validation pipe: `page` and `limit` are typed, so an
  // out-of-range value fails here before the service runs.
  @ApiErrors(400, 404)
  async list(
    @Auth() auth: AuthContext,
    @Query() query: PaginationQueryDto,
  ): Promise<Paginated<OrganizationResponseDto>> {
    const page = await this.organizationService.listForUser(auth.userId, query);

    return {
      ...page,
      items: page.items.map((item) => item.toResponse()),
    };
  }

  @Get(':organizationId')
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.ORGANIZATION_VIEW)
  @ApiOperation({
    summary: 'Get an organization',
    description:
      'One organization of the subscription. The :organizationId path segment defines the active organization for this call; your membership in it is verified.',
  })
  @ApiResponse({
    status: 200,
    description: 'Organization details',
    type: OrganizationResponseDto,
  })
  // No 404: `PermissionsGuard` resolves membership before the service looks the
  // record up, so an unknown or deleted organization answers 403. Documenting a
  // status the server cannot return is a promise it cannot keep.
  @ApiErrors(400, 403)
  async findOne(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
  ): Promise<OrganizationResponseDto> {
    const organization =
      await this.organizationService.findById(organizationId);
    return organization.toResponse();
  }

  @Patch(':organizationId')
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.ORGANIZATION_UPDATE)
  @ApiOperation({
    summary: 'Update an organization',
    description:
      'Renames an organization or changes its lifecycle status. Only fields you send are modified.',
  })
  @ApiResponse({
    status: 200,
    description: 'Updated organization',
    type: OrganizationResponseDto,
  })
  @ApiErrors(400, 401, 403)
  async update(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() dto: UpdateOrganizationDto,
  ): Promise<OrganizationResponseDto> {
    const organization = await this.organizationService.update(
      organizationId,
      dto,
    );
    return organization.toResponse();
  }

  @Delete(':organizationId')
  @HttpCode(200)
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.ORGANIZATION_DELETE)
  @ApiOperation({
    summary: 'Delete an organization',
    description:
      'Deletes the organization and every record scoped to it (roles, teams, ' +
      'clients, projects, tasks, time), including anything already ' +
      'soft-deleted. Unlike the other delete routes this is permanent, so it ' +
      'requires the organization name to be typed as ?confirm=<name>; without ' +
      'it the request is refused with 409 and nothing is deleted.',
  })
  @ApiResponse({
    status: 200,
    description: 'Organization deleted',
    type: OrganizationMessageResponseDto,
  })
  // No 404: membership is resolved before the lookup, so an organization
  // the caller cannot reach answers 403 whether or not it exists.
  @ApiErrors(400, 401, 403, 409)
  async remove(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Query() query: ConfirmOrganizationDeletionDto,
  ): Promise<OrganizationMessageResponseDto> {
    await this.organizationService.remove(organizationId, query.confirm);
    return { message: 'Organization deleted' };
  }
}
