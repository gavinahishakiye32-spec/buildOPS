import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Organization } from '../organization/organization.entity.js';
import { Project } from '../project/project.entity.js';
import { Subtask } from '../subtask/subtask.entity.js';
import { Task } from '../task/task.entity.js';
import { User } from '../user/user.entity.js';

/** What a channel is attached to. Closed so clients can pick an icon/label. */
export const CHAT_CHANNEL_TYPES = [
  'organization',
  'project',
  'task',
  'subtask',
  'direct',
] as const;

export type ChatChannelType = (typeof CHAT_CHANNEL_TYPES)[number];

/** Types the service lazily ensures exist, rather than accepting from a client. */
export const AUTO_CHAT_CHANNEL_TYPES = [
  'organization',
  'project',
  'task',
  'subtask',
] as const satisfies readonly ChatChannelType[];

/**
 * A conversation room. Four scopes are attached to existing work and are hard
 * deleted with it (`ON DELETE CASCADE`); `direct` channels belong to their
 * participants and outlive any particular project or task.
 *
 * `last_message_at` is denormalised so the conversation list can be ordered
 * without touching every message row; it is `null` for a room nobody has spoken
 * in yet, which the list sorts last.
 */
@Entity('chat_channels')
@Index('IDX_chat_channels_organization', ['organizationId'])
@Index('IDX_chat_channels_last_message', ['organizationId', 'lastMessageAt'])
export class ChatChannel {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organization_id' })
  organization: Organization;

  @Column({ type: 'varchar', length: 20 })
  type: ChatChannelType;

  /** Set for `project` channels; the partial unique index keeps one per scope. */
  @Column({ name: 'project_id', type: 'uuid', nullable: true })
  projectId: string | null;

  @ManyToOne(() => Project, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'project_id' })
  project: Project | null;

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

  /** Optional label; chiefly for named group DMs. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  name: string | null;

  @Column({ name: 'last_message_at', type: 'timestamp', nullable: true })
  lastMessageAt: Date | null;

  /** Who opened the room. `SET NULL`: the room is not theirs to lose. */
  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  createdBy: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'created_by' })
  creator: User | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  toResponse() {
    return {
      id: this.id,
      organizationId: this.organizationId,
      type: this.type,
      projectId: this.projectId,
      taskId: this.taskId,
      subtaskId: this.subtaskId,
      name: this.name,
      lastMessageAt: this.lastMessageAt,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}

/**
 * One message in a channel.
 *
 * Soft-deleted rather than removed: clients have already rendered it, and
 * moderation wants to know who removed it. Deleted rows stay in the table and
 * leave every list; the gateway tells joined clients to drop them by id.
 */
@Entity('chat_messages')
@Index('IDX_chat_messages_channel_created', ['channelId', 'createdAt'])
@Index('IDX_chat_messages_organization', ['organizationId'])
export class ChatMessage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organization_id' })
  organization: Organization;

  @Column({ name: 'channel_id', type: 'uuid' })
  channelId: string;

  @ManyToOne(() => ChatChannel, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'channel_id' })
  channel: ChatChannel;

  @Column({ name: 'sender_id', type: 'uuid' })
  senderId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'sender_id' })
  sender: User;

  @Column({ type: 'text' })
  body: string;

  @Column({ name: 'edited_at', type: 'timestamp', nullable: true })
  editedAt: Date | null;

  @Column({ name: 'deleted_at', type: 'timestamp', nullable: true })
  deletedAt: Date | null;

  @Column({ name: 'deleted_by', type: 'uuid', nullable: true })
  deletedBy: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  toResponse() {
    return {
      id: this.id,
      channelId: this.channelId,
      senderId: this.senderId,
      sender: this.sender
        ? { id: this.sender.id, name: this.sender.name }
        : { id: this.senderId, name: 'Unknown' },
      body: this.body,
      editedAt: this.editedAt,
      createdAt: this.createdAt,
    };
  }
}

/**
 * Membership of a channel plus that viewer's read marker.
 *
 * The composite primary key is the whole point: a user is in a channel once,
 * and their `last_read_at` hangs off that single row.
 */
@Entity('chat_channel_participants')
@Index('IDX_chat_channel_participants_user', ['userId'])
export class ChatChannelParticipant {
  @PrimaryColumn({ name: 'channel_id', type: 'uuid' })
  channelId: string;

  @ManyToOne(() => ChatChannel, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'channel_id' })
  channel: ChatChannel;

  @PrimaryColumn({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  /** `null` is unread; the unread count is every message after this instant. */
  @Column({ name: 'last_read_at', type: 'timestamp', nullable: true })
  lastReadAt: Date | null;

  @Column({ name: 'joined_at', type: 'timestamp', default: () => 'now()' })
  joinedAt: Date;
}
