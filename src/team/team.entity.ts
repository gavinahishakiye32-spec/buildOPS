import { Column, CreateDateColumn, DeleteDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Organization } from '../organization/organization.entity.js';

@Entity('teams')
export class Team {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organization_id' })
  organization: Organization;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'varchar', length: 50, default: 'active' })
  status: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

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
      organizationId: this.organizationId,
      name: this.name,
      description: this.description,
      status: this.status,
      createdAt: this.createdAt,
    };
  }
}
