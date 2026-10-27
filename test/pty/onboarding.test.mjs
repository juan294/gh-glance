import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { capture, waitForAwk } from "./capture.mjs";

const RUNS = "repos/acme/widget/actions/runs?exclude_pull_requests=true&per_page=60";
function fixture(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "gh-glance-onboarding-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const statePath = join(root, "fixture.json");
  const now = Date.now();
  writeFileSync(statePath, JSON.stringify({ createdAt: now,
    core: { limit: 5000, remaining: 5000, used: 0, resetMs: now + 3600000 },
    graphql: { limit: 5000, remaining: 5000, used: 0, resetMs: now + 3600000 }, events: [],
    apiEntities: { [RUNS]: { body: "[]" } }, ...overrides }));
  return { root, statePath };
}
const waitFor = (message) => waitForAwk('"$GH_GLANCE_CAPTURE_OUT"', `index($0, "${message}") { ok=1 }`, 180);
for (const [cols, rows] of [24, 45, 80, 120].flatMap((cols) => [10, 24].map((rows) => [cols, rows]))) {
  test(`CX-01/03/12/13: empty Actions is tableless at ${cols}x${rows}`, (t) => {
    const box = fixture(t, { delayByCommand: { actions: 500 },
      apiEntities: { [RUNS]: { body: "[]" } } });
    const result = capture({ cols, rows, signal: "none", settle: 25,
      stdin: waitFor("No workflow runs") + "sleep .3; printf w; sleep .2; printf q",
      args: "--repo acme/widget", configHome: box.root,
      env: { GH_GLANCE_FIXTURE_STATE: box.statePath, GH_GLANCE_CAPTURE_LIVE_FLUSH: "1", NO_COLOR: "1" } });
    const screen = result.finalFrame.lines.join("\n");
    assert.match(screen, /No workflow runs/);
    if (cols === 80 && rows === 24) assert.match(result.raw, /Waiting to check Actions/);
    if (process.env.GH_GLANCE_ONBOARDING_CAPTURES &&
        [[24, 10], [45, 24], [80, 24]].some(([c, r]) => c === cols && r === rows)) {
      writeFileSync(join(process.env.GH_GLANCE_ONBOARDING_CAPTURES, `${cols}x${rows}.txt`), screen);
    }
    assert.doesNotMatch(screen, /WORKFLOW|BRANCH|0 of 0|Width:|too narrow|Adjust/);
    assert.match(screen, /[Rr]efresh|\br\b/);
    assert.match(screen, /Quit|\bq\b/);
    assert.ok(result.finalFrame.widest <= cols);
    assert.ok(result.finalFrame.lines.length < rows);
    assert.equal(result.exitCode, 0);
    const state = JSON.parse(readFileSync(box.statePath));
    assert.equal(state.events.filter((event) => event.type === "start" &&
      event.argv?.some((arg) => arg.includes("/actions/workflows?"))).length, 0);
  });
}

test("CX-05/11: failed Actions load recovers to rows through explicit refresh", (t) => {
  const box = fixture(t, { apiEntities: {},
    failure: { selector: "actions", remaining: 1, message: "HTTP 403: Resource not accessible by integration" } });
  const result = capture({ cols: 80, rows: 24, signal: "none", settle: 30,
    stdin: waitFor("Could not load Actions") + "printf R; " + waitFor("ci: pin actions") + "printf q",
    args: "--repo acme/widget", configHome: box.root,
    env: { GH_GLANCE_FIXTURE_STATE: box.statePath, GH_GLANCE_CAPTURE_LIVE_FLUSH: "1" } });
  assert.match(result.raw, /Could not load Actions/);
  assert.match(result.finalFrame.lines.join("\n"), /ci: pin actions/);
  assert.doesNotMatch(result.finalFrame.lines.join("\n"), /Could not load|authorization failed/);
});

test("CX-03/10/13: reader output explains an empty Security result without clearance", (t) => {
  const box = fixture(t);
  const result = capture({ cols: 80, rows: 24, signal: "none", settle: 25,
    stdin: waitFor("checked sources") + "sleep .3; printf q",
    args: "--repo acme/widget --tab security --background off", configHome: box.root,
    env: { GH_GLANCE_FIXTURE_STATE: box.statePath, GH_GLANCE_CAPTURE_LIVE_FLUSH: "1",
      INK_SCREEN_READER: "true", NO_COLOR: "1" } });
  assert.match(result.raw, /No alerts returned by the checked sources/);
  assert.doesNotMatch(result.raw, /all clear|repository is secure|0 of 0/);
  assert.equal(result.exitCode, 0);
});

