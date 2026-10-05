import { Logger } from '@nestjs/common';
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { SoftDeletePurgeService } from './soft-delete-purge.service.js';

const BATCH_SIZE = 500;
const DAY_MS = 24 * 60 * 60 * 1000;

interface Call {
  kind: 'select' | 'delete';
  table: string | undefined;
  where: { clause: string; args: Record<string, unknown> } | undefined;
}

/**
 * A DataSource stub that records every query and replays a scripted list of
 * id batches, so the batching loop can be driven without a database.
 */
function stubDataSource(selectBatches: string[][] = []) {
  const calls: Call[] = [];
  let select = 0;

  const chain = () => {
    const state: {
      table?: string;
      where?: { clause: string; args: Record<string, unknown> };
    } = {};

    const builder: Record<string, unknown> = {
      select: () => builder,
      delete: () => builder,
      from: (_entity: unknown, table: string) => {
        state.table = table;
        return builder;
      },
      where: (clause: string, args: Record<string, unknown>) => {
        state.where = { clause, args };
        return builder;
      },
      orderBy: () => builder,
      limit: () => builder,
      getRawMany: async () => {
        calls.push({ kind: 'select', table: state.table, where: state.where });
        return (selectBatches[select++] ?? []).map((id) => ({ id }));
      },
      execute: async () => {
        calls.push({ kind: 'delete', table: state.table, where: state.where });
        return { affected: (state.where?.args.ids as string[] | undefined)?.length ?? 0 };
      },
    };

    return builder;
  };

  return { dataSource: { createQueryBuilder: () => chain() } as unknown as DataSource, calls };
}

const configFor = (values: Record<string, string>): ConfigService =>
  ({
    get: (key: string, fallback?: string) => values[key] ?? fallback,
  }) as unknown as ConfigService;

const ids = (n: number, prefix: string): string[] =>
  Array.from({ length: n }, (_, index) => `${prefix}-${index}`);

