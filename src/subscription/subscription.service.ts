import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository, type EntityManager } from 'typeorm';
import { Subscription } from './subscription.entity.js';
import { PlanService } from '../plan/plan.service.js';
import type { Plan } from '../plan/plan.entity.js';
import { SelectPlanDto } from './dto/select-plan.dto.js';
import type { PlanUsageDto } from './dto/subscription-response.dto.js';
import {
  isUsableSubscription,
  subscriptionRefusalReason,
} from '../common/enums.js';
import { PlanLimitService } from '../plan-limit/plan-limit.service.js';
import { BILLING_PROVIDER } from '../billing/billing.tokens.js';
import type {
  BillingProvider,
  PurchaseResult,
} from '../billing/billing-provider.js';

/**
 * The outcome of asking to move to a plan.
 *
 * `settled` means the plan is already in force and the caller can treat the
 * response as the new truth. `pending` means payment has been started but the
 * money has not arrived, so the plan is unchanged and the customer has to
 * complete a checkout first.
 */
export interface PlanChangeResult {
  subscription: Subscription;
  usage: PlanUsageDto[];
  purchase: PurchaseResult | null;
}

/**
 * Subscription lifecycle (spec §4.2): a subscription is created by subscribing to
 * a plan. Capacity enforcement lives in {@link PlanLimitService}, which every
 * consuming operation funnels through so plan limits stay centralized (spec §16).
 *
 * A plan is only ever put in force by money that has arrived. Requesting a plan
 * starts a purchase and stores it as pending; the provider's confirmation --
 * synchronous, or a webhook in production -- is what writes `planId`. This is
 * the difference between a pricing page and a pricing page that collects money.
 */
@Injectable()
export class SubscriptionService {
  constructor(
    @InjectRepository(Subscription)
    private readonly subscriptionRepo: Repository<Subscription>,
    private readonly planService: PlanService,
    private readonly planLimits: PlanLimitService,
    private readonly config: ConfigService,
    private readonly dataSource: DataSource,
    @Inject(BILLING_PROVIDER)
    private readonly billing: BillingProvider,
  ) {}

  async findById(id: string): Promise<Subscription | null> {
    return this.subscriptionRepo.findOne({
      where: { id },
      relations: { plan: true },
    });
  }

  async findByUserId(userId: string): Promise<Subscription | null> {
    return this.subscriptionRepo.findOne({
      where: { userId },
      relations: { plan: true },
    });
  }

  /** Resolves the subscription that owns an organization (spec §4.3). */
  async findByOrganizationId(
    organizationId: string,
  ): Promise<Subscription | null> {
    return this.planLimits.findByOrganizationId(organizationId);
  }

  /** Same as {@link findByOrganizationId} but fails loudly for scoped services. */
  async requireByOrganizationId(organizationId: string): Promise<Subscription> {
    return this.planLimits.requireByOrganizationId(organizationId);
  }

  /**
   * Returns the subscription owned by the user. Registration does not create one:
   * subscribing does (spec §4.2).
   */
  async requireForUser(userId: string): Promise<Subscription> {
    const subscription = await this.findByUserId(userId);
    if (!subscription) {
      throw new NotFoundException(
        'No subscription found. Subscribe to a plan first.',
      );
    }
    return subscription;
  }

  /**
   * The trial length, in days. Configurable because the commercial offer is not
   * a code change: `TRIAL_DAYS` is read per subscription rather than baked into
   * a constant.
   */
  private trialDays(): number {
    return Number(this.config.get<string>('TRIAL_DAYS', '14'));
  }