test("CX-11/13: a table disappearing during width mode releases its keys and returns", (t) => {
  const runs = readFileSync(new URL("./fixtures/actions-runs.json", import.meta.url), "utf8");
  const expanded = readFileSync(new URL("./fixtures/actions-runs-expanded.json", import.meta.url), "utf8");
  const box = fixture(t, { apiEntities: { [RUNS]: { sequence: [
    { etag: '"runs"', body: runs }, { etag: '"empty"', body: "[]" },
    { etag: '"expanded"', body: expanded },
  ] } } });
  const result = capture({ cols: 80, rows: 24, signal: "none", settle: 40,
    stdin: waitFor("ci: pin actions") + "printf w; " + waitFor("No workflow runs") +
      "printf R; " + waitFor("new run one") + "printf q",
    args: "--repo acme/widget --refresh 5 --background off", configHome: box.root,
    env: { GH_GLANCE_FIXTURE_STATE: box.statePath, GH_GLANCE_CAPTURE_LIVE_FLUSH: "1" } });
  assert.match(result.raw, /Width: WORKFLOW/);
  assert.match(result.raw, /No workflow runs found/);
  assert.match(result.finalFrame.lines.join("\n"), /new run one/);
  assert.doesNotMatch(result.finalFrame.lines.join("\n"), /Tab select|resize.*reset/);
  assert.equal(result.exitCode, 0);
});

