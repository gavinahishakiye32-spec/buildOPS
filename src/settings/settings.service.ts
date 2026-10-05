import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MAX_MINUTES_IN_DAY } from '../common/enums.js';
import { User } from '../user/user.entity.js';
import { Organization } from '../organization/organization.entity.js';
import { UserSettings } from './user-settings.entity.js';
import { OrganizationSettings } from './organization-settings.entity.js';
import {
  UpdateOrganizationSettingsDto,
  UpdateUserSettingsDto,
} from './dto/settings.dto.js';

/**
 * Reads and writes the two settings tables.
 *
 * The row for a user or an organization is created on first read. That is a
 * deliberate departure from the usual "return nothing until it is configured",
 * and it exists so a client never has to hold two representations of the
 * defaults -- the ones the API would have merged in and the ones it would have
 * to reproduce itself to render a form before the first write. Reading gives a
 * complete, current object either way.
 *
 * It also means `GET` is not free of side effects, which is the cost of that.
 * The write is a single-row insert of defaults; it happens once per owner and is
 * idempotent.
 */
@Injectable()
export class SettingsService {
  constructor(
    @InjectRepository(UserSettings)
    private readonly userSettingsRepo: Repository<UserSettings>,
    @InjectRepository(OrganizationSettings)
    private readonly organizationSettingsRepo: Repository<OrganizationSettings>,
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    @InjectRepository(Organization)
    private readonly organizationRepo: Repository<Organization>,
  ) {}

  /**
   * The user's settings, creating them with defaults if absent.
   *
   * The user is verified to exist first. Without that check a request carrying a
   * valid token for a deleted user would insert a settings row whose foreign key
   * points at nothing, and it would fail on the constraint with a 500 instead of
   * the 404 that says what actually happened.
   *
   * The insert races with itself if two requests for a brand-new user arrive at
   * once, so a failed insert is not an error: it means the other request won and
   * the row is there to read. That is why this is `INSERT ... ON CONFLICT DO
   * NOTHING` and then a read, rather than an insert whose failure was expected.
   */
  async getUserSettings(userId: string): Promise<UserSettings> {
    const user = await this.userRepo.findOne({ where: { id: userId } });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const existing = await this.userSettingsRepo.findOne({
      where: { userId },
    });

    if (existing) {
      return existing;
    }

    return this.materializeUserSettings(userId);
  }

  /**
   * Applies a partial update to the user's settings.
   *
   * Only fields actually sent are written, so a client changing one preference
   * does not have to read and resend the rest. `getUserSettings` first means a
   * `PATCH` on an untouched account behaves exactly like a `PATCH` on a
   * configured one.
   */
  async updateUserSettings(
    userId: string,
    dto: UpdateUserSettingsDto,
  ): Promise<UserSettings> {
    const settings = await this.getUserSettings(userId);

    if (dto.theme !== undefined) settings.theme = dto.theme;
    if (dto.locale !== undefined) settings.locale = dto.locale;
    if (dto.timezone !== undefined) settings.timezone = dto.timezone;
    if (dto.dateFormat !== undefined) settings.dateFormat = dto.dateFormat;
    if (dto.timeFormat !== undefined) settings.timeFormat = dto.timeFormat;
    if (dto.digestFrequency !== undefined) {
      settings.digestFrequency = dto.digestFrequency;
    }

    return this.userSettingsRepo.save(settings);
  }

  /**
   * The organization's settings, creating them with defaults if absent.
   *
   * The organization is verified for the same reason and with the same effect as
   * in {@link getUserSettings}: without it, a stale organization id in the header
   * would produce a foreign key violation reported as a 500.
   */
  async getOrganizationSettings(
    organizationId: string,
  ): Promise<OrganizationSettings> {
    const organization = await this.organizationRepo.findOne({
      where: { id: organizationId },
    });

    if (!organization) {
      throw new NotFoundException('Organization not found');
    }

    const existing = await this.organizationSettingsRepo.findOne({
      where: { organizationId },
    });

    if (existing) {
      return existing;
    }

    return this.materializeOrganizationSettings(organizationId);
  }

  /**
   * Applies a partial update to the organization's settings.
   *
   * The working window is validated as a pair against the *resulting* row rather
   * than against the request. Sending only `workingDayEndMinutes` to narrow an
   * existing window is a legitimate thing to do, and checking the request alone
   * would reject it for lacking a start bound. The rule is that a window must
   * end after it starts, and only the resulting row can say whether it does.
   */
  async updateOrganizationSettings(
    organizationId: string,
    dto: UpdateOrganizationSettingsDto,
  ): Promise<OrganizationSettings> {
    const settings = await this.getOrganizationSettings(organizationId);

    if (dto.timezone !== undefined) settings.timezone = dto.timezone;
    if (dto.weekStart !== undefined) settings.weekStart = dto.weekStart;
    if (dto.timeFormat !== undefined) settings.timeFormat = dto.timeFormat;
    if (dto.workingDayStartMinutes !== undefined) {
      settings.workingDayStartMinutes = dto.workingDayStartMinutes;
    }
    if (dto.workingDayEndMinutes !== undefined) {
      settings.workingDayEndMinutes = dto.workingDayEndMinutes;
    }

    assertWorkingWindow(
      settings.workingDayStartMinutes,
      settings.workingDayEndMinutes,
    );

    return this.organizationSettingsRepo.save(settings);
  }

  /**
   * Inserts the default row, tolerating the loser of a concurrent first read.
   *
   * `ON CONFLICT DO NOTHING` rather than a plain insert, because two requests
   * arriving together for the same new user is ordinary traffic, not an error
   * condition. Whichever loses the race then reads the row the winner wrote.
   */
  private async materializeUserSettings(userId: string): Promise<UserSettings> {
    await this.userSettingsRepo
      .createQueryBuilder()
      .insert()
      .values({ userId })
      .orIgnore()
      .execute();

    const settings = await this.userSettingsRepo.findOne({
      where: { userId },
    });

    if (!settings) {
      throw new NotFoundException('User settings not found');
    }

    return settings;
  }

  /** The concurrent-first-read counterpart of {@link materializeUserSettings}. */
  private async materializeOrganizationSettings(
    organizationId: string,
  ): Promise<OrganizationSettings> {
    await this.organizationSettingsRepo
      .createQueryBuilder()
      .insert()
      .values({ organizationId })
      .orIgnore()
      .execute();

    const settings = await this.organizationSettingsRepo.findOne({
      where: { organizationId },
    });

    if (!settings) {
      throw new NotFoundException('Organization settings not found');
    }

    return settings;
  }
}

/**
 * A working day has to end after it starts, and both bounds have to be real
 * minutes in a day.
 *
 * Zero-length windows are rejected rather than allowed as "no working hours".
 * That case is better expressed by not configuring one at all, and accepting a
 * window of zero minutes would make "the team does not work" indistinguishable
 * from "nobody has set this yet" in every report that reads the window.
 */
function assertWorkingWindow(start: number, end: number): void {
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end > MAX_MINUTES_IN_DAY ||
    start >= end
  ) {
    throw new BadRequestException(
      'The working day must start before it ends, between 00:00 and 23:59.',
    );
  }
}
