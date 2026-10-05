import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, type EntityTarget, type ObjectLiteral } from 'typeorm';
import { Subtask } from '../subtask/subtask.entity.js';
import { Task } from '../task/task.entity.js';
import { TimeEntry } from '../time-entry/time-entry.entity.js';
import { Project } from '../project/project.entity.js';
import { Client } from '../client/client.entity.js';
import { Badge } from '../badge/badge.entity.js';
import { Team } from '../team/team.entity.js';

const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_INTERVAL_HOURS = 24;
const BATCH_SIZE = 500;

/**
 * Tables in dependency order, children before parents.
 *
 * A hard delete of a soft-deleted parent still goes through the real foreign
 * keys, so removing a task before its subtasks is fine -- PostgreSQL cascades --
 * but the batches have to be bounded, and going deepest-first keeps the counts
 * honest: a subtask purged with its task is never counted twice.
 */
const TABLES: ReadonlyArray<{
  name: string;
  entity: EntityTarget<ObjectLiteral>;
}> = [
  { name: 'time_entries', entity: TimeEntry },
  { name: 'subtasks', entity: Subtask },
  { name: 'tasks', entity: Task },
  { name: 'projects', entity: Project },
  { name: 'clients', entity: Client },
  { name: 'badges', entity: Badge },
  { name: 'teams', entity: Team },
];

/**
 * Hard-deletes soft-deleted rows once they are past the retention window.
 *
 * Soft deletion trades storage for safety, and a table that only ever grows is
 * the failure mode that eventually makes someone reach for a manual `TRUNCATE`.
 * Thirty days is a deliberate default: long enough that a mistake is noticed
 * and reported, short enough that the table is not an archive.
 *
 * Two properties matter more than the schedule:
 *
 *  - The cutoff is a lower bound on `deleted_at`, never "not restored yet". Rows
 *    are removed because they are old, not because nobody happened to look.
 *  - Each table is drained in bounded batches. A single statement over a large
 *    table takes a long lock and bloats WAL; if the process dies halfway, the
 *    next tick resumes from the new cutoff rather than starting over.
 *
 * The timer runs the same way the session cleanup does -- delayed, unref'd, and
 * errors swallowed into the log -- because a purge that fails should retry, not
 * take the API down with it.
 */
@Injectable()
export class SoftDeletePurgeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SoftDeletePurgeService.name);

  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
  ) {}

  /** Retention window in days; 0 or less disables the purge entirely. */
  get retentionDays(): number {
    const days = Number(
      this.config.get<string>('SOFT_DELETE_RETENTION_DAYS', String(DEFAULT_RETENTION_DAYS)),
    );

    return Number.isFinite(days) ? days : DEFAULT_RETENTION_DAYS;
  }

  onModuleInit(): void {
    const days = this.retentionDays;

    if (days <= 0) {
      // An explicit opt-out has to be honoured, not second-guessed. A deployment
      // that wants to keep deleted rows forever should be able to say so.
      this.logger.log('Soft-delete purge disabled (SOFT_DELETE_RETENTION_DAYS <= 0)');
      return;
    }

    const hours = Number(
      this.config.get<string>('PURGE_INTERVAL_HOURS', String(DEFAULT_INTERVAL_HOURS)),
    );
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

    this.timer.unref?.();
  }

  private async runOnce(): Promise<void> {
    try {
      const purged = await this.purgeExpired();

      if (purged > 0) {
        this.logger.log(`Permanently removed ${purged} soft-deleted row(s)`);
      }
    } catch (error) {
      this.logger.error(
        `Soft-delete purge failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Removes every row past the retention window and reports how many went.
   *
   * Public because the retention window is a policy a test needs to assert on,
   * not just a side effect of a timer.
   */
  async purgeExpired(cutoff = this.cutoff()): Promise<number> {
    let total = 0;

    for (const table of TABLES) {
      total += await this.drainTable(table.name, table.entity, cutoff);
    }

    return total;
  }

  private cutoff(): Date | null {
    const days = this.retentionDays;

    if (days <= 0) {
      return null;
    }

    return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  }

  /**
   * Deletes in batches until the table is clear of rows older than the cutoff.
   *
   * `ctid` ordering is what keeps this from looping forever on a large table:
   * each pass takes a slice, and the next pass re-reads the remaining rows
   * rather than re-scanning the ones already gone.
   */
  private async drainTable(
    name: string,
    entity: EntityTarget<ObjectLiteral>,
    cutoff: Date | null,
  ): Promise<number> {
    if (!cutoff) {
      return 0;
    }

    let removed = 0;

    // A hard cap on batches, so a pathological backlog is worked through over
    // several ticks instead of monopolising one.
    for (let pass = 0; pass < 50; pass += 1) {
      const ids = await this.dataSource
        .createQueryBuilder()
        .select('id')
        .from(entity, name)
        .where('deleted_at < :cutoff', { cutoff })
        .orderBy('deleted_at', 'ASC')
        .limit(BATCH_SIZE)
        .getRawMany<{ id: string }>();

      if (ids.length === 0) {
        break;
      }

      const idList = ids.map((row) => row.id);

      const result = await this.dataSource
        .createQueryBuilder()
        .delete()
        .from(entity, name)
        .where('id IN (:...ids)', { ids: idList })
        .execute();

      removed += result.affected ?? 0;

      if (ids.length < BATCH_SIZE) {
        break;
      }
    }

    return removed;
  }
}
