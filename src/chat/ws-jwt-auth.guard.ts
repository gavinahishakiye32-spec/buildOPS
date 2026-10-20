import { UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { ExecutionContext } from '@nestjs/common';
import type { Socket } from 'socket.io';
import passport from 'passport';
import type { AuthenticatedUser } from '../common/types.js';

/** The socket handshake doubles as the "request" passport reads. */
type Handshake = Socket['handshake'];

/**
 * Puts the bearer token from the handshake's `auth` payload where passport's
 * JWT strategy reads it. Client-supplied `Authorization` headers are left
 * alone on purpose: a native client may legitimately send the token that way.
 */
function withBearerFromAuth(handshake: Handshake): Handshake {
  const auth = (handshake.auth as { token?: unknown } | undefined)?.token;

  if (typeof auth === 'string' && auth.length > 0) {
    const headers = handshake as Handshake & {
      headers: Record<string, string | string[] | undefined>;
    };
    headers.headers.authorization = `Bearer ${auth}`;
  }

  return handshake;
}

/**
 * Runs the shared `jwt` strategy over a socket handshake and resolves the
 * authenticated user, rejecting exactly where the HTTP pipeline would answer
 * 401 — token missing, expired, wrong purpose, dead session, unknown or
 * unverified user. `JwtStrategy.validate` is the single implementation of all
 * of that; nothing here re-checks any of it.
 *
 * This exists because of a Nest lifecycle gap: the class-level guard on the
 * gateway runs for every `@SubscribeMessage` handler, but `handleConnection`
 * is invoked through a static path with no enhancers whenever the app has no
 * request-scoped global enhancers — so the guard cannot be what authenticates
 * the handshake. The guard stays (messages are still re-verified on every
 * event); this covers the connect hook with the same strategy.
 */
export function authenticateHandshake(
  handshake: Handshake,
): Promise<AuthenticatedUser> {
  const request = withBearerFromAuth(handshake);

  return new Promise<AuthenticatedUser>((resolve, reject) => {
    passport.authenticate(
      'jwt',
      { session: false },
      (error: Error | null, user?: AuthenticatedUser) => {
        if (error) {
          reject(error);
          return;
        }
        if (!user) {
          reject(new UnauthorizedException('Unauthorized'));
          return;
        }
        resolve(user);
      },
    )(request, undefined, (error?: Error) => {
      if (error) {
        reject(error);
      }
    });
  });
}

/**
 * Authenticates a socket from the access token in the handshake.
 *
 * The JWT strategy itself is untouched: it already refuses non-access tokens,
 * checks the session is still alive and loads the user, which is exactly what
 * a socket needs. All this guard does is hand the strategy the socket's
 * handshake as if it were an HTTP request, by synthesising the bearer header
 * passport-jwt reads.
 */
export class WsJwtAuthGuard extends AuthGuard('jwt') {
  getRequest(context: ExecutionContext): Handshake {
    const client = context.switchToWs().getClient<Socket>();
    return withBearerFromAuth(client.handshake);
  }
}
