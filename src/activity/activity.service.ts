import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Between,
  type EntityManager,
  Repository,
} from 'typeorm';
import {
  resolvePage,
  toPaginated,
  type Paginated,
} from '../common/pagination.dto.js';
import { recordActivity } from './record-activity.js';
import {
  ActivityEvent,
  type ActivityAction,
  type ActivityEntityType,
} from './activity.entity.js';
import {
  ActivityBreakdownDto,
  ActivityBreakdownEntryDto,
  ActivityEventDto,
  ActivityEventsQueryDto,
  ActivityLeaderboardDto,
  ActivityLeaderboardQueryDto,
  ActivityRangeQueryDto,
  ActivityTimelineBucketDto,
  ActivityTimelineDto,
  ActivityTimelineQueryDto,
} from './dto/activity.dto.js';

const DEFAULT_RANGE_DAYS = 30;
const MAX_RANGE_DAYS = 366;

interface Range {
  from: Date;
  to: Date;
}

/**
 * The write side is one method, {@link ActivityService.record}, and it takes a
 * transactional `EntityManager` on purpose: an activity event is only worth
 * writing if the mutation it describes is written with it, so every caller
 * either already holds a transaction or opens one. A "best effort" insert
 * outside the transaction would produce a feed that lies — events for changes
 * that rolled back, and missing events for changes that succeeded.
 *
 * The read side is the four analytics views behind `GET /activity/*`
 * (spec §21). Every query is organization-scoped through a bound parameter,
 * never string interpolation, and the shared date-range resolution is the same
 * 30-day default / 366-day cap the dashboard uses.
 */
@Injectable()
export class ActivityService {
  constructor(
    @InjectRepository(ActivityEvent)
    private readonly activityRepo: Repository<ActivityEvent>,
  ) {}

  // --- write ----------------------------------------------------------------

  /**
   * Appends one event inside the caller's transaction.
   *
   * The actor comes from the argument when the service already has one (it is
   * the more reliable of the two), and otherwise from the request-scoped
   * context the global interceptor publishes.
   */
  async record(
    manager: EntityManager,
    event: {
      organizationId: string;
      entityType: ActivityEntityType;
      action: ActivityAction;
      entityId: string;
      actorId?: string | null;
      projectId?: string | null;
      metadata?: Record<string, unknown> | null;
    },
  ): Promise<void> {
    await recordActivity(manager, event);
  }

  // --- read -----------------------------------------------------------------

  /** Events per day or week, oldest bucket first. */
  async timeline(
    organizationId: string,
    query: ActivityTimelineQueryDto,
  ): Promise<ActivityTimelineDto> {
    const range = this.resolveRange(query);
    const groupBy = query.groupBy ?? 'day';
    const filter = this.buildFilter(organizationId, range, query);

    const rows: { bucket: string; count: string }[] =
      await this.activityRepo.manager.query(
        `SELECT date_trunc($4, e.created_at) AS bucket, COUNT(*) AS count
           FROM activity_events e
          WHERE ${filter.sql}
          GROUP BY bucket
          ORDER BY bucket ASC`,
        [...filter.params, groupBy],
      );

    const buckets: ActivityTimelineBucketDto[] = rows.map((row) => ({
      bucket: new Date(row.bucket).toISOString(),
      count: Number(row.count),
    }));

    return {
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      groupBy,
      buckets,
    };
  }

  /** The most active users in the range, most events first. */
  async leaderboard(
    organizationId: string,
    query: ActivityLeaderboardQueryDto,
  ): Promise<ActivityLeaderboardDto> {
    const range = this.resolveRange(query);
    const filter = this.buildFilter(organizationId, range, query);
    const limit = query.limit ?? 10;

    const rows: {
      actorId: string | null;
      name: string | null;
      count: string;
    }[] = await this.activityRepo.manager.query(
      `SELECT e.actor_id AS "actorId", u.name, COUNT(*) AS count
         FROM activity_events e
         LEFT JOIN users u ON u.id = e.actor_id
        WHERE ${filter.sql}
        GROUP BY e.actor_id, u.name
        ORDER BY COUNT(*) DESC, u.name ASC
        LIMIT $${filter.params.length + 1}`,
      [...filter.params, limit],
    );

    return {
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      entries: rows.map((row) => ({
        actorId: row.actorId,
        name: row.name,
        count: Number(row.count),
      })),
    };
  }

