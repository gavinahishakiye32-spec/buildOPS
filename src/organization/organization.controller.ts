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
import { Auth, SkipOrganization } from '../common/decorators/auth.decorator.js';
import { ApiErrors } from '../common/decorators/api-errors.decorator.js';
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
  @ApiResponse({ status: 201, type: OrganizationResponseDto })
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
  @ApiResponse({ status: 200, type: OrganizationPageDto })
  @ApiErrors(404)
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
  @ApiOperation({ summary: 'Get an organization' })
  @ApiResponse({ status: 200, type: OrganizationResponseDto })
  @ApiErrors(403, 404)
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
  @ApiOperation({ summary: 'Update an organization' })
  @ApiResponse({ status: 200, type: OrganizationResponseDto })
  @ApiErrors(400, 403, 404)
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
      'Deletes the organization and every record scoped to it (roles, teams, clients, projects, tasks, time).',
  })
  @ApiResponse({ status: 200, type: OrganizationMessageResponseDto })
  @ApiErrors(403, 404)
  async remove(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
  ): Promise<OrganizationMessageResponseDto> {
    await this.organizationService.remove(organizationId);
    return { message: 'Organization deleted' };
  }
}
