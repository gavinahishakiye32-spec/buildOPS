import { ForbiddenException, Injectable } from '@nestjs/common';
import { isProduction } from '../common/env.js';
// A value import, not `import type`: Nest resolves the injection token from
// the class itself, and a type-only import leaves it undefined at runtime.
import { ConfigService } from '@nestjs/config';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { CookieOptions, Request, Response } from 'express';
import { SessionService } from './session.service.js';
import type { IssuedSession, SessionClient } from './session.service.js';

/** Carries the refresh token. Readable by the browser's cookie jar only. */
export const REFRESH_COOKIE = 'rt';

/**
 * Carries the CSRF token, and is deliberately *not* httpOnly.
 *
 * The double-submit pattern needs JavaScript to read this value and echo it in a
 * header. That is safe precisely because it is not a credential: knowing it grants
 * nothing on its own, since an attacker who can read it through XSS can already
 * read the response. The point is that a cross-site attacker can neither read the
 * cookie nor set the header.
 */
export const CSRF_COOKIE = 'csrf';

/** Header the CSRF cookie value must be echoed in. */
export const CSRF_HEADER = 'x-csrf-token';

/**
 * Scoped to the auth routes.
 *
 * A cookie with `path: /` is attached to every request the browser makes to the
 * origin, including the ones that carry `Authorization` and do not need it. The
 * refresh token is only ever read by the four session endpoints, so the narrower
 * path is both safer and the correct statement of intent.
 */
const COOKIE_PATH = '/api/v1/auth';

const BASE: CookieOptions = {
  path: COOKIE_PATH,
  // `strict`, not `lax`: this cookie authorises nothing on its own, but it is the
  // credential behind a session, and `lax` would attach it to a top-level GET
  // navigation from another site.
  sameSite: 'strict',
  // Off in development so the flow works over plain http on localhost, on in
  // production so the cookie never crosses a plaintext connection.
  secure: false,
};

/** Cookie options for `res`, hardened according to the environment. */
function optionsFor(
  config: ConfigService,
  httpOnly: boolean,
  maxAgeMs: number,
): CookieOptions {
  return {
    ...BASE,
    httpOnly,
    secure: isProduction(config),
    maxAge: maxAgeMs,
  };
}

export function refreshCookieOptions(
  config: ConfigService,
  ttlDays: number,
): CookieOptions {
  return optionsFor(config, true, ttlDays * 24 * 60 * 60 * 1000);
}

/**
 * The CSRF cookie deliberately outlives the access token.
 *
 * It has to survive a page reload and a tab left open for a day, which is exactly
 * when a refresh happens; expiring it with the access token would produce a
 * window where the session is live and cannot be refreshed.
 */
export function csrfCookieOptions(config: ConfigService): CookieOptions {
  return optionsFor(config, false, 24 * 60 * 60 * 1000);
}

export function readRefreshToken(req: Request): string | null {
  const value = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Enforces the double-submit check on a route authenticated by the refresh
 * cookie.
 *
 * `SameSite=strict` already stops a browser from attaching the refresh cookie to
 * a cross-site request, which is the primary defence and is why this does not
 * need to be clever. This is the second lock on the same door: if the cookie
 * policy is ever relaxed, or a client is misconfigured to send it, a forged
 * cross-site request still cannot produce the header a browser will not let a
 * hostile page set.
 */
export function assertCsrfToken(req: Request): void {
  const cookie = (req.cookies as Record<string, string> | undefined)?.[CSRF_COOKIE];
  const header = req.header(CSRF_HEADER);

  if (!cookie || !header) {
    throw new ForbiddenException(
      `Missing CSRF token. Send the ${CSRF_COOKIE} cookie value in the ${CSRF_HEADER} header.`,
    );
  }

  const expected = Buffer.from(cookie);
  const received = Buffer.from(header);

  // `timingSafeEqual` throws on a length mismatch, and the length of a
  // comparison should not be observable.
  if (
    expected.length !== received.length ||
    !timingSafeEqual(expected, received)
  ) {
    throw new ForbiddenException('CSRF token does not match');
  }
}

/**
 * Writes and clears the session cookies.
 *
 * Separate from the request-side helpers above because the two run on opposite
 * sides of a request: reading a cookie needs no configuration, writing one needs
 * to know the environment and the token lifetime.
 */
@Injectable()
export class SessionCookies {
  constructor(
    private readonly config: ConfigService,
    private readonly sessions: SessionService,
  ) {}

  writeCookies(res: Response, session: IssuedSession): void {
    res.cookie(REFRESH_COOKIE, session.token, {
      ...refreshCookieOptions(this.config, this.sessions.ttlDays),
      // The store's own expiry is authoritative; this only bounds the cookie.
      expires: session.expiresAt,
    });
    res.cookie(
      CSRF_COOKIE,
      randomBytes(24).toString('hex'),
      csrfCookieOptions(this.config),
    );
  }

  clearCookies(res: Response): void {
    // Same path and flags as when it was set, or the browser keeps the original
    // and the "cleared" cookie is simply ignored.
    res.clearCookie(REFRESH_COOKIE, { ...BASE, httpOnly: true, secure: isProduction(this.config) });
    res.clearCookie(CSRF_COOKIE, { ...BASE, httpOnly: false, secure: isProduction(this.config) });
  }
}

/** The client details recorded against a session, for the sessions list. */
export function clientOf(req: Request): SessionClient {
  const forwarded = req.header('x-forwarded-for');
  const ip = forwarded?.split(',')[0]?.trim() || req.ip || null;

  return { userAgent: req.header('user-agent') ?? null, ip };
}
