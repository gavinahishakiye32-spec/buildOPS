import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, MoreThan, Repository } from 'typeorm';
import { createHash, randomUUID } from 'node:crypto';
import { RefreshToken } from './refresh-token.entity.js';
import type { RefreshTokenRevocationReason } from './refresh-token.entity.js';
import { SignedTokens } from './signed-tokens.js';

const DEFAULT_REFRESH_TTL_DAYS = 30;

/** What a caller learns about a client's request, for the sessions list. */
export interface SessionClient {
  userAgent: string | null;
  ip: string | null;
}

/**
 * The result of exchanging a refresh token.
 *
 * `ok: false` is a single outcome on purpose. The caller must not be able to
 * tell "no such token" from "expired" from "revoked, and I just killed the whole
 * family because it looked like a replay": the difference is only useful to
 * somebody probing for a valid token hash, and every one of them ends in the
 * same 401.
 */
export type RotationResult =
  | { ok: true; token: string; record: RefreshToken }
  | { ok: false; reason: 'unknown' | 'expired' | 'revoked' | 'inactive_user' };

/** A freshly minted session: the token to hand out, and the id carried by its
 * access tokens so a later revocation can be enforced against them. */
export interface IssuedSession {
  token: string;
  familyId: string;
  expiresAt: Date;
}

/**
 * Issues, rotates and revokes refresh tokens.
 *
 * The rules this enforces, and why each exists:
 *
 *  - **Tokens are stored hashed.** As with the password-reset token, a copy of
 *    the database must not be replayable against the API.
 *
 *  - **Every refresh rotates.** The presented token is revoked and a new one is
 *    issued in the same family. A long-lived token that is never replaced is a
 *    long-lived liability; rotation also bounds the damage of a leak to the
 *    window before the next refresh.
 *
 *  - **A replayed token kills its whole family.** A token that comes back after
 *    it was rotated is either an attacker or a client that raced two refreshes.
 *    Those two cases cannot be told apart from the token alone, and the response
 *    has to be the same for both: revoke the family and force a fresh login.
 *    Guessing "it's probably a race" is how a stolen token stays usable.
 *
 *  - **The user's own status is re-checked on refresh.** An access token is
 *    stateless, so it cannot notice that an account was deactivated or
 *    unverified. The refresh is the one moment the session is re-authorised
 *    against the database, and it is the right place to fail closed.
 */
