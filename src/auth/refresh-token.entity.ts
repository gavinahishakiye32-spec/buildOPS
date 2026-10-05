import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../user/user.entity.js';

/**
 * One issued refresh token, and the audit trail of how it was rotated.
 *
 * The token itself is never stored: only its SHA-256 hash, exactly as with the
 * email-verification and password-reset tokens. A dump of this table therefore
 * does not hand an attacker working refresh tokens, and a stolen database cannot
 * be replayed against the API.
 *
 * `familyId` is the rotation lineage. Refreshing revokes the presented token and
 * issues a new one carrying the same family id, which is what makes replay
 * detectable: a token that is already revoked but still being presented means
 * somebody kept a copy, and the only safe response is to revoke the entire
 * family rather than the single token. See `SessionService.rotate`.
 *
 * The row outlives its own expiry on purpose -- it is deleted by the cleanup in
 * `SessionService.purgeExpired`, not by expiry -- because a revoked token
 * presented after its expiry still has to be recognised as a replay in order to
 * kill the family it belongs to.
 */
@Entity('refresh_tokens')
@Index('refresh_tokens_token_hash_idx', ['tokenHash'], { unique: true })
@Index('refresh_tokens_family_id_idx', ['familyId'])
@Index('refresh_tokens_user_id_idx', ['userId'])
export class RefreshToken {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ name: 'token_hash', type: 'char', length: 64 })
  tokenHash: string;

  /** Shared by every token in one rotation lineage; see the class comment. */
  @Column({ name: 'family_id', type: 'uuid' })
  familyId: string;

  @Column({ name: 'expires_at', type: 'timestamp' })
  expiresAt: Date;

  /** Null while the token is live. Set on logout, rotation or reuse detection. */
  @Column({ name: 'revoked_at', type: 'timestamp', nullable: true })
  revokedAt: Date | null;

  /** Why it was revoked, for the sessions list and for support. */
  @Column({ name: 'revoked_reason', type: 'varchar', length: 40, nullable: true })
  revokedReason: RefreshTokenRevocationReason | null;

  /** The token that superseded this one, so a replay can be traced back. */
  @Column({ name: 'replaced_by_id', type: 'uuid', nullable: true })
  replacedById: string | null;

  /**
   * Free-text client description, recorded so a customer can tell their own
   * sessions apart. Never trusted for authorisation.
   */
  @Column({ name: 'user_agent', type: 'varchar', length: 255, nullable: true })
  userAgent: string | null;

  @Column({ type: 'varchar', length: 45, nullable: true })
  ip: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

export type RefreshTokenRevocationReason =
  /** Superseded by a rotation, or the customer logged out. */
  | 'rotated'
  | 'logout'
  /** The customer signed out everywhere. */
  | 'logout_all'
  /** A password change or reset: a compromise has to be able to cut the attacker off. */
  | 'password_changed'
  /** A revoked token was presented again, so the whole family is assumed stolen. */
  | 'reuse_detected';
