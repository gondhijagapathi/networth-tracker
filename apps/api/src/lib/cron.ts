/**
 * A minimal 5-field cron matcher and scheduler.
 *
 * The dead-man sweep gets away with a plain `setInterval` because it only needs to run
 * *often enough*. A NAV refresh does not: AMFI publishes once a day, after the market
 * closes, and a job that ran at a random hour would spend most of its calls re-fetching a
 * file that has not changed. `NAV_REFRESH_CRON` is a real cron expression for exactly that
 * reason, so this is a real (if small) cron matcher rather than a second interval dressed up
 * to look like one.
 *
 * Matched against the server's local time, the same as an ordinary crontab — an operator who
 * wants NAV refresh to land at 20:30 IST sets `TZ=Asia/Kolkata` in the environment, same as
 * they would for `cron(8)` itself.
 */

export interface CronSchedule {
  minute: ReadonlySet<number>;
  hour: ReadonlySet<number>;
  day: ReadonlySet<number>;
  month: ReadonlySet<number>;
  weekday: ReadonlySet<number>;
}

const FIELD_RANGES = {
  minute: [0, 59],
  hour: [0, 23],
  day: [1, 31],
  month: [1, 12],
  weekday: [0, 6],
} as const satisfies Record<keyof CronSchedule, readonly [number, number]>;

export function parseCron(expression: string): CronSchedule {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(
      `Cron expression needs 5 fields (minute hour day month weekday): "${expression}"`,
    );
  }
  const [minute, hour, day, month, weekday] = fields as [string, string, string, string, string];
  return {
    minute: parseField(minute, FIELD_RANGES.minute),
    hour: parseField(hour, FIELD_RANGES.hour),
    day: parseField(day, FIELD_RANGES.day),
    month: parseField(month, FIELD_RANGES.month),
    weekday: parseField(weekday, FIELD_RANGES.weekday),
  };
}

/** One field: comma-separated `*`, `a`, `a-b`, or any of those with `/step`. */
function parseField(field: string, [min, max]: readonly [number, number]): Set<number> {
  const values = new Set<number>();

  for (const token of field.split(',')) {
    const [range, stepText] = token.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step <= 0) {
      throw new Error(`Bad step in cron field "${field}"`);
    }

    let start = min;
    let end = max;
    if (range !== '*' && range !== undefined && range !== '') {
      const [fromText, toText] = range.split('-');
      const from = Number(fromText);
      if (!Number.isInteger(from)) throw new Error(`Bad cron field "${field}"`);
      start = from;
      end = toText === undefined ? from : Number(toText);
      if (!Number.isInteger(end)) throw new Error(`Bad cron field "${field}"`);
    }
    if (start < min || end > max || start > end) {
      throw new Error(`Cron field "${field}" is out of range ${min}-${max}`);
    }

    for (let value = start; value <= end; value += step) values.add(value);
  }

  return values;
}

export function matchesCron(schedule: CronSchedule, at: Date): boolean {
  return (
    schedule.minute.has(at.getMinutes()) &&
    schedule.hour.has(at.getHours()) &&
    schedule.day.has(at.getDate()) &&
    schedule.month.has(at.getMonth() + 1) &&
    schedule.weekday.has(at.getDay())
  );
}

export interface ScheduledCron {
  stop: () => void;
}

/**
 * Check every `checkIntervalMs` (default one minute) and run `task` once per matching minute.
 *
 * "Once per minute" needs its own guard: a check that landed a second late must not decide
 * the minute never matched, and a check that runs twice inside the same minute — a slow tick
 * followed immediately by the next one — must not run `task` twice. Both are handled by
 * remembering the last minute a run happened, keyed to the tick's own clock rather than the
 * wall clock, so this is exercised the same way in a test with an injected `now`.
 */
export function scheduleCron(
  expression: string,
  task: () => void,
  options: { now?: () => Date; checkIntervalMs?: number } = {},
): ScheduledCron {
  const schedule = parseCron(expression);
  const now = options.now ?? (() => new Date());
  const checkIntervalMs = options.checkIntervalMs ?? 60_000;
  let lastRunKey: string | null = null;

  function tick(): void {
    const at = now();
    if (!matchesCron(schedule, at)) return;

    const key = `${at.getFullYear()}-${at.getMonth()}-${at.getDate()}-${at.getHours()}-${at.getMinutes()}`;
    if (key === lastRunKey) return;
    lastRunKey = key;
    task();
  }

  tick();
  const timer = setInterval(tick, checkIntervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
