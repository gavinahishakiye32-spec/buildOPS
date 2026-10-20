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
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiResponse, ApiTags } from '@nestjs/swagger';
import { PaginatedSchema } from '../common/dto/paginated-response.dto.js';
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
import type { Paginated } from '../common/pagination.dto.js';
import { PERMISSIONS } from '../common/permissions.js';
import {
  CHAT_CHANNEL_TYPES,
  type ChatChannel,
  type ChatChannelType,
} from './chat.entity.js';
import { ChatService, type ChannelListEntry } from './chat.service.js';
import {
  ChatChannelQueryDto,
  ChatMessageQueryDto,
  CreateDirectChannelDto,
  EditMessageDto,
  MarkReadDto,
  ResolveChannelDto,
  SendMessageDto,
} from './dto/chat.dto.js';

class ChatSenderDto {
  @ApiProperty({ example: '9a2b7c1d-4e5f-4a6b-8c9d-0e1f2a3b4c5d' })
  id: string;

  @ApiPropertyOptional({ example: 'Ada Login', nullable: true })
  name: string | null;
}

/** One member of a direct channel, as the channel detail route shows them. */
export class ChatParticipantDto {
  @ApiProperty({ example: '9a2b7c1d-4e5f-4a6b-8c9d-0e1f2a3b4c5d' })
  id: string;

  @ApiPropertyOptional({ example: 'Ada Login', nullable: true })
  name: string | null;
}

export class ChatChannelResponseDto {
  @ApiProperty({ example: 'c3d4e5f6-a7b8-4c9d-0e1f-2a3b4c5d6e7f' })
  id: string;

  @ApiProperty({ example: '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b' })
  organizationId: string;

  @ApiProperty({ enum: CHAT_CHANNEL_TYPES, example: 'organization' })
  type: ChatChannelType;

  @ApiPropertyOptional({ example: null, nullable: true })
  projectId: string | null;

  @ApiPropertyOptional({ example: null, nullable: true })
  taskId: string | null;

  @ApiPropertyOptional({ example: null, nullable: true })
  subtaskId: string | null;

  @ApiPropertyOptional({ example: 'General', nullable: true })
  name: string | null;

  @ApiPropertyOptional({ example: null, nullable: true })
  lastMessageAt: Date | null;

  @ApiProperty({ example: '2026-10-01T09:00:00.000Z' })
  createdAt: Date;

  @ApiProperty({ example: '2026-10-01T09:00:00.000Z' })
  updatedAt: Date;

  @ApiPropertyOptional({
    type: ChatParticipantDto,
    isArray: true,
    nullable: true,
    description:
      'Members of a direct channel (id + name), joined in order. `null` for ' +
      'scoped rooms, whose membership is the organization itself.',
  })
  participants: ChatParticipantDto[] | null;
}

class ChatLastMessageDto {
  @ApiProperty() id: string;
  @ApiProperty() body: string;
  @ApiProperty() senderId: string;
  @ApiProperty() createdAt: Date;
}

export class ChatChannelListEntryDto {
  @ApiProperty({ type: ChatChannelResponseDto })
  channel: ChatChannelResponseDto;

  @ApiPropertyOptional({ type: ChatLastMessageDto, nullable: true })
  lastMessage: ChatLastMessageDto | null;

  @ApiProperty({
    example: 3,
    description: 'Messages in this room the caller has not read.',
  })
  unreadCount: number;

  @ApiPropertyOptional({
    example: 2,
    nullable: true,
    description: 'Members of a direct channel; null for scoped rooms.',
  })
  participantCount: number | null;
}

export class ChatMessageResponseDto {
  @ApiProperty({ example: 'f4a5b6c7-d8e9-4f0a-9b1c-2d3e4f5a6b7c' })
  id: string;

  @ApiProperty({ example: 'c3d4e5f6-a7b8-4c9d-0e1f-2a3b4c5d6e7f' })
  channelId: string;

  @ApiProperty({ example: '9a2b7c1d-4e5f-4a6b-8c9d-0e1f2a3b4c5d' })
  senderId: string;

  @ApiProperty({ type: ChatSenderDto })
  sender: ChatSenderDto;

  @ApiProperty({ example: 'Deploy is green — moving on to the billing flow.' })
  body: string;

  @ApiPropertyOptional({ example: null, nullable: true })
  editedAt: Date | null;

