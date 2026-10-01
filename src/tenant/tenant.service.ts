import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Tenant } from './tenant.entity.js';
import { Plan } from '../plan/plan.entity.js';
import { PlanService } from '../plan/plan.service.js';
import { Organization } from '../organization/organization.entity.js';
import { Project } from '../project/project.entity.js';
import { User } from '../user/user.entity.js';
import { SelectPlanDto } from './dto/select-plan.dto.js';
import type { PlanUsageDto } from './dto/tenant-response.dto.js';

export type LimitResource = 'organizations' | 'users' | 'projects';

export const LIMIT_RESOURCES: LimitResource[] = [
  'organizations',
  'users',
  'projects',
];

/**
 * Subscription state machine (spec §4.2): a tenant is created by subscribing to
 * a plan, and every capacity-consuming operation funnels through
 * {@link TenantService.assertCanConsume} so plan limits stay centralized (spec §16).
 */
@Injectable()
export class TenantService {
  constructor(
    @InjectRepository(Tenant)
    private readonly tenantRepo: Repository<Tenant>,
    @InjectRepository(Organization)
    private readonly organizationRepo: Repository<Organization>,
    @InjectRepository(Project)
    private readonly projectRepo: Repository<Project>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly planService: PlanService,
  ) {}

  async findById(id: string): Promise<Tenant | null> {
    return this.tenantRepo.findOne({
      where: { id },
      relations: { plan: true },
    });
  }

  async findByUserId(userId: string): Promise<Tenant | null> {
    return this.tenantRepo.findOne({
      where: { userId },
      relations: { plan: true },
    });
  }

  /** Resolves the subscription that owns an organization (spec §4.3). */
  async findByOrganizationId(organizationId: string): Promise<Tenant | null> {
    return this.tenantRepo
      .createQueryBuilder('tenant')
      .leftJoinAndSelect('tenant.plan', 'plan')
      .innerJoin('organizations', 'org', 'org.tenant_id = tenant.id')
      .where('org.id = :organizationId', { organizationId })
      .getOne();
  }

  /** Same as {@link findByOrganizationId} but fails loudly for scoped services. */
  async requireByOrganizationId(organizationId: string): Promise<Tenant> {
    const tenant = await this.findByOrganizationId(organizationId);

    if (!tenant) {
      throw new NotFoundException(
        'The organization has no owning subscription',
      );
    }

    return tenant;
  }

  /**
   * Returns the tenant owned by the user. Registration does not create a tenant:
   * subscription does (spec §4.2).
   */
  async requireForUser(userId: string): Promise<Tenant> {
    const tenant = await this.findByUserId(userId);
    if (!tenant) {
      throw new NotFoundException(
        'No subscription found. Subscribe to a plan first.',
      );
    }
    return tenant;
  }

  async subscribe(userId: string, dto: SelectPlanDto): Promise<Tenant> {
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
      const reactivated = await this.tenantRepo.save(existing);
      reactivated.plan = plan;
      return reactivated;
    }

    const tenant = this.tenantRepo.create({
      userId,
      planId: plan.id,
      status: dto.status ?? 'active',
      plan,
    });
    return this.tenantRepo.save(tenant);
  }

  async changePlan(tenant: Tenant, planId: string): Promise<Tenant> {
    const plan = await this.planService.requireById(planId);

    if (tenant.planId === plan.id) {
      tenant.plan = plan;
      return tenant;
    }

    await this.assertDowngradeIsSafe(tenant, plan);

    tenant.planId = plan.id;
    tenant.plan = plan;
    tenant.status = 'active';
    return this.tenantRepo.save(tenant);
  }

  async cancel(tenant: Tenant): Promise<Tenant> {
    tenant.status = 'cancelled';
    return this.tenantRepo.save(tenant);
  }

  isUsable(tenant: Tenant): boolean {
    return tenant.status === 'active' || tenant.status === 'trial';
  }

  /**
   * Centralized plan-limit enforcement (spec §4.2 / §16): every capacity
   * consuming operation funnels through here so subscription rules stay identical
   * across services.
   */
  async assertCanConsume(
    tenant: Tenant,
    resource: LimitResource,
    additional = 1,
  ): Promise<void> {
    if (!this.isUsable(tenant)) {
      throw new BadRequestException(
        `Subscription is ${tenant.status}. Reactivate it before using the workspace.`,
      );
    }

    const { used, limit, label } = await this.usage(tenant, resource);
    if (used + additional > limit) {
      throw new BadRequestException(
        `Plan limit reached: the ${tenant.plan?.name ?? 'current'} plan allows ${limit} ${label}, ${used} in use.`,
      );
    }
  }

  async usage(
    tenant: Tenant,
    resource: LimitResource,
  ): Promise<{ used: number; limit: number; label: string }> {
    const plan = await this.requirePlan(tenant);

    switch (resource) {
      case 'organizations': {
        const used = await this.organizationRepo.count({
          where: { tenantId: tenant.id },
        });
        return { used, limit: plan.maxOrganizations, label: 'organizations' };
      }
      case 'users': {
        const used = await this.userRepo
          .createQueryBuilder('user')
          .innerJoin('organizations', 'org', 'org.id = user.organization_id')
          .where('org.tenant_id = :tenantId', { tenantId: tenant.id })
          .getCount();
        return { used, limit: plan.maxUsers, label: 'users' };
      }
      case 'projects': {
        const used = await this.projectRepo
          .createQueryBuilder('project')
          .innerJoin('organizations', 'org', 'org.id = project.organization_id')
          .where('org.tenant_id = :tenantId', { tenantId: tenant.id })
          .getCount();
        return { used, limit: plan.maxProjects, label: 'projects' };
      }
    }
  }

  /** Usage for every limited resource, for the subscription dashboard. */
  async usageSummary(tenant: Tenant): Promise<PlanUsageDto[]> {
    const summary: PlanUsageDto[] = [];

    for (const resource of LIMIT_RESOURCES) {
      const { used, limit } = await this.usage(tenant, resource);
      summary.push({
        resource,
        used,
        limit,
        remaining: Math.max(0, limit - used),
      });
    }

    return summary;
  }

  private async requirePlan(tenant: Tenant): Promise<Plan> {
    const plan =
      tenant.plan ??
      (tenant.planId ? await this.planService.findById(tenant.planId) : null);

    if (!plan) {
      throw new BadRequestException('Subscription has no plan attached');
    }

    tenant.plan = plan;
    return plan;
  }

  private async assertDowngradeIsSafe(
    tenant: Tenant,
    plan: Plan,
  ): Promise<void> {
    for (const resource of LIMIT_RESOURCES) {
      const { used, limit, label } = await this.usage(tenant, resource);
      if (used > limit) {
        throw new BadRequestException(
          `Cannot switch to the ${plan.name} plan: ${used} ${label} are in use but the plan allows ${limit}.`,
        );
      }
    }
  }
}
