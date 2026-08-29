import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { capture, waitForAwk } from "./capture.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNS_PATH = "repos/acme/widget/actions/runs?exclude_pull_requests=true&per_page=20";
const WORKFLOWS_PATH = "repos/acme/widget/actions/workflows?page=1&per_page=100";

function fixture(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "gh-glance-conditional-pty-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const now = Date.now();
  const statePath = join(root, "fixture.json");
  writeFileSync(statePath, `${JSON.stringify({
    createdAt: now,
    core: { limit: 5000, used: 0, remaining: 5000, resetMs: now + 3_600_000 },
    graphql: { limit: 5000, used: 0, remaining: 5000, resetMs: now + 3_600_000 },
    events: [],
    ...overrides,
  })}\n`, { mode: 0o600 });
  return {
    root,
    statePath,
    read: () => JSON.parse(readFileSync(statePath, "utf8")),
    readGovernor: () => {
      const directory = join(root, "gh-glance");
      const name = readdirSync(directory).find((entry) => entry.startsWith("rate-governor-v1-"));
      return JSON.parse(readFileSync(join(directory, name), "utf8"));
    },
  };
}

function pathEvents(state, path, type = "start") {
  return state.events.filter((event) =>
    event.type === type && event.argv?.some((argument) => argument === path));
}

function isConditional(event) {
  return event.argv.some((argument) => /^If-None-Match:/i.test(argument));
}

function waitForActionsRuns(count) {
  return waitForAwk(
    '"$GH_GLANCE_CAPTURE_OUT.calls"',
    `index($0, "/actions/runs?") { count++ } END { if (count >= ${count}) ok=1 }`,
    400,
  );
}

function waitForNotModified(count = 2) {
  return waitForAwk(
    '"$GH_GLANCE_FIXTURE_STATE"',
    `{ copy=$0; if (gsub(/"status":304/, "", copy) >= ${count}) ok=1 }`,
    300,
  );
}

test("a quiet Actions tab spends nothing after its first fetch across three refresh cycles", (t) => {
  const box = fixture(t);
  const result = capture({
    cols: 80,
    rows: 24,
    signal: "none",
    settle: 30,
    stdin: waitForActionsRuns(4) + "sleep .3; printf q",
    args: "--repo acme/widget --refresh 5 --tab actions",
    configHome: box.root,
    env: {
      GH_GLANCE_CAPTURE_LIVE_FLUSH: "1",
      GH_GLANCE_FIXTURE_STATE: box.statePath,
    },
  });
  const state = box.read();
  const runs = pathEvents(state, RUNS_PATH);
  const workflows = pathEvents(state, WORKFLOWS_PATH);

  assert.ok(runs.length >= 4, `Actions runs calls: ${runs.length}`);
  assert.ok(workflows.length >= 4, `Actions workflows calls: ${workflows.length}`);
  assert.equal(runs[0].cost.core, 1);
  assert.equal(workflows[0].cost.core, 1);
  assert.ok(runs.slice(1).every((event) => event.cost.core === 0 && isConditional(event)));
  assert.ok(workflows.slice(1).every((event) => event.cost.core === 0 && isConditional(event)));
  assert.equal(state.core.used, 3);
  const governor = box.readGovernor();
  assert.equal(governor.budgets.core.used, state.core.used);
  assert.equal(governor.budgets.core.source, "response-header");
  assert.match(result.finalFrame.lines.join("\n"), /ci: pin actions to commit/);
});

test("a changed Actions runs entity returns 200 and publishes the new row", (t) => {
  const initial = readFileSync(join(HERE, "fixtures", "actions-runs.json"), "utf8");
  const changed = readFileSync(join(HERE, "fixtures", "actions-runs-expanded.json"), "utf8");
  const box = fixture(t, {
    apiEntities: {
      [RUNS_PATH]: {
        sequence: [
          { etag: '"runs-v1"', body: initial },
          { etag: '"runs-v2"', body: changed },
        ],
      },
    },
  });
  const result = capture({
    cols: 80,
    rows: 24,
    signal: "none",
    settle: 20,
    stdin: waitForAwk(
      '"$GH_GLANCE_CAPTURE_OUT"',
      'index($0, "new run one") { ok=1 }',
      250,
    ) + "sleep .3; printf q",
    args: "--repo acme/widget --refresh 5 --tab actions",
    configHome: box.root,
    env: {
      GH_GLANCE_CAPTURE_LIVE_FLUSH: "1",
      GH_GLANCE_FIXTURE_STATE: box.statePath,
    },
  });
  const state = box.read();
  const runs = pathEvents(state, RUNS_PATH);
  const endings = pathEvents(state, RUNS_PATH, "end");

  assert.ok(runs.length >= 2, `Actions runs calls: ${runs.length}`);
  assert.ok(isConditional(runs[1]));
  assert.deepEqual(endings.slice(0, 2).map((event) => event.status), [200, 200]);
  assert.deepEqual(runs.slice(0, 2).map((event) => event.cost.core), [1, 1]);
  assert.match(result.finalFrame.lines.join("\n"), /new run one/);
});

test("manual refresh drops If-None-Match on a quiet tab and spends again", (t) => {
  const box = fixture(t);
  const result = capture({
    cols: 80,
    rows: 24,
    signal: "none",
    settle: 20,
    stdin: waitForActionsRuns(2) + waitForNotModified() + "printf r; " +
      waitForActionsRuns(3) + "sleep .3; printf q",
    args: "--repo acme/widget --refresh 5 --tab actions",
    configHome: box.root,
    env: { GH_GLANCE_FIXTURE_STATE: box.statePath },
  });
  const state = box.read();
  const runs = pathEvents(state, RUNS_PATH);
  const workflows = pathEvents(state, WORKFLOWS_PATH);
  const forcedRuns = runs.filter((event) => !isConditional(event));
  const forcedWorkflows = workflows.filter((event) => !isConditional(event));
  const forcedEnd = pathEvents(state, RUNS_PATH, "end")
    .find((event) => event.sequence === forcedRuns.at(-1)?.sequence);

  assert.ok(runs.some(isConditional), "the tab never reached a conditional 304");
  assert.equal(forcedRuns.length, 2, "manual refresh kept the Actions runs ETag");
  assert.equal(forcedWorkflows.length, 2, "manual refresh kept the workflows ETag");
  assert.equal(forcedRuns.at(-1).cost.core, 1);
  assert.equal(forcedWorkflows.at(-1).cost.core, 1);
  assert.equal(forcedEnd?.status, 200);
  assert.equal(state.core.used, 5);
  assert.match(result.finalFrame.lines.join("\n"), /ci: pin actions to commit/);
});
