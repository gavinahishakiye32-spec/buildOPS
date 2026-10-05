import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  BeforeInsert,
  BeforeUpdate,
} from 'typeorm';
import { hash } from 'bcryptjs';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'organization_id', type: 'uuid', nullable: true })
  organizationId: string | null;

  @Column({ type: 'varchar', length: 255, unique: true })
  email: string;

  @Column({ name: 'password_hash', type: 'varchar', length: 255 })
  passwordHash: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  name: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  status: string | null;

  @Column({ name: 'is_verified', type: 'boolean', default: false })
  isVerified: boolean;

  @Column({
    name: 'verification_token',
    type: 'varchar',
    length: 64,
    nullable: true,
  })
  verificationToken: string | null;

  @Column({
    name: 'verification_token_expires',
    type: 'timestamp',
    nullable: true,
  })
  verificationTokenExpires: Date | null;

  @Column({ name: 'reset_token', type: 'varchar', length: 64, nullable: true })
  resetToken: string | null;

  @Column({ name: 'reset_token_expires', type: 'timestamp', nullable: true })
  resetTokenExpires: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  /**
   * Set when the account was deleted, `null` while it is live.
   *
   * Declared as a `@DeleteDateColumn` for the same reason `Client.deletedAt` is:
   * the filter it turns on (`deleted_at IS NULL` on every `find`, `findOne` and
   * `count`, plus every joined alias of a query builder) is what makes a deleted
   * account disappear from the API without a single read having been taught
   * about it. `JwtStrategy` already refuses a token whose user cannot be
   * resolved, so deleting an account ends its live tokens here rather than in
   * every guard that follows.
   *
   * The row is deliberately kept rather than removed -- see
   * `AccountDeletion1700000000005` for the cascade this avoids and the history it
   * preserves.
   */
  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamp', nullable: true })
  deletedAt: Date | null;

  @BeforeInsert()
  @BeforeUpdate()
  async hashPassword() {
    if (this.passwordHash) {
      this.passwordHash = await hash(this.passwordHash, 10);
    }
  }

  toResponse() {
    const {
      passwordHash: _passwordHash,
      verificationToken: _verificationToken,
      verificationTokenExpires: _verificationTokenExpires,
      resetToken: _resetToken,
      resetTokenExpires: _resetTokenExpires,
      deletedAt: _deletedAt,
      ...result
    } = this;
    return result;
  }
}