test("CX-06/11: cached empty failure retains its source time then fresh success clears failure", (t) => {
  const box = fixture(t);
  const sourceExpression = 'Object.values(JSON.parse(fs.readFileSync(process.env.XDG_CONFIG_HOME + "/gh-glance/dashboard-cache.json", "utf8")).targets).find(entry => entry.tabs.actions).tabs.actions.lastOk';
  const waitForNode = (code) => {
    const script = `try { const fs = require("node:fs"); ${code} } catch {} process.exit(1);`;
    return `i=0; while ! node -e '${script}' && [ $i -lt 600 ]; do i=$((i + 1)); sleep .1; done; `;
  };
  const options = { cols: 80, rows: 24, signal: "none", settle: 90,
    args: "--repo acme/widget --refresh 300 --background off", configHome: box.root,
    env: { GH_GLANCE_FIXTURE_STATE: box.statePath, GH_GLANCE_CAPTURE_LIVE_FLUSH: "1" } };
  const warm = capture({ ...options, stdin: waitFor("No workflow runs") + "sleep .7; printf q" });
  assert.match(warm.finalFrame.lines.join("\n"), /Checked/);
  const readSource = () => Object.values(JSON.parse(readFileSync(
    join(box.root, "gh-glance", "dashboard-cache.json"), "utf8")).targets)
    .find((entry) => entry.tabs.actions).tabs.actions.lastOk;
  const warmSource = readSource();
  const state = JSON.parse(readFileSync(box.statePath));
  const warmSequence = Math.max(...state.events.map((event) => event.sequence));
  // Startup may check before the forced request. Keep failure active until the
  // failed-source checkpoint explicitly releases it for the recovery request.
  state.failure = { selector: "actions", remaining: 10,
    message: "HTTP 403: Resource not accessible by integration" };
  writeFileSync(box.statePath, JSON.stringify(state));
  const failedCheckpoint = join(box.root, "failed-lastOk");
  const releaseCheckpoint = join(box.root, "released-after");
  const checkpointScript = `
    const path = process.env.GH_GLANCE_FIXTURE_STATE;
    const lock = path + ".lock";
    const owner = { pid: process.pid, nonce: require("node:crypto").randomUUID() };
    const candidate = lock + ".candidate-" + owner.nonce;
    fs.writeFileSync(candidate, JSON.stringify(owner), { flag: "wx", mode: 0o600 });
    try { fs.linkSync(candidate, lock); } finally { fs.rmSync(candidate); }
    try {
      const state = JSON.parse(fs.readFileSync(path, "utf8"));
      const requests = state.events.filter(e => e.sequence > ${warmSequence} && e.argv.includes("${RUNS}"));
      const ended = requests.filter(e => e.type === "end");
      if (!ended.length || ended.some(e => !e.failed) ||
          requests.some(e => e.type === "start" && !ended.some(done => done.sequence === e.sequence))) {
        throw new Error("Failure has not settled");
      }
      fs.writeFileSync(process.env.XDG_CONFIG_HOME + "/failed-lastOk", String(${sourceExpression}));
      fs.writeFileSync(process.env.XDG_CONFIG_HOME + "/released-after", String(Math.max(...ended.map(e => e.sequence))));
      state.failure.remaining = 0;
      const temporary = path + ".checkpoint-" + owner.nonce;
      fs.writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
      fs.renameSync(temporary, path);
    } finally { fs.rmSync(lock); }
    process.exit(0);`;
  const result = capture({ ...options,
    stdin: waitFor("No workflow runs") + "printf R; " + waitFor("Could not refresh Actions") +
      waitForNode(checkpointScript) + "printf R; " +
      waitForNode(`const {events} = JSON.parse(fs.readFileSync(process.env.GH_GLANCE_FIXTURE_STATE, "utf8"));
        const failed = events.findLast(e => e.type === "end" && e.failed && e.argv.includes("${RUNS}"));
        if (failed && events.some(e => e.type === "end" && e.failed === false && e.sequence > failed.sequence && e.argv.includes("${RUNS}"))) process.exit(0);`) +
      waitForNode(`const raw = fs.readFileSync(process.env.GH_GLANCE_CAPTURE_OUT, "utf8");
        if (raw.lastIndexOf("No workflow runs found") > raw.lastIndexOf("Could not refresh Actions") && ${sourceExpression} > ${warmSource}) process.exit(0);`) + "printf q" });
  assert.equal(Number(readFileSync(failedCheckpoint, "utf8")), warmSource,
    "failed request changed the original source timestamp");
  assert.ok(readSource() > warmSource, "successful recovery did not publish a new source timestamp");
  const events = JSON.parse(readFileSync(box.statePath)).events;
  const releasedAfter = Number(readFileSync(releaseCheckpoint, "utf8"));
  const beforeRelease = events.filter((event) => event.type === "end" && event.argv.includes(RUNS) &&
    event.sequence > warmSequence && event.sequence <= releasedAfter);
  assert.ok(beforeRelease.length > 0 && beforeRelease.every((event) => event.failed),
    "a source request succeeded before the failed-source checkpoint released recovery");
  const failed = events.findLast((event) => event.type === "end" && event.failed && event.argv.includes(RUNS));
  assert.ok(failed && events.some((event) => event.type === "end" && event.failed === false &&
    event.sequence > failed.sequence && event.argv.includes(RUNS)), "no successful source request followed the failed request");
  assert.match(result.raw, /Could not refresh Actions/);
  assert.match(result.raw, /Last check found no workflow runs/);
  assert.match(result.finalFrame.lines.join("\n"), /No workflow runs found/);
  assert.doesNotMatch(result.finalFrame.lines.join("\n"), /Could not refresh|authorization failed/);
  assert.equal(result.exitCode, 0);
});

test("CX-10/11: incomplete Security coverage clears after a successful source retry", (t) => {
  const box = fixture(t, { failure: { selector: "security", remaining: 1,
    message: "HTTP 404: Not Found" } });
  const result = capture({ cols: 80, rows: 24, signal: "none", settle: 60,
    stdin: waitFor("not enabled") + "printf R; " + waitForAwk('"$GH_GLANCE_CAPTURE_OUT.calls"',
      'index($0, "dependabot/alerts") { n++ } END { if (n >= 2) ok=1 }', 500) + "sleep 1; printf q",
    args: "--repo acme/widget --tab security --background off", configHome: box.root,
    env: { GH_GLANCE_FIXTURE_STATE: box.statePath, GH_GLANCE_CAPTURE_LIVE_FLUSH: "1" } });
  assert.match(result.raw, /not enabled/);
  assert.match(result.finalFrame.lines.join("\n"), /No alerts returned by the checked sources/);
  assert.doesNotMatch(result.finalFrame.lines.join("\n"), /not enabled|unavailable/);
  assert.equal(result.exitCode, 0);
});

