const UNIT_SECONDS = {
  year: 31536000,
  mon: 2592000,
  day: 86400,
  hour: 3600,
  min: 60,
  sec: 1,
} as const;

/**
 * Shape produced by the PostgreSQL driver for `interval` columns. Values
 * depend on the magnitude: `{ hours: 2 }` for `02:00:00`, `{ days: 1, hours: 4 }`
 * for `1 day 04:00:00`.
 */
export interface IntervalParts {
  years?: number;
  months?: number;
  days?: number;
  hours?: number;
  minutes?: number;
  seconds?: number;
}

export type IntervalValue = string | IntervalParts;

const INTERVAL_PATTERN =
  /(-?\d+(?:\.\d+)?)\s+(year|mon|day|hour|min|sec)s?/g;
const CLOCK_PATTERN = /(-)?(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/;

/**
 * Converts a PostgreSQL interval to seconds. Accepts both the literal string
 * form (`02:00:00`, `1 day 04:30:00`, `-00:15:00`) and the object the driver
 * returns for `interval` columns.
 */
export function parseIntervalSeconds(
  value: IntervalValue | null | undefined,
): number {
  if (value === null || value === undefined) {
    return 0;
  }

  if (typeof value === 'object') {
    return (
      (value.years ?? 0) * UNIT_SECONDS.year +
      (value.months ?? 0) * UNIT_SECONDS.mon +
      (value.days ?? 0) * UNIT_SECONDS.day +
      (value.hours ?? 0) * UNIT_SECONDS.hour +
      (value.minutes ?? 0) * UNIT_SECONDS.min +
      (value.seconds ?? 0) * UNIT_SECONDS.sec
    );
  }

  let total = 0;
  let match: RegExpExecArray | null;

  INTERVAL_PATTERN.lastIndex = 0;
  while ((match = INTERVAL_PATTERN.exec(value)) !== null) {
    total +=
      Number(match[1]) * UNIT_SECONDS[match[2] as keyof typeof UNIT_SECONDS];
  }

  // PostgreSQL renders the time part as a clock literal, combined with the
  // unit part when one is present: `04:30:00`, `1 day 04:30:00`, `-00:15:00`.
  const clock = CLOCK_PATTERN.exec(value);
  if (clock) {
    const sign = clock[1] === '-' ? -1 : 1;
    total +=
      sign *
      (Number(clock[2]) * 3600 + Number(clock[3]) * 60 + Number(clock[4]));
  }

  return total;
}

function pad(value: number, size = 2): string {
  return String(Math.abs(value)).padStart(size, '0');
}

/**
 * Renders a PostgreSQL interval as a canonical literal so API responses never
 * expose the driver specific object form.
 */
export function formatInterval(value: IntervalValue | null | undefined): string | null {
  const seconds = parseIntervalSeconds(value);
  if (!seconds) {
    return value === null || value === undefined ? null : '00:00:00';
  }

  const sign = seconds < 0 ? '-' : '';
  const rest = Math.abs(seconds);
  const days = Math.floor(rest / UNIT_SECONDS.day);
  const hours = Math.floor((rest % UNIT_SECONDS.day) / UNIT_SECONDS.hour);
  const minutes = Math.floor((rest % UNIT_SECONDS.hour) / UNIT_SECONDS.min);
  const clock = `${pad(hours)}:${pad(minutes)}:${pad(rest % UNIT_SECONDS.min)}`;

  return days > 0 ? `${sign}${days} days ${clock}` : `${sign}${clock}`;
}

/** Renders whole seconds as a PostgreSQL interval literal. */
export function secondsToInterval(seconds: number): string {
  return `${Math.round(seconds)} seconds`;
}
