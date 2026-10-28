/**
 * Fixed-window attempt limiter for the auth server actions (ONCF-01). Defence in depth on top of
 * Supabase Auth's own per-project limits: it is per server instance (memory), so a distributed
 * limiter (e.g. a shared store) is still needed before high-traffic production use.
 */
export interface RateRule {
  readonly limit: number;
  readonly windowMs: number;
}

export const RATE_RULES = {
  signin: { limit: 8, windowMs: 10 * 60_000 },
  signinIp: { limit: 40, windowMs: 10 * 60_000 },
  signup: { limit: 5, windowMs: 60 * 60_000 },
  email: { limit: 4, windowMs: 60 * 60_000 },
  reset: { limit: 6, windowMs: 15 * 60_000 },
} as const satisfies Record<string, RateRule>;

/**
 * D-P5 · Sign-ups per client IP per hour. One registration desk, club or office shares one public
 * address, so an operator may size this for a desk through the server-only
 * AUTH_SIGNUP_LIMIT_PER_IP, never above SIGNUP_LIMIT_PER_IP_MAX. Anything else (unset, empty, not a
 * whole number, out of range) keeps the default: a typo can never disable or widen the limit. The
 * window, the client-IP source and every other rule are unchanged.
 */
export const SIGNUP_LIMIT_PER_IP_MAX = 30;

export function signupRule(configured = process.env.AUTH_SIGNUP_LIMIT_PER_IP): RateRule {
  const limit = /^[0-9]{1,2}$/.test(configured ?? '') ? Number(configured) : Number.NaN;
  return limit >= 1 && limit <= SIGNUP_LIMIT_PER_IP_MAX
    ? { limit, windowMs: RATE_RULES.signup.windowMs }
    : RATE_RULES.signup;
}

const MAX_KEYS = 10_000;

export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Records an attempt; false when the key is over its limit for the current window. */
  attempt(key: string, rule: RateRule): boolean {
    const t = this.now();
    const entry = this.hits.get(key);
    if (entry === undefined || entry.resetAt <= t) {
      if (this.hits.size >= MAX_KEYS) this.evict(t);
      this.hits.set(key, { count: 1, resetAt: t + rule.windowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= rule.limit;
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  private evict(t: number): void {
    for (const [k, v] of this.hits) if (v.resetAt <= t) this.hits.delete(k);
    // Still full: drop the oldest insertions (Map preserves insertion order).
    for (const k of this.hits.keys()) {
      if (this.hits.size < MAX_KEYS) break;
      this.hits.delete(k);
    }
  }
}

export const authRateLimiter = new RateLimiter();
