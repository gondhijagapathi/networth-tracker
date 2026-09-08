import { describe, expect, it, vi } from 'vitest';
import { matchesCron, parseCron, scheduleCron } from '../cron.js';

describe('parseCron / matchesCron', () => {
  it('matches the default NAV refresh schedule at 20:30 on a weekday', () => {
    const schedule = parseCron('30 20 * * 1-5');
    expect(matchesCron(schedule, new Date(2026, 8, 7, 20, 30))).toBe(true); // Monday
    expect(matchesCron(schedule, new Date(2026, 8, 7, 20, 31))).toBe(false);
    expect(matchesCron(schedule, new Date(2026, 8, 7, 20, 29))).toBe(false);
    expect(matchesCron(schedule, new Date(2026, 8, 7, 9, 30))).toBe(false);
  });

  it('excludes the weekend on a weekday range', () => {
    const schedule = parseCron('30 20 * * 1-5');
    expect(matchesCron(schedule, new Date(2026, 8, 6, 20, 30))).toBe(false); // Sunday
    expect(matchesCron(schedule, new Date(2026, 8, 12, 20, 30))).toBe(false); // Saturday
  });

  it('supports lists, steps and a bare wildcard', () => {
    const schedule = parseCron('*/15 9,18 * * *');
    expect(matchesCron(schedule, new Date(2026, 8, 7, 9, 0))).toBe(true);
    expect(matchesCron(schedule, new Date(2026, 8, 7, 9, 15))).toBe(true);
    expect(matchesCron(schedule, new Date(2026, 8, 7, 9, 20))).toBe(false);
    expect(matchesCron(schedule, new Date(2026, 8, 7, 18, 45))).toBe(true);
    expect(matchesCron(schedule, new Date(2026, 8, 7, 12, 0))).toBe(false);
  });

  it('rejects a malformed expression', () => {
    expect(() => parseCron('30 20 * *')).toThrow();
    expect(() => parseCron('60 20 * * *')).toThrow();
    expect(() => parseCron('x 20 * * *')).toThrow();
  });
});

describe('scheduleCron', () => {
  it('runs the task once per matching minute and not on off-minutes', () => {
    let clock = new Date(2026, 8, 7, 20, 29, 50);
    const task = vi.fn();

    const job = scheduleCron('30 20 * * *', task, {
      now: () => clock,
      checkIntervalMs: 1_000,
    });

    // Tick a few times inside the same off-minute: nothing runs.
    for (let i = 0; i < 3; i += 1) {
      clock = new Date(clock.getTime() + 5_000);
    }
    job.stop();
    expect(task).not.toHaveBeenCalled();
  });

  it('does not run twice for the same matching minute', () => {
    let clock = new Date(2026, 8, 7, 20, 30, 0);
    const task = vi.fn();
    let tickFn: (() => void) | undefined;

    // Drive ticks manually via a fake timer so the test controls exactly how many run.
    const originalSetInterval = global.setInterval;
    global.setInterval = ((fn: () => void) => {
      tickFn = fn;
      return { unref: () => {} } as unknown as NodeJS.Timeout;
    }) as typeof global.setInterval;

    try {
      const job = scheduleCron('30 20 * * *', task, { now: () => clock });
      expect(task).toHaveBeenCalledTimes(1); // the immediate check at construction

      clock = new Date(clock.getTime() + 10_000); // still 20:30
      tickFn?.();
      expect(task).toHaveBeenCalledTimes(1);

      clock = new Date(clock.getTime() + 60_000); // now 20:31
      tickFn?.();
      expect(task).toHaveBeenCalledTimes(1);

      job.stop();
    } finally {
      global.setInterval = originalSetInterval;
    }
  });
});