  /**
   * Subscribes to a plan.
   *
   * A trial is granted without payment -- that is what a trial is -- and is
   * stamped with an end date here, so it stops granting capacity on its own.
   * An `active` subscription has to be paid for, so it takes the same
   * start-a-purchase path as a plan change and may come back pending.
   */
  async subscribe(
    userId: string,
    dto: SelectPlanDto,
  ): Promise<PlanChangeResult> {
    const plan = await this.planService.requireById(dto.planId);
    const status = dto.status ?? 'active';

    const existing = await this.findByUserId(userId);
    if (existing && isUsableSubscription(existing)) {
      if (existing.planId === plan.id) {
        return {
          subscription: existing,
          usage: await this.usageSummary(existing),
          purchase: null,
        };
      }

      throw new ConflictException(
        'An active subscription already exists. Change the plan instead of subscribing again.',
      );
    }

    // A lapsed trial, a cancellation or a suspension all re-enter here: the row
    // is reused rather than duplicated, because the user may only ever have one
    // subscription.
    if (existing) {
      return this.resume(existing, plan, status);
    }

    if (status === 'trial') {
      const trial = this.subscriptionRepo.create({
        userId,
        planId: plan.id,
        plan,
        status: 'trial',
        trialEndsAt: this.trialEnd(),
      });

      const saved = await this.subscriptionRepo.save(trial);

      return {
        subscription: saved,
        usage: await this.usageSummary(saved),
        purchase: null,
      };
    }

    const subscription = this.subscriptionRepo.create({
      userId,
      status: 'pending_payment',
      planId: null,
    });

    const saved = await this.subscriptionRepo.save(subscription);
    return this.startPurchase(saved, plan);
  }

  /**
   * Puts a lapsed or cancelled subscription back on a plan, keeping its history
   * and its organizations.
   */
  private async resume(
    existing: Subscription,
    plan: Plan,
    status: string,
  ): Promise<PlanChangeResult> {
    if (status === 'trial') {
      existing.status = 'trial';
      existing.trialEndsAt = this.trialEnd();
      existing.planId = plan.id;
      existing.pendingPlanId = null;
      existing.pendingPlanReference = null;

      const revived = await this.subscriptionRepo.save(existing);
      revived.plan = plan;

      return {
        subscription: revived,
        usage: await this.usageSummary(revived),
        purchase: null,
      };
    }

    existing.status = 'pending_payment';
    existing.planId = null;
    existing.trialEndsAt = null;
    const saved = await this.subscriptionRepo.save(existing);

    return this.startPurchase(saved, plan);
  }

  /**
   * Asks the provider to take money for `plan` and records the attempt as
   * pending.
   *
   * `planId` is deliberately left alone until the provider confirms. A customer
   * who closes the checkout window must not end up on the plan they did not pay
   * for, and a customer who retries must not be charged twice for one purchase.
   *
   * Every write goes through `manager`, not `this.subscriptionRepo`. The caller
   * may already hold a transaction with a write lock on this very row, and the
   * repository is bound to a different connection -- saving through it would
   * block on the lock the transaction itself holds and deadlock.
   */
  private async startPurchase(
    subscription: Subscription,
    plan: Plan,
    manager: EntityManager = this.dataSource.manager,
  ): Promise<PlanChangeResult> {
    const purchase = await this.billing.startPurchase({
      subscription,
      plan,
      attemptId: randomUUID(),
      successUrl: `${this.appBaseUrl()}/subscription?purchase=confirmed`,
      cancelUrl: `${this.appBaseUrl()}/subscription?purchase=cancelled`,
    });

    // The provider issues the reference payment will be reported against, so it
    // is what gets stored and what a later confirmation is matched on. Using the
    // attempt id here instead would be wrong in the other direction: two
    // attempts to buy the same plan would then be indistinguishable to
    // `confirmPurchase`, and a single confirmation could settle the wrong one.
    subscription.pendingPlanId = plan.id;
    subscription.pendingPlanReference = purchase.reference;
    subscription.pendingPlan = plan;

    if (purchase.confirmed) {
      await this.applyPaidPlan(
        subscription,
        plan,
        purchase.subscriptionRef,
        manager,
      );
    } else {
      await manager.getRepository(Subscription).save(subscription);
    }

    return {
      subscription,
      usage: await this.usageSummary(subscription, manager),
      purchase,
    };
  }

  /**
   * Writes a plan that has been paid for.
   *
   * Called on the confirmation path, whether that arrives inside the request
   * (the stub) or later on a webhook. Reactivating a subscription clears
   * `trialEndsAt`: a trial and a paid agreement are not both true at once, and
   * leaving the old date behind would eventually lapse a paying customer.
   */
  private async applyPaidPlan(
    subscription: Subscription,
    plan: Plan,
    subscriptionRef: string | null,
    manager: EntityManager = this.dataSource.manager,
  ): Promise<void> {
    subscription.planId = plan.id;
    subscription.plan = plan;
    subscription.status = 'active';
    subscription.trialEndsAt = null;
    subscription.pendingPlanId = null;
    subscription.pendingPlanReference = null;
    subscription.pendingPlan = null;
    if (subscriptionRef) {
      subscription.billingSubscriptionRef = subscriptionRef;
    }

    await manager.getRepository(Subscription).save(subscription);
  }

