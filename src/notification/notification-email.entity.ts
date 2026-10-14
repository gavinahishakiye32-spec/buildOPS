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
import { Notification } from './notification.entity.js';

/** Where one queued notification email is in its life. Closed, so the worker can branch on it. */
export const NOTIFICATION_EMAIL_STATUSES = [
  'pending',
  'sent',
  'failed',
] as const;

export type NotificationEmailStatus =
  (typeof NOTIFICATION_EMAIL_STATUSES)[number];

/**
 * The outbox for notification emails: one durable row per email that has to go
 * out, written in the same transaction as the notification it belongs to.
 *
 * Sending an email inline is the thing this exists to replace. A direct
 * `sendMail` inside the request is at-most-once and silent: if SMTP is briefly
 * down -- which it is, routinely -- the email is gone and the only trace is a
 * log line nobody reads. The work that triggered it (an assignment, a
 * milestone) is still committed, so the recipient is simply never told, and
 * nothing retries.
 *
 * The outbox makes delivery durable and retryable instead. The row is written
 * atomically with the notification, so there is no window where one exists
 * without the other. A background worker then claims due rows, sends them, and
 * either marks them sent or schedules the next attempt with a backoff -- until
 * it succeeds or exhausts `max_attempts` and is marked `failed`. Every outcome
 * is a row somebody can query, not a line in a log.
 *
 * The recipient's address is copied onto the row at enqueue time rather than
 * resolved at send time. That is deliberate: the address an email *was owed to*
 * is part of the event, and re-reading it minutes later could send it somewhere
 * the account has since moved to -- or nowhere, if the account was deleted.
 */
@Entity('notification_emails')
@Index('IDX_notification_emails_due', ['nextAttemptAt'], {
  where: `"status" = 'pending'`,
})
export class NotificationEmail {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** The notification this email tells the recipient about. Cascades with it. */
  @Column({ name: 'notification_id', type: 'uuid', nullable: true })
  notificationId: string | null;

  @ManyToOne(() => Notification, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'notification_id' })
  notification: Notification | null;

  /**
   * The recipient, kept for auditing and `SET NULL` rather than cascade: the
   * address is already copied below, so removing the account must not erase the
   * record that an email was owed.
   */
  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'user_id' })
  user: User | null;

  @Column({ name: 'to_email', type: 'varchar', length: 255 })
  toEmail: string;

  @Column({ type: 'varchar', length: 255 })
  subject: string;

  @Column({ type: 'text' })
  body: string;

  /** A deep link into the app, when the notification points at something. */
  @Column({ type: 'varchar', length: 512, nullable: true })
  link: string | null;

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status: string;

  /** How many times a send has been *attempted*, incremented when claimed. */
  @Column({ type: 'integer', default: 0 })
  attempts: number;

  @Column({ name: 'max_attempts', type: 'integer', default: 5 })
  maxAttempts: number;

  /**
   * When the next attempt is allowed. Set to `now()` on enqueue, pushed into the
   * future on a failed attempt (the backoff) and on a claim (the lease, so two
   * workers do not both send the same row).
   */
  @Column({ name: 'next_attempt_at', type: 'timestamp', default: () => 'now()' })
  nextAttemptAt: Date;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError: string | null;

  @Column({ name: 'sent_at', type: 'timestamp', nullable: true })
  sentAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
