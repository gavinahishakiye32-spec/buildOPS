import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';
import {
  MAX_MINUTES_IN_DAY,
  SETTINGS_DATE_FORMATS,
  SETTINGS_DIGEST_FREQUENCIES,
  SETTINGS_LOCALES,
  SETTINGS_THEMES,
  SETTINGS_TIME_FORMATS,
  SETTINGS_WEEK_STARTS,
  TIMEZONE_PATTERN,
} from '../../common/enums.js';

/**
 * A user's own preferences.
 *
 * Every field is optional and only the fields sent are written, which is what
 * makes a settings form work: a client that changes the theme sends the theme,
 * not the whole object it read back earlier. Sending the whole object is also
 * fine, because the values are the same closed sets the GET returned.
 */
export class UpdateUserSettingsDto {
  @ApiPropertyOptional({
    enum: SETTINGS_THEMES,
    example: 'dark',
    description: '`system` follows the device setting.',
  })
  @IsOptional()
  @IsIn(SETTINGS_THEMES)
  theme?: string;

  @ApiPropertyOptional({ enum: SETTINGS_LOCALES, example: 'fr' })
  @IsOptional()
  @IsIn(SETTINGS_LOCALES)
  locale?: string;

  @ApiPropertyOptional({
    example: 'Europe/Paris',
    description:
      'IANA time zone name. Used for every date and time this user sees, ' +
      'independently of the organization setting.',
  })
  @IsOptional()
  @IsString()
  @Matches(TIMEZONE_PATTERN, {
    message:
      'timezone must be an IANA time zone name such as UTC or Europe/Paris',
  })
  timezone?: string;

  @ApiPropertyOptional({ enum: SETTINGS_DATE_FORMATS, example: 'DD/MM/YYYY' })
  @IsOptional()
  @IsIn(SETTINGS_DATE_FORMATS)
  dateFormat?: string;

  @ApiPropertyOptional({ enum: SETTINGS_TIME_FORMATS, example: '12h' })
  @IsOptional()
  @IsIn(SETTINGS_TIME_FORMATS)
  timeFormat?: string;

  @ApiPropertyOptional({
    enum: SETTINGS_DIGEST_FREQUENCIES,
    example: 'off',
    description:
      'How often this user is notified. `off` is a real value rather than an ' +
      'absence: a user who wants no notifications has to be able to say so.',
  })
  @IsOptional()
  @IsIn(SETTINGS_DIGEST_FREQUENCIES)
  digestFrequency?: string;
}

export class UserSettingsResponseDto {
  @ApiProperty({
    format: 'uuid',
    example: '9a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
  })
  userId: string;

  @ApiProperty({ enum: SETTINGS_THEMES, example: 'system' })
  theme: string;

  @ApiProperty({ enum: SETTINGS_LOCALES, example: 'en' })
  locale: string;

  @ApiProperty({ example: 'UTC' })
  timezone: string;

  @ApiProperty({ enum: SETTINGS_DATE_FORMATS, example: 'YYYY-MM-DD' })
  dateFormat: string;

  @ApiProperty({ enum: SETTINGS_TIME_FORMATS, example: '24h' })
  timeFormat: string;

  @ApiProperty({ enum: SETTINGS_DIGEST_FREQUENCIES, example: 'daily' })
  digestFrequency: string;

  @ApiProperty({ example: '2026-09-30T10:00:00.000Z' })
  createdAt: Date;

  @ApiProperty({ example: '2026-09-30T10:00:00.000Z' })
  updatedAt: Date;
}

/**
 * The settings every member of an organization shares.
 *
 * The working window is two bounds rather than one `HH:MM` string so it can be
 * compared against a logged duration as a number. Each bound is validated on its
 * own here; that they form a sane window is a business rule and is enforced by
 * the service, which has to reject the pair anyway since the two arrive
 * independently.
 */
export class UpdateOrganizationSettingsDto {
  @ApiPropertyOptional({
    example: 'Europe/Paris',
    description:
      'IANA time zone name the organization reports in. Individual members can ' +
      'still override it for their own view.',
  })
  @IsOptional()
  @IsString()
  @Matches(TIMEZONE_PATTERN, {
    message:
      'timezone must be an IANA time zone name such as UTC or Europe/Paris',
  })
  timezone?: string;

  @ApiPropertyOptional({
    enum: SETTINGS_WEEK_STARTS,
    example: 'monday',
    description: 'Day the week starts on for calendars and summaries.',
  })
  @IsOptional()
  @IsIn(SETTINGS_WEEK_STARTS)
  weekStart?: string;

  @ApiPropertyOptional({
    enum: SETTINGS_TIME_FORMATS,
    example: '24h',
    description:
      'Default clock for the organization. Members may override it in their own settings.',
  })
  @IsOptional()
  @IsIn(SETTINGS_TIME_FORMATS)
  timeFormat?: string;

  @ApiPropertyOptional({
    example: 540,
    minimum: 0,
    maximum: MAX_MINUTES_IN_DAY,
    description:
      'Start of the working day in minutes from midnight (09:00 is 540). Used ' +
      'to judge whether logged time falls inside working hours.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_MINUTES_IN_DAY)
  workingDayStartMinutes?: number;

  @ApiPropertyOptional({
    example: 1020,
    minimum: 0,
    maximum: MAX_MINUTES_IN_DAY,
    description:
      'End of the working day in minutes from midnight (17:00 is 1020). Must be ' +
      'later than the start; sending a window that ends before it starts is refused with 400.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_MINUTES_IN_DAY)
  workingDayEndMinutes?: number;
}

export class OrganizationSettingsResponseDto {
  @ApiProperty({
    format: 'uuid',
    example: 'b7d8e9f0-1a2b-4c3d-8e4f-5a6b7c8d9e0f',
  })
  organizationId: string;

  @ApiProperty({ example: 'UTC' })
  timezone: string;

  @ApiProperty({ enum: SETTINGS_WEEK_STARTS, example: 'monday' })
  weekStart: string;

  @ApiProperty({ enum: SETTINGS_TIME_FORMATS, example: '24h' })
  timeFormat: string;

  @ApiProperty({ example: 540 })
  workingDayStartMinutes: number;

  @ApiProperty({ example: 1020 })
  workingDayEndMinutes: number;

  @ApiProperty({ example: '2026-09-30T10:00:00.000Z' })
  createdAt: Date;

  @ApiProperty({ example: '2026-09-30T10:00:00.000Z' })
  updatedAt: Date;
}
