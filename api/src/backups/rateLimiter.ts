// Small in-memory fixed-window rate limiter, scoped to the backup-result webhook endpoint only.
// Per CLAUDE.md's "do not add a dependency for a trivial utility" -- a homelab-scale, single-
// process API doesn't need a real rate-limiting library for one low-traffic endpoint; this is a
// few lines and easy to reason about. Deliberately per-process/in-memory (not persisted) --
// resets on restart, which is fine for its purpose (blunt abuse protection, not precise quota
// accounting).
export class FixedWindowRateLimiter {
  private readonly hits = new Map<string, { windowStart: number; count: number }>();

  constructor(
    private readonly maxRequests: number,
    private readonly windowMs: number,
  ) {}

  // Returns true if the request is allowed (and records it); false if the key is over budget
  // for the current window.
  allow(key: string, nowMs: number = Date.now()): boolean {
    const entry = this.hits.get(key);
    if (!entry || nowMs - entry.windowStart >= this.windowMs) {
      this.hits.set(key, { windowStart: nowMs, count: 1 });
      return true;
    }
    if (entry.count >= this.maxRequests) return false;
    entry.count += 1;
    return true;
  }
}
