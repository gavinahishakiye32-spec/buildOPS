import { Column, CreateDateColumn, DeleteDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { Project } from '../project/project.entity.js';
import { Team } from '../team/team.entity.js';
import { Badge } from '../badge/badge.entity.js';

@Entity('tasks')
export class Task {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'project_id', type: 'uuid' })
  projectId: string;

  @ManyToOne(() => Project, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'project_id' })
  project: Project;

  @Column({ name: 'team_id', type: 'uuid', nullable: true })
  teamId: string | null;

  @ManyToOne(() => Team, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'team_id' })
  team: Team | null;

  @Column({ name: 'badge_id', type: 'uuid', nullable: true })
  badgeId: string | null;

  @ManyToOne(() => Badge, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'badge_id' })
  badge: Badge | null;

  @Column({ type: 'varchar', length: 255 })
  title: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'varchar', length: 50, default: 'medium' })
  priority: string;

  @Column({ type: 'varchar', length: 50, default: 'todo' })
  status: string;

  @Column({ name: 'due_date', type: 'date', nullable: true })
  dueDate: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  /**
   * Set when this row was soft-deleted, `null` while it is live.
   *
   * Declaring it as a `@DeleteDateColumn` rather than a plain column is what
   * turns on TypeORM's soft-delete behaviour, and both halves of that matter:
   * every `find`/`findOne`/`count` silently adds `deleted_at IS NULL`, and
   * `Repository.delete()` becomes an update instead of a `DELETE FROM`. That is
   * why the existing delete routes needed no rewrite and why the rows that
   * cascade from them are still recoverable.
   *
   * The filter reaches further than it looks: measured against PostgreSQL, it
   * applies to the root alias and to every joined alias of a query builder,
   * whether the join names the entity class or the table as a string, and
   * whether it is an inner or a left join. That is why none of the existing
   * reads needed changing. Hand-written SQL through `DataSource.query` is the
   * one thing it does not reach, and there is none against these tables.
   */
  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamp', nullable: true })
  deletedAt: Date | null;

  /** Who deleted it, kept for as long as the row is kept. */
  @Column({ name: 'deleted_by', type: 'uuid', nullable: true })
  deletedBy: string | null;

  toResponse() {
    return {
      id: this.id,
      projectId: this.projectId,
      teamId: this.teamId,
      badgeId: this.badgeId,
      title: this.title,
      description: this.description,
      priority: this.priority,
      status: this.status,
      dueDate: this.dueDate,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}
