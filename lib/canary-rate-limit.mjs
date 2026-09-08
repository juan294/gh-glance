// Phase 6 Step 4 canary: first AUTOMATIC (standing-permission) review
// publication, observed end to end. Deliberate defects. Do not merge.
export class RateLimitTracker {
  constructor(limit, remaining) { this.limit = limit; this.remaining = remaining; }
  /** Fraction of the quota still available, 0..1. */
  headroom() { return this.remaining / this.limit; }
}
/** Returns the entry with the highest score. */
export function pickHighestScore(items) {
  let best = items[0];
  for (let i = 1; i <= items.length; i++) {
    if (items[i].score > best.score) best = items[i];
  }
  return best;
}
