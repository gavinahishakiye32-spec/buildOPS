import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/pagination.dto.js';
import {
  AUTO_CHAT_CHANNEL_TYPES,
  CHAT_CHANNEL_TYPES,
  type ChatChannelType,
} from '../chat.entity.js';

export const MIN_DM_PARTICIPANTS = 2;
export const MAX_DM_PARTICIPANTS = 8;
export const MAX_MESSAGE_LENGTH = 4000;

/**
 * Opens a direct channel. `participantIds` is the *full* set, caller included:
 * accepting "the others" would mean the caller's own membership of the room
 * depends on the service remembering to add it, which is one refactor away from
 * a room its creator cannot open.
 */
export class CreateDirectChannelDto {
  @ApiProperty({
    description:
      'Every member of the conversation, including yourself. 2–8 active members of the organization.',
    minItems: MIN_DM_PARTICIPANTS,
    maxItems: MAX_DM_PARTICIPANTS,
    example: [
      '9a2b7c1d-4e5f-4a6b-8c9d-0e1f2a3b4c5d',
      '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e',
    ],
  })
  @IsUUID('4', { each: true })
  @ArrayUnique()
  @ArrayMinSize(MIN_DM_PARTICIPANTS)
  @ArrayMaxSize(MAX_DM_PARTICIPANTS)
  participantIds: string[];

  @ApiPropertyOptional({
    example: 'Launch planning',
    maxLength: 255,
    description: 'Optional label for the conversation.',
  })
  @IsOptional()
  @IsString()
  @Length(1, 255)
  name?: string;
}

export class SendMessageDto {
  @ApiProperty({
    example: 'Deploy is green — moving on to the billing flow.',
    maxLength: MAX_MESSAGE_LENGTH,
  })
  @IsString()
  @Length(1, MAX_MESSAGE_LENGTH)
  body: string;
}

export class EditMessageDto {
  @ApiProperty({ example: 'Deploy is green — moving to billing.', maxLength: MAX_MESSAGE_LENGTH })
  @IsString()
  @Length(1, MAX_MESSAGE_LENGTH)
  body: string;
}

export class MarkReadDto {
  @ApiPropertyOptional({
    description:
      'Read up to (and including) this message instead of "now". Must be in the same channel.',
  })
  @IsOptional()
  @IsUUID('4')
  upToMessageId?: string;
}

export class ChatChannelQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    enum: CHAT_CHANNEL_TYPES,
    description: 'Restrict the list to one kind of room.',
  })
  @IsOptional()
  @IsIn(CHAT_CHANNEL_TYPES)
  type?: ChatChannelType;
}

/**
 * Paging for a channel's message history. Deliberately carries no filters:
 * a conversation is read start-to-end, and a filter that silently narrows it
 * would make "what did I miss" unanswerable from the client.
 */
export class ChatMessageQueryDto extends PaginationQueryDto {}

/**
 * Resolves the room of one scope, opening it if nobody has asked for it yet.
 *
 * The scope id has to match the `type` and nothing else may be sent, but that
 * pairing is a service-level rule rather than a class-validator constraint:
 * "project takes projectId, task takes taskId" spans three optional fields in
 * a way a single decorator cannot express, and the service answers with one
 * plain 400 string instead of a field-by-field array the client would have to
 * assemble itself.
 */
export class ResolveChannelDto {
  @ApiProperty({
    enum: AUTO_CHAT_CHANNEL_TYPES,
    description:
      'Whose room to resolve. `direct` is absent on purpose — direct rooms are ' +
      'opened through POST /chat/channels, not resolved.',
    example: 'project',
  })
  @IsIn([...AUTO_CHAT_CHANNEL_TYPES])
  type: (typeof AUTO_CHAT_CHANNEL_TYPES)[number];

  @ApiPropertyOptional({
    description: 'Required for `type=project`, forbidden for every other type.',
  })
  @IsOptional()
  @IsUUID('4')
  projectId?: string;

  @ApiPropertyOptional({
    description: 'Required for `type=task`, forbidden for every other type.',
  })
  @IsOptional()
  @IsUUID('4')
  taskId?: string;

  @ApiPropertyOptional({
    description: 'Required for `type=subtask`, forbidden for every other type.',
  })
  @IsOptional()
  @IsUUID('4')
  subtaskId?: string;
}
