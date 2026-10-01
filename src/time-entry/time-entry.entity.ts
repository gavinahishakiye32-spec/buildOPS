import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
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

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'SET NULL' })
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
