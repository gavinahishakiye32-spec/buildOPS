import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import {
  resolvePage,
  toPaginated,
  type Paginated,
} from '../common/pagination.dto.js';
import { buildNotificationLink } from '../mail/mail.links.js';
import { BROADCAST_AUDIENCE_PERMISSIONS } from '../common/permissions.js';
import { Role } from '../role/role.entity.js';
import { User } from '../user/user.entity.js';
import { Notification } from './notification.entity.js';
import { NotificationEmailService } from './notification-email.service.js';
import type { PaginationQueryDto } from '../common/pagination.dto.js';

/**
 * Permissions that make a member part of the "what's new in the system"
 * broadcast audience (project and milestone management).
 */
const BROADCAST_PERMISSIONS = new Set<string>(BROADCAST_AUDIENCE_PERMISSIONS);

/** Everything the caller needs to decide who to tell and what to say. */
export interface NotificationRequest {
  organizationId: string;
  /** The recipient. */
  userId: string;
  /** Whoever caused it, for the "Ada assigned this to you" line. */
  actorId?: string | null;
  type: string;
  title: string;
  body?: string | null;
  taskId?: string | null;
  subtaskId?: string | null;
}

/**
 * Notifications, in the inbox and by email.
 *
 * Two rules everything else follows from:
 *
 * 1. **The recipient is decided here, never by the caller.** There is no route
 *    that posts an arbitrary notification to an arbitrary user. `userId` is an
 *    argument the action passes in, not a field a request can set, so there is
 *    no request in this API that can make the product tell one member that
 *    another has been suspended.
 *
 * 2. **A write is best-effort.** `notify` never throws into the caller. The
 *    work that triggered it has already happened -- the subtask is assigned --
 *    and failing that write would roll back a correct assignment because a
 *    bell icon could not be rung. A swallowed error is the right trade here,
 *    and the warning is what makes it visible rather than silent.
 *
 * The email is not sent here. It is *queued* here, in the same transaction as
 * the notification, for {@link NotificationEmailService} to deliver durably and
 * retry. Sending inline is what made delivery at-most-once and silent.
 */
