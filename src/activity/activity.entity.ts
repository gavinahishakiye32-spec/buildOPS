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
import { Project } from '../project/project.entity.js';
import { User } from '../user/user.entity.js';

/**
 * What kind of row an activity event is about. Closed so the API can enumerate
 * it in Swagger and so a typo cannot produce an unfilterable event type.
 */
export const ACTIVITY_ENTITY_TYPES = [
  'project',
  'task',
  'subtask',
  'milestone',
  'team',
  'client',
  'badge',
  'time_entry',
  'chat_message',
  'chat_channel',
  'invitation',
  'role',
  'member',
] as const;

export type ActivityEntityType = (typeof ACTIVITY_ENTITY_TYPES)[number];

/** What happened to the row. Also closed, for the same reasons. */
export const ACTIVITY_ACTIONS = [
  'created',
  'updated',
  'deleted',
  'restored',
  'accepted',
] as const;

export type ActivityAction = (typeof ACTIVITY_ACTIONS)[number];

/**
 * One "who did what" fact, written in the same transaction as the mutation it
 * describes (spec §21).
 *
 * The table is append-only from the application's point of view: no update and
 * no delete path exists, so the feed is an audit trail rather than a status
 * document. `entity_id` deliberately carries no foreign key — events must
 * survive the row they describe (chat channels are hard-deleted with their
 * scope, for instance) — while `actor_id` and `project_id` are `SET NULL` so a
 * removed user or project degrades to "system / unscoped" instead of dragging
 * the event away with them. `organization_id` is `CASCADE`: an event has no
 * meaning without its tenant.
 *
 * `metadata` holds the small extras a feed line needs (a name snapshot, the
 * fields an update touched) that are not worth a join at read time.
 */
@Entity('activity_events')
@Index('IDX_activity_events_org_created', ['organizationId', 'createdAt'])
@Index('IDX_activity_events_org_actor', ['organizationId', 'actorId', 'createdAt'])
@Index('IDX_activity_events_org_entity', [
  'organizationId',
  'entityType',
  'action',
  'createdAt',
])
@Index('IDX_activity_events_org_project', [
  'organizationId',
  'projectId',
  'createdAt',
])
export class ActivityEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organization_id' })
  organization: Organization;

  /** Who did it; `null` when the user is gone or the actor was a system job. */
  @Column({ name: 'actor_id', type: 'uuid', nullable: true })
  actorId: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'actor_id' })
  actor: User | null;

  @Column({ name: 'entity_type', type: 'varchar', length: 32 })
  entityType: ActivityEntityType;

  @Column({ type: 'varchar', length: 16 })
  action: ActivityAction;

  /**
   * Id of the row this event is about. No foreign key on purpose: the feed
   * outlives the rows it describes.
   */
  @Column({ name: 'entity_id', type: 'uuid' })
  entityId: string;

  /**
   * Project the event belongs to when one is in hand, so the analytics filters
   * can use an index instead of joining through task/subtask. `null` for
   * organization-level events (teams, clients, members) and for rows whose
   * project was not already loaded by the mutation.
   */
  @Column({ name: 'project_id', type: 'uuid', nullable: true })
  projectId: string | null;

  @ManyToOne(() => Project, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'project_id' })
  project: Project | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
