import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Subscription } from './subscription.entity.js';
import { Plan } from '../plan/plan.entity.js';
import { PlanService } from '../plan/plan.service.js';
import { Organization } from '../organization/organization.entity.js';
import { Project } from '../project/project.entity.js';
import { User } from '../user/user.entity.js';
import { SelectPlanDto } from './dto/select-plan.dto.js';
import type { PlanUsageDto } from './dto/subscription-response.dto.js';
import { PLAN_LIMIT_RESOURCES } from '../common/enums.js';

/** Alias kept local: the service speaks in terms of a limitable resource. */
type LimitResource = (typeof PLAN_LIMIT_RESOURCES)[number];

const LIMIT_RESOURCES: readonly LimitResource[] = PLAN_LIMIT_RESOURCES;

/**
 * Subscription state machine (spec §4.2): a subscription is created by subscribing to
 * a plan, and every capacity-consuming operation funnels through
 * {@link SubscriptionService.assertCanConsume} so plan limits stay centralized (spec §16).
 */
@Injectable()
export class SubscriptionService {
  constructor(
    @InjectRepository(Subscription)
    private readonly subscriptionRepo: Repository<Subscription>,
    @InjectRepository(Organization)
    private readonly organizationRepo: Repository<Organization>,
    @InjectRepository(Project)
    private readonly projectRepo: Repository<Project>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly planService: PlanService,
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
    return this.subscriptionRepo
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
      throw new NotFoundException(
        'The organization has no owning subscription',
      );
    }

    return subscription;
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

  async subscribe(userId: string, dto: SelectPlanDto): Promise<Subscription> {
    const plan = await this.planService.requireById(dto.planId);

    const existing = await this.findByUserId(userId);
    if (existing && this.isUsable(existing)) {
      if (existing.planId === plan.id) {
        return existing;
      }
      throw new ConflictException(
        'An active subscription already exists. Change the plan instead of subscribing again.',
      );
    }

    if (existing) {
      existing.planId = plan.id;
      existing.status = dto.status ?? 'active';
      const reactivated = await this.subscriptionRepo.save(existing);
      reactivated.plan = plan;
      return reactivated;
    }

    const subscription = this.subscriptionRepo.create({
      userId,
      planId: plan.id,
      status: dto.status ?? 'active',
      plan,
    });
    return this.subscriptionRepo.save(subscription);
  }

  async changePlan(
    subscription: Subscription,
    planId: string,
  ): Promise<Subscription> {
    const plan = await this.planService.requireById(planId);

    if (subscription.planId === plan.id) {
      subscription.plan = plan;
      return subscription;
    }

    await this.assertDowngradeIsSafe(subscription, plan);

    subscription.planId = plan.id;
    subscription.plan = plan;
    subscription.status = 'active';
    return this.subscriptionRepo.save(subscription);
  }

  async cancel(subscription: Subscription): Promise<Subscription> {
    subscription.status = 'cancelled';
    return this.subscriptionRepo.save(subscription);
  }

  isUsable(subscription: Subscription): boolean {
    return subscription.status === 'active' || subscription.status === 'trial';
  }

  /**
   * Centralized plan-limit enforcement (spec §4.2 / §16): every capacity
   * consuming operation funnels through here so subscription rules stay identical
   * across services.
   */
  async assertCanConsume(
    subscription: Subscription,
    resource: LimitResource,
    additional = 1,
  ): Promise<void> {
    if (!this.isUsable(subscription)) {
      throw new BadRequestException(
        `Subscription is ${subscription.status}. Reactivate it before using the workspace.`,
      );
    }

    const { used, limit, label } = await this.usage(subscription, resource);
    if (used + additional > limit) {
      throw new BadRequestException(
        `Plan limit reached: the ${subscription.plan?.name ?? 'current'} plan allows ${limit} ${label}, ${used} in use.`,
      );
    }
  }

  async usage(
    subscription: Subscription,
    resource: LimitResource,
  ): Promise<{ used: number; limit: number; label: string }> {
    const plan = await this.requirePlan(subscription);

    switch (resource) {
      case 'organizations': {
        const used = await this.organizationRepo.count({
          where: { tenantId: subscription.id },
        });
        return { used, limit: plan.maxOrganizations, label: 'organizations' };
      }
      case 'users': {
        const used = await this.userRepo
          .createQueryBuilder('user')
          .innerJoin('organizations', 'org', 'org.id = user.organization_id')
          .where('org.tenant_id = :tenantId', { tenantId: subscription.id })
          .getCount();
        return { used, limit: plan.maxUsers, label: 'users' };
      }
      case 'projects': {
        const used = await this.projectRepo
          .createQueryBuilder('project')
          .innerJoin('organizations', 'org', 'org.id = project.organization_id')
          .where('org.tenant_id = :tenantId', { tenantId: subscription.id })
          .getCount();
        return { used, limit: plan.maxProjects, label: 'projects' };
      }
    }
  }

  /** Usage for every limited resource, for the subscription dashboard. */
  async usageSummary(subscription: Subscription): Promise<PlanUsageDto[]> {
    const summary: PlanUsageDto[] = [];

    for (const resource of LIMIT_RESOURCES) {
      const { used, limit } = await this.usage(subscription, resource);
      summary.push({
        resource,
        used,
        limit,
        remaining: Math.max(0, limit - used),
      });
    }

    return summary;
  }

  private async requirePlan(subscription: Subscription): Promise<Plan> {
    const plan =
      subscription.plan ??
      (subscription.planId
        ? await this.planService.findById(subscription.planId)
        : null);

    if (!plan) {
      throw new BadRequestException('Subscription has no plan attached');
    }

    subscription.plan = plan;
    return plan;
  }

  private async assertDowngradeIsSafe(
    subscription: Subscription,
    plan: Plan,
  ): Promise<void> {
    for (const resource of LIMIT_RESOURCES) {
      const { used, limit, label } = await this.usage(subscription, resource);
      if (used > limit) {
        throw new BadRequestException(
          `Cannot switch to the ${plan.name} plan: ${used} ${label} are in use but the plan allows ${limit}.`,
        );
      }
    }
  }
}
