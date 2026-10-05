import { Column, CreateDateColumn, DeleteDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { Task } from '../task/task.entity.js';
import { User } from '../user/user.entity.js';

@Entity('subtasks')
export class Subtask {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'task_id', type: 'uuid' })
  taskId: string;

  @ManyToOne(() => Task, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'task_id' })
  task: Task;

  /** Assigned user — must be an active TeamMember of the parent task's team. */
  @Column({ name: 'assigned_to', type: 'uuid', nullable: true })
  assignedTo: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'assigned_to' })
  assignee: User | null;

  @Column({ type: 'varchar', length: 255 })
  title: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

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
      taskId: this.taskId,
      assignedTo: this.assignedTo,
      title: this.title,
      description: this.description,
      status: this.status,
      dueDate: this.dueDate,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}
