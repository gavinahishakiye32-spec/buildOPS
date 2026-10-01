import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
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

  @Column({ name: 'verification_token', type: 'varchar', length: 64, nullable: true })
  verificationToken: string | null;

  @Column({ name: 'verification_token_expires', type: 'timestamp', nullable: true })
  verificationTokenExpires: Date | null;

  @Column({ name: 'reset_token', type: 'varchar', length: 64, nullable: true })
  resetToken: string | null;

  @Column({ name: 'reset_token_expires', type: 'timestamp', nullable: true })
  resetTokenExpires: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

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
      ...result
    } = this;
    return result;
  }
}
