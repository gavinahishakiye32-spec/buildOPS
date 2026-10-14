import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { jest } from '@jest/globals';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap.js';
import { MailService } from '../src/mail/mail.service.js';
import { NotificationEmailService } from '../src/notification/notification-email.service.js';
import { resetDatabase } from './support/reset-database.js';

/**
 * Notification email delivery, end to end, against a real database.
 *
 * This is the part the notifications suite cannot prove: that a queued email is
 * *actually delivered*, that a mail server that refuses it is retried with a
 * backoff instead of losing the message, and that an email which never succeeds
 * ends up visibly `failed` rather than silently gone. Those transitions are
 * written by real SQL (`SKIP LOCKED`, the partial index, the lease), so testing
 * them against a mock would test the mock.
 *
 * The background worker is disabled for e2e (see `test/setup/test-database.mjs`)
 * so every send here is a deliberate `deliverDue()` rather than a race with a
 * timer.
 */
jest.setTimeout(60000);

interface EmailRow {
  id: string;
  status: string;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  sent_at: Date | null;
  next_attempt_at: Date;
}

describe('notification email delivery (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let emailService: NotificationEmailService;

  /** Emails the mock transport accepted, in order. */
  const sent: { to: string; title: string; body: string; link?: string }[] = [];

  /** How many upcoming sends should be refused, to force a retry. */
  let failNext = 0;

  const rows = async (): Promise<EmailRow[]> =>
    dataSource.query(
      `SELECT id, status, attempts, max_attempts, last_error, sent_at, next_attempt_at
         FROM notification_emails
        ORDER BY created_at`,
    );

  const makeDue = async (id: string): Promise<void> => {
    await dataSource.query(
      `UPDATE notification_emails SET next_attempt_at = now() WHERE id = $1`,
      [id],
    );
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(MailService)
      .useValue({
        sendVerificationEmail: async () => undefined,
        sendResetPasswordEmail: async () => undefined,
        sendInvitationEmail: async () => undefined,
        sendNotificationEmail: async (
          to: string,
          input: { title: string; body: string; link?: string },
        ) => {
          if (failNext > 0) {
            failNext -= 1;
            throw new Error('smtp down');
          }
          sent.push({ to, ...input });
        },
      })
      .compile();

    app = configureApp(moduleFixture.createNestApplication());
    await app.init();

    dataSource = app.get(DataSource);
    emailService = app.get(NotificationEmailService);

    await resetDatabase(dataSource);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    sent.length = 0;
    failNext = 0;
    await dataSource.query('DELETE FROM notification_emails');
  });

  const enqueue = (overrides: Record<string, unknown> = {}): Promise<void> =>
    emailService.enqueue({
      to: 'ada@example.com',
      subject: 'Build the login form',
      body: 'Assigned to you',
      ...overrides,
    });

  it('delivers a queued email and marks it sent', async () => {
    await enqueue();
    expect(await rows()).toHaveLength(1);

    const delivery = await emailService.deliverDue();

    expect(delivery).toEqual({ sent: 1, retried: 0, failed: 0 });
    expect(sent).toEqual([
      {
        to: 'ada@example.com',
        title: 'Build the login form',
        body: 'Assigned to you',
        link: undefined,
      },
    ]);

    const [row] = await rows();
    expect(row.status).toBe('sent');
    expect(row.attempts).toBe(1);
    expect(row.sent_at).not.toBeNull();
  });

  it('carries the deep link through to the email', async () => {
    await enqueue({ link: 'http://localhost:3000/subtasks/sub-1' });

    await emailService.deliverDue();

    expect(sent[0].link).toBe('http://localhost:3000/subtasks/sub-1');
  });

  it('retries a refused send with a backoff instead of losing it', async () => {
    await enqueue();
    failNext = 1;

    const first = await emailService.deliverDue();

    expect(first).toEqual({ sent: 0, retried: 1, failed: 0 });

    const [afterFirst] = await rows();
    expect(afterFirst.status).toBe('pending');
    expect(afterFirst.attempts).toBe(1);

    // Not due again immediately: a fresh pass now sends nothing, because the
    // retry was pushed out. (Asserted behaviourally rather than by comparing
    // `next_attempt_at` to this process's clock -- the two need not agree.)
    expect(await emailService.deliverDue()).toEqual({
      sent: 0,
      retried: 0,
      failed: 0,
    });
    expect(sent).toHaveLength(0);

    // Once the backoff elapses and the server recovers, it goes out.
    await makeDue(afterFirst.id);
    const second = await emailService.deliverDue();

    expect(second).toEqual({ sent: 1, retried: 0, failed: 0 });

    const [afterSecond] = await rows();
    expect(afterSecond.status).toBe('sent');
    expect(afterSecond.attempts).toBe(2);
  });

  it('gives up after the attempt limit and marks the row failed', async () => {
    await enqueue();
    const [queued] = await rows();
    await dataSource.query(
      `UPDATE notification_emails SET max_attempts = 2 WHERE id = $1`,
      [queued.id],
    );
    failNext = 100;

    const first = await emailService.deliverDue();
    expect(first).toEqual({ sent: 0, retried: 1, failed: 0 });

    await makeDue(queued.id);
    const second = await emailService.deliverDue();
    expect(second).toEqual({ sent: 0, retried: 0, failed: 1 });

    const [dead] = await rows();
    expect(dead.status).toBe('failed');
    expect(dead.attempts).toBe(2);
    expect(dead.last_error).toContain('smtp down');
  });

  it('leaves an email whose time has not come alone', async () => {
    await enqueue();
    const [queued] = await rows();
    await dataSource.query(
      `UPDATE notification_emails
          SET next_attempt_at = now() + interval '1 hour'
        WHERE id = $1`,
      [queued.id],
    );

    const delivery = await emailService.deliverDue();

    expect(delivery).toEqual({ sent: 0, retried: 0, failed: 0 });
    expect(sent).toHaveLength(0);

    const [still] = await rows();
    expect(still.status).toBe('pending');
    expect(still.attempts).toBe(0);
  });
});
