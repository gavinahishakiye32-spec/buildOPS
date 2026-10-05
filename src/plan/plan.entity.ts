import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('plans')
export class Plan {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ name: 'max_users', type: 'integer', default: 1 })
  maxUsers: number;

  @Column({ name: 'max_projects', type: 'integer', default: 1 })
  maxProjects: number;

  @Column({ name: 'max_storage_gb', type: 'integer', default: 1 })
  maxStorageGb: number;

  @Column({ name: 'max_organizations', type: 'integer', default: 1 })
  maxOrganizations: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  price: string;

  /**
   * Identifier of this plan's recurring price inside the payment provider
   * (a Stripe price id, a Paddle plan id). Null until a real provider is wired
   * up.
   *
   * The provider is the authority on the amount: a purchase carries this
   * reference, never the `price` column, because a price supplied by the client
   * is a price the client chose.
   */
  @Column({ name: 'billing_price_ref', type: 'varchar', nullable: true })
  billingPriceRef: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  toResponse() {
    return {
      id: this.id,
      name: this.name,
      description: this.description,
      maxUsers: this.maxUsers,
      maxProjects: this.maxProjects,
      maxStorageGb: this.maxStorageGb,
      maxOrganizations: this.maxOrganizations,
      price: this.price,
      billingPriceRef: this.billingPriceRef,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}
