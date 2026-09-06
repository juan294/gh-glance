import assert from "node:assert/strict";
import { test } from "node:test";

import {
  THROTTLE_LADDER_MS,
  THROTTLE_PAUSE_AFTER,
  applyTransportCooldown,
  classifyThrottle,
  clearTransportThrottle,
  emptyTransportThrottle,
  throttleLadderMs,
  transportCooldownDeadline,
} from "../index.mjs";

const NOW = 1_800_000_000_000;
const transport = () => ({ lastStartedAt: 0, cooldownUntil: 0, permit: null, waiters: [], throttle: emptyTransportThrottle() });

test("SCHED-05 throttle evidence is read, never inferred from the status alone", () => {
  // The case that matters most: a 403 that is a permission error, not a limit.
  // It carries no rate-limit headers and no secondary marker, and holding the
  // shared transport for it would pause every pane over one unreadable repo.
  assert.deepEqual(classifyThrottle({ status: 403, headers: {}, body: { message: "Must have admin rights to Repository." } }),
    { kind: "none" });
  assert.deepEqual(classifyThrottle({ status: 404, headers: {} }), { kind: "none" });

  // Primary exhaustion holds its own resource until its own reset, and says
  // nothing about the other one.
  const primary = classifyThrottle({
    status: 403,
    headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1800003600", "x-ratelimit-resource": "core" },
  });
  assert.deepEqual(primary, { kind: "primary", resource: "core", resetMs: 1_800_003_600_000 });
  assert.equal(classifyThrottle({
    status: 403,
    headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1800003600", "x-ratelimit-resource": "graphql" },
  }).resource, "graphql");

  // An exhausted counter that also names a secondary limit is secondary: the
  // account-wide hold is the stronger claim and it holds both resources.
  assert.equal(classifyThrottle({
    status: 403,
    headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1800003600", "x-ratelimit-resource": "core" },
    body: { message: "You have exceeded a secondary rate limit." },
  }).kind, "secondary");

  // A GraphQL error envelope carries the same evidence in a different shape.
  assert.equal(classifyThrottle({ status: 200, graphqlErrors: [{ type: "RATE_LIMITED", message: "secondary rate limit" }] }).kind, "secondary");
  assert.equal(classifyThrottle({ status: 429, headers: {} }).kind, "secondary");
  assert.equal(classifyThrottle({ status: 200, stderr: "You have triggered an abuse detection mechanism" }).kind, "secondary");
});

test("SCHED-04 a supplied deadline is honoured exactly and the local ladder is capped", () => {
  // Thirty seconds is thirty seconds. The old flat law rounded every secondary
  // limit up to a minute, which turned a short server-chosen wait into a long
  // one for no reason.
  assert.equal(transportCooldownDeadline({ retryAfter: "30", status: 429, at: NOW }), NOW + 30_000);
  // Two hours is two hours: the cap bounds only the delay this client invents.
  assert.equal(transportCooldownDeadline({ retryAfter: "7200", status: 429, at: NOW }), NOW + 7_200_000);
  const httpDate = new Date(NOW + 45_000).toUTCString();
  assert.equal(transportCooldownDeadline({ retryAfter: httpDate, status: 429, at: NOW }), Date.parse(httpDate));

  // Without a supplied deadline the ladder climbs by consecutive throttle and
  // stops climbing, rather than doubling without bound.
  assert.deepEqual(THROTTLE_LADDER_MS, [60_000, 120_000, 240_000, 480_000, 900_000]);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 99].map(throttleLadderMs),
    [60_000, 120_000, 240_000, 480_000, 900_000, 900_000, 900_000]);
  assert.equal(transportCooldownDeadline({ status: 429, at: NOW, attempts: 3 }), NOW + 480_000);
  assert.equal(transportCooldownDeadline({ status: 200, at: NOW }), null);
});

test("SCHED-04 a shorter concurrent error never shortens a hold already established", () => {
  const shared = transport();
  applyTransportCooldown(shared, { retryAfter: "3600", status: 429, at: NOW });
  assert.equal(shared.cooldownUntil, NOW + 3_600_000);
  // A second pane's 429 arrives with no Retry-After and would choose two
  // minutes. Merging by maximum keeps the hour the server actually asked for.
  applyTransportCooldown(shared, { status: 429, at: NOW + 1_000 });
  assert.equal(shared.cooldownUntil, NOW + 3_600_000);
  assert.equal(shared.throttle.attempts, 2);
});

test("SCHED-06 repeated throttles are bounded and pause until an explicit retry", () => {
  const shared = transport();
  const chosen = [];
  for (let attempt = 0; attempt < THROTTLE_PAUSE_AFTER; attempt += 1) {
    const before = shared.cooldownUntil;
    applyTransportCooldown(shared, { status: 429, at: NOW + attempt });
    chosen.push(shared.cooldownUntil - before === 0 ? null : shared.cooldownUntil);
    assert.equal(shared.throttle.attempts, attempt + 1);
  }
  // Bounded: the fifth throttle waits fifteen minutes, not an ever-doubling one.
  assert.equal(shared.cooldownUntil, NOW + 4 + 900_000);
  assert.equal(shared.throttle.paused, true);

  // Only evidence of a request that was not throttled clears the ladder.
  // Waiting out the deadline is what produced the last throttle.
  clearTransportThrottle(shared);
  assert.deepEqual(shared.throttle, emptyTransportThrottle());
  applyTransportCooldown(shared, { status: 429, at: NOW });
  assert.equal(shared.throttle.attempts, 1);
  assert.equal(shared.throttle.paused, false);
});

test("SCHED-05 a permission failure moves neither the hold nor the ladder", () => {
  const shared = transport();
  const verdict = classifyThrottle({ status: 403, headers: {}, body: { message: "Resource not accessible by integration" } });
  assert.equal(verdict.kind, "none");
  // The release path only applies a cooldown for a secondary verdict, so this
  // records the state that path leaves behind: untouched.
  assert.equal(shared.cooldownUntil, 0);
  assert.deepEqual(shared.throttle, emptyTransportThrottle());
});