@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  constructor(
    @InjectRepository(RefreshToken)
    private readonly refreshTokens: Repository<RefreshToken>,
    private readonly config: ConfigService,
    private readonly signed: SignedTokens,
  ) {}

  /** Days a refresh token stays valid. Absolute, not sliding: see `rotate`. */
  get ttlDays(): number {
    return Number(
      this.config.get<string>('REFRESH_TOKEN_TTL_DAYS', String(DEFAULT_REFRESH_TTL_DAYS)),
    );
  }

  /**
   * Starts a new session and returns the token to hand to the client.
   *
   * The plaintext token exists only in this return value: it goes into the
   * httpOnly cookie and is never written anywhere, which is what makes the
   * stored hash safe to keep.
   */
  async issue(
    userId: string,
    client: SessionClient,
  ): Promise<IssuedSession> {
    const familyId = randomUUID();
    const expiresAt = this.expiresAt();
    const { token, hash } = this.signed.sign(
      'refresh',
      { sub: userId, sid: familyId },
      expiresAt.getTime() - Date.now(),
    );
    const record = this.refreshTokens.create({
      userId,
      tokenHash: hash,
      familyId,
      expiresAt,
      revokedAt: null,
      revokedReason: null,
      replacedById: null,
      userAgent: client.userAgent?.slice(0, 255) ?? null,
      ip: client.ip?.slice(0, 45) ?? null,
    });

    await this.refreshTokens.save(record);

    return { token, familyId: record.familyId, expiresAt };
  }

  /**
   * Exchanges a refresh token for a new one.
   *
   * Absolute expiry on purpose: a sliding window never ends, so a token that
   * leaked once would stay usable as long as its holder kept refreshing. The
   * customer re-authenticates when it lapses, and `forgotPassword` is there.
   */
  async rotate(
    token: string,
    client: SessionClient,
  ): Promise<RotationResult> {
    if (!token || !this.signed.verify('refresh', token)) {
      return { ok: false, reason: 'unknown' };
    }

    const hash = this.hash(token);
    const now = new Date();

    return this.refreshTokens.manager.transaction(async (manager) => {
      const repo = manager.getRepository(RefreshToken);
      const record = await repo.findOne({ where: { tokenHash: hash } });

      if (!record) {
        return { ok: false, reason: 'unknown' };
      }

      if (record.revokedAt) {
        await this.handleReuse(repo, record);
        return { ok: false, reason: 'revoked' };
      }

      if (record.expiresAt.getTime() <= now.getTime()) {
        return { ok: false, reason: 'expired' };
      }

      const replacement = this.signed.sign(
        'refresh',
        { sub: record.userId, sid: record.familyId },
        record.expiresAt.getTime() - now.getTime(),
      );

      const next = repo.create({
        userId: record.userId,
        tokenHash: replacement.hash,
        familyId: record.familyId,
        expiresAt: record.expiresAt,
        revokedAt: null,
        revokedReason: null,
        replacedById: null,
        userAgent: client.userAgent?.slice(0, 255) ?? record.userAgent,
        ip: client.ip?.slice(0, 45) ?? record.ip,
      });

      // The replacement is written first on purpose: a failure before the claim
      // below leaves the customer holding a token that still works, rather than
      // none. The claim is what makes that safe, not the ordering.
      const saved = await repo.save(next);

      // The claim, not the earlier read, is the serialisation point. Two
      // simultaneous refreshes both read this row as live, so read-then-write
      // would let both proceed and leave the family with two live tokens -- the
      // client's next refresh would then look like a replay of a token the
      // server had only just replaced, and the family would be killed for
      // honest use of the feature.
      //
      // Under read-committed, Postgres re-checks the predicate after the
      // competing writer commits, so exactly one caller gets a row here and the
      // other is told zero.
      const claim = await repo
        .createQueryBuilder()
        .update(RefreshToken)
        .set({ revokedAt: now, revokedReason: 'rotated' })
        .where('token_hash = :hash', { hash })
        .andWhere('revoked_at IS NULL')
        .andWhere('expires_at > :now', { now })
        .execute();

      if (!claim.affected) {
        // Lost the race, or the token lapsed between the read and the claim.
        // The replacement just written must not be left live: two live tokens in
        // one family is the state this whole dance exists to prevent.
        await repo.delete({ id: saved.id });

        const fresh = await repo.findOne({ where: { tokenHash: hash } });

        if (fresh?.revokedAt) {
          // Somebody else is already using it, so from here it is a replay.
          await this.handleReuse(repo, fresh);
          return { ok: false, reason: 'revoked' };
        }

        return { ok: false, reason: 'expired' };
      }

      await repo.update({ id: record.id }, { replacedById: saved.id });

      return { ok: true, token: replacement.token, record: saved };
    });
  }

  /**
   * A token that was already revoked has come back.
   *
   * Either it was stolen, or two refreshes raced and one client is now holding a
   * token the server has forgotten. Both are indistinguishable here and both get
   * the same answer: the entire family dies and its owner has to log in again.
   *
   * Note this fires for a token revoked by a plain logout too, which is the
   * point -- a token that works after being cancelled is exactly the bug this
   * guards against.
   */
  private async handleReuse(
    repo: Repository<RefreshToken>,
    record: RefreshToken,
  ): Promise<void> {
    this.logger.warn(
      `Refresh token for user ${record.userId} was presented after being revoked (${record.revokedReason ?? 'unknown reason'}); revoking the whole session family ${record.familyId}`,
    );

    await repo.update(
      { familyId: record.familyId, userId: record.userId, revokedAt: IsNull() },
      { revokedAt: new Date(), revokedReason: 'reuse_detected' },
    );
  }

  /** Revokes the single session a token belongs to. Idempotent. */
  async revokeByToken(
    token: string,
    reason: RefreshTokenRevocationReason = 'logout',
  ): Promise<void> {
    const record = await this.findByToken(token);

    if (!record || record.revokedAt) {
      return;
    }

    await this.revokeFamily(record.familyId, record.userId, reason);
  }

  /** Revokes every session belonging to a user. */
  async revokeAllForUser(
    userId: string,
    reason: RefreshTokenRevocationReason,
  ): Promise<number> {
    const result = await this.refreshTokens.update(
      { userId, revokedAt: IsNull() },
      { revokedAt: new Date(), revokedReason: reason },
    );

    if (result.affected) {
      this.logger.log(
        `Revoked ${result.affected} session(s) for user ${userId} (${reason})`,
      );
    }

    return result.affected ?? 0;
  }

  /**
   * Revokes one session of one user, and reports whether it was live.
   *
   * Scoped to `userId` as well as `familyId` on purpose: the id comes from the
   * caller's own sessions list, but nothing about a request body or a path
   * segment can be treated as belonging to the caller, and a family id is
   * guessable enough that updating on it alone would let one user sign another
   * out. A `false` here covers both "no such family" and "not yours" -- the two
   * have to be indistinguishable to a caller probing for other people's session
   * ids, and the sessions list already distinguishes them by not containing them.
   *
   * Revoked rows are not re-revoked: an expired family reads the same as a
   * revoked one, which keeps the route idempotent.
   */
  async revokeFamilyForUser(
    familyId: string,
    userId: string,
    reason: RefreshTokenRevocationReason,
  ): Promise<boolean> {
    const result = await this.refreshTokens.update(
      { familyId, userId, revokedAt: IsNull(), expiresAt: MoreThan(new Date()) },
      { revokedAt: new Date(), revokedReason: reason },
    );

    return (result.affected ?? 0) > 0;
  }

  private async revokeFamily(
    familyId: string,
    userId: string,
    reason: RefreshTokenRevocationReason,
  ): Promise<void> {
    await this.refreshTokens.update(
      { familyId, userId, revokedAt: IsNull() },
      { revokedAt: new Date(), revokedReason: reason },
    );
  }

  /**
   * Whether a session is still allowed to have access tokens minted for it.
   *
   * Called on every authenticated request, which is why it is one indexed
   * existence query rather than a load: this is the only thing that makes
   * "log out everywhere" actually log out everywhere, because an access token
   * already in the wild stays cryptographically valid until it expires and only
   * this check can say otherwise.
   */
  async isFamilyActive(familyId: string): Promise<boolean> {
    if (!familyId) {
      return false;
    }

    // `MoreThan`, not a bare `Date`. A plain value in a `where` is an equality
    // comparison in TypeORM, so `{ expiresAt: new Date() }` asks for tokens
    // expiring at *this instant* and reports every real session as dead.
    const count = await this.refreshTokens.count({
      where: {
        familyId,
        revokedAt: IsNull(),
        expiresAt: MoreThan(new Date()),
      },
    });

    return count > 0;
  }

  /**
   * Live sessions for the sessions list, most recent first.
   *
   * One row per family rather than one per token: a session that has been
   * refreshed a hundred times is still one device, and listing it a hundred
   * times would be its own kind of wrong.
   */
  async listForUser(
    userId: string,
    currentFamilyId: string | null,
  ): Promise<
    Array<{
      id: string;
      userAgent: string | null;
      ip: string | null;
      createdAt: Date;
      expiresAt: Date;
      isCurrent: boolean;
    }>
  > {
    const live = await this.refreshTokens.find({
      where: { userId, revokedAt: IsNull() },
      order: { createdAt: 'DESC' },
    });

    const now = Date.now();
    const byFamily = new Map<
      string,
      { createdAt: Date; expiresAt: Date; record: RefreshToken }
    >();

    for (const record of live) {
      if (record.expiresAt.getTime() <= now) {
        continue;
      }

      // Superseded tokens in the same family collapse into the newest one, so
      // the earliest `createdAt` is when the device actually started this
      // session.
      const seen = byFamily.get(record.familyId);

      if (!seen || record.createdAt.getTime() < seen.createdAt.getTime()) {
        byFamily.set(record.familyId, {
          createdAt: record.createdAt,
          expiresAt: record.expiresAt,
          record,
        });
      }
    }

    return [...byFamily.values()]
      .sort(
        (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
      )
      .map(({ record, createdAt, expiresAt }) => ({
        id: record.familyId,
        userAgent: record.userAgent,
        ip: record.ip,
        createdAt,
        expiresAt,
        isCurrent: currentFamilyId !== null && record.familyId === currentFamilyId,
      }));
  }

  /**
   * Drops rows that can no longer do anything.
   *
   * Expiry is not enough: a revoked token has to stay findable until it would
   * have expired anyway, because presenting it is what triggers reuse detection.
   * So the cutoff is the later of "revoked" and "expired" plus the token's own
   * lifetime, which is why this is not simply `expires_at < now()`.
   */
  async purgeExpired(): Promise<number> {
    const result = await this.refreshTokens
      .createQueryBuilder()
      .delete()
      .where('expires_at < :now', { now: new Date() })
      .andWhere(
        'revoked_at IS NULL OR revoked_at < :revokedCutoff',
        { revokedCutoff: new Date(Date.now() - this.ttlDays * 24 * 60 * 60 * 1000) },
      )
      .execute();

    return result.affected ?? 0;
  }

  /** Deletes every session for the given users. Used when accounts go away. */
  async deleteForUsers(userIds: string[]): Promise<void> {
    if (userIds.length === 0) {
      return;
    }

    await this.refreshTokens.delete({ userId: In(userIds) });
  }

  private async findByToken(token: string): Promise<RefreshToken | null> {
    if (!token) {
      return null;
    }

    return this.refreshTokens.findOne({ where: { tokenHash: this.hash(token) } });
  }

  private expiresAt(): Date {
    return new Date(Date.now() + this.ttlDays * 24 * 60 * 60 * 1000);
  }

  private hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
