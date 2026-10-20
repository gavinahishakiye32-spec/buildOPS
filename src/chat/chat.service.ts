import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, FindOptionsWhere, In, IsNull, Repository, type EntityManager } from 'typeorm';
import {
  resolvePage,
  toPaginated,
  type Paginated,
} from '../common/pagination.dto.js';
import { MembershipResolver } from '../common/membership.js';
import { PERMISSIONS, type PermissionName } from '../common/permissions.js';
import { Project } from '../project/project.entity.js';
import { Role } from '../role/role.entity.js';
import { Subtask } from '../subtask/subtask.entity.js';
import { Task } from '../task/task.entity.js';
import { User } from '../user/user.entity.js';
import { ChatEmitter } from './chat-emitter.js';
import {
  AUTO_CHAT_CHANNEL_TYPES,
  ChatChannel,
  ChatChannelParticipant,
  ChatMessage,
} from './chat.entity.js';
import {
  type ChatChannelQueryDto,
  type MarkReadDto,
  type ResolveChannelDto,
} from './dto/chat.dto.js';

/** Scopes a room can be opened for; `direct` is created explicitly, never ensured. */
export type AutoChannelType = (typeof AUTO_CHAT_CHANNEL_TYPES)[number];

export interface ChannelListEntry {
  channel: ReturnType<ChatChannel['toResponse']>;
  lastMessage: {
    id: string;
    body: string;
    senderId: string;
    createdAt: Date;
  } | null;
  unreadCount: number;
  /** Members of a direct channel; `null` for the org-wide room. */
  participantCount: number | null;
}

/** How a socket authenticates and scopes itself; filled in by the gateway. */
export interface ChatSocketIdentity {
  userId: string;
  organizationId: string;
  permissions: PermissionName[];
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Chat rooms and the messages in them.
 *
 * Three rules everything here follows:
 *
 * 1. **The organization is never taken from the caller.** Every query carries
 *    the `organizationId` the guard resolved from membership, so a channel id
 *    from another tenant answers 404 rather than leaking its existence.
 *
 * 2. **Auto channels are ensured, not created.** The organization/project/task/
 *    subtask room is opened lazily on first use and made unique per scope by
 *    partial indexes, so two clients racing to open the same room converge on
 *    one row. Only direct channels are created explicitly, and they are deduped
 *    per participant set under a transaction-scoped advisory lock, because a
 *    partial unique index cannot express "exactly these members" for a
 *    variable-size set.
 *
 * 3. **Unread is a property of the viewer, not of the message.** It is the count
 *    of live messages in a channel after the viewer's `last_read_at` that they
 *    did not send; the marker lives on the participant row.
 */
@Injectable()
export class ChatService {
  constructor(
    @InjectRepository(ChatChannel)
    private readonly channelRepo: Repository<ChatChannel>,
    @InjectRepository(ChatMessage)
    private readonly messageRepo: Repository<ChatMessage>,
    @InjectRepository(ChatChannelParticipant)
    private readonly participantRepo: Repository<ChatChannelParticipant>,
    @InjectRepository(Role)
    private readonly roleRepo: Repository<Role>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    // Scope records are checked before their room is opened: a foreign or
    // unknown id has to answer 404 here rather than trip the FK on insert.
    @InjectRepository(Project)
    private readonly projectRepo: Repository<Project>,
    @InjectRepository(Task)
    private readonly taskRepo: Repository<Task>,
    @InjectRepository(Subtask)
    private readonly subtaskRepo: Repository<Subtask>,
    @Inject(MembershipResolver)
    private readonly membershipResolver: MembershipResolver,
    // The gateway implements this and re-checks access through the service on
    // socket events; binding the abstract emitter here is what keeps that cycle
    // out of the module graph (see `chat-emitter.ts`).
    @Inject(ChatEmitter)
    private readonly gateway: ChatEmitter,
  ) {}

