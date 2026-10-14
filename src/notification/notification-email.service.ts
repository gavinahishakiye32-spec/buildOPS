import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, Repository } from 'typeorm';
import { MailService } from '../mail/mail.service.js';
import { NotificationEmail } from './notification-email.entity.js';

const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_RETRY_BASE_MS = 60_000;
const DEFAULT_RETRY_MAX_MS = 3_600_000;
const DEFAULT_LEASE_MS = 120_000;

/** Everything needed to queue one email. */
export interface NotificationEmailInput {
  notificationId?: string | null;
  userId?: string | null;
  to: string;
  subject: string;
  body: string;
  link?: string | null;
}

/** What one delivery pass did, so a caller can assert on it. */
export interface NotificationEmailDelivery {
  sent: number;
  retried: number;
  failed: number;
}

/**
 * How long to wait before retrying an email that has already failed `attempts`
 * times: exponential, base * 2^(attempts-1), capped.
 *
 * Exported and pure so the schedule is a thing a test asserts directly rather
 * than a number inferred from timing. The first retry waits the base delay --
 * an SMTP blip is usually gone by then -- and later ones widen so a real outage
 * is not hammered once per poll for an hour.
 */
export function retryDelayMs(
  attempts: number,
  baseMs: number,
  maxMs: number,
): number {
  const attempt = Math.max(1, attempts);
  return Math.min(baseMs * 2 ** (attempt - 1), maxMs);
}

/**
 * The delivery half of notifications: a durable outbox and the worker that
 * drains it.
 *
 * The contract is small and the whole point of the design is in it:
 *
 *  - {@link enqueue} writes a row, optionally inside the caller's transaction,
 *    so the notification and the email it owes are committed together. There is
 *    no state where a member is told in-app but an email was never queued.
 *  - {@link deliverDue} claims due rows, sends them, and marks each `sent`,
 *    reschedules it with a backoff, or -- once `max_attempts` is spent --
 *    `failed`. It is idempotent-safe under concurrency: a claim takes a
 *    `FOR UPDATE SKIP LOCKED` lease, so two workers (or a worker and a `kick`)
 *    never send the same row twice.
 *
 * A failure is never thrown at the caller that queued the email. The assignment
 * that caused it has already happened; the outbox is what makes losing the
 * email a retryable row instead of a stacked promise rejection.
 */
