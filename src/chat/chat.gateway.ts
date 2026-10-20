import {
  BadRequestException,
  ForbiddenException,
  forwardRef,
  Inject,
  Logger,
  NotFoundException,
  UseGuards,
} from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { resolveAllowedOrigins } from '../bootstrap.js';
import { PERMISSIONS } from '../common/permissions.js';
import type { AuthenticatedUser } from '../common/types.js';
import { ChatEmitter } from './chat-emitter.js';
import { ChatService, type ChatSocketIdentity } from './chat.service.js';
import { authenticateHandshake, WsJwtAuthGuard } from './ws-jwt-auth.guard.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface JoinChannelPayload {
  channelId: string;
}

export interface TypingPayload {
  channelId: string;
  isTyping?: boolean;
}

interface SocketWithIdentity extends Socket {
  data: {
    user?: AuthenticatedUser;
    chat?: ChatSocketIdentity;
    channels?: Set<string>;
    /**
     * Set synchronously by `handleConnection`, before its first `await`:
     * resolves with the identity — or `null` once the handshake is refused —
     * so an event racing the connect handshake waits for the decision instead
     * of finding no identity and reporting a bogus "not authenticated".
     */
    ready?: Promise<ChatSocketIdentity | null>;
  };
}

/**
 * The realtime half of chat.
 *
 * A socket is not an HTTP request: there is no guard pipeline carrying the
 * caller's organization and permissions, so this gateway resolves them once at
 * connection time (via the same `MembershipResolver` the REST guards use) and
 * re-checks channel access on every join and typing event. Membership can be
 * revoked while a socket is open; because every server-side emit goes through
 * room membership that was verified at join time *and* the service re-checks
 * access on the REST write path, a revoked member stops receiving new messages
 * the next time their client reconnects or re-joins — and can no longer send
 * through REST at all, which is where messages actually come from.
 *
 * Messages are only ever *written* through the REST controller (the service
 * broadcasts them from there); sockets receive them and drive the ephemeral
 * extras — joins, leaves, typing, read receipts.
 */
