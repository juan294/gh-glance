import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { resourceReserve } from "../../index.mjs";
import { captureAsync } from "./capture.mjs";

// Pacing credit returns the difference between what a request reserved and what
// it actually spent. A conditional request answered 304 spends nothing, so it
// returns everything, and a sustained run of them is the shape that would expose
// a return that is too generous. Nothing else in the suite settles one: the
// single-pane conditional tests run three refresh cycles, and the twelve-pane
// tests spend real quota rather than 304s.
//
// The assertion with teeth is that charged spend stays inside its paced
// allowance: a return that gives back more than the request spent shows up as
// charged work outrunning its rate. Verified by breaking the return to refund
// the full reserved cost unconditionally, which takes spend to 20 units against
// a 13.3 allowance and fails this test.
//
// Capacity is deliberately scarce so pacing is the binding constraint. With a
// full hour of quota the paced rate exceeds anything four panes ask for, and the
// test measures nothing at all -- an earlier version of it passed against an
// implementation that refunded everything unconditionally.
const SPENDABLE = 200;
const WINDOW_MS = 600_000;
const UNITS_PER_MS = SPENDABLE / WINDOW_MS;
const SOAK_MS = 40_000;
const DATA_PATH = /\/actions\/(runs|workflows)/;
const RUNS_PATH = "repos/acme/widget/actions/runs?exclude_pull_requests=true&per_page=20";
const HERE = dirname(fileURLToPath(import.meta.url));

// Runs changes on every fetch and workflows never does, so one path is charged
// throughout while the other answers 304 after its first call. Both halves of
// the credit rule are then live in the same soak: a static fixture would let
// every pane settle into 304s, and charged spend would be capped by the number
// of first fetches rather than by pacing -- which is how an earlier version of
// this test passed against an implementation that refunded everything.
function changingRuns() {
  const body = readFileSync(join(HERE, "fixtures", "actions-runs.json"), "utf8");
  return { sequence: Array.from({ length: 200 }, (_, index) => ({ etag: `"runs-v${index}"`, body })) };
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "gh-glance-pacing-pty-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const now = Date.now();
  const statePath = join(root, "fixture.json");
  writeFileSync(statePath, `${JSON.stringify({
    createdAt: now,
    // 1200 remaining against a 1000 reserve leaves SPENDABLE over WINDOW_MS.
    // The window must outlast the soak: one that expires mid-run pauses every
    // pane waiting for a reset the fixture never delivers.
    core: { limit: 5000, used: 5000 - 1200, remaining: 1200, resetMs: now + WINDOW_MS },
    graphql: { limit: 5000, used: 0, remaining: 5000, resetMs: now + 3_600_000 },
    apiEntities: { [RUNS_PATH]: changingRuns() },
    events: [],
  })}\n`, { mode: 0o600 });
  return {
    root,
    statePath,
    startedAt: now,
    read: () => JSON.parse(readFileSync(statePath, "utf8")),
    readGovernor: () => {
      const directory = join(root, "gh-glance", "coordination-v2");
      const name = readdirSync(directory).find((entry) => /^quota-[a-f0-9]{64}\.json$/.test(entry));
      return JSON.parse(readFileSync(join(directory, name), "utf8"));
    },
  };
}

test("a sustained run of 304s returns pacing without letting charged work outrun it", async (t) => {
  const box = fixture(t);
  const readyPath = join(box.root, "soak-ready");
  const panes = Promise.all(Array.from({ length: 4 }, (_, index) => captureAsync({
    cols: 80,
    rows: 24,
    signal: "none",
    settle: 60,
    stdin:
      "i=0; while [ ! -f \"$GH_GLANCE_FIXTURE_READY\" ] && [ \"$i\" -lt 1500 ]; do " +
      "sleep .1; i=$((i + 1)); done; printf q",
    args: "--repo acme/widget --refresh 2 --tab actions",
    configHome: box.root,
    env: {
      GH_GLANCE_FIXTURE_STATE: box.statePath,
      GH_GLANCE_FIXTURE_PANE: `soak-${index}`,
      GH_GLANCE_FIXTURE_READY: readyPath,
    },
  })));

  await new Promise((resolve) => setTimeout(resolve, SOAK_MS));
  const state = box.read();
  const governor = box.readGovernor();
  writeFileSync(readyPath, "ready\n", { mode: 0o600 });
  await panes;

  const starts = state.events
    .filter((event) => event.type === "start" && event.argv[0] === "api")
    .sort((left, right) => left.at - right.at);
  const data = starts.filter((event) => event.argv.some((argument) => DATA_PATH.test(argument)));
  const conditional = data.filter((event) => event.argv.some((argument) => /^If-None-Match:/i.test(argument)));
  const elapsed = SOAK_MS;
  const allowance = elapsed * UNITS_PER_MS;
  const spent = state.core.used - (5000 - 1200);

  t.diagnostic(`spent=${spent} allowance=${allowance.toFixed(1)} data=${data.length} ` +
    `conditional=${conditional.length} elapsed=${elapsed}`);
  assert.ok(data.length >= 8, `the soak made too little data traffic to judge: ${data.length} calls`);
  assert.ok(conditional.length >= 2,
    `the soak never re-fetched an unchanged entity: ${conditional.length} conditional of ${data.length}`);
  assert.ok(spent >= 4, `the soak never sustained charged traffic: ${spent} units`);

  // Charged work stays inside its paced allowance. A return that gave back more
  // than the request spent would show up as spend outrunning the rate; the
  // tolerance is one operation's worth, because a grant is paced after it starts.
  assert.ok(spent <= allowance + 2,
    `charged spend outran its pacing: ${spent} units in ${elapsed}ms, allowance ${allowance.toFixed(1)}`);

  // What this test deliberately does NOT claim to catch: a return that never
  // happens. Removing the return entirely produces the same spend, the same
  // call count and the same conditional count as keeping it, measured both
  // ways -- throughput here is governed by the refresh cadence and the phase
  // spread as much as by the lane, and the difference does not surface. An
  // assertion worded as though it caught that would be decoration.
  //
  // The asymmetry is acceptable because the two directions are not equally
  // dangerous. Returning too little is the conservative failure: work is paced
  // more slowly than it needed to be, which is what the code did before pacing
  // credit existed. Returning too much is the one that spends into the reserve,
  // and that is the one asserted above.

  // Deliberately not asserted here: the interval between recorded starts. The
  // fixture stamps each call when its own process runs, which includes `gh`
  // spawn latency, so permits a clean 250ms apart can record 90ms apart when the
  // first spawn was slow and the second fast. That measures process startup
  // rather than the transport gap. ID-08 in identity-transport covers the shared
  // permit against the thing it actually guards.

  // The reserve is what pacing exists to protect, and the lane is a future
  // position rather than a backdated one.
  assert.ok(governor.budgets.core.remaining > resourceReserve(governor.budgets.core.limit),
    `core fell into its reserve: ${governor.budgets.core.remaining}`);
  assert.ok(governor.budgets.core.laneNextAt >= box.startedAt,
    `the lane was pulled behind the run: ${governor.budgets.core.laneNextAt - box.startedAt}ms`);
});
