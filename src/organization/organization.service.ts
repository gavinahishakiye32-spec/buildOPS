import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  resolvePage,
  toPaginated,
  type Paginated,
  type PaginationQueryDto,
} from '../common/pagination.dto.js';
import { RoleService } from '../role/role.service.js';
import { SubscriptionService } from '../subscription/subscription.service.js';
import { PlanLimitService } from '../plan-limit/plan-limit.service.js';
import { Organization } from './organization.entity.js';
import {
  CreateOrganizationDto,
  UpdateOrganizationDto,
} from './dto/organization.dto.js';

/**
 * Organizations are the subscription workspace (spec §4.3). Creation is bounded by
 * the plan limit and the creator receives the Owner role so the organization is
 * administrable immediately (spec §6, §14).
 */
@Injectable()
export class OrganizationService {
  constructor(
    @InjectRepository(Organization)
    private readonly organizationRepo: Repository<Organization>,
    private readonly subscriptionService: SubscriptionService,
    private readonly roleService: RoleService,
    private readonly planLimits: PlanLimitService,
  ) {}

  async listForUser(
    userId: string,
    query: PaginationQueryDto,
  ): Promise<Paginated<Organization>> {
    const subscription = await this.subscriptionService.requireForUser(userId);
    const { page, limit, skip } = resolvePage(query);

    const [items, total] = await this.organizationRepo.findAndCount({
      where: { tenantId: subscription.id },
      order: { createdAt: 'DESC' },
      skip,
      take: limit,
    });

    return toPaginated(items, total, page, limit);
  }

  async findById(id: string): Promise<Organization> {
    const organization = await this.organizationRepo.findOne({
      where: { id },
    });

    if (!organization) {
      throw new NotFoundException('Organization not found');
    }

    return organization;
  }

  async create(
    userId: string,
    dto: CreateOrganizationDto,
  ): Promise<Organization> {
    const subscription = await this.subscriptionService.requireForUser(userId);

    const name = dto.name.trim();
    if (!name) {
      throw new BadRequestException('Organization name cannot be empty');
    }

    // The tenant row is locked for the whole operation, so the organization
    // limit and the owner's member seat are checked and consumed atomically.
    return this.planLimits.locked(
      subscription.id,
      async (limits, current) => {
        await limits.assertCanConsume(current, 'organizations');

        const organizations = limits.manager.getRepository(Organization);
        const organization = await organizations.save(
          organizations.create({
            tenantId: current.id,
            name,
            status: dto.status ?? 'active',
          }),
        );

        await this.roleService.bootstrapOwner(
          organization.id,
          userId,
          limits,
          current,
        );

        return organization;
      },
    );
  }

  async update(id: string, dto: UpdateOrganizationDto): Promise<Organization> {
    const organization = await this.findById(id);

    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (!name) {
        throw new BadRequestException('Organization name cannot be empty');
      }
      organization.name = name;
    }
    if (dto.status !== undefined) {
      organization.status = dto.status;
    }

    return this.organizationRepo.save(organization);
  }

  async remove(id: string): Promise<void> {
    await this.findById(id);
    await this.organizationRepo.delete(id);
  }
}
