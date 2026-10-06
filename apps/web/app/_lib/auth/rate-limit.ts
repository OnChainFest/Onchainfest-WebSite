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
