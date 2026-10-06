import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { Organization } from '../organization/organization.entity.js';
import { User } from '../user/user.entity.js';

/**
 * An invitation to join an organization, sent by email.
 *
 * The row exists because at invite time there is nothing to attach a role to:
 * the invitee may have no account yet (spec §4 requires a verified email before
 * anybody can join). So the invitation holds who was invited, under which role
 * template, and the hash of the token that went out in the email -- and the role
 * itself is created only when the invitation is accepted, by which point the
 * account exists and the plan seat can be checked against a real user.
 *
 * `token_hash` is a SHA-256 of the token, never the token. The same rule as the
 * verification and reset tokens: a leaked database must not be a working inbox,
 * and the only place the raw value exists is the link that was emailed.
 *
 * Rows are kept after they are used rather than deleted: an accepted invitation
 * is the record of how somebody got in, and revoking one without removing it is
 * the difference between "this invitation was revoked" and "there is no such
 * invitation".
 */
@Entity('organization_invitations')
export class OrganizationInvitation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organization_id' })
  organization: Organization;

  /** Normalized (trimmed, lowercased) by the service before it is written. */
  @Column({ type: 'varchar', length: 255 })
  email: string;

  /** The default role template the invitee receives on acceptance. */
  @Column({ name: 'template_key', type: 'varchar', length: 50 })
  templateKey: string;

  /** The template's display name, copied so history survives a template edit. */
  @Column({ name: 'role_name', type: 'varchar', length: 255 })
  roleName: string;

  @Column({ name: 'token_hash', type: 'varchar', length: 64 })
  tokenHash: string;

  /** Stored as `pending | accepted | revoked`; `expired` is derived on read. */
  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status: string;

  @Column({ name: 'expires_at', type: 'timestamp' })
  expiresAt: Date;

  @Column({ name: 'invited_by', type: 'uuid', nullable: true })
  invitedBy: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'invited_by' })
  invitedByUser: User | null;

  @Column({ name: 'accepted_at', type: 'timestamp', nullable: true })
  acceptedAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  /** True while the row could still be accepted: pending and inside its window. */
  isLive(): boolean {
    return this.status === 'pending' && this.expiresAt.getTime() > Date.now();
  }

  /** The status a response reports: `expired` is derived, never stored. */
  reportedStatus(): string {
    if (this.status === 'pending' && !this.isLive()) {
      return 'expired';
    }

    return this.status;
  }

  toResponse() {
    return {
      id: this.id,
      organizationId: this.organizationId,
      email: this.email,
      templateKey: this.templateKey,
      roleName: this.roleName,
      status: this.reportedStatus(),
      expiresAt: this.expiresAt,
      invitedBy: this.invitedBy,
      acceptedAt: this.acceptedAt,
      createdAt: this.createdAt,
    };
  }
}
