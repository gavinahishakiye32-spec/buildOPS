import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Task } from '../task/task.entity.js';
import { Subtask } from '../subtask/subtask.entity.js';
import {
  formatInterval,
  parseIntervalSeconds,
  type IntervalValue,
} from '../common/duration.js';

@Entity('time_complexity')
export class TimeComplexity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'task_id', type: 'uuid' })
  taskId: string;

  @ManyToOne(() => Task, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'task_id' })
  task: Task;

  @Column({ name: 'subtask_id', type: 'uuid', nullable: true })
  subtaskId: string | null;

  @ManyToOne(() => Subtask, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'subtask_id' })
  subtask: Subtask | null;

  @Column({ type: 'varchar', length: 50 })
  name: string;

  @Column({ type: 'varchar', length: 50, default: 'active' })
  status: string;

  @Column({ name: 'min_duration', type: 'interval' })
  minDuration: IntervalValue;

  @Column({ name: 'max_duration', type: 'interval' })
  maxDuration: IntervalValue;

  toResponse() {
    return {
      id: this.id,
      taskId: this.taskId,
      subtaskId: this.subtaskId,
      name: this.name,
      status: this.status,
      minDuration: formatInterval(this.minDuration) as string,
      maxDuration: formatInterval(this.maxDuration) as string,
      minDurationSeconds: parseIntervalSeconds(this.minDuration),
      maxDurationSeconds: parseIntervalSeconds(this.maxDuration),
    };
  }
}
