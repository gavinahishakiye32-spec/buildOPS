import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import {
  resolvePage,
  toPaginated,
  type Paginated,
  type PaginationQueryDto,
} from '../common/pagination.dto.js';
import { Badge } from './badge.entity.js';
import { CreateBadgeDto, UpdateBadgeDto } from './dto/badge.dto.js';
import {
  restoreBy,
  softDeleteBy,
  type TrashEntryDto,
} from '../common/soft-delete.js';
import { recordActivity } from '../activity/record-activity.js';

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
    return this.badgeRepo.manager.transaction(async (manager) => {
      const badgeRepo = manager.getRepository(Badge);
      const badge = await badgeRepo.save(
        badgeRepo.create({
          organizationId,
          name: dto.name.trim(),
          description: dto.description ?? null,
          color: dto.color ?? null,
          icon: dto.icon ?? null,
        }),
      );

      await recordActivity(manager, {
        organizationId,
        entityType: 'badge',
        action: 'created',
        entityId: badge.id,
        metadata: { name: badge.name },
      });

      return badge;
    });
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

    return this.badgeRepo.manager.transaction(async (manager) => {
      const badgeRepo = manager.getRepository(Badge);
      const saved = await badgeRepo.save(badge);

      await recordActivity(manager, {
        organizationId,
        entityType: 'badge',
        action: 'updated',
        entityId: badgeId,
        metadata: { name: saved.name },
      });

      return saved;
    });
  }

  /**
   * Soft-deletes a badge.
   *
   * Tasks keep a `badgeId` that becomes `NULL` when the badge goes, and a
   * restored badge does not reattach them: the assignment is a point-in-time
   * fact about a task, not a link worth reconstructing.
   */
  async remove(
    organizationId: string,
    badgeId: string,
    actorId: string,
  ): Promise<void> {
    const badge = await this.findOne(organizationId, badgeId);

    await this.badgeRepo.manager.transaction(async (manager) => {
      await softDeleteBy(
        manager.getRepository(Badge),
        'id = :id',
        { id: badgeId },
        actorId,
        new Date(),
      );

      await recordActivity(manager, {
        organizationId,
        entityType: 'badge',
        action: 'deleted',
        entityId: badgeId,
        actorId,
        metadata: { name: badge.name },
      });
    });
  }

  async restore(organizationId: string, badgeId: string): Promise<Badge> {
    const badge = await this.badgeRepo.findOne({
      where: { id: badgeId, organizationId },
      withDeleted: true,
    });

    if (!badge) {
      throw new NotFoundException('Badge not found');
    }

    if (!badge.deletedAt) {
      throw new ConflictException('Badge is not deleted');
    }

    await this.badgeRepo.manager.transaction(async (manager) => {
      await restoreBy(manager.getRepository(Badge), 'id = :id', { id: badgeId });

      await recordActivity(manager, {
        organizationId,
        entityType: 'badge',
        action: 'restored',
        entityId: badgeId,
        metadata: { name: badge.name },
      });
    });

    return this.findOne(organizationId, badgeId);
  }

  async listDeleted(organizationId: string): Promise<TrashEntryDto[]> {
    const rows = await this.badgeRepo.find({
      where: { organizationId, deletedAt: Not(IsNull()) },
      order: { deletedAt: 'DESC' },
      withDeleted: true,
    });

    return rows.map((row) => ({
      id: row.id,
      deletedAt: row.deletedAt as Date,
      deletedBy: row.deletedBy,
      resource: row.toResponse(),
    }));
  }
}
