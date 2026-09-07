// Canary fixture for the Graphify PR-review pipeline. Not wired into the CLI.
// See juan294/archy docs/plans/2026-08-30-local-graphify-fleet.md Phase 6.

/**
 * Tracks GitHub API rate-limit headroom across a run and decides whether the
 * next request should wait.
 */
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

  /** Seconds until the window resets. */
  secondsUntilReset(nowMs) {
    return this.resetEpochSeconds - Math.floor(nowMs / 1000);
  }

  /**
   * Whether the caller should pause before issuing another request.
   * Pauses once headroom drops below 10% and the window has not yet reset.
   */
  shouldThrottle(nowMs) {
    if (this.headroom() > 0.1) return false;
    return this.secondsUntilReset(nowMs) > 0;
  }
}

/**
 * Returns the entry with the highest score.
 */
export function pickHighestScore(items) {
  let best = items[0];
  for (let i = 1; i <= items.length; i++) {
    if (items[i].score > best.score) {
      best = items[i];
    }
  }
  return best;
}
