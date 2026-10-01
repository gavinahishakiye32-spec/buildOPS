import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  resolvePage,
  toPaginated,
  type Paginated,
  type PaginationQueryDto,
} from '../common/pagination.dto.js';
import { Badge } from './badge.entity.js';
import { CreateBadgeDto, UpdateBadgeDto } from './dto/badge.dto.js';

/** Badges are organization-defined task classifications (spec §10). */
@Injectable()
export class BadgeService {
  constructor(
    @InjectRepository(Badge)
    private readonly badgeRepo: Repository<Badge>,
  ) {}

  async list(
    organizationId: string,
    query: PaginationQueryDto,
  ): Promise<Paginated<Badge>> {
    const { page, limit, skip } = resolvePage(query);

    const [items, total] = await this.badgeRepo.findAndCount({
      where: { organizationId },
      order: { name: 'ASC' },
      skip,
      take: limit,
    });

    return toPaginated(items, total, page, limit);
  }

  async findOne(organizationId: string, badgeId: string): Promise<Badge> {
    const badge = await this.badgeRepo.findOne({
      where: { id: badgeId, organizationId },
    });

    if (!badge) {
      throw new NotFoundException('Badge not found in this organization');
    }

    return badge;
  }

  async create(organizationId: string, dto: CreateBadgeDto): Promise<Badge> {
    return this.badgeRepo.save(
      this.badgeRepo.create({
        organizationId,
        name: dto.name.trim(),
        description: dto.description ?? null,
        color: dto.color ?? null,
        icon: dto.icon ?? null,
      }),
    );
  }

  async update(
    organizationId: string,
    badgeId: string,
    dto: UpdateBadgeDto,
  ): Promise<Badge> {
    const badge = await this.findOne(organizationId, badgeId);

    if (dto.name !== undefined) {
      badge.name = dto.name.trim();
    }
    if (dto.description !== undefined) {
      badge.description = dto.description;
    }
    if (dto.color !== undefined) {
      badge.color = dto.color;
    }
    if (dto.icon !== undefined) {
      badge.icon = dto.icon;
    }

    return this.badgeRepo.save(badge);
  }

  async remove(organizationId: string, badgeId: string): Promise<void> {
    await this.findOne(organizationId, badgeId);
    await this.badgeRepo.delete(badgeId);
  }
}
