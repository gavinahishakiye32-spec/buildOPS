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

  /**
   * Membership status: `active` while the member may use the organization,
   * `deactivated` while their access is suspended.
   *
   * It is only meaningful once `userId` is set -- an unassigned role definition
   * has no member to suspend -- which is why it is reported by the member
   * endpoints rather than by `toResponse()`. Read through
   * {@link RoleService.resolve}, this column is what a deactivation actually
   * does: an inactive membership resolves to no membership at all, so every
   * organization-scoped request fails the permission guard from then on.
   *
   * The column is deliberately not `@DeleteDateColumn`. Deactivation is
   * reversible state a colleague has to be able to see in a list, not a filter
   * that hides the row from every query it is not expected in.
   */
  @Column({ type: 'varchar', length: 20, default: 'active' })
  status: string;

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
