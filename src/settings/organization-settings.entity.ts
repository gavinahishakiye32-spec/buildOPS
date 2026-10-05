import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Organization } from '../organization/organization.entity.js';
import {
  DEFAULT_ORGANIZATION_SETTINGS,
  MAX_MINUTES_IN_DAY,
  SETTINGS_TIME_FORMATS,
  SETTINGS_WEEK_STARTS,
} from '../common/enums.js';

/** See the note in `user-settings.entity.ts` for why these are built this way. */
const inList = (values: readonly string[]): string =>
  values.map((value) => `'${value}'`).join(', ');

/**
 * The settings every member of an organization shares.
 *
 * Keyed by `organization_id` for the same reason {@link UserSettings} is keyed by
 * `user_id`: one row per owner, for the owner's whole life, and the foreign key
 * is the primary key. That also makes the uniqueness structural rather than a
 * constraint that has to be separately enforced, so two concurrent first-reads
 * cannot produce two competing defaults for the same organization.
 *
 * Distinct from the user's own settings on purpose. An organization timezone and
 * working window are facts about how the team works and have to be consistent
 * across members; a per-user theme is a fact about one person's screen and must
 * not be. Collapsing them into one table would mean every member could silently
 * change the reporting timezone for everybody else.
 */
@Entity('organization_settings')
@Check(
  `CHK_organization_settings_week_start`,
  `"week_start" IN (${inList(SETTINGS_WEEK_STARTS)})`,
)
@Check(
  `CHK_organization_settings_time_format`,
  `"time_format" IN (${inList(SETTINGS_TIME_FORMATS)})`,
)
@Check(
  `CHK_organization_settings_working_window`,
  `"working_day_start_minutes" >= 0` +
    ` AND "working_day_start_minutes" <= ${MAX_MINUTES_IN_DAY}` +
    ` AND "working_day_end_minutes" >= 0` +
    ` AND "working_day_end_minutes" <= ${MAX_MINUTES_IN_DAY}` +
    ` AND "working_day_start_minutes" < "working_day_end_minutes"`,
)
export class OrganizationSettings {
  @PrimaryColumn({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'organization_id',
    foreignKeyConstraintName: 'FK_organization_settings_organization_id',
  })
  organization: Organization;

  @Column({
    type: 'varchar',
    length: 64,
    default: DEFAULT_ORGANIZATION_SETTINGS.timezone,
  })
  timezone: string;

  @Column({
    name: 'week_start',
    type: 'varchar',
    length: 10,
    default: DEFAULT_ORGANIZATION_SETTINGS.weekStart,
  })
  weekStart: string;

  @Column({
    name: 'time_format',
    type: 'varchar',
    length: 10,
    default: DEFAULT_ORGANIZATION_SETTINGS.timeFormat,
  })
  timeFormat: string;

  /**
   * The working window as minutes from midnight.
   *
   * A number rather than a `HH:MM` string because the working window has to be
   * comparable against a logged duration to answer "was this in hours?", and a
   * string column would push that comparison into every caller that needs it.
   */
  @Column({
    name: 'working_day_start_minutes',
    type: 'integer',
    default: DEFAULT_ORGANIZATION_SETTINGS.workingDayStartMinutes,
  })
  workingDayStartMinutes: number;

  @Column({
    name: 'working_day_end_minutes',
    type: 'integer',
    default: DEFAULT_ORGANIZATION_SETTINGS.workingDayEndMinutes,
  })
  workingDayEndMinutes: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  toResponse() {
    return {
      organizationId: this.organizationId,
      timezone: this.timezone,
      weekStart: this.weekStart,
      timeFormat: this.timeFormat,
      workingDayStartMinutes: this.workingDayStartMinutes,
      workingDayEndMinutes: this.workingDayEndMinutes,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}

export const ORGANIZATION_SETTING_VALUES = {
  weekStarts: SETTINGS_WEEK_STARTS,
  timeFormats: SETTINGS_TIME_FORMATS,
} as const;
