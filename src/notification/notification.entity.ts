import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Organization } from '../organization/organization.entity.js';
import { Subtask } from '../subtask/subtask.entity.js';
import { Task } from '../task/task.entity.js';
import { User } from '../user/user.entity.js';

/** What a notification is about. Closed so the interface can pick an icon. */
export const NOTIFICATION_TYPES = [
  'subtask_assigned',
  'subtask_reassigned',
  'milestone_created',
  'milestone_updated',
  'milestone_deleted',
  'milestone_restored',
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/**
 * One thing worth telling somebody about, addressed to exactly one person.
 *
 * Not soft-deleted. A notification is a receipt that something happened, and a
 * receipt the reader can un-see is not a receipt: it disappears for the one
 * person who is supposed to have been told, and only for them, which is the
 * hardest kind of bug to notice. `organization_id` cascades so a deleted
 * organization takes its notifications with it.
 */
@Entity('notifications')
@Index('IDX_notifications_user_recent', ['userId', 'createdAt'])
@Index('IDX_notifications_organization', ['organizationId'])
export class Notification {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organization_id' })
  organization: Organization;

  /** The recipient. Always the resolved caller -- never taken from a request. */
  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ type: 'varchar', length: 50, default: 'subtask_assigned' })
  type: string;

  @Column({ type: 'varchar', length: 255 })
  title: string;

  @Column({ type: 'text', nullable: true })
  body: string | null;

  /**
   * What the notification is about, so the interface can deep-link rather than
   * showing a dead-end sentence. Nullable and `ON DELETE CASCADE`: the work the
   * notification described can be deleted, and the notification should go with
   * it rather than survive as a link to nothing.
   */
  @Column({ name: 'task_id', type: 'uuid', nullable: true })
  taskId: string | null;

  @ManyToOne(() => Task, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'task_id' })
  task: Task | null;

  @Column({ name: 'subtask_id', type: 'uuid', nullable: true })
  subtaskId: string | null;

  @ManyToOne(() => Subtask, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'subtask_id' })
  subtask: Subtask | null;

  /**
   * Whoever caused it, for "Ada assigned this to you".
   *
   * `SET NULL` rather than cascade: the notification is still true and still
   * unread long after the person who wrote it has left the organization.
   */
  @Column({ name: 'actor_id', type: 'uuid', nullable: true })
  actorId: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'actor_id' })
  actor: User | null;

  /** When the reader saw it. `null` is what the badge counts. */
  @Column({ name: 'read_at', type: 'timestamp', nullable: true })
  readAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  toResponse() {
    return {
      id: this.id,
      type: this.type,
      title: this.title,
      body: this.body,
      taskId: this.taskId,
      subtaskId: this.subtaskId,
      actor: this.actor ? { id: this.actor.id, name: this.actor.name } : null,
      readAt: this.readAt,
      createdAt: this.createdAt,
    };
  }
}