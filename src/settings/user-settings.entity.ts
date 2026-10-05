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
import { User } from '../user/user.entity.js';
import {
  DEFAULT_USER_SETTINGS,
  SETTINGS_DATE_FORMATS,
  SETTINGS_DIGEST_FREQUENCIES,
  SETTINGS_LOCALES,
  SETTINGS_THEMES,
  SETTINGS_TIME_FORMATS,
} from '../common/enums.js';

/**
 * A user's own preferences.
 *
 * The primary key is `user_id` rather than a generated `id`, and the reason is
 * that a user has at most one of these rows for their whole life: the identity
 * of the row *is* the user. A surrogate key would have to be made unique on
 * `user_id` to prevent duplicates, so it would buy a second column and a second
 * constraint in exchange for nothing, and the foreign key would no longer be
 * the primary key.
 *
 * Every column is NOT NULL with a database default, so there is no partially
 * configured row to interpret. The row is created on the first read, which means
 * a client can GET the settings it has never touched and receive a complete,
 * usable answer instead of a sparse object it has to fill in itself -- and the
 * same defaults apply to a direct database read, not only to this API.
 */
/**
 * The value sets as SQL `IN` lists, built from the same arrays the validators and
 * the Swagger enums read.
 *
 * Written out per constraint rather than generated, because the constraint *name*
 * has to match what the migration created -- TypeORM compares the two by name and
 * expression, and a generated expression that only reorders the values is enough
 * for it to propose dropping the live constraint. The names are the contract; the
 * lists come from `enums.ts` so a new value cannot be added to a validator without
 * also being accepted here.
 */
const inList = (values: readonly string[]): string =>
  values.map((value) => `'${value}'`).join(', ');

@Entity('user_settings')
@Check(`CHK_user_settings_theme`, `"theme" IN (${inList(SETTINGS_THEMES)})`)
@Check(`CHK_user_settings_locale`, `"locale" IN (${inList(SETTINGS_LOCALES)})`)
@Check(
  `CHK_user_settings_time_format`,
  `"time_format" IN (${inList(SETTINGS_TIME_FORMATS)})`,
)
@Check(
  `CHK_user_settings_date_format`,
  `"date_format" IN (${inList(SETTINGS_DATE_FORMATS)})`,
)
@Check(
  `CHK_user_settings_digest_frequency`,
  `"digest_frequency" IN (${inList(SETTINGS_DIGEST_FREQUENCIES)})`,
)
export class UserSettings {
  @PrimaryColumn({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'FK_user_settings_user_id',
  })
  user: User;

  @Column({ type: 'varchar', length: 20, default: DEFAULT_USER_SETTINGS.theme })
  theme: string;

  @Column({
    type: 'varchar',
    length: 10,
    default: DEFAULT_USER_SETTINGS.locale,
  })
  locale: string;

  @Column({
    type: 'varchar',
    length: 64,
    default: DEFAULT_USER_SETTINGS.timezone,
  })
  timezone: string;

  @Column({
    name: 'date_format',
    type: 'varchar',
    length: 20,
    default: DEFAULT_USER_SETTINGS.dateFormat,
  })
  dateFormat: string;

  @Column({
    name: 'time_format',
    type: 'varchar',
    length: 10,
    default: DEFAULT_USER_SETTINGS.timeFormat,
  })
  timeFormat: string;

  @Column({
    name: 'digest_frequency',
    type: 'varchar',
    length: 20,
    default: DEFAULT_USER_SETTINGS.digestFrequency,
  })
  digestFrequency: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  toResponse() {
    return {
      userId: this.userId,
      theme: this.theme,
      locale: this.locale,
      timezone: this.timezone,
      dateFormat: this.dateFormat,
      timeFormat: this.timeFormat,
      digestFrequency: this.digestFrequency,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}

/**
 * The value sets the columns above are drawn from, re-exported from where the
 * validators read them. A `@Column` default and the `@IsIn` on the DTO have to
 * agree, or a row can hold a value the API would refuse to accept back.
 */
export const USER_SETTING_VALUES = {
  themes: SETTINGS_THEMES,
  locales: SETTINGS_LOCALES,
  dateFormats: SETTINGS_DATE_FORMATS,
  timeFormats: SETTINGS_TIME_FORMATS,
  digestFrequencies: SETTINGS_DIGEST_FREQUENCIES,
} as const;
