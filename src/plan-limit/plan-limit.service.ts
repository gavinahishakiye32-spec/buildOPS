import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import {
  PLAN_LIMIT_RESOURCES,
  subscriptionRefusalReason,
  type PlanLimitResource,
} from '../common/enums.js';
import { Organization } from '../organization/organization.entity.js';
import { Plan } from '../plan/plan.entity.js';
import { PlanService } from '../plan/plan.service.js';
import { Project } from '../project/project.entity.js';
import { Role } from '../role/role.entity.js';
import { Subscription } from '../subscription/subscription.entity.js';

export interface PlanUsage {
  resource: PlanLimitResource;
  used: number;
  limit: number;
  label: string;
}

/**
 * A transaction-scoped view of one tenant's plan limits. Every method reads
 * through the same `EntityManager`, so a check and the write that follows it see
 * one snapshot while the tenant row stays locked.
 */
export interface PlanLimits {
  readonly manager: EntityManager;
  usage(
    subscription: Subscription,
    resource: PlanLimitResource,
  ): Promise<PlanUsage>;
  assertCanConsume(
    subscription: Subscription,
    resource: PlanLimitResource,
    additional?: number,
  ): Promise<void>;
  assertUserSeat(subscription: Subscription, userId: string): Promise<void>;
  assertDowngradeIsSafe(
    subscription: Subscription,
    plan: Plan,
  ): Promise<void>;
}

/**
 * The capacity a tenant has against its plan (spec §4.2/§16): the single place
 * that counts usage and enforces `max_organizations`, `max_users` and
 * `max_projects`.
 *
 * It also resolves the subscription that owns an organization, so feature
 * modules that must enforce capacity depend on this leaf module instead of
 * `SubscriptionModule` (importing the latter from `RoleModule` would close a
 * module cycle through `AuthorizationModule`).
 */
