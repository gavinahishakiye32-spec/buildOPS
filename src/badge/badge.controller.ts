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
import { PaginatedSchema } from '../common/dto/paginated-response.dto.js';
import { PERMISSIONS } from '../common/permissions.js';
import { ApiErrors } from '../common/decorators/api-errors.decorator.js';
import {
  OrgAuth,
  type OrganizationAuthContext,
} from '../common/decorators/org-auth.decorator.js';
import {
  OrganizationHeader,
  Protected,
  RequirePermissions,
} from '../common/decorators/protected.decorator.js';
import {
  PaginationQueryDto,
  type Paginated,
} from '../common/pagination.dto.js';
import { BadgeService } from './badge.service.js';
import {
  BadgeMessageResponseDto,
  BadgeResponseDto,
  CreateBadgeDto,
  UpdateBadgeDto,
} from './dto/badge.dto.js';

const BadgePageDto = PaginatedSchema(BadgeResponseDto, 'BadgePage');

@ApiTags('badges')
@Protected()
@Controller('badges')
export class BadgeController {
  constructor(private readonly badgeService: BadgeService) {}

  @Post()
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.BADGE_CREATE)
  @ApiOperation({
    summary: 'Create a badge',
    description:
      'Creates an organization-defined label that can be attached to tasks for consistent classification.',
  })
  @ApiResponse({ status: 201, type: BadgeResponseDto })
  @ApiErrors(400, 403)
  async create(
    @OrgAuth() auth: OrganizationAuthContext,
    @Body() dto: CreateBadgeDto,
  ): Promise<BadgeResponseDto> {
    const badge = await this.badgeService.create(auth.organizationId, dto);
    return badge.toResponse();
  }

  @Get()
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.BADGE_VIEW)
  @ApiOperation({ summary: 'List badges' })
  @ApiResponse({ status: 200, type: BadgePageDto })
  @ApiErrors(403)
  async list(
    @OrgAuth() auth: OrganizationAuthContext,
    @Query() query: PaginationQueryDto,
  ): Promise<Paginated<BadgeResponseDto>> {
    const page = await this.badgeService.list(auth.organizationId, query);
    return { ...page, items: page.items.map((badge) => badge.toResponse()) };
  }

  @Get(':badgeId')
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.BADGE_VIEW)
  @ApiOperation({ summary: 'Get a badge' })
  @ApiResponse({ status: 200, type: BadgeResponseDto })
  @ApiErrors(403, 404)
  async findOne(
    @OrgAuth() auth: OrganizationAuthContext,
    @Param('badgeId', ParseUUIDPipe) badgeId: string,
  ): Promise<BadgeResponseDto> {
    const badge = await this.badgeService.findOne(auth.organizationId, badgeId);
    return badge.toResponse();
  }

  @Patch(':badgeId')
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.BADGE_UPDATE)
  @ApiOperation({ summary: 'Update a badge' })
  @ApiResponse({ status: 200, type: BadgeResponseDto })
  @ApiErrors(400, 403, 404)
  async update(
    @OrgAuth() auth: OrganizationAuthContext,
    @Param('badgeId', ParseUUIDPipe) badgeId: string,
    @Body() dto: UpdateBadgeDto,
  ): Promise<BadgeResponseDto> {
    const badge = await this.badgeService.update(
      auth.organizationId,
      badgeId,
      dto,
    );
    return badge.toResponse();
  }

  @Delete(':badgeId')
  @HttpCode(200)
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.BADGE_DELETE)
  @ApiOperation({
    summary: 'Delete a badge',
    description: 'Deletes the badge; tasks keep a null badge reference.',
  })
  @ApiResponse({ status: 200, type: BadgeMessageResponseDto })
  @ApiErrors(403, 404)
  async remove(
    @OrgAuth() auth: OrganizationAuthContext,
    @Param('badgeId', ParseUUIDPipe) badgeId: string,
  ): Promise<BadgeMessageResponseDto> {
    await this.badgeService.remove(auth.organizationId, badgeId);
    return { message: 'Badge deleted' };
  }
}
