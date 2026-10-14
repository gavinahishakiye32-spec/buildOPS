import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import { DEFAULT_USER_SETTINGS } from '../common/enums.js';
import { BROADCAST_AUDIENCE_PERMISSIONS } from '../common/permissions.js';
import {
  resolvePage,
  toPaginated,
  type Paginated,
} from '../common/pagination.dto.js';
import { MailService } from '../mail/mail.service.js';
import { Role } from '../role/role.entity.js';
import { UserSettings } from '../settings/user-settings.entity.js';
import { User } from '../user/user.entity.js';
import { Notification } from './notification.entity.js';
import { NotificationQueryDto } from './dto/notification.dto.js';

/**
 * Who a broadcast ("what's new in the system") notification reaches.
 *
 * A member is in the audience when the role that grants their access carries
 * one of the {@link BROADCAST_AUDIENCE_PERMISSIONS} -- managing projects and
 * milestones is what it means to run delivery. The audience is resolved by
 * capability rather than by a fixed set of role names or template keys, so a
 * role an administrator builds is included the moment it is given one of these
 * permissions, and excluded the moment it is not. A renamed role is untouched
 * by this: the match never looked at the name.
 */
const BROADCAST_PERMISSIONS = new Set<string>(BROADCAST_AUDIENCE_PERMISSIONS);

/**
 * The in-app inbox and its realtime email half.
 *
 * Rows are created by the delivery flows (task/subtask assignment, task status
 * changes), never directly by a client: the inbox endpoints only read and tidy
 * up. Every write route keys off the caller's own `userId`, so a recipient can
 * only ever see and clear their own inbox; the `organizationId` column exists
 * for the permission guard.
 *
 * The email is a best-effort nudge governed by the recipient's own
 * `digestFrequency`: only `realtime` gets an email here (daily/weekly digests
 * are a separate job). A send that fails must not fail the request that created
 * the notification, so it is caught and logged.
 */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    @InjectRepository(Notification)
    private readonly notificationRepo: Repository<Notification>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(UserSettings)
    private readonly userSettingsRepo: Repository<UserSettings>,
    @InjectRepository(Role)
    private readonly roleRepo: Repository<Role>,
    private readonly mailService: MailService,
  ) {}

  async create(
    organizationId: string,
    recipientId: string,
    kind: string,
    title: string,
    body: string,
    data?: Record<string, unknown>,
    actorId?: string | null,
  ): Promise<Notification> {
    const notification = await this.notificationRepo.save(
      this.notificationRepo.create({
        organizationId,
        recipientId,
        actorId: actorId ?? null,
        kind,
        title,
        body,
        data: data ?? null,
      }),
    );

    await this.sendRealtimeEmail(recipientId, title, body);

    return notification;
  }

  /**
   * Delivers a lifecycle notification to every owner and project manager.
   *
   * Each row is guarded individually, matching the delivery flows' convention
   * (best-effort, never fails the mutation that produced the event). The
   * actor who caused the event is skipped: the row would tell them what they
   * just did. Returns how many rows were written.
   */
  async broadcast(
    organizationId: string,
    actorId: string | null,
    kind: string,
    title: string,
    body: string,
    data?: Record<string, unknown>,
  ): Promise<number> {
    const roles = await this.roleRepo.find({
      where: {
        organizationId,
        status: 'active',
        // A role definition without a member has no `user_id`; it is a
        // template waiting to be assigned, not a recipient.
        userId: Not(IsNull()),
      },
      relations: { permissions: true },
    });

    let delivered = 0;
    for (const role of roles) {
      if (role.userId === actorId || !this.isBroadcastAudience(role)) {
        continue;
      }

      try {
        await this.create(
          organizationId,
          role.userId as string,
          kind,
          title,
          body,
          data,
          actorId,
        );
        delivered += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `Broadcast not delivered kind=${kind} recipient=${role.userId}: ${message}`,
        );
      }
    }

    return delivered;
  }

  /**
   * Whether the role that grants this member their access carries one of the
   * management permissions that put them in the broadcast audience. Read from
   * the attached permission rows, so the answer follows the role definition the
   * administrator actually maintains.
   */
  private isBroadcastAudience(role: Role): boolean {
    return (role.permissions ?? []).some((permission) =>
      BROADCAST_PERMISSIONS.has(permission.name),
    );
  }

  async list(
    organizationId: string,
    recipientId: string,
    query: NotificationQueryDto,
  ): Promise<Paginated<Notification>> {
    const { page, limit, skip } = resolvePage(query);

    const where: Record<string, unknown> = { organizationId, recipientId };
    if (query.unread === true) {
      where.readAt = IsNull();
    }
    if (query.kind) {
      where.kind = query.kind;
    }

    const [items, total] = await this.notificationRepo.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      skip,
      take: limit,
    });

    return toPaginated(items, total, page, limit);
  }

  async unreadCount(
    organizationId: string,
    recipientId: string,
  ): Promise<number> {
    return this.notificationRepo.count({
      where: { organizationId, recipientId, readAt: IsNull() },
    });
  }

  /** Marks one notification of the caller as read. Idempotent. */
  async markRead(
    organizationId: string,
    recipientId: string,
    notificationId: string,
  ): Promise<Notification> {
    const notification = await this.requireOwnNotification(
      organizationId,
      recipientId,
      notificationId,
    );

    if (!notification.readAt) {
      notification.readAt = new Date();
      await this.notificationRepo.save(notification);
    }

    return notification;
  }

  /** Marks every notification of the caller as read. */
  async markAllRead(
    organizationId: string,
    recipientId: string,
  ): Promise<{ updated: number }> {
    const result = await this.notificationRepo.update(
      { organizationId, recipientId, readAt: IsNull() },
      { readAt: new Date() },
    );

    return { updated: result.affected ?? 0 };
  }

  /** Removes one of the caller's notifications entirely. */
  async remove(
    organizationId: string,
    recipientId: string,
    notificationId: string,
  ): Promise<void> {
    const notification = await this.requireOwnNotification(
      organizationId,
      recipientId,
      notificationId,
    );

    await this.notificationRepo.delete(notification.id);
  }

  private async requireOwnNotification(
    organizationId: string,
    recipientId: string,
    notificationId: string,
  ): Promise<Notification> {
    const notification = await this.notificationRepo.findOne({
      where: { id: notificationId, organizationId, recipientId },
    });

    if (!notification) {
      throw new NotFoundException(
        'Notification not found in this organization',
      );
    }

    return notification;
  }

  /**
   * The realtime half, gated by the recipient's own digest preference.
   *
   * Deeper than an `if digest === 'realtime'`: a user without a settings row
   * falls back to the same default every fresh settings row would get
   * (`DEFAULT_USER_SETTINGS.digestFrequency`), so a never-configured recipient
   * behaves exactly like one who was asked.
   */
  private async sendRealtimeEmail(
    recipientId: string,
    title: string,
    body: string,
  ): Promise<void> {
    try {
      const settings = await this.userSettingsRepo.findOne({
        where: { userId: recipientId },
      });

      if ((settings?.digestFrequency ?? DEFAULT_USER_SETTINGS.digestFrequency) !== 'realtime') {
        return;
      }

      const user = await this.userRepo.findOne({ where: { id: recipientId } });
      if (!user?.email) {
        return;
      }

      await this.mailService.sendNotificationEmail(user.email, { title, body });
    } catch (error) {
      // The notification is already stored; an email that fails is noise, not
      // a failed request.
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Notification email not sent to=${recipientId} title="${title}": ${message}`,
      );
    }
  }
}