/**
 * The emit half of the chat gateway, as the service sees it.
 *
 * The service drives broadcasts (a message was written, a marker moved) but
 * must not import the gateway: the gateway imports the service to re-check
 * access on socket events, and under ESM that cycle evaluates one module
 * before the other's bindings exist. Depending on this interface instead keeps
 * the runtime edge one-directional — gateway → service — and leaves the
 * binding to the module, which knows about both.
 */
export abstract class ChatEmitter {
  abstract emitToChannel(channelId: string, event: string, payload: unknown): void;
  abstract emitToUser(userId: string, event: string, payload: unknown): void;
}
