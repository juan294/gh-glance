import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

import { THROTTLE_LADDER_MS } from "../../index.mjs";
import { captureAsync } from "./capture.mjs";

// Secondary limits are the one class of throttle that is account-wide rather
// than per resource, so they are proved here against the real binary and the
// real registry: what matters is that a failing data call reaches the shared
// transport, and that a failure which only looks like a limit does not.
//
// The stateless fixture is used deliberately. `GH_GLANCE_FIXTURE_FAIL` is read
// by the `gh` shim itself, and the shim execs into the stateful gh-state.mjs
// before reaching it -- so setting a fixture state file here would silently
// serve every call successfully and prove nothing.
function box(t, name) {
  const root = mkdtempSync(join(tmpdir(), `gh-glance-${name}-pty-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const registryPath = join(root, "gh-glance", "coordination-v2", "registry.json");
  return { root, readRegistry: () => JSON.parse(readFileSync(registryPath, "utf8")) };
}

async function observeUntil(read, predicate, deadlineAt) {
  let value = null;
  while (Date.now() < deadlineAt) {
    try {
      value = read();
      if (predicate(value)) return { matched: true, value };
    } catch {
      // The registry is written atomically; a read can land between writes.
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  return { matched: false, value };
}

// `api-data` fails the REST data calls and leaves `user`, `rate_limit` and
// `graphql` readable, so identity and both observers still work. A pane that
// could not bootstrap would report Paused for lack of a budget and would prove
// nothing about how a throttle is classified.
function runPane(target, { pane, failure, readyPath }) {
  return captureAsync({
    cols: 80,
    rows: 24,
    signal: "none",
    settle: 40,
    stdin:
      "i=0; while [ ! -f \"$GH_GLANCE_FIXTURE_READY\" ] && [ \"$i\" -lt 900 ]; do " +
      "sleep .1; i=$((i + 1)); done; printf q",
    configHome: target.root,
    args: "--repo acme/widget",
    env: {
      GH_GLANCE_FIXTURE_PANE: pane,
      GH_GLANCE_FIXTURE_FAIL: failure,
      GH_GLANCE_FIXTURE_FAIL_ON: "api-data",
      GH_GLANCE_FIXTURE_READY: readyPath,
    },
  });
}

const transportOf = (registry) => registry?.hosts?.["github.com"] ?? null;

test("SEC-01 a confirmed secondary limit holds the shared transport for one ladder step", async (t) => {
  const target = box(t, "secondary");
  const readyPath = join(target.root, "secondary-ready");
  const pane = runPane(target, {
    pane: "secondary",
    failure: "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.",
    readyPath,
  });
  const held = await observeUntil(
    target.readRegistry,
    (registry) => (transportOf(registry)?.throttle?.attempts ?? 0) >= 1,
    Date.now() + 60_000,
  );
  writeFileSync(readyPath, "ready\n", { mode: 0o600 });
  await pane;

  assert.ok(held.matched, `no secondary hold was recorded: ${JSON.stringify(transportOf(held.value))}`);
  const transport = transportOf(held.value);
  // The first step of the ladder, not a doubling from some other constant, and
  // not the flat minute the old law applied to every secondary limit alike.
  assert.ok(
    transport.cooldownUntil - transport.throttle.lastAt >= THROTTLE_LADDER_MS[0],
    `hold was ${transport.cooldownUntil - transport.throttle.lastAt}ms, expected at least ${THROTTLE_LADDER_MS[0]}`,
  );
  // One failure is not five, so the transport is held rather than paused: it
  // recovers on its own deadline without waiting for a person.
  assert.equal(transport.throttle.paused, false);
});

test("SEC-02 a permission failure holds neither the transport nor the ladder", async (t) => {
  const target = box(t, "permission");
  const readyPath = join(target.root, "permission-ready");
  const pane = runPane(target, {
    pane: "permission",
    // No rate-limit headers and no secondary marker. It looks like a limit to
    // anything keying off the status alone, and it is not one -- holding the
    // shared transport here would pause every pane over one repository the
    // user simply cannot read.
    failure: "Resource not accessible by personal access token (HTTP 403)",
    readyPath,
  });
  // `lastStartedAt` moving is the registry's own record that requests went out
  // through the shared permit, so the absence asserted below is a decision and
  // not merely an absence of activity. SEC-01 runs this same harness and
  // selector and does record a hold; the only difference is the message, which
  // is what makes the pair a test of classification rather than of plumbing.
  const observed = await observeUntil(
    target.readRegistry,
    (registry) => (transportOf(registry)?.lastStartedAt ?? 0) > 0,
    Date.now() + 60_000,
  );
  // Let the failing data call be released through the transport before quitting.
  await observeUntil(target.readRegistry, () => false, Date.now() + 4_000);
  const settled = (() => { try { return target.readRegistry(); } catch { return observed.value; } })();
  writeFileSync(readyPath, "ready\n", { mode: 0o600 });
  await pane;

  assert.ok(observed.matched, `the pane never started an HTTP request: ${JSON.stringify(observed.value)}`);
  const transport = transportOf(settled);
  assert.ok(transport, `no transport record was written: ${JSON.stringify(settled)}`);
  assert.equal(transport.cooldownUntil, 0, "a permission failure must not hold the shared transport");
  assert.equal(transport.throttle.attempts, 0, "a permission failure must not climb the throttle ladder");
});