@Injectable()
export class PlanLimitService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly planService: PlanService,
  ) {}

  /** Resolves the subscription that owns an organization (spec §4.3). */
  async findByOrganizationId(
    organizationId: string,
  ): Promise<Subscription | null> {
    return this.dataSource.manager
      .getRepository(Subscription)
      .createQueryBuilder('subscription')
      .leftJoinAndSelect('subscription.plan', 'plan')
      .innerJoin('organizations', 'org', 'org.tenant_id = subscription.id')
      .where('org.id = :organizationId', { organizationId })
      .getOne();
  }

  /** Same as {@link findByOrganizationId} but fails loudly for scoped services. */
  async requireByOrganizationId(organizationId: string): Promise<Subscription> {
    const subscription = await this.findByOrganizationId(organizationId);

    if (!subscription) {
      throw new NotFoundException('The organization has no owning subscription');
    }

    return subscription;
  }

  /** Read-only usage against the current plan. */
  async usage(
    subscription: Subscription,
    resource: PlanLimitResource,
    manager: EntityManager = this.dataSource.manager,
  ): Promise<PlanUsage> {
    return this.usageOf(subscription, resource, manager);
  }

  /**
   * Read-only usage for every limited resource, for the subscription dashboard.
   *
   * A subscription with no plan in force -- cancelled, or a first purchase that
   * has not been paid for -- reports nothing rather than failing. There are no
   * limits to show, and a 400 here would make the subscription screen unusable
   * for exactly the customers who most need to see it.
   *
   * The `manager` argument is what lets a caller inside a locked transaction see
   * its own uncommitted snapshot; reading through `this.dataSource.manager` there
   * would report the pre-transaction counts.
   */
  async usageAll(
    subscription: Subscription,
    manager: EntityManager = this.dataSource.manager,
  ): Promise<PlanUsage[]> {
    const summary: PlanUsage[] = [];

    if (!(await this.planFor(subscription))) {
      return summary;
    }

    for (const resource of PLAN_LIMIT_RESOURCES) {
      summary.push(await this.usageOf(subscription, resource, manager));
    }

    return summary;
  }

  /**
   * Runs `work` in a transaction that holds a write lock on the tenant row. The
   * lock serialises every capacity-consuming operation of the tenant, so a count
   * and the insert that consumes the capacity cannot interleave: the
   * check-then-act race behind over-limit tenants is closed.
   *
   * `lock_timeout` is set for the transaction only. Anything that needs the
   * tenant row while this transaction holds it is a bug -- it is waiting on a
   * lock this transaction will not release until `work` returns -- and without a
   * timeout that bug presents as a request that hangs forever instead of an
   * error. Ten seconds is far longer than any legitimate capacity check.
   */
  async locked<T>(
    subscriptionId: string,
    work: (limits: PlanLimits, subscription: Subscription) => Promise<T>,
  ): Promise<T> {
    return this.dataSource.transaction(async (manager) => {
      await manager.query(`SET LOCAL lock_timeout = '10s'`);

      const subscription = await manager.getRepository(Subscription).findOne({
        where: { id: subscriptionId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!subscription) {
        throw new NotFoundException('Subscription not found');
      }

      // Loaded without a locking join: `FOR UPDATE` cannot be applied to the
      // nullable side of an outer join, which is what `relations` would emit.
      subscription.plan = subscription.planId
        ? await this.planService.findById(subscription.planId)
        : null;

      return work(this.limitsFor(manager), subscription);
    });
  }

  private limitsFor(manager: EntityManager): PlanLimits {
    return {
      manager,
      usage: (subscription, resource) =>
        this.usageOf(subscription, resource, manager),
      assertCanConsume: (subscription, resource, additional = 1) =>
        this.assertCanConsume(subscription, resource, additional, manager),
      assertUserSeat: (subscription, userId) =>
        this.assertUserSeat(subscription, userId, manager),
      assertDowngradeIsSafe: (subscription, plan) =>
        this.assertDowngradeIsSafe(subscription, plan, manager),
    };
  }

  private async assertCanConsume(
    subscription: Subscription,
    resource: PlanLimitResource,
    additional: number,
    manager: EntityManager,
  ): Promise<void> {
    // Read through the shared refusal reason rather than the status alone: a trial
    // that has run out still says `status = 'trial'`, so the status-only check
    // kept granting capacity to expired trials indefinitely.
    const refusal = subscriptionRefusalReason(subscription);

    if (refusal) {
      throw new BadRequestException(refusal);
    }

    const { used, limit, label } = await this.usageOf(
      subscription,
      resource,
      manager,
    );

    if (used + additional > limit) {
      throw new BadRequestException(
        `Plan limit reached: the ${subscription.plan?.name ?? 'current'} plan allows ${limit} ${label}, ${used} in use.`,
      );
    }
  }

  /**
   * A member claims a seat only when they are not already part of the tenant:
   * joining another organization of the same tenant reuses their existing seat.
   */
  private async assertUserSeat(
    subscription: Subscription,
    userId: string,
    manager: EntityManager,
  ): Promise<void> {
    const alreadyAMember = await manager
      .createQueryBuilder()
      .select('1', 'present')
      .from(Role, 'role')
      .innerJoin('organizations', 'org', 'org.id = role.organization_id')
      .where('org.tenant_id = :tenantId', { tenantId: subscription.id })
      .andWhere('role.user_id = :userId', { userId })
      .limit(1)
      .getRawOne<{ present: number }>();

    await this.assertCanConsume(
      subscription,
      'users',
      alreadyAMember ? 0 : 1,
      manager,
    );
  }

  private async usageOf(
    subscription: Subscription,
    resource: PlanLimitResource,
    manager: EntityManager,
  ): Promise<PlanUsage> {
    const plan = await this.requirePlan(subscription);
    const used = await this.usedOf(subscription, resource, manager);
    const { limit, label } = this.limitOf(plan, resource);

    return { resource, used, limit, label };
  }

  private async usedOf(
    subscription: Subscription,
    resource: PlanLimitResource,
    manager: EntityManager,
  ): Promise<number> {
    switch (resource) {
      case 'organizations':
        return manager.getRepository(Organization).count({
          where: { tenantId: subscription.id },
        });
      case 'users': {
        // Membership lives in `roles` (one assigned role per member and
        // organization); `users.organization_id` is only a cached first-join
        // pointer and misses members of additional organizations.
        const row = await manager
          .createQueryBuilder()
          .select('COUNT(DISTINCT role.user_id)', 'used')
          .from(Role, 'role')
          .innerJoin('organizations', 'org', 'org.id = role.organization_id')
          .where('org.tenant_id = :tenantId', { tenantId: subscription.id })
          .andWhere('role.user_id IS NOT NULL')
          .getRawOne<{ used: string }>();

        return Number(row?.used ?? 0);
      }
      case 'projects':
        return manager
          .getRepository(Project)
          .createQueryBuilder('project')
          .innerJoin('organizations', 'org', 'org.id = project.organization_id')
          .where('org.tenant_id = :tenantId', { tenantId: subscription.id })
          .getCount();
    }
  }

  private limitOf(
    plan: Plan,
    resource: PlanLimitResource,
  ): { limit: number; label: string } {
    switch (resource) {
      case 'organizations':
        return { limit: plan.maxOrganizations, label: 'organizations' };
      case 'users':
        return { limit: plan.maxUsers, label: 'users' };
      case 'projects':
        return { limit: plan.maxProjects, label: 'projects' };
    }
  }

  /**
   * Guards a plan change: usage must fit the *target* plan. Measuring against the
   * current plan instead would always pass, because the tenant already satisfies
   * the limits it was admitted under.
   */
  private async assertDowngradeIsSafe(
    subscription: Subscription,
    plan: Plan,
    manager: EntityManager,
  ): Promise<void> {
    for (const resource of PLAN_LIMIT_RESOURCES) {
      const used = await this.usedOf(subscription, resource, manager);
      const { limit, label } = this.limitOf(plan, resource);

      if (used > limit) {
        throw new BadRequestException(
          `Cannot switch to the ${plan.name} plan: ${used} ${label} are in use but the plan allows ${limit}.`,
        );
      }
    }
  }

  /**
   * The plan a usage figure is measured against, or null when the subscription
   * has none in force.
   *
   * A purchase that has not settled has no plan yet, so this falls back to the
   * plan being bought. Without the fallback, asking for usage during an
   * unsettled purchase failed with "Subscription has no plan attached" -- which
   * is exactly backwards, because the pending plan is what the customer needs to
   * see the limits of before paying for it.
   */
  private async planFor(subscription: Subscription): Promise<Plan | null> {
    const candidate =
      subscription.plan ??
      subscription.pendingPlan ??
      (subscription.planId
        ? await this.planService.findById(subscription.planId)
        : null);

    if (candidate) {
      subscription.plan = candidate;
    }

    return candidate;
  }

  private async requirePlan(subscription: Subscription): Promise<Plan> {
    const plan = await this.planFor(subscription);

    if (!plan) {
      throw new BadRequestException('Subscription has no plan attached');
    }

    return plan;
  }
}
