import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { getSecret } from '../common/env.js';
import { UserModule } from '../user/user.module.js';
import { MailModule } from '../mail/mail.module.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { AuthService } from './auth.service.js';
import { AuthController } from './auth.controller.js';
import { JwtStrategy } from './jwt.strategy.js';
import { RefreshToken } from './refresh-token.entity.js';
import { SessionService } from './session.service.js';
import { SessionCleanupService } from './session-cleanup.service.js';
import { SessionCookies } from './session-cookies.js';
import { SignedTokens } from './signed-tokens.js';

@Module({
  imports: [
    UserModule,
    MailModule,
    TypeOrmModule.forFeature([RefreshToken]),
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => ({
        secret: getSecret(config, 'JWT_SECRET', 'fallback-secret'),
        signOptions: {
          expiresIn: Number(config.get<string>('JWT_EXPIRATION', '3600')),
        },
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    JwtStrategy,
    SessionService,
    SessionCookies,
    SessionCleanupService,
    SignedTokens,
    // Guards are provided here so every feature module can reference them
    // through @Protected() without importing JwtModule/PassportModule itself.
    JwtAuthGuard,
  ],
  exports: [
    JwtAuthGuard,
    JwtModule,
    PassportModule,
    SessionService,
    // Exported for `AccountService`, which owns the `/settings/account` surface
    // and delegates the credential rules here rather than restating them: a
    // password change has to re-check the current password and end every
    // session, and an address change has to reset verification. One
    // implementation of those is the whole point.
    AuthService,
    // Same reason, for `InvitationService`: accepting an invitation signs the
    // invitee in, and the cookies have to be written by the one class that
    // knows their flags and paths.
    SessionCookies,
    // Invitation tokens are signed with the same secret and checked against the
    // same rules as every other purpose-bound token, so they are minted here
    // rather than by a second signer in the invitation module.
    SignedTokens,
  ],
})
export class AuthModule {}
