import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Organization } from '../organization/organization.entity.js';
import { User } from '../user/user.entity.js';
import type { Permission } from './permission.entity.js';

@Entity('roles')
export class Role {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organization_id' })
  organization: Organization;

  /**
   * Applicable user (organization member). A role row is the assignment of a
   * role definition to one member: `user_id IS NULL` means the definition is not
   * assigned yet (spec §6: create role → attach permissions → assign).
   */
  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'user_id' })
  user: User | null;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  // The target is referenced by entity name so this file never imports
  // permission.entity.js at runtime: with ESM + emitDecoratorMetadata a direct
  // import would deadlock the role <-> permission cycle.
  @OneToMany('Permission', (permission: Permission) => permission.role, {
    cascade: false,
  })
  permissions: Permission[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  toResponse() {
    return {
      id: this.id,
      organizationId: this.organizationId,
      userId: this.userId,
      name: this.name,
      description: this.description,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }

  toResponseWithPermissions() {
    return {
      ...this.toResponse(),
      permissions: (this.permissions ?? []).map((permission) =>
        permission.toResponse(),
      ),
    };
  }
}