  /** The caller's rooms, busiest first. Creates the org room on first call. */
  async listChannels(
    organizationId: string,
    userId: string,
    query: ChatChannelQueryDto,
  ): Promise<Paginated<ChannelListEntry>> {
    await this.ensureAutoChannel(organizationId, 'organization', undefined, userId);

    const { page, limit, skip } = resolvePage(query);

    const qb = this.channelRepo
      .createQueryBuilder('channel')
      .where('channel.organization_id = :organizationId', { organizationId });

    if (query.type) {
      qb.andWhere('channel.type = :type', { type: query.type });
    } else {
      // Everything not tied to a scope is listable by any member holding
      // `chat.view` (the controller already checked it); direct channels are
      // only listable by their participants.
      qb.andWhere(
        new Brackets((where) => {
          where
            .where('channel.type <> :direct', { direct: 'direct' })
            .orWhere(
              `EXISTS (SELECT 1 FROM chat_channel_participants p
                       WHERE p.channel_id = channel.id AND p.user_id = :userId)`,
              { userId },
            );
        }),
      );
    }

    qb.orderBy('channel.last_message_at', 'DESC', 'NULLS LAST')
      .addOrderBy('channel.created_at', 'DESC')
      .skip(skip)
      .take(limit);

    const [channels, total] = await qb.getManyAndCount();
    const items = await this.decorateChannels(channels, userId);

    return toPaginated(items, total, page, limit);
  }

  /**
   * The room of one scope, opened on demand — what a client calls when the
   * user opens a project's, task's or subtask's conversation.
   *
   * The scope is proven against this organization *before* the room is
   * touched: an unknown id, a record in the trash and a record of another
   * tenant all answer the same 404, so the route cannot be used to probe what
   * exists elsewhere. The room itself is then ensured exactly like the
   * organization one, with the same race lost to the partial unique index.
   */
  async resolveScopedChannel(
    organizationId: string,
    userId: string,
    dto: ResolveChannelDto,
  ): Promise<ChannelListEntry> {
    const scopeKey =
      dto.type === 'organization'
        ? null
        : dto.type === 'project'
          ? 'projectId'
          : dto.type === 'task'
            ? 'taskId'
            : 'subtaskId';

    const present = (['projectId', 'taskId', 'subtaskId'] as const).filter(
      (key) => dto[key] !== undefined,
    );

    if (scopeKey === null) {
      if (present.length > 0) {
        throw new BadRequestException('An organization room takes no scope id');
      }
    } else {
      if (present.some((key) => key !== scopeKey)) {
        throw new BadRequestException(`${dto.type} rooms take only ${scopeKey}`);
      }
      if (dto[scopeKey] === undefined) {
        throw new BadRequestException(
          `${scopeKey} is required for a ${dto.type} room`,
        );
      }
    }

    const scopeId = scopeKey ? dto[scopeKey] : undefined;
    await this.requireScopeRecord(organizationId, dto.type, scopeId);

    const channel = await this.ensureAutoChannel(
      organizationId,
      dto.type,
      scopeId,
      userId,
    );
    const [entry] = await this.decorateChannels([channel], userId);
    return entry;
  }