@UseGuards(WsJwtAuthGuard)
@WebSocketGateway({
  namespace: '/chat',
  cors: {
    origin: resolveAllowedOrigins(),
    credentials: true,
  },
})
export class ChatGateway
  extends ChatEmitter
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(ChatGateway.name);

  constructor(
    // One half of the service ⇄ gateway cycle (the other half is the
    // `ChatEmitter` binding in the module); `forwardRef` lets Nest untangle it.
    @Inject(forwardRef(() => ChatService))
    private readonly chatService: ChatService,
  ) {
    super();
  }

  /**
   * Validates the connected user against the organization they claim in the
   * handshake. The token proved who they are; this proves they still belong
   * and may read chat before any room is joined.
   */
  async handleConnection(client: SocketWithIdentity): Promise<void> {
    // Published before anything can await: Nest subscribes the message
    // handlers right after this hook starts, so an event may land while the
    // handshake below is still being validated.
    let decide!: (identity: ChatSocketIdentity | null) => void;
    client.data.ready = new Promise<ChatSocketIdentity | null>((resolve) => {
      decide = resolve;
    });

    try {
      const handshake = client.handshake as typeof client.handshake & {
        user?: AuthenticatedUser;
      };
      const organizationId = (client.handshake.auth as { organizationId?: unknown })
        .organizationId;

      // The class-level guard authenticates every message event, but Nest
      // runs `handleConnection` without enhancers, so the handshake has to be
      // authenticated right here — through the same `jwt` strategy, or a
      // socket would be accepted on connect and refused only on its first
      // event. Where a guard-authenticated connection does arrive (some Nest
      // wiring runs guards for it), that result is trusted rather than
      // verifying the same token twice.
      let user = handshake.user;
      if (!user) {
        try {
          user = await authenticateHandshake(handshake);
        } catch {
          decide(null);
          client.emit('chat:error', { message: 'Unauthorized' });
          client.disconnect(true);
          return;
        }
      }

      if (typeof organizationId !== 'string' || !UUID_PATTERN.test(organizationId)) {
        decide(null);
        client.emit('chat:error', {
          message: 'A valid organizationId is required in the handshake auth',
        });
        client.disconnect(true);
        return;
      }

      const identity = await this.chatService.resolveSocketIdentity(
        organizationId,
        user.id,
      );

      if (!identity) {
        decide(null);
        client.emit('chat:error', {
          message: 'You do not have access to this organization',
        });
        client.disconnect(true);
        return;
      }

      if (!identity.permissions.includes(PERMISSIONS.CHAT_VIEW)) {
        decide(null);
        client.emit('chat:error', {
          message: `Missing required permission: ${PERMISSIONS.CHAT_VIEW}`,
        });
        client.disconnect(true);
        return;
      }

      client.data.user = user;
      client.data.chat = identity;
      client.data.channels = new Set();
      void client.join(`user:${user.id}`);
      void client.join(`org:${organizationId}`);
      decide(identity);
    } catch (error) {
      decide(null);
      this.logger.warn(
        `chat socket rejected: ${error instanceof Error ? error.message : String(error)}`,
      );
      client.disconnect(true);
    }
  }

  /**
   * Clears typing indicators this socket may have left behind. Socket.IO has
   * already removed the socket from its rooms by the time this runs, so the
   * channels are tracked on `client.data` instead of read back off the socket.
   */
  handleDisconnect(client: SocketWithIdentity): void {
    const identity = client.data.chat;
    const channels = client.data.channels;
    if (!identity || !channels) {
      return;
    }

    for (const channelId of channels) {
      this.server.to(this.channelRoom(channelId)).emit('typing', {
        channelId,
        userId: identity.userId,
        isTyping: false,
      });
    }
  }

  /** Subscribes the socket to a channel's room after a full access check. */
  @SubscribeMessage('channel:join')
  async onChannelJoin(
    @ConnectedSocket() client: SocketWithIdentity,
    @MessageBody() payload: JoinChannelPayload,
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      const identity = await this.requireIdentity(client);
      const channelId = this.requireUuid(payload?.channelId, 'channelId');

      await this.chatService.assertSocketAccess(
        identity,
        channelId,
        PERMISSIONS.CHAT_VIEW,
      );
      await client.join(this.channelRoom(channelId));
      client.data.channels?.add(channelId);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: toAckError(error) };
    }
  }

  @SubscribeMessage('channel:leave')
  async onChannelLeave(
    @ConnectedSocket() client: SocketWithIdentity,
    @MessageBody() payload: JoinChannelPayload,
  ): Promise<{ ok: boolean }> {
    const channelId = this.requireUuid(payload?.channelId, 'channelId');
    await client.leave(this.channelRoom(channelId));
    client.data.channels?.delete(channelId);
    return { ok: true };
  }

  /** Relays a typing indicator. Ephemeral: never persisted, never stored. */
  @SubscribeMessage('typing')
  async onTyping(
    @ConnectedSocket() client: SocketWithIdentity,
    @MessageBody() payload: TypingPayload,
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      const identity = await this.requireIdentity(client);
      const channelId = this.requireUuid(payload?.channelId, 'channelId');

      await this.chatService.assertSocketAccess(
        identity,
        channelId,
        PERMISSIONS.CHAT_VIEW,
      );
      client.to(this.channelRoom(channelId)).emit('typing', {
        channelId,
        userId: identity.userId,
        isTyping: payload.isTyping ?? true,
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: toAckError(error) };
    }
  }

  /** Broadcast to everyone who joined a channel's room. No-op with no sockets. */
  emitToChannel(channelId: string, event: string, payload: unknown): void {
    this.server?.to(this.channelRoom(channelId)).emit(event, payload);
  }

  /** Direct delivery to one user's sockets, across every tab. */
  emitToUser(userId: string, event: string, payload: unknown): void {
    this.server?.to(`user:${userId}`).emit(event, payload);
  }

  private channelRoom(channelId: string): string {
    return `channel:${channelId}`;
  }

  private async requireIdentity(
    client: SocketWithIdentity,
  ): Promise<ChatSocketIdentity> {
    // An event can overtake the connect handshake's awaits; wait for its
    // verdict rather than failing a legitimate client for being fast.
    const identity = client.data.chat ?? (await client.data.ready);
    if (!identity) {
      throw new ForbiddenException('Not authenticated');
    }
    return identity;
  }

  private requireUuid(value: unknown, field: string): string {
    if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
      throw new BadRequestException(`${field} must be a uuid`);
    }
    return value;
  }
}

function toAckError(error: unknown): string {
  if (
    error instanceof BadRequestException ||
    error instanceof ForbiddenException ||
    error instanceof NotFoundException
  ) {
    return error.message;
  }
  return 'Unexpected error';
}
