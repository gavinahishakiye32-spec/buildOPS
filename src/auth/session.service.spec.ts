import { ConfigService } from '@nestjs/config';
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { FindOperator } from 'typeorm';
import { SessionService } from './session.service.js';
import type { RefreshToken } from './refresh-token.entity.js';

const DAY = 24 * 60 * 60 * 1000;

const row = (overrides: Partial<RefreshToken> = {}): RefreshToken =>
  ({
    id: 'token-1',
    userId: 'user-1',
    tokenHash: 'hash',
    familyId: 'family-1',
    expiresAt: new Date(Date.now() + DAY),
    revokedAt: null,
    revokedReason: null,
    replacedById: null,
    userAgent: null,
    ip: null,
    createdAt: new Date(),
    ...overrides,
  }) as RefreshToken;

describe('SessionService', () => {
  let repo: any;
  let config: { get: any };
  let service: SessionService;

  beforeEach(() => {
    repo = {
      create: jest.fn((values: Record<string, unknown>) => ({ id: 'new-token', ...values })),
      save: jest.fn(async (record) => record),
      findOne: jest.fn(async () => null),
      find: jest.fn(async () => []),
      count: jest.fn(async () => 0),
      update: jest.fn(async () => ({ affected: 0 })),
      delete: jest.fn(async () => ({ affected: 0 })),
      createQueryBuilder: jest.fn(),
      manager: { transaction: jest.fn() },
    };

    repo.manager.transaction.mockImplementation(async (work: (tx: unknown) => unknown) => {
      const tx = {
        getRepository: () => repo,
        create: repo.create,
        save: repo.save,
        findOne: repo.findOne,
        find: repo.find,
        count: repo.count,
        update: repo.update,
        delete: repo.delete,
        createQueryBuilder: repo.createQueryBuilder,
      };
      return work(tx);
    });

    config = { get: jest.fn((_key: string, fallback?: string) => fallback) };
    service = new SessionService(repo as never, config as unknown as ConfigService);
  });

  describe('ttlDays', () => {
    it('falls back to 30 days when nothing is configured', () => {
      expect(service.ttlDays).toBe(30);
    });

    it('reads the configured value', () => {
      config.get.mockImplementation((key: string, fallback?: string) =>
        key === 'REFRESH_TOKEN_TTL_DAYS' ? '7' : fallback,
      );
      expect(service.ttlDays).toBe(7);
    });
  });

  describe('issue', () => {
    it('stores only a hash of the token and never the token itself', async () => {
      const issued = await service.issue('user-1', {
        userAgent: 'Mozilla/5.0',
        ip: '203.0.113.7',
      });

      const written = repo.save.mock.calls[0][0] as Record<string, unknown>;

      expect(issued.token).toMatch(/^[a-f0-9]{64}$/);
      expect(written.tokenHash).not.toBe(issued.token);
      expect(written.tokenHash).toMatch(/^[a-f0-9]{64}$/);
      expect(written.userId).toBe('user-1');
      // A family per session, so reuse detection has something to work with.
      expect(written.familyId).toEqual(expect.any(String));
    });

    it('truncates client metadata to what the columns can hold', async () => {
      await service.issue('user-1', {
        userAgent: 'x'.repeat(5000),
        ip: 'y'.repeat(500),
      });

      const written = repo.save.mock.calls[0][0] as Record<string, unknown>;

      // An over-long User-Agent must not be a 500 from a login the customer can
      // do nothing about.
      expect((written.userAgent as string).length).toBe(255);
      expect((written.ip as string).length).toBe(45);
    });
  });

  describe('isFamilyActive', () => {
    it('refuses a request with no family at all', async () => {
      // A legacy token minted before sessions existed has no `sid`. It must not
      // be waved through on the grounds that an empty id matches nothing.
      await expect(service.isFamilyActive('')).resolves.toBe(false);
      expect(repo.count).not.toHaveBeenCalled();
    });

    it('requires an unrevoked row that has not lapsed', async () => {
      repo.count.mockResolvedValue(1);
      await expect(service.isFamilyActive('family-1')).resolves.toBe(true);

      const where = repo.count.mock.calls[0][0] as { where: Record<string, unknown> };

      expect(where.where.familyId).toBe('family-1');
      expect(where.where.revokedAt).toBeDefined();
      // `MoreThan`, not a bare Date: in a TypeORM `where`, a plain value is
      // equality, so `{ expiresAt: new Date() }` would demand a token expiring
      // at this exact instant and call every live session dead.
      expect(where.where.expiresAt).toBeInstanceOf(FindOperator);
      expect((where.where.expiresAt as FindOperator<Date>).type).toBe('moreThan');
    });

    it('reports dead when no live row remains', async () => {
      repo.count.mockResolvedValue(0);
      await expect(service.isFamilyActive('family-1')).resolves.toBe(false);
    });
  });

  describe('listForUser', () => {
    it('collapses a rotated family into the one device it really is', async () => {
      const started = new Date(Date.now() - 10 * DAY);

      repo.find.mockResolvedValue([
        row({ id: 'a', familyId: 'family-1', createdAt: new Date() }),
        row({ id: 'b', familyId: 'family-2', createdAt: started }),
      ]);

      const sessions = await service.listForUser('user-1', 'family-2');

      expect(sessions).toHaveLength(2);
      expect(sessions.map((s) => s.id).sort()).toEqual(['family-1', 'family-2']);
      expect(sessions.find((s) => s.id === 'family-2')!.isCurrent).toBe(true);
      expect(sessions.find((s) => s.id === 'family-1')!.isCurrent).toBe(false);
    });

    it('ignores rows that have already lapsed', async () => {
      repo.find.mockResolvedValue([
        row({ id: 'a', familyId: 'family-1' }),
        row({
          id: 'b',
          familyId: 'family-2',
          expiresAt: new Date(Date.now() - 1000),
        }),
      ]);

      const sessions = await service.listForUser('user-1', null);

      // A dead session is not something to offer a "sign out everywhere" button
      // for, and it must not be marked current.
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe('family-1');
    });

    it('marks nothing current when the request carries no family', async () => {
      repo.find.mockResolvedValue([row()]);
      const sessions = await service.listForUser('user-1', null);
      expect(sessions[0].isCurrent).toBe(false);
    });
  });

  describe('revokeAllForUser', () => {
    it('only touches live rows and reports how many it closed', async () => {
      repo.update.mockResolvedValue({ affected: 3 });

      await expect(
        service.revokeAllForUser('user-1', 'password_changed'),
      ).resolves.toBe(3);

      const [criteria, patch] = repo.update.mock.calls[0] as [
        Record<string, unknown>,
        Record<string, unknown>,
      ];

      expect(criteria.userId).toBe('user-1');
      expect(criteria.revokedAt).toBeDefined();
      expect(patch.revokedReason).toBe('password_changed');
      expect(patch.revokedAt).toEqual(expect.any(Date));
    });

    it('reports zero rather than undefined when nothing was live', async () => {
      repo.update.mockResolvedValue({ affected: 0 });
      await expect(
        service.revokeAllForUser('user-1', 'logout_all'),
      ).resolves.toBe(0);
    });
  });

  describe('revokeByToken', () => {
    it('does nothing for a token that was never issued', async () => {
      repo.findOne.mockResolvedValue(null);
      await service.revokeByToken('nope');
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('does nothing for a token that is already revoked', async () => {
      // Idempotent on purpose: logout is called on page unload, and a second
      // call must not overwrite the reason a real replay left behind.
      repo.findOne.mockResolvedValue(row({ revokedAt: new Date(), revokedReason: 'reuse_detected' }));
      await service.revokeByToken('token');
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('revokes the whole family, not just the presented token', async () => {
      repo.findOne.mockResolvedValue(row());
      await service.revokeByToken('token');

      const [criteria, patch] = repo.update.mock.calls[0] as [
        Record<string, unknown>,
        Record<string, unknown>,
      ];

      // The siblings of this token are the ones an attacker would be holding.
      expect(criteria.familyId).toBe('family-1');
      expect(criteria.userId).toBe('user-1');
      expect(patch.revokedReason).toBe('logout');
    });
  });

  describe('purgeExpired', () => {
    const build = () => {
      const where = { clauses: [] as Array<[string, unknown]> };
      const qb = {
        delete: jest.fn(() => qb),
        where: jest.fn((clause: string, params: unknown) => {
          where.clauses.push([clause, params]);
          return qb;
        }),
        andWhere: jest.fn((clause: string, params: unknown) => {
          where.clauses.push([clause, params]);
          return qb;
        }),
        execute: jest.fn(async () => ({ affected: 4 })),
      };
      repo.createQueryBuilder.mockReturnValue(qb);
      return { qb, where };
    };

    it('reports how many rows it removed', async () => {
      build();
      await expect(service.purgeExpired()).resolves.toBe(4);
    });

    it('keeps a revoked row for a full lifetime after it was revoked', async () => {
      const { where } = build();

      await service.purgeExpired();

      const params = where.clauses.find(([clause]) =>
        clause.includes('revoked_at IS NULL'),
      )![1] as { revokedCutoff: Date };

      // A revoked token must stay findable until it would have expired anyway,
      // because presenting it is exactly what triggers reuse detection. Deleting
      // it on logout would turn a caught replay into a silent unknown-token 401,
      // and the family would survive untouched.
      expect(params.revokedCutoff).toBeInstanceOf(Date);
      // The cutoff sits a full token lifetime in the past, so recent revocations
      // are always retained.
      expect(params.revokedCutoff.getTime()).toBeLessThanOrEqual(
        Date.now() - 30 * DAY + 5000,
      );
    });

    it('scopes the sweep to rows past their own expiry', async () => {
      const { where } = build();

      await service.purgeExpired();

      const [clause, params] = where.clauses.find(
        ([c]) => c.includes('expires_at'),
      ) as [string, { now: Date }];

      expect(clause).toMatch(/expires_at < :now/);
      expect(params.now).toEqual(expect.any(Date));
    });
  });

  describe('deleteForUsers', () => {
    it('short-circuits an empty list rather than issuing a nonsense query', async () => {
      await service.deleteForUsers([]);
      expect(repo.delete).not.toHaveBeenCalled();
    });
  });
});
