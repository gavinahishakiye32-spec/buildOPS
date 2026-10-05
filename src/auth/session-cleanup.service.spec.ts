import { ConfigService } from '@nestjs/config';
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { SessionCleanupService } from './session-cleanup.service.js';
import type { SessionService } from './session.service.js';

describe('SessionCleanupService', () => {
  let sessionService: { purgeExpired: any };
  let config: { get: any };
  let service: SessionCleanupService;
  let timeouts: Array<{ callback: () => void; unref: jest.Mock; delay: number }>;

  beforeEach(() => {
    sessionService = { purgeExpired: jest.fn(async (): Promise<number> => 0) };
    config = { get: jest.fn((_key: string, fallback?: string) => fallback) };

    timeouts = [];

    jest
      .spyOn(global, 'setTimeout')
      .mockImplementation(((callback: () => void, delay: number) => {
        const handle = { callback, delay, unref: jest.fn() };
        timeouts.push(handle);
        return handle as unknown as NodeJS.Timeout;
      }) as never);

    jest
      .spyOn(global, 'clearTimeout')
      .mockImplementation((() => undefined) as never);

    service = new SessionCleanupService(
      sessionService as unknown as SessionService,
      config as unknown as ConfigService,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('does not sweep at boot', () => {
    service.onModuleInit();

    // A sweep during startup would race every other boot-time write and every
    // test that has just seeded a session, so the first run is always a full
    // interval away.
    expect(sessionService.purgeExpired).not.toHaveBeenCalled();
  });

  it('sweeps once the interval elapses and then reschedules itself', async () => {
    service.onModuleInit();

    expect(timeouts).toHaveLength(1);
    expect(timeouts[0].delay).toBe(6 * 60 * 60 * 1000);

    timeouts[0].callback();
    await new Promise(process.nextTick);
    await new Promise(process.nextTick);

    expect(sessionService.purgeExpired).toHaveBeenCalledTimes(1);
    // A one-shot timer would sweep once and then stop, leaving the table to grow
    // again for the life of the process.
    expect(timeouts).toHaveLength(2);
  });

  it('unrefs its handle so it cannot keep the process alive', () => {
    service.onModuleInit();
    expect(timeouts[0].unref).toHaveBeenCalled();
  });

  it('falls back to a sane interval rather than trusting a bad value', () => {
    for (const bad of ['0', '-1', 'often', '']) {
      timeouts = [];
      config.get.mockImplementation((_key: string, fallback?: string) =>
        _key === 'SESSION_CLEANUP_INTERVAL_HOURS' ? bad : fallback,
      );

      const fresh = new SessionCleanupService(
        sessionService as unknown as SessionService,
        config as unknown as ConfigService,
      );
      fresh.onModuleInit();

      // Zero or negative would be a hot loop; unparseable would be no sweep at
      // all. Both are worse than the default.
      expect(timeouts[0].delay).toBe(6 * 60 * 60 * 1000);
      fresh.onModuleDestroy();
    }
  });

  it('honours a configured interval', () => {
    config.get.mockImplementation((_key: string, fallback?: string) =>
      _key === 'SESSION_CLEANUP_INTERVAL_HOURS' ? '1' : fallback,
    );

    service.onModuleInit();

    expect(timeouts[0].delay).toBe(60 * 60 * 1000);
  });

  it('keeps rescheduling after a failure instead of giving up', async () => {
    sessionService.purgeExpired.mockRejectedValue(new Error('deadlock detected'));

    service.onModuleInit();
    timeouts[0].callback();
    await new Promise(process.nextTick);
    await new Promise(process.nextTick);

    // A transient database problem must not silently retire the sweeper for the
    // rest of the process's life.
    expect(timeouts).toHaveLength(2);
  });

  it('cancels its pending sweep on shutdown', () => {
    service.onModuleInit();
    service.onModuleDestroy();

    expect(clearTimeout).toHaveBeenCalledWith(timeouts[0] as never);
  });
});
