import {
  Check,
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Organization } from '../organization/organization.entity.js';
import { Project } from '../project/project.entity.js';
import { MILESTONE_STATUSES } from '../common/enums.js';

const inList = (values: readonly string[]): string =>
  values.map((value) => `'${value}'`).join(', ');

/**
 * A milestone groups deliveries of a project under a shared target date (spec:
 * project management). The organization is derived from the project, never from
 * client input; deleting a milestone detaches its tasks rather than hiding
 * them, so a wrong click cannot take work with it.
 */
@Entity('milestones')
@Check(
  `CHK_milestones_status`,
  `"status" IN (${inList(MILESTONE_STATUSES)})`,
)
export class Milestone {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organization_id' })
  organization: Organization;

  @Column({ name: 'project_id', type: 'uuid' })
  projectId: string;

  @ManyToOne(() => Project, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'project_id' })
  project: Project;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'varchar', length: 50, default: 'planned' })
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
   * `@DeleteDateColumn` rather than a plain column so every ordinary read
   * silently filters it out; the delete routes got their flagging and their
   * re-reads from `softDeleteBy`/`restoreBy` without teaching this entity
   * anything about them.
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
      name: this.name,
      description: this.description,
      status: this.status,
      dueDate: this.dueDate,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}