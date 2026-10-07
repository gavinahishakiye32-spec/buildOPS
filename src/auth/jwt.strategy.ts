import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { getSecret } from '../common/env.js';
import { UserService } from '../user/user.service.js';
import { SessionService } from './session.service.js';

interface JwtPayload {
  sub: string;
  email: string;
  /**
   * The session this token was minted for.
   *
   * Checked against the session store on every request, which is the only reason
   * logout and "log out everywhere" mean anything: a signed JWT cannot be
   * withdrawn, so without this the only way to end a session would be to wait out
   * the token's lifetime.
   */
  sid?: string;
  /**
   * Present on every credential that is not an access token.
   *
   * The refresh token is signed with the same secret and carries a `sid`, so
   * without this check it would be accepted straight from the cookie as a
   * bearer credential. See `SignedTokens`.
   */
  purpose?: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    configService: ConfigService,
    private readonly userService: UserService,
    private readonly sessions: SessionService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: getSecret(configService, 'JWT_SECRET', 'fallback-secret'),
    });
  }

  async validate(payload: JwtPayload) {
    // Only access tokens are bearer credentials. Anything else signed with this
    // secret -- a refresh token, most notably -- is refused here rather than
    // being honoured because it happens to carry a `sid`.
    if (payload.purpose) {
      throw new UnauthorizedException();
    }

    // A token with no session claim predates sessions, or was minted by something
    // that should not have minted it. Either way it cannot be revoked, which is
    // the one property an access token here must have, so it is refused rather
    // than quietly honoured until it expires.
    if (!payload.sid || !(await this.sessions.isFamilyActive(payload.sid))) {
      throw new UnauthorizedException();
    }

    const user = await this.userService.findById(payload.sub);
    if (!user || !user.isVerified) {
      throw new UnauthorizedException();
    }

    return { ...user.toResponse(), sessionId: payload.sid };
  }
}