  private appBaseUrl(): string {
    return (
      this.config.get<string>('APP_BASE_URL') ?? 'http://localhost:3000'
    ).replace(/\/+$/, '');
  }

  private trialEnd(): Date {
    const end = new Date();
    end.setDate(end.getDate() + this.trialDays());
    return end;
  }

  /**
   * Switches plans.
   *
   * The downgrade guard runs before the purchase is started, so a customer is
   * never asked to pay for a plan they cannot fit into, and it runs under the
   * tenant lock so a concurrent capacity-consuming request cannot invalidate it
   * between the check and the purchase. The plan itself is not moved here: the
   * provider's confirmation does that.
   */
  async changePlan(
    subscription: Subscription,
    planId: string,
  ): Promise<PlanChangeResult> {
    const plan = await this.planService.requireById(planId);

    if (subscription.planId === plan.id) {
      return {
        subscription,
        usage: await this.usageSummary(subscription),
        purchase: null,
      };
    }

    return this.planLimits.locked(subscription.id, async (limits, current) => {
      const refusal = subscriptionRefusalReason(current);
      if (refusal) {
        throw new BadRequestException(refusal);
      }

      await limits.assertDowngradeIsSafe(current, plan);

      // Deliberately leaves `planId`, `plan` and `status` alone. The customer
      // keeps using -- and paying for -- the plan they already had until the
      // money for the new one arrives; the pending fields record what is on its
      // way. Moving the plan here would hand out the new plan's capacity for
      // free, and would leave a customer who then cancelled stuck with a plan
      // they never paid for.
      return this.startPurchase(current, plan, limits.manager);
    });
  }

  /**
   * Applies a purchase the provider has confirmed.
   *
   * The plan id comes from the reference the provider issued, never from the
   * request, so a forged webhook body cannot name a plan that was never paid
   * for. Applying the same reference twice is a no-op, which is what makes a
   * retried webhook delivery safe.
   */
  async confirmPurchase(reference: string): Promise<PlanChangeResult | null> {
    const confirmed = await this.billing.confirmPurchase(reference);

    if (!confirmed) {
      return null;
    }

    const subscription = await this.subscriptionRepo.findOne({
      where: { pendingPlanReference: reference },
    });

    if (!subscription) {
      return null;
    }

    // Already applied: the delivery is a duplicate.
    if (subscription.planId === confirmed.planId) {
      return null;
    }

    const plan = await this.planService.requireById(confirmed.planId);
    await this.applyPaidPlan(subscription, plan, null);

    return {
      subscription,
      usage: await this.usageSummary(subscription),
      purchase: null,
    };
  }

  /**
   * Cancels the subscription: the recurring agreement is stopped at the provider
   * and the status is closed locally. Data is preserved, and capacity-consuming
   * operations stay refused until the subscription is resumed by subscribing
   * again.
   *
   * The reference is captured before the row is cleared, because the outstanding
   * purchase is voided at the provider rather than merely forgotten locally.
   * Forgetting it would leave a live checkout that a determined customer could
   * still pay, handing back a plan they cancelled.
   */
  async cancel(subscription: Subscription): Promise<Subscription> {
    if (subscription.billingSubscriptionRef) {
      await this.billing.cancelSubscription(subscription);
    }

    if (subscription.pendingPlanReference) {
      await this.billing.voidPurchase(subscription.pendingPlanReference);
    }

    subscription.status = 'cancelled';
    subscription.pendingPlanId = null;
    subscription.pendingPlanReference = null;
    subscription.pendingPlan = null;

    return this.subscriptionRepo.save(subscription);
  }

  /** Usage for every limited resource, for the subscription dashboard. */
  async usageSummary(
    subscription: Subscription,
    manager?: EntityManager,
  ): Promise<PlanUsageDto[]> {
    const usage = await this.planLimits.usageAll(subscription, manager);

    return usage.map(({ resource, used, limit }) => ({
      resource,
      used,
      limit,
      remaining: Math.max(0, limit - used),
    }));
  }
}
