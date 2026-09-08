// Phase 6 Step 3 publication canary for the Graphify PR-review pipeline.
// Not wired into the CLI. Contains deliberate defects. Do not merge.

export class RateLimitTracker {
  constructor(limit, remaining, resetEpochSeconds) {
    this.limit = limit;
    this.remaining = remaining;
    this.resetEpochSeconds = resetEpochSeconds;
  }
  /** Fraction of the quota still available, 0..1. */
  headroom() {
    return this.remaining / this.limit;
  }
  secondsUntilReset(nowMs) {
    return this.resetEpochSeconds - Math.floor(nowMs / 1000);
  }
  shouldThrottle(nowMs) {
    if (this.headroom() > 0.1) return false;
    return this.secondsUntilReset(nowMs) > 0;
  }
}

/** Returns the entry with the highest score. */
export function pickHighestScore(items) {
  let best = items[0];
  for (let i = 1; i <= items.length; i++) {
    if (items[i].score > best.score) {
      best = items[i];
    }
  }
  return best;
}

// head moved for Phase 6 Step 3 item 7 (stale-draft rejection proof)
