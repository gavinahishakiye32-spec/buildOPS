import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomUUID } from 'node:crypto';

/**
 * Every credential this API hands out, besides the access token.
 *
 * `purpose` is what keeps them apart: all four are signed with the same secret,
 * so without it a password-reset JWT would be accepted as a refresh token (and
 * the refresh token, which carries a `sid`, would be accepted as an access
 * token).
 */
export type TokenPurpose =
  'refresh' | 'email_verification' | 'password_reset' | 'invitation';

export interface SignedToken {
  /** The JWT: what goes in the cookie, the emailed link or the response body. */
  token: string;
  /** SHA-256 of `token`, which is all the database is ever allowed to keep. */
  hash: string;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Issues and checks the signed tokens that are not access tokens.
 *
 * Signing alone is never the whole check. Every one of these is also a
 * single-use row in the database (a session, a verification column, an
 * invitation), and that row is what makes revocation, rotation and reuse
 * detection possible -- so callers verify the signature here and then look the
 * token up by its hash. The signature rejects forgeries without touching the
 * database; the row decides whether the token is still allowed to work.
 */
@Injectable()
export class SignedTokens {
  constructor(private readonly jwt: JwtService) {}

  sign(
    purpose: TokenPurpose,
    claims: Record<string, unknown>,
    ttlMs: number,
  ): SignedToken {
    const token = this.jwt.sign(
      { ...claims, purpose },
      {
        expiresIn: Math.max(1, Math.ceil(ttlMs / 1000)),
        jwtid: randomUUID(),
      },
    );

    return { token, hash: hashToken(token) };
  }

  verify(purpose: TokenPurpose, token: string | null | undefined): boolean {
    if (!token) {
      return false;
    }

    try {
      const payload = this.jwt.verify<Record<string, unknown>>(token);
      return payload?.purpose === purpose && typeof payload.jti === 'string';
    } catch {
      return false;
    }
  }
}
