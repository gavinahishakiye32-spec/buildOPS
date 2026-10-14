import { jest, describe, it, expect } from '@jest/globals';
import {
  NotificationEmailService,
  retryDelayMs,
} from './notification-email.service.js';

/**
 * The outbox's delivery decisions.
 *
 * `deliverDue` is exercised against a real database in
 * `test/notification-email.e2e-spec.ts`; what is pinned down here is the part
 * that is cheap to get wrong and expensive to notice: the backoff schedule, and
 * the branch between "mark sent", "schedule a retry" and "give up".
 */

const queuedRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'email-1',
  toEmail: 'ada@example.com',
  subject: 'Build the login form',
  body: 'Assigned to you',
  link: null,
  status: 'pending',
  attempts: 0,
  maxAttempts: 5,
  nextAttemptAt: new Date(),
  ...overrides,
});

const build = (
  rows: Record<string, unknown>[],
  send: () => Promise<void>,
): {
  service: NotificationEmailService;
  repo: any;
  mail: any;
} => {
  const repo: any = {
    create: jest.fn((value: unknown) => value),
    save: jest.fn(async (value: unknown) => value),
    update: jest.fn(async () => undefined),
    manager: {
      transaction: jest.fn(async (work: (manager: unknown) => unknown) => {
        const manager = {
          query: jest.fn(async () => rows.map((row) => ({ id: row.id }))),
          createQueryBuilder: jest.fn(() => {
            const chain: any = {};
            chain.update = jest.fn(() => chain);
            chain.set = jest.fn(() => chain);
            chain.where = jest.fn(() => chain);
            chain.execute = jest.fn(async () => ({ affected: rows.length }));
            return chain;
          }),
          getRepository: jest.fn(() => ({
            // The real `find` runs after an UPDATE that bumps `attempts`, so it
            // reads the incremented value; mirror that or the send/retry branch
            // is decided against a stale count.
            find: jest.fn(async () =>
              rows.map((row) => ({
                ...row,
                attempts: Number(row.attempts) + 1,
              })),
            ),
          })),
        };
        return work(manager);
      }),
    },
  };

  const mail: any = { sendNotificationEmail: jest.fn(send) };
  const config: any = { get: jest.fn(() => undefined) };

  return {
    service: new NotificationEmailService(repo, mail, config),
    repo,
    mail,
  };
};

describe('retryDelayMs', () => {
  it('waits the base delay before the first retry', () => {
    expect(retryDelayMs(1, 1000, 100000)).toBe(1000);
  });

  it('doubles with each further attempt', () => {
    expect(retryDelayMs(2, 1000, 100000)).toBe(2000);
    expect(retryDelayMs(3, 1000, 100000)).toBe(4000);
    expect(retryDelayMs(4, 1000, 100000)).toBe(8000);
  });

  it('stops widening at the cap', () => {
    expect(retryDelayMs(10, 1000, 5000)).toBe(5000);
  });

  it('treats a still-zero attempt count as the first attempt', () => {
    expect(retryDelayMs(0, 1000, 100000)).toBe(1000);
  });
});

describe('NotificationEmailService', () => {
  let service: NotificationEmailService;
  let repo: any;
  let mail: any;

  it('marks an email sent when the mail server accepts it', async () => {
    const built = build([queuedRow()], async () => undefined);
    service = built.service;
    repo = built.repo;
    mail = built.mail;

    const result = await service.deliverDue();

    expect(result).toEqual({ sent: 1, retried: 0, failed: 0 });
    expect(mail.sendNotificationEmail).toHaveBeenCalledWith('ada@example.com', {
      title: 'Build the login form',
      body: 'Assigned to you',
      link: undefined,
    });
    expect(repo.update).toHaveBeenCalledWith(
      'email-1',
      expect.objectContaining({ status: 'sent' }),
    );
  });

  it('schedules a retry with a backoff instead of dropping a failed email', async () => {
    const built = build([queuedRow()], async () => {
      throw new Error('smtp down');
    });
    service = built.service;
    repo = built.repo;

    const result = await service.deliverDue();

    expect(result).toEqual({ sent: 0, retried: 1, failed: 0 });

    // The lease renewal is also an update; pick out the one that recorded the
    // failure.
    const patch = repo.update.mock.calls
      .map((call: any[]) => call[1])
      .find((candidate: any) => candidate.lastError === 'smtp down');

    expect(patch.status).toBeUndefined();
    // The retry is scheduled in database time, not on this process's clock.
    expect(patch.nextAttemptAt()).toBe('now() + make_interval(secs => 60)');
  });

  it('caps the retry backoff at the configured maximum', async () => {
    const built = build(
      [queuedRow({ attempts: 20, maxAttempts: 25 })],
      async () => {
        throw new Error('smtp down');
      },
    );
    service = built.service;
    repo = built.repo;

    const result = await service.deliverDue();

    expect(result.retried).toBe(1);
    const patch = repo.update.mock.calls
      .map((call: any[]) => call[1])
      .find((candidate: any) => candidate.lastError === 'smtp down');
    expect(patch.nextAttemptAt()).toBe('now() + make_interval(secs => 3600)');
  });

  it('gives up and marks the row failed once attempts are spent', async () => {
    const built = build([queuedRow({ attempts: 4 })], async () => {
      throw new Error('smtp down');
    });
    service = built.service;
    repo = built.repo;

    const result = await service.deliverDue();

    expect(result).toEqual({ sent: 0, retried: 0, failed: 1 });
    expect(repo.update).toHaveBeenCalledWith(
      'email-1',
      expect.objectContaining({ status: 'failed', lastError: 'smtp down' }),
    );
  });

  it('does nothing when no email is due', async () => {
    const built = build([], async () => undefined);
    service = built.service;
    mail = built.mail;

    const result = await service.deliverDue();

    expect(result).toEqual({ sent: 0, retried: 0, failed: 0 });
    expect(mail.sendNotificationEmail).not.toHaveBeenCalled();
  });

  it('queues a pending email capped at the configured attempt limit', async () => {
    const built = build([], async () => undefined);
    service = built.service;
    repo = built.repo;

    await service.enqueue({
      to: 'ada@example.com',
      subject: 'Subject',
      body: 'Body',
      link: 'http://localhost:3000/subtasks/abc',
    });

    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        toEmail: 'ada@example.com',
        status: 'pending',
        attempts: 0,
        maxAttempts: 5,
      }),
    );
  });
});
