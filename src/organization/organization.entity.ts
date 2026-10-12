import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Subscription } from '../subscription/subscription.entity.js';
import {
  DEFAULT_ORGANIZATION_CURRENCY,
  ORGANIZATION_CURRENCIES,
} from '../common/enums.js';

/**
 * The values as a SQL `IN` list, from the same array the validator and the
 * Swagger enum read. Written out for the same reason as the settings constraints
 * (`user-settings.entity.ts:37-49`): TypeORM compares a `@Check` against the
 * live constraint by name *and* expression, so the expression has to match the
 * migration exactly or it proposes dropping the constraint it should keep.
 */
const inList = (values: readonly string[]): string =>
  values.map((value) => `'${value}'`).join(', ');

@Entity('organizations')
@Check(
  `CHK_organizations_currency`,
  `"currency" IN (${inList(ORGANIZATION_CURRENCIES)})`,
)
export class Organization {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId: string;

  @ManyToOne(() => Subscription, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenant_id' })
  tenant: Subscription;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({ type: 'varchar', length: 50, default: 'active' })
  status: string;

  /**
   * The ISO 4217 code this organization's money is read in.
   *
   * On the organization rather than in `organization_settings` because the app
   * already loads the organization list on every request cycle and would have to
   * fetch settings separately to learn this. It is a fact about the workspace
   * itself, decided once when the workspace is created, and shared by every
   * member -- which is exactly what belongs here rather than in user settings.
   *
   * NOT NULL with a default so a row is never partially configured, matching how
   * the settings tables are built.
   */
  @Column({
    type: 'varchar',
    length: 3,
    default: DEFAULT_ORGANIZATION_CURRENCY,
  })
  currency: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  toResponse() {
    return {
      id: this.id,
      tenantId: this.tenantId,
      name: this.name,
      status: this.status,
      currency: this.currency,
      createdAt: this.createdAt,
    };
  }
}
