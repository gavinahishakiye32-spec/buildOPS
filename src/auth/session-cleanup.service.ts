import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SessionService } from './session.service.js';

const DEFAULT_INTERVAL_HOURS = 6;

/**
 * Periodically drops refresh tokens that can no longer do anything.
 *
 * Without this the table only ever grows, and it grows fastest exactly when the
 * product is succeeding. Nothing breaks immediately -- an unreachable row is
 * still just a row -- but the sessions query behind every authenticated request
 * is the one place a runaway table would turn into a slow response for everybody,
 * so the sweep is scheduled rather than left for someone to remember.
 */
@Injectable()
export class SessionCleanupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SessionCleanupService.name);

  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly sessionService: SessionService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const hours = Number(
      this.config.get<string>(
        'SESSION_CLEANUP_INTERVAL_HOURS',
        String(DEFAULT_INTERVAL_HOURS),
      ),
    );

    // A nonsensical or absent value must not silently become "never sweep" or
    // "sweep continuously"; fall back rather than trust it.
    const intervalMs =
      Number.isFinite(hours) && hours > 0 ? hours * 60 * 60 * 1000 : DEFAULT_INTERVAL_HOURS * 60 * 60 * 1000;

    this.schedule(intervalMs);
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule(intervalMs: number): void {
    this.timer = setTimeout(() => {
      void this.runOnce().finally(() => this.schedule(intervalMs));
    }, intervalMs);

    // Keeps the handle from holding the process open, so a test run or a
    // `Ctrl-C` still exits promptly instead of waiting out the interval.
    this.timer.unref?.();
  }

  private async runOnce(): Promise<void> {
    try {
      const removed = await this.sessionService.purgeExpired();

      if (removed > 0) {
        this.logger.log(`Removed ${removed} unusable refresh token(s)`);
      }
    } catch (error) {
      // A failed sweep is not worth taking the API down for: the rows are inert,
      // the next tick will try again, and the worst case is a table that stays
      // slightly larger than it needs to be.
      this.logger.error(
        `Refresh token cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
