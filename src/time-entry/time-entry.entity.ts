import { Column, CreateDateColumn, DeleteDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Subtask } from '../subtask/subtask.entity.js';
import { User } from '../user/user.entity.js';

@Entity('time_entries')
export class TimeEntry {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'subtask_id', type: 'uuid' })
  subtaskId: string;

  @ManyToOne(() => Subtask, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'subtask_id' })
  subtask: Subtask;

  /**
   * `RESTRICT`, not the `SET NULL` this used to declare. Users are never
   * hard-deleted (only deactivated via `status`), so the rule was latent -- but
   * it was also wrong: the column is `NOT NULL`, and a `SET NULL` key against a
   * `NOT NULL` column makes deleting a user who has logged time raise a foreign
   * key violation. `RESTRICT` states the real intent, which is that logged time
   * is not separable from its author: if user deletion is ever added, the
   * database refuses instead of destroying or orphaning the entries.
   */
  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ name: 'entry_time', type: 'timestamp' })
  entryTime: Date;

  @Column({ name: 'exit_time', type: 'timestamp', nullable: true })
  exitTime: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  /** Duration in seconds; live while the timer is running. */
  durationSeconds(now: Date = new Date()): number {
    const end = this.exitTime ?? now;
    return Math.max(
      0,
      Math.floor((end.getTime() - this.entryTime.getTime()) / 1000),
    );
  }

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

  toResponse(now: Date = new Date()) {
    return {
      id: this.id,
      subtaskId: this.subtaskId,
      userId: this.userId,
      entryTime: this.entryTime,
      exitTime: this.exitTime,
      durationSeconds: this.durationSeconds(now),
      isRunning: this.exitTime === null,
      createdAt: this.createdAt,
    };
  }
}
