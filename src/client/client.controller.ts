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
import {
  PaginationQueryDto,
  type Paginated,
} from '../common/pagination.dto.js';
import { ClientService } from './client.service.js';
import {
  ClientMessageResponseDto,
  ClientResponseDto,
  CreateClientDto,
  UpdateClientDto,
} from './dto/client.dto.js';
import { TrashEntryDto } from '../common/soft-delete.js';

const ClientPageDto = PaginatedSchema(ClientResponseDto, 'ClientPage');

@ApiRateLimited()
@ApiTags('clients')
@Protected()
@Controller('clients')
export class ClientController {
  constructor(private readonly clientService: ClientService) {}

  @Post()
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.CLIENT_CREATE)
  @ApiOperation({
    summary: 'Create a client',
    description:
      'Creates a CRM record in the active organization. Email is unique across clients.',
  })
  @ApiResponse({
    description: 'Client created',
    status: 201,
    type: ClientResponseDto,
  })
  @ApiErrors(400, 403, 409)
  async create(
    @OrgAuth() auth: OrganizationAuthContext,
    @Body() dto: CreateClientDto,
  ): Promise<ClientResponseDto> {
    const client = await this.clientService.create(auth.organizationId, dto);
    return client.toResponse();
  }

  @Get()
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.CLIENT_VIEW)
  @ApiOperation({
    summary: 'List clients',
    description: 'Paginated clients of the active organization.',
  })
  @ApiResponse({
    description: 'One page of clients',
    status: 200,
    type: ClientPageDto,
  })
  @ApiErrors(403)
  async list(
    @OrgAuth() auth: OrganizationAuthContext,
    @Query() query: PaginationQueryDto,
  ): Promise<Paginated<ClientResponseDto>> {
    const page = await this.clientService.list(auth.organizationId, query);
    return {
      ...page,
      items: page.items.map((client) => client.toResponse()),
    };
  }

  /**
   * Deleted clients, newest first.
   *
   * Declared before `/clientId` on purpose. A `trash` route registered after a
   * parameterised one is unreachable: the parameter route matches the literal
   * string `trash` first, and the UUID pipe rejects it.
   */
  @Get('trash')
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.CLIENT_VIEW)
  @ApiOperation({
    summary: 'List deleted clients',
    description:
      'Soft-deleted clients, with when each was deleted and who deleted it. ' +
      'These rows are excluded from every ordinary read.',
  })
  @ApiResponse({
    description: 'Clients moved to trash',
    status: 200,
    type: [TrashEntryDto],
  })
  @ApiErrors(403)
  async trash(
    @OrgAuth() auth: OrganizationAuthContext,
  ): Promise<TrashEntryDto[]> {
    return this.clientService.listDeleted(auth.organizationId);
  }

  @Post(':clientId/restore')
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.CLIENT_UPDATE)
  @ApiOperation({
    summary: 'Restore a deleted client',
    description:
      'Brings a soft-deleted client back. ' +
      'Only the records removed by that same delete are restored, so anything ' +
      'deleted on purpose afterwards stays deleted.',
  })
  @ApiResponse({
    description: 'Client restored, no longer in the trash',
    status: 201,
    type: ClientResponseDto,
  })
  @ApiErrors(403, 404, 409)
  async restore(
    @OrgAuth() auth: OrganizationAuthContext,
    @Param('clientId', ParseUUIDPipe) clientId: string,
  ): Promise<ClientResponseDto> {
    const restored = await this.clientService.restore(
      auth.organizationId,
      clientId,
    );

    return restored.toResponse();
  }

  @Get(':clientId')
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.CLIENT_VIEW)
  @ApiOperation({
    summary: 'Get a client',
    description: 'One client of the active organization.',
  })
  @ApiResponse({
    description: 'The client',
    status: 200,
    type: ClientResponseDto,
  })
  @ApiErrors(403, 404)
  async findOne(
    @OrgAuth() auth: OrganizationAuthContext,
    @Param('clientId', ParseUUIDPipe) clientId: string,
  ): Promise<ClientResponseDto> {
    const client = await this.clientService.findOne(
      auth.organizationId,
      clientId,
    );
    return client.toResponse();
  }

  @Patch(':clientId')
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.CLIENT_UPDATE)
  @ApiOperation({
    summary: 'Update a client',
    description:
      'Updates the mutable fields of a client. Only fields you send are modified, and a conflicting email returns 409.',
  })
  @ApiResponse({
    description: 'The client as updated',
    status: 200,
    type: ClientResponseDto,
  })
  @ApiErrors(400, 403, 404, 409)
  async update(
    @OrgAuth() auth: OrganizationAuthContext,
    @Param('clientId', ParseUUIDPipe) clientId: string,
    @Body() dto: UpdateClientDto,
  ): Promise<ClientResponseDto> {
    const client = await this.clientService.update(
      auth.organizationId,
      clientId,
      dto,
    );
    return client.toResponse();
  }

  @Delete(':clientId')
  @HttpCode(200)
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.CLIENT_DELETE)
  @ApiOperation({
    summary: 'Delete a client',
    description:
      'Deletes the client. Projects linked to it keep a null client reference.',
  })
  @ApiResponse({
    description: 'Client moved to trash',
    status: 200,
    type: ClientMessageResponseDto,
  })
  @ApiErrors(403, 404)
  async remove(
    @OrgAuth() auth: OrganizationAuthContext,
    @Param('clientId', ParseUUIDPipe) clientId: string,
  ): Promise<ClientMessageResponseDto> {
    await this.clientService.remove(auth.organizationId, clientId, auth.userId);
    return { message: 'Client deleted' };
  }
}