describe('SoftDeletePurgeService', () => {
  describe('retention window', () => {
    const retentionDays = (values: Record<string, string> = {}): number =>
      new SoftDeletePurgeService(
        stubDataSource().dataSource,
        configFor(values),
      ).retentionDays;

    it('defaults to thirty days', () => {
      expect(retentionDays()).toBe(30);
    });

    it('reads the configured window', () => {
      expect(retentionDays({ SOFT_DELETE_RETENTION_DAYS: '7' })).toBe(7);
    });

    it('falls back to the default rather than trusting a nonsensical value', () => {
      // A typo in the environment must not silently become "purge everything"
      // or "purge nothing, ever".
      expect(retentionDays({ SOFT_DELETE_RETENTION_DAYS: 'soon' })).toBe(30);
    });

    it('treats zero as an explicit opt-out', () => {
      expect(retentionDays({ SOFT_DELETE_RETENTION_DAYS: '0' })).toBe(0);
    });
  });

  describe('purgeExpired', () => {
    it('visits every soft-deletable table, children before parents', async () => {
      const { dataSource, calls } = stubDataSource();
      const service = new SoftDeletePurgeService(dataSource, configFor({}));

      await expect(service.purgeExpired()).resolves.toBe(0);

      const tables = calls.filter((call) => call.kind === 'select').map((call) => call.table);
      expect(tables).toEqual([
        'time_entries',
        'subtasks',
        'tasks',
        'projects',
        'clients',
        'badges',
        'teams',
      ]);
    });

    it('cuts off on age, not on whether a row was restored', async () => {
      const { dataSource, calls } = stubDataSource();
      const service = new SoftDeletePurgeService(dataSource, configFor({}));

      const before = Date.now();
      await service.purgeExpired();
      const after = Date.now();

      const clause = calls[0].where?.clause;
      expect(clause).toBe('deleted_at < :cutoff');

      const cutoff = calls[0].where?.args.cutoff as Date;
      const expected = 30 * DAY_MS;
      // The cutoff is `now - retention`, so it sits inside the window that the
      // surrounding clock allows.
      expect(cutoff.getTime()).toBeGreaterThanOrEqual(before - expected);
      expect(cutoff.getTime()).toBeLessThanOrEqual(after - expected);
    });

    it('drains a table in bounded batches until it is clear', async () => {
      // Two full batches, then a short one: a short batch ends the loop, so
      // there is no reason to ask again.
      const { dataSource, calls } = stubDataSource([
        ids(BATCH_SIZE, 'a'),
        ids(BATCH_SIZE, 'b'),
        ids(3, 'c'),
      ]);
      const service = new SoftDeletePurgeService(dataSource, configFor({}));

      await expect(service.purgeExpired()).resolves.toBe(BATCH_SIZE * 2 + 3);

      const forTimeEntries = calls.filter((call) => call.table === 'time_entries');
      expect(forTimeEntries.filter((call) => call.kind === 'select')).toHaveLength(3);
      expect(forTimeEntries.filter((call) => call.kind === 'delete')).toHaveLength(3);

      // Every delete names exactly the ids that were selected for it, so a row
      // can never be removed without having been read first.
      const firstDelete = forTimeEntries.find((call) => call.kind === 'delete');
      expect(firstDelete?.where?.args.ids).toHaveLength(BATCH_SIZE);
    });

    it('bounds how much one pass can do', async () => {
      // A table that never drains: the cap is what stops a backlog from
      // monopolising a tick.
      const { dataSource, calls } = stubDataSource(
        Array.from({ length: 60 }, () => ids(BATCH_SIZE, 'x')),
      );
      const service = new SoftDeletePurgeService(dataSource, configFor({}));

      await service.purgeExpired();

      const selects = calls.filter(
        (call) => call.kind === 'select' && call.table === 'time_entries',
      );
      expect(selects).toHaveLength(50);
    });

    it('removes nothing when the window is disabled', async () => {
      const { dataSource, calls } = stubDataSource();
      const service = new SoftDeletePurgeService(
        dataSource,
        configFor({ SOFT_DELETE_RETENTION_DAYS: '0' }),
      );

      await expect(service.purgeExpired()).resolves.toBe(0);
      expect(calls).toEqual([]);
    });
  });

  describe('scheduling', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
      jest.restoreAllMocks();
    });

    it('arms a timer and clears it on shutdown', () => {
      const { dataSource } = stubDataSource();
      const service = new SoftDeletePurgeService(dataSource, configFor({}));

      service.onModuleInit();
      expect(jest.getTimerCount()).toBe(1);

      service.onModuleDestroy();
      expect(jest.getTimerCount()).toBe(0);
    });

    it('does not arm a timer when the window is disabled', () => {
      const { dataSource } = stubDataSource();
      const service = new SoftDeletePurgeService(
        dataSource,
        configFor({ SOFT_DELETE_RETENTION_DAYS: '0' }),
      );

      service.onModuleInit();
      expect(jest.getTimerCount()).toBe(0);
    });

    it('keeps a failed sweep to the log instead of failing the tick', async () => {
      // A purge that throws would stop the reschedule and leave the table
      // growing for the life of the process. The rows are already invisible to
      // every read, so the worst case is a table that stays larger than it
      // needs to be -- which is not worth taking the API down for.
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const dataSource = {
        createQueryBuilder: () => ({
          select: () => dataSource.createQueryBuilder(),
          from: () => dataSource.createQueryBuilder(),
          where: () => dataSource.createQueryBuilder(),
          orderBy: () => dataSource.createQueryBuilder(),
          limit: () => dataSource.createQueryBuilder(),
          getRawMany: async () => {
            throw new Error('connection lost');
          },
        }),
      } as unknown as DataSource;

      const service = new SoftDeletePurgeService(dataSource, configFor({}));
      service.onModuleInit();

      await jest.advanceTimersByTimeAsync(25 * 60 * 60 * 1000);

      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('Soft-delete purge failed'),
      );
      // Still rescheduled, which is the part that matters.
      expect(jest.getTimerCount()).toBe(1);
    });
  });
});
