import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { captureAsync } from "./capture.mjs";

test("a slow background response cannot block active Actions publication", { timeout: 90_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gh-glance-background-progress-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const statePath = join(root, "fixture.json");
  const now = Date.now();
  const resource = () => ({ limit: 5000, used: 0, remaining: 5000, resetMs: now + 3_600_000 });
  writeFileSync(statePath, JSON.stringify({ createdAt: now, core: resource(), graphql: resource(),
    apiEntities: { "repos/acme/widget/actions/runs?exclude_pull_requests=true&per_page=60": {
      sequence: [{ etag: '"running"', body: readFileSync(new URL("./fixtures/actions-runs-running.json", import.meta.url), "utf8") }],
    } },
    delayMs: 100, delayByCommand: { "graphql-data": 20_000 }, events: [] }));
  const observations = [];
  const directory = join(root, "gh-glance/coordination-v2");
  const sampler = setInterval(() => {
    try {
      const state = JSON.parse(readFileSync(join(directory, "acquisition.json"), "utf8"));
      const actions = Object.values(state.queries).find((row) => row.query.resource === "actions");
      if (actions?.snapshot) observations.push(actions.snapshot.lastSuccessAt);
    } catch { /* setup has not created acquisition state yet */ }
  }, 100);
  let result;
  try {
    result = await captureAsync({ cols: 100, rows: 28, signal: "none", settle: 70,
      stdin: "sleep 70; printf q", args: "--repo acme/widget --refresh 2 --background all", configHome: root,
      env: { GH_GLANCE_FIXTURE_STATE: statePath } });
  } finally { clearInterval(sampler); }
  assert.equal(result.exitCode, 0);
  assert.equal(result.altEnter, 1);
  assert.equal(result.altExit, 1);
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  if (process.env.GH_GLANCE_TEST_EVIDENCE) {
    mkdirSync(process.env.GH_GLANCE_TEST_EVIDENCE, { recursive: true });
    writeFileSync(join(process.env.GH_GLANCE_TEST_EVIDENCE, "background-state.json"), JSON.stringify({ state, observations, raw: result.raw }, null, 2));
  }
  const starts = state.events.filter((event) => event.type === "start" && event.argv[0] === "api");
  const ends = new Map(state.events.filter((event) => event.type === "end").map((event) => [event.sequence, event]));
  const issues = starts.find((event) => event.graphqlOperation === "issues.page");
  assert.ok(issues && ends.has(issues.sequence), "slow background Issues request did not complete");
  const end = ends.get(issues.sequence);
  assert.ok(end.at - issues.at >= 19_000, "fixture did not keep the background transport open");
  assert.ok(observations.some((at) => at > issues.at + 1_000 && at < end.at),
    "Actions source never advanced while the background response was pending");
  for (const start of starts) {
    const overlap = starts.filter((other) => other.at <= start.at && ends.get(other.sequence)?.at > start.at);
    assert.ok(overlap.length <= 3, "normal HTTP concurrency exceeded three");
    const query = start.graphqlOperation ?? start.argv[2];
    assert.ok(overlap.filter((other) => (other.graphqlOperation ?? other.argv[2]) === query).length <= 1,
      "one query dispatched duplicate concurrent transports");
  }
  for (const name of readdirSync(directory).filter((name) => name.endsWith(".recovery.json"))) {
    const journal = JSON.parse(readFileSync(join(directory, name), "utf8"));
    assert.equal(journal.entries.some((event) => event.code === "clock-recovery"), false,
      "awaited HTTP was mistaken for a clock discontinuity");
  }
});