test("CX-13/14: 24x10 failed load keeps the login remedy and quit/refresh", (t) => {
  const box = fixture(t, { failure: { selector: "actions", remaining: 10,
    message: "HTTP 401: Bad credentials" } });
  const result = capture({ cols: 24, rows: 10, signal: "none", settle: 25,
    stdin: waitFor("Could not load") + "sleep .2; printf q",
    args: "--repo acme/widget", configHome: box.root,
    env: { GH_GLANCE_FIXTURE_STATE: box.statePath, GH_GLANCE_CAPTURE_LIVE_FLUSH: "1", NO_COLOR: "1" } });
  const screen = result.finalFrame.lines.join("\n");
  assert.match(screen, /Could not load/);
  assert.match(screen, /gh auth status/);
  assert.match(screen, /Refresh|\br\b/);
  assert.match(screen, /Quit|\bq\b/);
  assert.ok(result.finalFrame.lines.length < 10);
  assert.equal(result.exitCode, 0);
});

test("CX-13: a live narrow-to-wide resize restores the full empty-state explanation", (t) => {
  const box = fixture(t);
  const result = capture({ cols: 24, rows: 10, resize: { cols: 80, rows: 24, afterSeconds: 8 },
    signal: "none", settle: 25, stdin: waitFor("matching trigger") + "sleep .2; printf q",
    args: "--repo acme/widget", configHome: box.root,
    env: { GH_GLANCE_FIXTURE_STATE: box.statePath, GH_GLANCE_CAPTURE_LIVE_FLUSH: "1" } });
  assert.match(result.raw, /No workflow runs/);
  assert.match(result.finalFrame.lines.join("\n"), /matching trigger/);
  assert.doesNotMatch(result.finalFrame.lines.join("\n"), /too narrow|0 of 0|WORKFLOW/);
  assert.equal(result.exitCode, 0);
});

test("CX-13/14: a one-row populated notice retains the required authorization remedy", (t) => {
  const box = fixture(t, { apiEntities: {} });
  const options = { cols: 80, rows: 10, signal: "none", settle: 30,
    args: "--repo acme/widget --refresh 300 --background off", configHome: box.root,
    env: { GH_GLANCE_FIXTURE_STATE: box.statePath, GH_GLANCE_CAPTURE_LIVE_FLUSH: "1" } };
  capture({ ...options, stdin: waitFor("ci: pin actions") + "sleep .7; printf q" });
  const state = JSON.parse(readFileSync(box.statePath));
  const warmSequence = Math.max(...state.events.map((event) => event.sequence));
  // This case needs a sustained failure, whether startup or the explicit refresh
  // reaches the source first. It must not recover before the layout assertion.
  state.failure = { selector: "actions", remaining: 10, message: "HTTP 401: Bad credentials" };
  writeFileSync(box.statePath, JSON.stringify(state));
  const result = capture({ ...options,
    stdin: waitFor("ci: pin actions") + "printf R; " + waitFor("Failed") +
      waitFor("Run gh auth status") + "sleep 3; printf q" });
  const failedRequests = JSON.parse(readFileSync(box.statePath)).events.filter((event) =>
    event.type === "end" && event.sequence > warmSequence && event.argv.includes(RUNS));
  assert.ok(failedRequests.length > 0 && failedRequests.every((event) => event.failed),
    "the sustained authorization fixture recovered before the layout assertion");
  const screen = result.finalFrame.lines.join("\n");
  assert.match(screen, /Run gh auth status/);
  assert.match(screen, /ci: pin actions/);
  assert.match(screen, /Failed/);
  assert.equal(result.finalFrame.lines.length, 9);
  assert.equal(result.exitCode, 0);
});