  @ApiProperty({ example: '2026-10-01T10:00:00.000Z' })
  createdAt: Date;
}

export class MessageResultDto {
  @ApiProperty({ example: 'Message deleted' })
  message: string;
}

export class MarkReadResultDto {
  @ApiProperty({ example: '2026-10-01T10:05:00.000Z' })
  lastReadAt: Date;
}

const ChatChannelPageDto = PaginatedSchema(
  ChatChannelListEntryDto,
  'ChatChannelPage',
);
const ChatMessagePageDto = PaginatedSchema(
  ChatMessageResponseDto,
  'ChatMessagePage',
);

/**
 * Chat rooms and messages.
 *
 * Every route is organization-scoped through the standard guard chain; direct
 * channels narrow further to their participants inside the service. Messages
 * are only ever written here — the websocket gateway relays them, it never
 * accepts one — so permissions and org scoping are enforced on every write by
 * the same pipeline as the rest of the API.
 */
@ApiRateLimited()
@ApiTags('chat')
@Protected()
@Controller('chat')
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Get('channels')
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.CHAT_VIEW)
  @ApiOperation({
    summary: 'List your chat channels',
    description:
      'Every room in the organization you may see — the org-wide channel, ' +
      'scoped project/task/subtask rooms and your direct channels — busiest ' +
      'first. The org-wide room is created on first call. Each entry carries ' +
      'the last message and your unread count.',
  })
  @ApiResponse({ description: 'One page of channels', status: 200, type: ChatChannelPageDto })
  @ApiErrors(401, 403)
  async listChannels(
    @OrgAuth() auth: OrganizationAuthContext,
    @Query() query: ChatChannelQueryDto,
  ): Promise<Paginated<ChannelListEntry>> {
    return this.chatService.listChannels(auth.organizationId, auth.userId, query);
  }

  @Post('channels')
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.CHAT_CREATE)
  @ApiOperation({
    summary: 'Open a direct channel',
    description:
      'Opens (or returns, if one already exists) a direct conversation for ' +
      'exactly the given set of members. `participantIds` is the full set, ' +
      'including yourself, of 2 to 8 active members.',
  })
  @ApiResponse({ description: 'The direct channel', status: 201, type: ChatChannelResponseDto })
  @ApiErrors(400, 401, 403)
  async createDirectChannel(
    @OrgAuth() auth: OrganizationAuthContext,
    @Body() dto: CreateDirectChannelDto,
  ) {
    const channel = await this.chatService.createDirectChannel(
      auth.organizationId,
      auth.userId,
      dto.participantIds,
      dto.name,
    );
    return channel.toResponse();
  }

  // Before `GET channels/:channelId` on purpose: Express matches in order, and
  // `scope` must not be read as a channel id.
  @Get('channels/scope')
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.CHAT_VIEW)
  @ApiOperation({
    summary: 'Resolve a scoped channel',
    description:
      'The room of one project, task or subtask — or of the organization ' +
      'itself — created the first time anybody asks for it. Call this when ' +
      'the user opens that record’s conversation and use the returned ' +
      '`channel.id` for messages and socket joins. The scope must belong to ' +
      'this organization and not be in the trash, or the answer is 404.',
  })
  @ApiResponse({ description: 'The room for that scope', status: 200, type: ChatChannelListEntryDto })
  @ApiErrors(400, 401, 403, 404)
  async resolveScopedChannel(
    @OrgAuth() auth: OrganizationAuthContext,
    @Query() dto: ResolveChannelDto,
  ): Promise<ChannelListEntry> {
    return this.chatService.resolveScopedChannel(
      auth.organizationId,
      auth.userId,
      dto,
    );
  }

  @Get('channels/:channelId')
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.CHAT_VIEW)
  @ApiOperation({
    summary: 'One channel',
    description:
      'A channel you have access to. Direct channels answer 404 for anyone ' +
      'outside them, so their ids cannot be probed, and list their members ' +
      '(`participants`); scoped rooms return `participants: null`.',
  })
  @ApiResponse({ description: 'The channel', status: 200, type: ChatChannelResponseDto })
  @ApiErrors(401, 403, 404)
  async getChannel(
    @OrgAuth() auth: OrganizationAuthContext,
    @Param('channelId', ParseUUIDPipe) channelId: string,
  ): Promise<ReturnType<ChatChannel['toResponse']> & { participants: ChatParticipantDto[] | null }> {
    const { channel, participants } = await this.chatService.getChannelDetail(
      auth.organizationId,
      channelId,
      auth.userId,
    );
    return { ...channel.toResponse(), participants };
  }

  @Get('channels/:channelId/messages')
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.CHAT_VIEW)
  @ApiOperation({
    summary: 'Messages in a channel',
    description: 'Newest first. Soft-deleted messages are omitted entirely.',
  })
  @ApiResponse({ description: 'One page of messages', status: 200, type: ChatMessagePageDto })
  @ApiErrors(401, 403, 404)
  async listMessages(
    @OrgAuth() auth: OrganizationAuthContext,
    @Param('channelId', ParseUUIDPipe) channelId: string,
    @Query() query: ChatMessageQueryDto,
  ): Promise<Paginated<ChatMessageResponseDto>> {
    const page = await this.chatService.listMessages(
      auth.organizationId,
      channelId,
      auth.userId,
      query,
    );
    return { ...page, items: page.items.map((item) => item.toResponse()) };
  }

  @Post('channels/:channelId/messages')
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.CHAT_CREATE)
  @ApiOperation({
    summary: 'Send a message',
    description:
      'Writes the message and pushes it to everyone in the room over their ' +
      'open sockets. Sending marks the message read for you.',
  })
  @ApiResponse({ description: 'The message', status: 201, type: ChatMessageResponseDto })
  @ApiErrors(400, 401, 403, 404)
  async sendMessage(
    @OrgAuth() auth: OrganizationAuthContext,
    @Param('channelId', ParseUUIDPipe) channelId: string,
    @Body() dto: SendMessageDto,
  ): Promise<ChatMessageResponseDto> {
    const message = await this.chatService.sendMessage(
      auth.organizationId,
      channelId,
      auth.userId,
      dto.body,
    );
    return message.toResponse();
  }

  @Patch('messages/:messageId')
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.CHAT_CREATE)
  @ApiOperation({
    summary: 'Edit your message',
    description: 'Sender-only. The edit is announced to the room with `editedAt` set.',
  })
  @ApiResponse({ description: 'The message', status: 200, type: ChatMessageResponseDto })
  @ApiErrors(400, 401, 403, 404)
  async editMessage(
    @OrgAuth() auth: OrganizationAuthContext,
    @Param('messageId', ParseUUIDPipe) messageId: string,
    @Body() dto: EditMessageDto,
  ): Promise<ChatMessageResponseDto> {
    const message = await this.chatService.editMessage(
      auth.organizationId,
      messageId,
      auth.userId,
      dto.body,
    );
    return message.toResponse();
  }

  @Delete('messages/:messageId')
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.CHAT_CREATE)
  @HttpCode(200)
  @ApiOperation({
    summary: 'Delete a message',
    description:
      'Soft-deletes it and tells the room to drop it. Your own message, or ' +
      'anybody\'s with `chat.manage`.',
  })
  @ApiResponse({ description: 'The message is gone from every list', status: 200, type: MessageResultDto })
  @ApiErrors(401, 403, 404)
  async deleteMessage(
    @OrgAuth() auth: OrganizationAuthContext,
    @Param('messageId', ParseUUIDPipe) messageId: string,
  ): Promise<MessageResultDto> {
    await this.chatService.deleteMessage(
      auth.organizationId,
      messageId,
      auth.userId,
      auth.permissions,
    );
    return { message: 'Message deleted' };
  }

  @Post('channels/:channelId/read')
  @OrganizationHeader()
  @RequirePermissions(PERMISSIONS.CHAT_VIEW)
  @HttpCode(200)
  @ApiOperation({
    summary: 'Mark a channel read',
    description:
      'Moves your read marker to now, or to a specific message with ' +
      '`upToMessageId`. The room is told, so other clients holding the same ' +
      'account refresh their badges.',
  })
  @ApiResponse({ description: 'Your new read marker', status: 200, type: MarkReadResultDto })
  @ApiErrors(401, 403, 404)
  async markRead(
    @OrgAuth() auth: OrganizationAuthContext,
    @Param('channelId', ParseUUIDPipe) channelId: string,
    @Body() dto: MarkReadDto,
  ): Promise<MarkReadResultDto> {
    const lastReadAt = await this.chatService.markRead(
      auth.organizationId,
      channelId,
      auth.userId,
      dto,
    );
    return { lastReadAt };
  }
}
