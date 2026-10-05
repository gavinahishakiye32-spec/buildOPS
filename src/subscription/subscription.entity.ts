import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../user/user.entity.js';
import { Plan } from '../plan/plan.entity.js';
import { isTrialExpired } from '../common/enums.js';

/**
 * The subscription row. The table stays named `tenants` (see `schema.sql`) even
 * though the domain vocabulary is "subscription": it is referenced by
 * `organizations.tenant_id`, which is left alone for the same reason. Changing
 * either would be a database migration, not a rename.
 */
@Entity('tenants')
export class Subscription {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * Unique: a user has exactly one subscription. `findByUserId` reads a single
   * row, so without this two concurrent `POST /subscription` requests could
   * each insert one and the second would silently shadow the first.
   */
  @Column({ name: 'user_id', type: 'uuid', unique: true })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ name: 'plan_id', type: 'uuid', nullable: true })
  planId: string | null;

  @ManyToOne(() => Plan, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'plan_id' })
  plan: Plan | null;

  @Column({ type: 'varchar', length: 50, default: 'trial' })
  status: string;

  /**
   * When a trial stops granting capacity. Null for a subscription that was
   * activated by payment rather than started as a trial.
   *
   * Expiry is derived from this column rather than from `status`, so a lapsed
   * trial never has to be rewritten by a scheduled job: the subscription still
   * reads `trial`, and `isUsableSubscription` reports it as expired at any
   * moment after this instant. A job that swept rows would either miss lapses
   * between runs or need to run continuously to be exact.
   */
  @Column({ name: 'trial_ends_at', type: 'timestamp', nullable: true })
  trialEndsAt: Date | null;

  /**
   * The plan being paid for right now, and the payment reference that will
   * confirm it. Both are null when no purchase is in flight.
   *
   * A plan change is not applied when the customer asks for it; it is applied
   * when the payment settles. These two columns are what bridge the gap, and
   * they are what makes an interrupted checkout recoverable.
   */
  @Column({ name: 'pending_plan_id', type: 'uuid', nullable: true })
  pendingPlanId: string | null;

  @ManyToOne(() => Plan, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'pending_plan_id' })
  pendingPlan: Plan | null;

  @Column({ name: 'pending_plan_reference', type: 'varchar', nullable: true })
  pendingPlanReference: string | null;

  /**
   * Provider-side handle for the recurring agreement, so cancellation and
   * reconciliation talk to the payment provider rather than to our own tables.
   */
  @Column({
    name: 'billing_subscription_ref',
    type: 'varchar',
    nullable: true,
  })
  billingSubscriptionRef: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  toResponse() {
    return {
      id: this.id,
      userId: this.userId,
      planId: this.planId,
      plan: this.plan ? this.plan.toResponse() : null,
      status: this.status,
      trialEndsAt: this.trialEndsAt,
      isTrialExpired: isTrialExpired(this),
      pendingPlan: this.pendingPlan ? this.pendingPlan.toResponse() : null,
      billingSubscriptionRef: this.billingSubscriptionRef,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}

/**
 * The shape a subscription is published as. Derived from `toResponse` so the
 * entity and the documented response cannot drift apart.
 */
export type SubscriptionResponse = ReturnType<Subscription['toResponse']>;