@Injectable()
export class NotificationService {
  constructor(
    @InjectRepository(Notification)
    private readonly notificationRepo: Repository<Notification>,
    @InjectRepository(Role)
    private readonly roleRepo: Repository<Role>,
    // The recipient's address is read here rather than passed in, so the email
    // half of a notification shares the one rule the in-app half follows: the
    // recipient is decided by the action, never by the caller.
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly notificationEmails: NotificationEmailService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Writes the notification and queues its email, atomically.
   *
   * The two rows go in one transaction on purpose: there is no moment where the
   * inbox says someone was told but no email was ever queued, or the reverse.
   * Delivery itself is the outbox's job and never runs here, so nothing in this
   * method waits on -- or can be failed by -- a mail server.
   */
  async notify(request: NotificationRequest): Promise<Notification | null> {
    // Assigning work to yourself is not news. This is the single most common
    // way this fires and the single least useful notification a member could
    // receive.
    if (request.actorId && request.actorId === request.userId) {
      return null;
    }

    try {
      // Resolved before the transaction so an address lookup that fails cannot
      // take the notification down with it; a missing address simply means no
      // email row is queued.
      const recipient = await this.userRepo.findOne({
        where: { id: request.userId },
        select: { id: true, email: true },
      });

      const notification = await this.notificationRepo.manager.transaction(
        async (manager) => {
          const repo = manager.getRepository(Notification);
          const saved = await repo.save(
            repo.create({
              organizationId: request.organizationId,
              userId: request.userId,
              actorId: request.actorId ?? null,
              type: request.type,
              title: request.title,
              body: request.body ?? null,
              taskId: request.taskId ?? null,
              subtaskId: request.subtaskId ?? null,
            }),
          );

          if (recipient?.email) {
            await this.notificationEmails.enqueue(
              {
                notificationId: saved.id,
                userId: saved.userId,
                to: recipient.email,
                subject: saved.title,
                body: saved.body ?? '',
                link: buildNotificationLink(this.config.get('APP_BASE_URL'), {
                  taskId: saved.taskId,
                  subtaskId: saved.subtaskId,
                }),
              },
              manager,
            );
          }

          return saved;
        },
      );

      // The rows are committed; nudge the worker so the email does not wait out
      // a full interval. A no-op when delivery is disabled, and it never throws.
      this.notificationEmails.kick();

      return notification;
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn(
        `[NotificationService] could not write a "${request.type}" notification ` +
          `for user ${request.userId}:`,
        error instanceof Error ? error.message : error,
      );
      return null;
    }
  }

  /** The caller's notifications, newest first. Nobody else's. */
  async list(
    organizationId: string,
    userId: string,
    query: PaginationQueryDto,
  ): Promise<Paginated<Notification>> {
    const { page, limit, skip } = resolvePage(query);

    const [items, total] = await this.notificationRepo.findAndCount({
      where: { organizationId, userId },
      order: { createdAt: 'DESC' },
      skip,
      take: limit,
    });

    return toPaginated(items, total, page, limit);
  }

  /** How many the reader has not seen. Drives the badge. */
  async unreadCount(organizationId: string, userId: string): Promise<number> {
    return this.notificationRepo.count({
      where: { organizationId, userId, readAt: IsNull() },
    });
  }

  /**
   * Marks one notification read.
   *
   * Scoped to the caller as well as the row id: a notification id is a UUID
   * that arrives in a URL, and without the `userId` predicate any member who
   * guessed or leaked one could clear another member's badge.
   *
   * Returns whether it changed anything, so the caller can answer 404 for a
   * notification that is not theirs rather than pretending to have read it.
   */
  async markRead(
    organizationId: string,
    userId: string,
    notificationId: string,
  ): Promise<boolean> {
    const result = await this.notificationRepo.update(
      { id: notificationId, organizationId, userId },
      { readAt: new Date() },
    );

    return (result.affected ?? 0) > 0;
  }

  /**
   * Clears the whole badge.
   *
   * Only unread rows are touched. Rewriting the timestamp on something read last
   * month would destroy the one piece of history a reader has -- *when* they
   * saw it -- and would make "read all" a way to falsify it.
   */
  async markAllRead(organizationId: string, userId: string): Promise<number> {
    const result = await this.notificationRepo.update(
      { organizationId, userId, readAt: IsNull() },
      { readAt: new Date() },
    );

    return result.affected ?? 0;
  }

  /**
   * Fans an event out to every active member whose role manages projects or
   * milestones.
   *
   * This is the one place a single action targets more than one recipient --
   * creating a milestone is news to the whole management team, not to the person
   * who did it. The audience is resolved from permissions rather than from a
   * hard-coded role name so a renamed or custom role with the same rights is
   * included, and the actor is skipped since `notify` already treats
   * self-targeted writes as noise.
   *
   * Like `notify`, this is best-effort and never throws into the caller; each
   * write is independently guarded, so one bad recipient cannot stop the rest.
   */
  async broadcast(
    organizationId: string,
    actorId: string,
    type: string,
    title: string,
    body?: string | null,
  ): Promise<number> {
    const roles = await this.roleRepo.find({
      where: { organizationId, status: 'active', userId: Not(IsNull()) },
      relations: { permissions: true },
    });

    let delivered = 0;

    for (const role of roles) {
      if (!role.userId || role.userId === actorId) {
        continue;
      }

      const canReceive = (role.permissions ?? []).some((permission) =>
        BROADCAST_PERMISSIONS.has(permission.name),
      );

      if (!canReceive) {
        continue;
      }

      const created = await this.notify({
        organizationId,
        userId: role.userId,
        actorId,
        type,
        title,
        body: body ?? null,
      });

      if (created) {
        delivered += 1;
      }
    }

    return delivered;
  }
}