@Injectable()
export class NotificationEmailService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationEmailService.name);

  private timer: NodeJS.Timeout | null = null;
  private dispatching = false;

  constructor(
    @InjectRepository(NotificationEmail)
    private readonly repo: Repository<NotificationEmail>,
    private readonly mailService: MailService,
    private readonly config: ConfigService,
  ) {}

  /** Whether the background worker runs. Off when the interval is 0 or less. */
  get enabled(): boolean {
    return this.intervalMs > 0;
  }

  get intervalMs(): number {
    return this.number('NOTIFICATION_EMAIL_INTERVAL_MS', DEFAULT_INTERVAL_MS);
  }

  get batchSize(): number {
    return this.number('NOTIFICATION_EMAIL_BATCH_SIZE', DEFAULT_BATCH_SIZE);
  }

  get maxAttempts(): number {
    return this.number('NOTIFICATION_EMAIL_MAX_ATTEMPTS', DEFAULT_MAX_ATTEMPTS);
  }

  get retryBaseMs(): number {
    return this.number('NOTIFICATION_EMAIL_RETRY_BASE_MS', DEFAULT_RETRY_BASE_MS);
  }

  get retryMaxMs(): number {
    return this.number('NOTIFICATION_EMAIL_RETRY_MAX_MS', DEFAULT_RETRY_MAX_MS);
  }

  get leaseMs(): number {
    return this.number('NOTIFICATION_EMAIL_LEASE_MS', DEFAULT_LEASE_MS);
  }

  /**
   * Queues one email, on `manager` when the caller is already in a transaction.
   *
   * The address, subject, body and link are captured here rather than recomputed
   * at send time: they describe the event that caused the email, and re-reading
   * them minutes later could deliver last week's wording to an address that has
   * since changed.
   */
  async enqueue(
    input: NotificationEmailInput,
    manager?: EntityManager,
  ): Promise<void> {
    const repo = manager
      ? manager.getRepository(NotificationEmail)
      : this.repo;

    await repo.save(
      repo.create({
        notificationId: input.notificationId ?? null,
        userId: input.userId ?? null,
        toEmail: input.to,
        subject: input.subject,
        body: input.body,
        link: input.link ?? null,
        status: 'pending',
        attempts: 0,
        maxAttempts: this.maxAttempts,
        // `next_attempt_at` is left to the column default (`now()` in the
        // database). Scheduling on the app host's clock instead would make
        // "due" depend on two clocks agreeing, and they routinely do not: a
        // `timestamp` column written from a JS `Date` and read back against the
        // server's `now()` can disagree by the timezone offset, which strands an
        // email as "not due yet" for hours.
      }),
    );
  }

  /**
   * Runs a delivery pass now instead of waiting for the next tick.
   *
   * Called after a queue so a notification that lands while the interval is
   * still counting down does not sit for it. Guarded so a burst of assignments
   * cannot pile up overlapping passes; the lease would keep them correct
   * anyway, this just keeps them from being wasteful.
   */
  kick(): void {
    if (!this.enabled || this.dispatching) {
      return;
    }

    this.dispatching = true;
    void this.deliverDue()
      .catch((error) => this.logFailure('run', error))
      .finally(() => {
        this.dispatching = false;
      });
  }

  /** Drains up to `limit` due emails and reports what each one did. */
  async deliverDue(limit = this.batchSize): Promise<NotificationEmailDelivery> {
    const claimed = await this.claim(limit);
    const delivery: NotificationEmailDelivery = {
      sent: 0,
      retried: 0,
      failed: 0,
    };

    for (const row of claimed) {
      // Re-lease this row immediately before sending it. The claim leased the
      // whole batch at once, so without this a row near the end of a slow batch
      // could have its lease expire before it is even reached -- and a second
      // worker would then send it too. Renewing narrows the exposure to this one
      // send.
      await this.renewLease(row.id);

      try {
        await this.mailService.sendNotificationEmail(row.toEmail, {
          title: row.subject,
          body: row.body,
          link: row.link ?? undefined,
        });

        await this.repo.update(row.id, {
          status: 'sent',
          // Stamped by the database, not this process: `sent_at` is evidence of
          // when delivery happened, and it should not carry the app host's
          // clock skew into the record.
          sentAt: () => 'now()',
          lastError: null,
          nextAttemptAt: () => 'now()',
        });
        delivery.sent += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        if (row.attempts >= row.maxAttempts) {
          await this.repo.update(row.id, { status: 'failed', lastError: message });
          delivery.failed += 1;
          this.logger.error(
            `Notification email ${row.id} failed permanently after ` +
              `${row.attempts} attempt(s): ${message}`,
          );
        } else {
          const delay = retryDelayMs(
            row.attempts,
            this.retryBaseMs,
            this.retryMaxMs,
          );

          await this.repo.update(row.id, {
            lastError: message,
            // Pushed forward relative to the database's clock, the same clock
            // the claim reads. `delay` is a number this service computed, so the
            // interpolation carries no caller input.
            nextAttemptAt: () =>
              `now() + make_interval(secs => ${delay / 1000})`,
          });
          delivery.retried += 1;
          this.logger.warn(
            `Notification email ${row.id} failed (attempt ${row.attempts}/` +
              `${row.maxAttempts}); retrying in ${delay}ms: ${message}`,
          );
        }
      }
    }

    return delivery;
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.log(
        'Notification email delivery disabled (NOTIFICATION_EMAIL_INTERVAL_MS <= 0)',
      );
      return;
    }

    this.schedule();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Pushes a claimed row's lease out to `now() + lease`, in database time. */
  private async renewLease(id: string): Promise<void> {
    await this.repo.update(id, {
      nextAttemptAt: () =>
        `now() + make_interval(secs => ${this.leaseMs / 1000})`,
    });
  }

  private schedule(): void {
    this.timer = setTimeout(() => {
      void this.deliverDue()
        .catch((error) => this.logFailure('run', error))
        .finally(() => this.schedule());
    }, this.intervalMs);

    this.timer.unref?.();
  }

  /**
   * Claims up to `limit` due rows and leases them.
   *
   * The select takes `FOR UPDATE SKIP LOCKED` so two workers cannot claim the
   * same email, and the update pushes `next_attempt_at` into the future by the
   * lease -- so a claim that then crashes (the process dies mid-send) releases
   * itself when the lease expires rather than stranding the row. `attempts` is
   * incremented here, at claim, which is what makes a crash count as a used
   * attempt instead of looping forever on a poison row.
   */
  private async claim(limit: number): Promise<NotificationEmail[]> {
    if (limit <= 0) {
      return [];
    }

    const leaseSeconds = this.leaseMs / 1000;

    return this.repo.manager.transaction(async (manager) => {
      const due = (await manager.query(
        `SELECT "id" FROM "notification_emails"
          WHERE "status" = 'pending' AND "next_attempt_at" <= now()
          ORDER BY "next_attempt_at" ASC
          LIMIT $1
          FOR UPDATE SKIP LOCKED`,
        [limit],
      )) as { id: string }[];

      if (due.length === 0) {
        return [];
      }

      const ids = due.map((row) => row.id);

      await manager
        .createQueryBuilder()
        .update(NotificationEmail)
        .set({
          attempts: () => 'attempts + 1',
          // The lease, in database time, matching what the claim reads.
          nextAttemptAt: () =>
            `now() + make_interval(secs => ${leaseSeconds})`,
        })
        .where('id IN (:...ids)', { ids })
        .execute();

      // Read back inside the same transaction, so `attempts` carries the
      // increment the statement above just made -- the send-or-retry decision
      // then reads what the row actually holds.
      return manager
        .getRepository(NotificationEmail)
        .find({ where: { id: In(ids) } });
    });
  }

  private number(key: string, fallback: number): number {
    const raw = Number(this.config.get<string>(key));
    return Number.isFinite(raw) ? raw : fallback;
  }

  private logFailure(context: string, error: unknown): void {
    this.logger.error(
      `Notification email delivery ${context} failed: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
