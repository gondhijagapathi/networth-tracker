import { describe, expect, it } from 'vitest';
import { LOGIN_POLICY, RateLimiter, type RateLimitPolicy } from '../rateLimit.js';
import { ApiError } from '../errors.js';

const POLICY: RateLimitPolicy = {
  freeAttempts: 3,
  baseDelaySeconds: 2,
  maxDelaySeconds: 60,
  windowSeconds: 600,
  message: 'Too many attempts',
};

/** A limiter over a clock the test moves by hand, so nothing has to sleep. */
function limiter(policy = POLICY) {
  let clock = 1_700_000_000_000;
  return {
    limiter: new RateLimiter(policy, () => clock),
    advance: (seconds: number) => {
      clock += seconds * 1000;
    },
  };
}

describe('RateLimiter', () => {
  it('allows the free attempts, then blocks', () => {
    const { limiter: rl } = limiter();

    for (let attempt = 0; attempt < POLICY.freeAttempts - 1; attempt += 1) {
      rl.assertAllowed('key');
      rl.recordFailure('key');
    }

    // The third failure reaches the limit and starts the backoff.
    rl.assertAllowed('key');
    rl.recordFailure('key');

    expect(() => rl.assertAllowed('key')).toThrow(ApiError);
  });

  it('doubles the delay with each further failure, up to the cap', () => {
    const { limiter: rl, advance } = limiter();
    const delays: number[] = [];

    for (let attempt = 0; attempt < 10; attempt += 1) {
      rl.recordFailure('key');
      try {
        rl.assertAllowed('key');
        delays.push(0);
      } catch (error) {
        delays.push((error as ApiError).retryAfterSeconds!);
        advance((error as ApiError).retryAfterSeconds!);
      }
    }

    expect(delays.slice(0, 3)).toEqual([0, 0, 2]);
    expect(delays.slice(3, 6)).toEqual([4, 8, 16]);
    expect(delays.at(-1)).toBe(POLICY.maxDelaySeconds);
  });

  it('lets the caller back in once the delay elapses', () => {
    const { limiter: rl, advance } = limiter();
    for (let attempt = 0; attempt < 3; attempt += 1) rl.recordFailure('key');

    expect(() => rl.assertAllowed('key')).toThrow();
    advance(2);
    expect(() => rl.assertAllowed('key')).not.toThrow();
  });

  it('forgets a key that has been quiet for a full window', () => {
    const { limiter: rl, advance } = limiter();
    for (let attempt = 0; attempt < 5; attempt += 1) rl.recordFailure('key');

    advance(POLICY.windowSeconds + 1);

    expect(rl.failureCount('key')).toBe(0);
    expect(() => rl.assertAllowed('key')).not.toThrow();
  });

  it('resets on success', () => {
    const { limiter: rl } = limiter();
    for (let attempt = 0; attempt < 5; attempt += 1) rl.recordFailure('key');

    rl.reset('key');

    expect(rl.failureCount('key')).toBe(0);
    expect(() => rl.assertAllowed('key')).not.toThrow();
  });

  it('keys are independent, so one account cannot lock out another', () => {
    const { limiter: rl } = limiter();
    for (let attempt = 0; attempt < 5; attempt += 1) rl.recordFailure('victim');

    expect(() => rl.assertAllowed('victim')).toThrow();
    expect(() => rl.assertAllowed('bystander')).not.toThrow();
  });

  it('caps the login policy at fifteen minutes however long the run', () => {
    const { limiter: rl, advance } = limiter(LOGIN_POLICY);
    for (let attempt = 0; attempt < 40; attempt += 1) {
      rl.recordFailure('key');
      advance(1);
    }
    try {
      rl.assertAllowed('key');
      throw new Error('expected the limiter to block');
    } catch (error) {
      expect((error as ApiError).retryAfterSeconds).toBeLessThanOrEqual(
        LOGIN_POLICY.maxDelaySeconds,
      );
    }
  });
});