  /** Opens (or returns) a direct channel for exactly this set of members. */
  async createDirectChannel(
    organizationId: string,
    userId: string,
    participantIds: string[],
    name?: string,
  ): Promise<ChatChannel> {
    if (!participantIds.includes(userId)) {
      throw new BadRequestException(
        'participantIds must include you — it is the full member set of the conversation',
      );
    }

    const members = await this.roleRepo.find({
      where: {
        organizationId,
        status: 'active',
        userId: In(participantIds),
      },
      select: { userId: true },
    });

    const found = new Set(
      members.map((role) => role.userId).filter((id): id is string => !!id),
    );
    const missing = participantIds.filter((id) => !found.has(id));
    if (missing.length) {
      throw new BadRequestException(
        `Not active members of this organization: ${missing.join(', ')}`,
      );
    }

    return this.channelRepo.manager.transaction(async (manager) => {
      // A partial unique index cannot cover "exactly this set of participants",
      // so two clients opening the same pair at once would each insert a room.
      // The advisory lock serialises that one decision per participant set.
      const lockKey = [
        organizationId,
        [...participantIds].sort().join(','),
      ].join('|');
      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        lockKey,
      ]);

      // Total participants must equal the requested set's size and every
      // participant must be in that set — either alone would match a channel
      // that merely overlaps with it.
      const existing = await manager.query(
        `SELECT c."id" AS id
           FROM "chat_channels" c
           JOIN "chat_channel_participants" p ON p."channel_id" = c."id"
          WHERE c."organization_id" = $1
            AND c."type" = 'direct'
          GROUP BY c."id"
         HAVING COUNT(*) = $2
            AND COUNT(*) FILTER (WHERE p."user_id" = ANY($3::uuid[])) = $2
          LIMIT 1`,
        [organizationId, participantIds.length, participantIds],
      );

      if (existing.length > 0) {
        const raced = await manager
          .getRepository(ChatChannel)
          .findOne({ where: { id: existing[0].id as string } });
        if (raced) {
          return raced;
        }
      }

      const channels = manager.getRepository(ChatChannel);
      const channel = await channels.save(
        channels.create({
          organizationId,
          type: 'direct',
          name: name ?? null,
          createdBy: userId,
        }),
      );

      const participants = manager.getRepository(ChatChannelParticipant);
      await participants.save(
        participantIds.map((participantId) =>
          participants.create({
            channelId: channel.id,
            userId: participantId,
            lastReadAt: participantId === userId ? new Date() : null,
          }),
        ),
      );

      return channel;
    });
  }

  /** One channel, with the caller proven allowed to see it. */
  async getChannel(
    organizationId: string,
    channelId: string,
    userId: string,
  ): Promise<ChatChannel> {
    const channel = await this.channelRepo.findOne({
      where: { id: channelId, organizationId },
    });

    // A DM the caller is not in is answered the same way as one that does not
    // exist: a channel id is an opaque handle, and a distinct 403 would turn
    // guessing one into an oracle for who is talking to whom.
    if (!channel) {
      throw new NotFoundException('Channel not found');
    }

    if (channel.type === 'direct') {
      const participant = await this.participantRepo.findOne({
        where: { channelId: channel.id, userId },
      });
      if (!participant) {
        throw new NotFoundException('Channel not found');
      }
      return channel;
    }

    // Opening a scoped room is joining it: the row is what the read marker
    // and the participant count hang off. The conflict clause keeps this a
    // pure membership upsert — it must never move an existing read marker.
    await this.participantRepo.query(
      `INSERT INTO "chat_channel_participants" ("channel_id", "user_id", "joined_at")
       VALUES ($1, $2, now())
       ON CONFLICT ("channel_id", "user_id") DO NOTHING`,
      [channel.id, userId],
    );

    return channel;
  }

  /** One channel plus, for a direct channel, the people in it. */
  async getChannelDetail(
    organizationId: string,
    channelId: string,
    userId: string,
  ): Promise<{
    channel: ChatChannel;
    participants: { id: string; name: string | null }[] | null;
  }> {
    const channel = await this.getChannel(organizationId, channelId, userId);

    if (channel.type !== 'direct') {
      return { channel, participants: null };
    }

    const rows = await this.participantRepo
      .createQueryBuilder('participant')
      .innerJoin(User, 'user', 'user.id = participant.user_id')
      .select(['participant.user_id AS "user_id"', 'user.name AS "name"'])
      .where('participant.channel_id = :channelId', { channelId })
      .orderBy('participant.joined_at', 'ASC')
      .getRawMany<{ user_id: string; name: string | null }>();

    return {
      channel,
      participants: rows.map((row) => ({ id: row.user_id, name: row.name })),
    };
  }

  /** One page of a channel's messages, newest first. Soft-deleted are gone. */
  async listMessages(
    organizationId: string,
    channelId: string,
    userId: string,
    query: { page?: number; limit?: number },
  ): Promise<Paginated<ChatMessage>> {
    await this.getChannel(organizationId, channelId, userId);

    const { page, limit, skip } = resolvePage(query);

    const [items, total] = await this.messageRepo.findAndCount({
      where: { organizationId, channelId, deletedAt: IsNull() },
      relations: { sender: true },
      order: { createdAt: 'DESC' },
      skip,
      take: limit,
    });

    return toPaginated(items, total, page, limit);
  }

  /** Writes a message and tells everyone in the room about it, atomically. */
  async sendMessage(
    organizationId: string,
    channelId: string,
    userId: string,
    body: string,
  ): Promise<ChatMessage> {
    await this.getChannel(organizationId, channelId, userId);
    const sender = await this.userRepo.findOne({ where: { id: userId } });
    if (!sender) {
      throw new ForbiddenException('Your account no longer exists');
    }

    const trimmed = body.trim();
    if (!trimmed) {
      throw new BadRequestException('Message body cannot be blank');
    }

    const message = await this.messageRepo.manager.transaction(
      async (manager) => {
        const messages = manager.getRepository(ChatMessage);
        const saved = await messages.save(
          messages.create({
            organizationId,
            channelId,
            senderId: userId,
            sender,
            body: trimmed,
          }),
        );

        await manager.getRepository(ChatChannel).update(
          { id: channelId, organizationId },
          { lastMessageAt: saved.createdAt },
        );

        // Sending is reading: without this, your own messages would count as
        // unread until you happened to open the room.
        await this.touchParticipant(manager, channelId, userId, saved.createdAt);

        return saved;
      },
    );

    this.gateway.emitToChannel(channelId, 'message:created', {
      ...message.toResponse(),
    });

    return message;
  }

  /** Sender-only. Edited messages carry `editedAt`; the original is not kept. */
  async editMessage(
    organizationId: string,
    messageId: string,
    userId: string,
    body: string,
  ): Promise<ChatMessage> {
    const message = await this.loadLiveMessage(organizationId, messageId);

    if (message.senderId !== userId) {
      throw new ForbiddenException('You can only edit your own messages');
    }

    const trimmed = body.trim();
    if (!trimmed) {
      throw new BadRequestException('Message body cannot be blank');
    }

    message.body = trimmed;
    message.editedAt = new Date();
    const saved = await this.messageRepo.save(message);

    this.gateway.emitToChannel(message.channelId, 'message:updated', {
      ...saved.toResponse(),
    });

    return saved;
  }

  /**
   * Soft-deletes a message: the sender, or anybody holding `chat.manage`.
   * Clients have already rendered the row, so it becomes a tombstone (dropped
   * from every list, announced to the room) rather than vanishing silently.
   */
  async deleteMessage(
    organizationId: string,
    messageId: string,
    userId: string,
    permissions: PermissionName[],
  ): Promise<void> {
    const message = await this.loadLiveMessage(organizationId, messageId);
    const canModerate = permissions.includes(PERMISSIONS.CHAT_MANAGE);

    if (message.senderId !== userId && !canModerate) {
      throw new ForbiddenException(
        'You can only delete your own messages unless you can manage chat',
      );
    }

    message.deletedAt = new Date();
    message.deletedBy = userId;
    await this.messageRepo.save(message);

    this.gateway.emitToChannel(message.channelId, 'message:deleted', {
      id: message.id,
      channelId: message.channelId,
    });
  }

  /** Moves the caller's read marker and tells the room so badges can refresh. */
  async markRead(
    organizationId: string,
    channelId: string,
    userId: string,
    dto: MarkReadDto,
  ): Promise<Date> {
    await this.getChannel(organizationId, channelId, userId);

    let readAt = new Date();

    if (dto.upToMessageId) {
      const upTo = await this.messageRepo.findOne({
        where: {
          id: dto.upToMessageId,
          organizationId,
          channelId,
          deletedAt: IsNull(),
        },
      });
      if (!upTo) {
        throw new NotFoundException('Message not found in this channel');
      }
      readAt = upTo.createdAt;
    }

    await this.participantRepo.manager.transaction(async (manager) => {
      await this.touchParticipant(manager, channelId, userId, readAt);
    });

    this.gateway.emitToChannel(channelId, 'channel:read', {
      channelId,
      userId,
      lastReadAt: readAt,
    });

    return readAt;
  }

  /**
   * Membership + permission check for a socket event. The REST pipeline runs
   * `PermissionsGuard`; a socket has no HTTP context, so the gateway asks the
   * service to run the same decision against the same resolver.
   */
  async assertSocketAccess(
    identity: ChatSocketIdentity,
    channelId: string,
    required: PermissionName,
  ): Promise<ChatChannel> {
    if (!identity.permissions.includes(required)) {
      throw new ForbiddenException(`Missing required permission: ${required}`);
    }

    return this.getChannel(identity.organizationId, channelId, identity.userId);
  }

  /** Resolves a socket's organization + permissions at connect time. */
  async resolveSocketIdentity(
    organizationId: string,
    userId: string,
  ): Promise<ChatSocketIdentity | null> {
    if (!UUID_PATTERN.test(organizationId)) {
      return null;
    }

    const membership = await this.membershipResolver.resolve(
      organizationId,
      userId,
    );
    if (!membership) {
      return null;
    }

    return { userId, organizationId, permissions: membership.permissions };
  }

  /**
   * Proves the record a scoped room is about exists inside this organization.
   * Trash rows count as gone (the repositories filter `deleted_at`), and a
   * record of another tenant is indistinguishable from one that never existed.
   */
  private async requireScopeRecord(
    organizationId: string,
    type: AutoChannelType,
    scopeId?: string,
  ): Promise<void> {
    if (type === 'project') {
      const project = await this.projectRepo.findOne({
        where: { id: scopeId as string, organizationId },
      });
      if (!project) {
        throw new NotFoundException('Project not found');
      }
      return;
    }

    if (type === 'task') {
      // A task carries no organization of its own: the project it hangs off
      // is the tenant boundary, as `TaskService.scopedQuery` sees it too.
      const task = await this.taskRepo
        .createQueryBuilder('task')
        .innerJoin(Project, 'project', 'project.id = task.project_id')
        .where('task.id = :taskId', { taskId: scopeId })
        .andWhere(
          'project.organization_id = :organizationId',
          { organizationId },
        )
        .getOne();
      if (!task) {
        throw new NotFoundException('Task not found');
      }
      return;
    }

    if (type === 'subtask') {
      const subtask = await this.subtaskRepo
        .createQueryBuilder('subtask')
        .innerJoin(Task, 'task', 'task.id = subtask.task_id')
        .innerJoin(Project, 'project', 'project.id = task.project_id')
        .where('subtask.id = :subtaskId', { subtaskId: scopeId })
        .andWhere(
          'project.organization_id = :organizationId',
          { organizationId },
        )
        .getOne();
      if (!subtask) {
        throw new NotFoundException('Subtask not found');
      }
    }
  }

  /**
   * Opens (or returns) the one room of a scope.
   *
   * The partial unique index makes this race-safe: two clients resolving at
   * once both try to insert, one loses on the constraint, and the loser reads
   * the winner's row instead of raising. Only the organization room gets a
   * name; scoped rooms take theirs from the record they belong to.
   */
  private async ensureAutoChannel(
    organizationId: string,
    type: AutoChannelType,
    scopeId: string | undefined,
    userId: string,
  ): Promise<ChatChannel> {
    const scopeColumn =
      type === 'project'
        ? 'projectId'
        : type === 'task'
          ? 'taskId'
          : type === 'subtask'
            ? 'subtaskId'
            : null;

    const where: FindOptionsWhere<ChatChannel> = { organizationId, type };
    if (scopeColumn && scopeId) {
      where[scopeColumn] = scopeId;
    }

    const existing = await this.channelRepo.findOne({ where });
    if (existing) {
      return existing;
    }

    try {
      const channels = this.channelRepo;
      const channel = channels.create({
        organizationId,
        type,
        name: type === 'organization' ? 'General' : null,
        createdBy: userId,
      });
      if (scopeColumn && scopeId) {
        channel[scopeColumn] = scopeId;
      }
      return await channels.save(channel);
    } catch (error) {
      if (isUniqueViolation(error)) {
        const raced = await this.channelRepo.findOne({ where });
        if (raced) {
          return raced;
        }
      }
      throw error;
    }
  }

  /**
   * Decorates one page of channels with the preview, the viewer's unread count
   * and (for DMs) their size — each in one grouped query for the whole page,
   * rather than three queries per row.
   */
  private async decorateChannels(
    channels: ChatChannel[],
    userId: string,
  ): Promise<ChannelListEntry[]> {
    if (channels.length === 0) {
      return [];
    }

    const channelIds = channels.map((channel) => channel.id);

    const lastMessages = await this.messageRepo
      .createQueryBuilder('message')
      .select([
        'message.channel_id AS channel_id',
        'message.id AS id',
        'message.body AS body',
        'message.sender_id AS sender_id',
        'message.created_at AS created_at',
      ])
      .where('message.channel_id IN (:...channelIds)', { channelIds })
      .andWhere('message.deleted_at IS NULL')
      .orderBy('message.created_at', 'DESC')
      .groupBy('message.channel_id')
      .addGroupBy('message.id')
      .addGroupBy('message.body')
      .addGroupBy('message.sender_id')
      .addGroupBy('message.created_at')
      .getRawMany<{
        channel_id: string;
        id: string;
        body: string;
        sender_id: string;
        created_at: Date;
      }>();

    const unreadRows = await this.messageRepo
      .createQueryBuilder('message')
      .select('message.channel_id', 'channel_id')
      .addSelect('COUNT(*)', 'unread')
      .innerJoin(
        ChatChannel,
        'channel',
        'channel.id = message.channel_id',
      )
      .leftJoin(
        ChatChannelParticipant,
        'participant',
        'participant.channel_id = message.channel_id AND participant.user_id = :userId',
        { userId },
      )
      .where('message.channel_id IN (:...channelIds)', { channelIds })
      .andWhere('message.deleted_at IS NULL')
      .andWhere('message.sender_id <> :userId', { userId })
      .andWhere(
        '(participant.last_read_at IS NULL OR message.created_at > participant.last_read_at)',
      )
      .groupBy('message.channel_id')
      .getRawMany<{ channel_id: string; unread: string }>();

    const dmIds = channels
      .filter((channel) => channel.type === 'direct')
      .map((channel) => channel.id);

    const sizes = dmIds.length
      ? await this.participantRepo
          .createQueryBuilder('participant')
          .select('participant.channel_id', 'channel_id')
          .addSelect('COUNT(*)', 'size')
          .where('participant.channel_id IN (:...dmIds)', { dmIds })
          .groupBy('participant.channel_id')
          .getRawMany<{ channel_id: string; size: string }>()
      : [];

    const lastByChannel = new Map(
      lastMessages.map((row) => [row.channel_id, row]),
    );
    const unreadByChannel = new Map(
      unreadRows.map((row) => [row.channel_id, Number(row.unread)]),
    );
    const sizeByChannel = new Map(
      sizes.map((row) => [row.channel_id, Number(row.size)]),
    );

    return channels.map((channel) => {
      const last = lastByChannel.get(channel.id);
      return {
        channel: channel.toResponse(),
        lastMessage: last
          ? {
              id: last.id,
              body: last.body,
              senderId: last.sender_id,
              createdAt: last.created_at,
            }
          : null,
        unreadCount: unreadByChannel.get(channel.id) ?? 0,
        participantCount:
          channel.type === 'direct'
            ? (sizeByChannel.get(channel.id) ?? 0)
            : null,
      };
    });
  }

  private async loadLiveMessage(
    organizationId: string,
    messageId: string,
  ): Promise<ChatMessage> {
    const message = await this.messageRepo.findOne({
      where: { id: messageId, organizationId, deletedAt: IsNull() },
    });
    if (!message) {
      throw new NotFoundException('Message not found');
    }
    return message;
  }

  /** Upserts the participant row and moves its read marker forward. */
  private async touchParticipant(
    manager: EntityManager,
    channelId: string,
    userId: string,
    readAt: Date,
  ): Promise<void> {
    await manager.query(
      `INSERT INTO "chat_channel_participants"
         ("channel_id", "user_id", "last_read_at", "joined_at")
       VALUES ($1, $2, $3, now())
       ON CONFLICT ("channel_id", "user_id")
       DO UPDATE SET "last_read_at" = GREATEST(
         COALESCE("chat_channel_participants"."last_read_at", $3::timestamp),
         $3::timestamp
       )`,
      [channelId, userId, readAt],
    );
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === '23505'
  );
}
