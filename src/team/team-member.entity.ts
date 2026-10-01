import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Team } from './team.entity.js';
import { User } from '../user/user.entity.js';

@Entity('team_members')
export class TeamMember {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'team_id', type: 'uuid' })
  teamId: string;

  @ManyToOne(() => Team, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'team_id' })
  team: Team;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ type: 'varchar', length: 50, default: 'member' })
  role: string;

  @Column({ type: 'varchar', length: 50, default: 'active' })
  status: string;

  @CreateDateColumn({ name: 'joined_at' })
  joinedAt: Date;

  toResponse() {
    return {
      id: this.id,
      teamId: this.teamId,
      userId: this.userId,
      user: this.user
        ? { id: this.user.id, name: this.user.name, email: this.user.email }
        : null,
      role: this.role,
      status: this.status,
      joinedAt: this.joinedAt,
    };
  }
}
