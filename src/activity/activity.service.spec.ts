import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { BadRequestException } from '@nestjs/common';
import { ActivityService } from './activity.service.js';
import { ActivityEvent } from './activity.entity.js';

const ORG = '00000000-0000-4000-8000-000000000001';

/**
 * The read side of the activity service is a thin layer over SQL, so the tests
 * that matter are the ones that do not show up in the SQL: the shared
 * date-range contract (30-day default, 366-day cap, from-before-to) and the
 * shape of each projection. Everything else is a GROUP BY, which the e2e suite
 * exercises against a real database.
 */
describe('ActivityService', () => {
  let activityRepo: any;
  let service: ActivityService;

  beforeEach(() => {
    activityRepo = {
      manager: { query: jest.fn(async () => []) },
      findAndCount: jest.fn(async () => [[], 0] as [unknown[], number]),
    };

    service = new ActivityService(activityRepo as never);
  });

  describe('timeline', () => {
    it('defaults to the last 30 days and buckets by day', async () => {
      const result = await service.timeline(ORG, {});

      expect(result.groupBy).toBe('day');
      expect(result.buckets).toEqual([]);

      const span = new Date(result.to).getTime() - new Date(result.from).getTime();
      // The lower bound is midnight 30 days before `to`; allow the day's slack.
      expect(span).toBeGreaterThanOrEqual(30 * 86400000);
      expect(span).toBeLessThanOrEqual(31 * 86400000);
    });

    it('groups by week when asked and maps rows to ISO buckets', async () => {
      activityRepo.manager.query.mockResolvedValue([
        { bucket: '2026-09-07T00:00:00.000Z', count: '3' },
      ]);

      const result = await service.timeline(ORG, { groupBy: 'week' });

      expect(result.groupBy).toBe('week');
      expect(result.buckets).toEqual([
        { bucket: '2026-09-07T00:00:00.000Z', count: 3 },
      ]);
      const [, params] = activityRepo.manager.query.mock.calls[0];
      expect(params[params.length - 1]).toBe('week');
    });
  });

  describe('range validation', () => {
    it('rejects a malformed date', async () => {
      await expect(
        service.timeline(ORG, { from: 'not-a-date' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(activityRepo.manager.query).not.toHaveBeenCalled();
    });

    it('rejects from after to', async () => {
      await expect(
        service.timeline(ORG, { from: '2026-09-30', to: '2026-09-01' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a range longer than 366 days', async () => {
      await expect(
        service.timeline(ORG, { from: '2024-01-01', to: '2026-01-01' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('leaderboard', () => {
    it('defaults to ten actors and maps counts to numbers', async () => {
      activityRepo.manager.query.mockResolvedValue([
        { actorId: 'user-1', name: 'Ada', count: '12' },
        { actorId: null, name: null, count: '2' },
      ]);

      const result = await service.leaderboard(ORG, {});

      expect(result.entries).toEqual([
        { actorId: 'user-1', name: 'Ada', count: 12 },
        { actorId: null, name: null, count: 2 },
      ]);
      const [, params] = activityRepo.manager.query.mock.calls[0];
      expect(params[params.length - 1]).toBe(10);
    });

    it('honours an explicit limit', async () => {
      await service.leaderboard(ORG, { limit: 25 });

      const [, params] = activityRepo.manager.query.mock.calls[0];
      expect(params[params.length - 1]).toBe(25);
    });
  });

  describe('breakdown', () => {
    it('sums the entry counts into a total', async () => {
      activityRepo.manager.query.mockResolvedValue([
        { entityType: 'task', action: 'created', count: '5' },
        { entityType: 'task', action: 'updated', count: '3' },
      ]);

      const result = await service.breakdown(ORG, {});

      expect(result.total).toBe(8);
      expect(result.items[0]).toEqual({
        entityType: 'task',
        action: 'created',
        count: 5,
      });
    });
  });

  describe('feed', () => {
    it('resolves the actor and paginates', async () => {
      const createdAt = new Date('2026-09-14T10:32:11.482Z');
      activityRepo.findAndCount.mockResolvedValue([
        [
          Object.assign(new ActivityEvent(), {
            id: 'event-1',
            organizationId: ORG,
            actorId: 'user-1',
            actor: { id: 'user-1', name: 'Ada' },
            entityType: 'task',
            action: 'created',
            entityId: 'task-1',
            projectId: 'project-1',
            metadata: { name: 'Ship' },
            createdAt,
          }),
        ],
        1,
      ]);

      const result = await service.feed(ORG, { page: 2, limit: 5 });

      expect(result.page).toBe(2);
      expect(result.limit).toBe(5);
      expect(result.totalPages).toBe(1);
      expect(result.items[0]).toMatchObject({
        id: 'event-1',
        entityType: 'task',
        action: 'created',
        entityId: 'task-1',
        projectId: 'project-1',
        actor: { id: 'user-1', name: 'Ada' },
        createdAt: '2026-09-14T10:32:11.482Z',
      });
      expect(activityRepo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 5, take: 5 }),
      );
    });

    it('falls back to the raw actor id when the user is gone', async () => {
      activityRepo.findAndCount.mockResolvedValue([
        [
          Object.assign(new ActivityEvent(), {
            id: 'event-2',
            organizationId: ORG,
            actorId: 'user-gone',
            actor: null,
            entityType: 'task',
            action: 'deleted',
            entityId: 'task-2',
            projectId: null,
            metadata: null,
            createdAt: new Date(),
          }),
        ],
        1,
      ]);

      const result = await service.feed(ORG, {});

      expect(result.items[0].actor).toEqual({ id: 'user-gone', name: null });
    });

    it('reports a null actor for organization-level events with no actor', async () => {
      activityRepo.findAndCount.mockResolvedValue([
        [
          Object.assign(new ActivityEvent(), {
            id: 'event-3',
            organizationId: ORG,
            actorId: null,
            actor: null,
            entityType: 'member',
            action: 'created',
            entityId: 'user-9',
            projectId: null,
            metadata: null,
            createdAt: new Date(),
          }),
        ],
        1,
      ]);

      const result = await service.feed(ORG, {});

      expect(result.items[0].actor).toBeNull();
    });
  });
});
