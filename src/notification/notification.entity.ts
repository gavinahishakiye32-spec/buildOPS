import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Organization } from '../organization/organization.entity.js';
import { User } from '../user/user.entity.js';
import { NOTIFICATION_KINDS } from '../common/enums.js';

const inList = (values: readonly string[]): string =>
  values.map((value) => `'${value}'`).join(', ');

/**
 * An in-app notification delivered to one member of an organization.
 *
 * The row is the deliverable: the kinds the system produces, the short
 * `title`/`body` a UI shows without a second lookup, and `data` for the
 * structured context (task id, project id, current status) a UI deep-links
 * with. `read_at` is the only mutable field -- an inbox entry is not a
 * document, so there is no reason for a client to edit title or body.
 *
 * Notifications belong to a recipient, not to a bucket a whole role shares,
 * and every read endpoint scopes by the caller's own `userId`; the
 * organization column exists for the FK and for the permission guard, which
 * still applies to the routes (a member may not read another member's rows).
 */
@Entity('notifications')
@Check(
  `CHK_notifications_kind`,
  `"kind" IN (${inList(NOTIFICATION_KINDS)})`,
)
export class Notification {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organization_id' })
  organization: Organization;

  @Column({ name: 'recipient_id', type: 'uuid' })
  recipientId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'recipient_id' })
  recipient: User;

  /** Who did the thing the notification reports; null if they are gone. */
  @Column({ name: 'actor_id', type: 'uuid', nullable: true })
  actorId: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'actor_id' })
  actor: User | null;

  @Column({ type: 'varchar', length: 50 })
  kind: string;

  @Column({ type: 'varchar', length: 255 })
  title: string;

  @Column({ type: 'text' })
  body: string;

  /** Structured context for the UI (task id, project id, status, ...). */
  @Column({ type: 'jsonb', nullable: true })
  data: Record<string, unknown> | null;

  /** Set once the recipient has opened it; `null` while it is unread. */
  @Column({ name: 'read_at', type: 'timestamp', nullable: true })
  readAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  toResponse() {
    return {
      id: this.id,
      kind: this.kind,
      title: this.title,
      body: this.body,
      data: this.data,
      actorId: this.actorId,
      readAt: this.readAt,
      createdAt: this.createdAt,
    };
  }
}