for (const [name, selector, message, expected, forbidden] of [
  ["all disabled", "api-data", "HTTP 404: Not Found", /No alert sources available/, /checked sources|returned no alerts|Saved Security view/],
  ["partially disabled", "dependabot", "HTTP 404: Not Found", /No alerts returned by the checked sources/, /No alert sources available/],
  ["partially failed", "dependabot", "dial tcp: fixture source unavailable", /fixture source unavailable/, /No alert sources available/],
]) {
  test(`P1-F08: Security ${name} reflects actual source coverage`, (t) => {
    const root = mkdtempSync(join(tmpdir(), "gh-glance-security-coverage-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const result = capture({ cols: 100, rows: 24, signal: "none", settle: 30,
      stdin: waitFor(message.includes("404") ? "not enabled" : "fixture source unavailable") + "sleep .5; printf q",
      args: `--repo acme/widget --tab security${name === "all disabled" ? "" : " --background off"}`,
      configHome: root,
      env: { GH_GLANCE_CAPTURE_LIVE_FLUSH: "1", NO_COLOR: "1",
        GH_GLANCE_FIXTURE_FAIL: message, GH_GLANCE_FIXTURE_FAIL_ON: selector } });
    const screen = result.finalFrame.lines.join("\n");
    assert.match(screen, expected);
    assert.doesNotMatch(screen, forbidden);
    for (const endpoint of ["dependabot/alerts", "code-scanning/alerts", "secret-scanning/alerts"]) {
      assert.ok(result.fixtureCalls.some((call) => call.includes(endpoint)), `${endpoint} was never checked`);
    }
    assert.equal(result.exitCode, 0);
  });
}

test("P1-F09: a future source clock renders Cached without a fabricated footer age", (t) => {
  const box = fixture(t);
  const options = { cols: 100, rows: 24, signal: "none", settle: 30,
    args: "--repo acme/widget --tab security", configHome: box.root,
    env: { GH_GLANCE_FIXTURE_STATE: box.statePath, GH_GLANCE_CAPTURE_LIVE_FLUSH: "1", NO_COLOR: "1" } };
  const warm = capture({ ...options, stdin: waitFor("Cached") +
    waitForAwk('"$XDG_CONFIG_HOME/gh-glance/dashboard-cache.json"', '/"security"/ { ok=1 }', 180) + "printf q" });
  assert.equal(warm.exitCode, 0);

  // Advance only the saved source clocks. Moving the whole process clock
  // backward correctly triggers Paused recovery, which is a different case.
  const future = Date.now() + 3_600_000;
  const storePath = join(box.root, "gh-glance/coordination-v2/acquisition.json");
  const store = JSON.parse(readFileSync(storePath, "utf8"));
  const record = Object.values(store.queries).find((entry) => entry.query.resource === "security");
  assert.ok(record?.snapshot, "warm Security observation did not persist a snapshot");
  const snapshotRoot = `${storePath}.snapshots`;
  const snapshot = JSON.parse(readFileSync(join(snapshotRoot, record.snapshot.artifact), "utf8"));
  snapshot.lastSuccessAt = snapshot.lastChangedAt = snapshot.meta.at = future;
  snapshot.nextDueAt = future + 300_000;
  const raw = JSON.stringify(snapshot);
  const digest = createHash("sha256").update(raw).digest("hex");
  const artifact = `${record.query.queryKey}.${record.generation}.${digest}.json`;
  writeFileSync(join(snapshotRoot, artifact), raw);
  record.snapshot = { ...record.snapshot, artifact, digest, bytes: Buffer.byteLength(raw),
    lastSuccessAt: future, lastChangedAt: future, nextDueAt: snapshot.nextDueAt };
  writeFileSync(storePath, JSON.stringify(store));
  const cachePath = join(box.root, "gh-glance/dashboard-cache.json");
  const cache = JSON.parse(readFileSync(cachePath, "utf8"));
  for (const entry of Object.values(cache.targets)) {
    if (entry.tabs.security) entry.tabs.security.lastOk = entry.tabs.security.meta.at = future;
  }
  writeFileSync(cachePath, JSON.stringify(cache));
  const result = capture({ ...options,
    stdin: waitFor("Last-check time unavailable") + waitFor("Cached") + "printf q" });
  assert.equal(JSON.parse(readFileSync(storePath, "utf8"))
    .queries[record.query.queryKey]?.snapshot?.lastSuccessAt, future,
  "restart replaced the future source observation");
  const screen = result.finalFrame.lines.join("\n");
  assert.match(screen, /Last-check time unavailable/);
  const footer = result.finalFrame.lines.find((line) => /^[^\s│] Cached/.test(line));
  assert.ok(footer, "expected a real Cached footer after successful on-demand observation");
  assert.doesNotMatch(footer, /Cached\s+\d|0s|just now/);
  assert.equal(result.exitCode, 0);
});