  /** Counts per entityType+action, most frequent first. */
  async breakdown(
    organizationId: string,
    query: ActivityRangeQueryDto,
  ): Promise<ActivityBreakdownDto> {
    const range = this.resolveRange(query);
    const filter = this.buildFilter(organizationId, range, query);

    const rows: {
      entityType: string;
      action: string;
      count: string;
    }[] = await this.activityRepo.manager.query(
      `SELECT e.entity_type AS "entityType", e.action, COUNT(*) AS count
         FROM activity_events e
        WHERE ${filter.sql}
        GROUP BY e.entity_type, e.action
        ORDER BY COUNT(*) DESC, e.entity_type ASC, e.action ASC`,
      filter.params,
    );

    const items: ActivityBreakdownEntryDto[] = rows.map((row) => ({
      entityType: row.entityType,
      action: row.action,
      count: Number(row.count),
    }));

    return {
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      total: items.reduce((sum, item) => sum + item.count, 0),
      items,
    };
  }

  /** The raw feed, newest first, with the actor's name resolved. */
  async feed(
    organizationId: string,
    query: ActivityEventsQueryDto,
  ): Promise<Paginated<ActivityEventDto>> {
    const range = this.resolveRange(query);
    const { page, limit, skip } = resolvePage(query);
    const filter = this.buildFilter(organizationId, range, query);

    const [rows, total] = await this.activityRepo.findAndCount({
      where: filter.where,
      relations: { actor: true },
      order: { createdAt: 'DESC', id: 'DESC' },
      skip,
      take: limit,
    });

    return toPaginated(
      rows.map((row) => this.toEventDto(row)),
      total,
      page,
      limit,
    );
  }

  // --- helpers --------------------------------------------------------------

  /**
   * The shared date-range resolution: last 30 days when neither bound is
   * given, capped at 366 days, `from` before `to`. Mirrors the dashboard so
   * the two surfaces agree on what "the default range" means.
   */
  private resolveRange(query: ActivityRangeQueryDto): Range {
    const to = query.to ? endOfDay(new Date(query.to)) : new Date();
    const from = query.from
      ? startOfDay(new Date(query.from))
      : new Date(to.getTime() - DEFAULT_RANGE_DAYS * 86400000);

    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new BadRequestException('Invalid date range');
    }
    if (from.getTime() > to.getTime()) {
      throw new BadRequestException('from must be before to');
    }
    if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * 86400000) {
      throw new BadRequestException(
        `The range cannot exceed ${MAX_RANGE_DAYS} days`,
      );
    }

    return { from, to };
  }

  /**
   * The shared WHERE clause for the raw-SQL aggregates, with its bound
   * parameters in order. Every filter is optional and added only when present,
   * so a caller that passes nothing gets "everything in the range".
   */
  private buildFilter(
    organizationId: string,
    range: Range,
    query: ActivityRangeQueryDto,
  ): { sql: string; params: unknown[]; where: Record<string, unknown> } {
    const params: unknown[] = [organizationId, range.from, range.to];
    const clauses = [
      'e.organization_id = $1',
      'e.created_at >= $2',
      'e.created_at <= $3',
    ];
    const where: Record<string, unknown> = {
      organizationId,
      createdAt: Between(range.from, range.to),
    };

    if (query.projectId) {
      params.push(query.projectId);
      clauses.push(`e.project_id = $${params.length}`);
      where.projectId = query.projectId;
    }
    if (query.entityType) {
      params.push(query.entityType);
      clauses.push(`e.entity_type = $${params.length}`);
      where.entityType = query.entityType;
    }
    if (query.action) {
      params.push(query.action);
      clauses.push(`e.action = $${params.length}`);
      where.action = query.action;
    }
    if (query.actorId) {
      params.push(query.actorId);
      clauses.push(`e.actor_id = $${params.length}`);
      where.actorId = query.actorId;
    }

    return { sql: clauses.join(' AND '), params, where };
  }

  private toEventDto(row: ActivityEvent): ActivityEventDto {
    return {
      id: row.id,
      entityType: row.entityType,
      action: row.action,
      entityId: row.entityId,
      projectId: row.projectId,
      actor: row.actor
        ? { id: row.actor.id, name: row.actor.name }
        : row.actorId
          ? { id: row.actorId, name: null }
          : null,
      metadata: row.metadata,
      createdAt: row.createdAt.toISOString(),
    };
  }
}

function startOfDay(date: Date): Date {
  const value = new Date(date);
  value.setHours(0, 0, 0, 0);
  return value;
}

function endOfDay(date: Date): Date {
  const value = new Date(date);
  value.setHours(23, 59, 59, 999);
  return value;
}
