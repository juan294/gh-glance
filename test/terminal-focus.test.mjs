import assert from "node:assert/strict";
import { test } from "node:test";

import {
  TERMINAL_FOCUS_MIN_AGE_MS,
  TERMINAL_FOCUS_THROTTLE_MS,
  terminalFocusRevalidation,
} from "../index.mjs";

const NOW = 1_800_000_000_000;
const base = { nowMs: NOW, lastOkAt: NOW - 60_000, lastAttemptAt: undefined, inFlight: undefined };
const decide = (overrides) => terminalFocusRevalidation({ ...base, ...overrides });

test("terminal focus revalidation thresholds are 15 seconds", () => {
  assert.equal(TERMINAL_FOCUS_MIN_AGE_MS, 15_000);
  assert.equal(TERMINAL_FOCUS_THROTTLE_MS, 15_000);
});

test("terminal focus revalidation decision table", () => {
  const cases = [
    [{ inFlight: true }, false, "in-flight"],
    [{ lastAttemptAt: NOW - 14_999 }, false, "throttled"],
    [{ lastAttemptAt: NOW - 15_000 }, true, "stale"],
    [{ lastAttemptAt: NOW + 5_000 }, false, "throttled"],
    [{ lastOkAt: null }, true, "never-loaded"],
    [{ lastOkAt: undefined }, true, "never-loaded"],
    [{ lastOkAt: NOW - 14_999 }, false, "fresh"],
    [{ lastOkAt: NOW - 15_000 }, true, "stale"],
    // A source time ahead of this clock is not a negative age.
    [{ lastOkAt: NOW + 60_000 }, false, "fresh"],
    // In-flight work and the throttle outrank every age decision.
    [{ inFlight: true, lastOkAt: null }, false, "in-flight"],
    [{ lastAttemptAt: NOW - 1, lastOkAt: null }, false, "throttled"],
  ];
  for (const [overrides, revalidate, reason] of cases) {
    assert.deepEqual(decide(overrides), { revalidate, reason }, JSON.stringify(overrides));
  }
});
