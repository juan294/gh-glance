import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  GITHUB_STATUS_URL,
  GITHUB_STATUS_MAX_BYTES,
  githubStatusConfig,
  fetchGitHubStatus,
  githubStatusLine,
  createGitHubStatusMonitor,
  createNotificationLog,
} from "../index.mjs";

const run = promisify(execFile);

test("githubStatusConfig: default, off, URL override, invalid value and other hosts", () => {
  assert.deepEqual(githubStatusConfig({}, null), { enabled: true, url: GITHUB_STATUS_URL, reason: null });
  assert.equal(GITHUB_STATUS_URL, "https://www.githubstatus.com/api/v2/summary.json");
  assert.deepEqual(githubStatusConfig({}, "github.com"), { enabled: true, url: GITHUB_STATUS_URL, reason: null });
  for (const value of ["off", "0", "OFF"]) {
    const config = githubStatusConfig({ GH_GLANCE_GITHUB_STATUS: value }, "github.com");
    assert.equal(config.enabled, false, value);
    assert.match(config.reason, /GitHub status checks off \(GH_GLANCE_GITHUB_STATUS\)/);
  }
  assert.deepEqual(githubStatusConfig({ GH_GLANCE_GITHUB_STATUS: "http://127.0.0.1:9/summary.json" }, null),
    { enabled: true, url: "http://127.0.0.1:9/summary.json", reason: null });
  const invalid = githubStatusConfig({ GH_GLANCE_GITHUB_STATUS: "sometimes" }, null);
  assert.equal(invalid.enabled, false);
  assert.match(invalid.reason, /GH_GLANCE_GITHUB_STATUS value not recognised/);
  const ftp = githubStatusConfig({ GH_GLANCE_GITHUB_STATUS: "ftp://example.com/x" }, null);
  assert.equal(ftp.enabled, false);
  const ghes = githubStatusConfig({}, "github.example.com");
  assert.equal(ghes.enabled, false);
  assert.equal(ghes.reason, "GitHub status not checked for github.example.com");
});

const summary = (patch = {}) => ({
  page: { id: "x", name: "GitHub", url: "https://www.githubstatus.com" },
  status: { indicator: "none", description: "All Systems Operational" },
  components: [
    { name: "Git Operations", status: "operational" },
    { name: "API Requests", status: "operational" },
    { name: "Actions", status: "operational" },
    { name: "Copilot", status: "major_outage" },
  ],
  incidents: [],
  scheduled_maintenances: [],
  ...patch,
});

const response = (status, body, headers = {}) => new Response(
  status === 304 ? null : typeof body === "string" ? body : JSON.stringify(body),
  { status, headers: { "content-type": "application/json", ...headers } },
);

test("fetchGitHubStatus: operational summary keeps tracked components only", async () => {
  const result = await fetchGitHubStatus({ url: GITHUB_STATUS_URL,
    fetchImpl: async () => response(200, summary(), { etag: 'W/"abc"' }) });
  assert.equal(result.status, "ok");
  assert.equal(result.etag, 'W/"abc"');
  assert.deepEqual(result.summary.components.map((component) => component.name),
    ["Git Operations", "API Requests", "Actions"]);
  assert.deepEqual(result.summary.incidents, []);
  assert.equal(githubStatusLine({ enabled: true, summary: result.summary }), "GitHub status: All systems operational");
});

test("fetchGitHubStatus: sends the validator and reuses on 304", async () => {
  let seen = null;
  const result = await fetchGitHubStatus({ url: GITHUB_STATUS_URL, etag: 'W/"abc"',
    fetchImpl: async (_url, init) => { seen = init.headers["if-none-match"]; return response(304); } });
  assert.equal(seen, 'W/"abc"');
  assert.equal(result.status, "not-modified");
});

test("fetchGitHubStatus: incidents touching tracked components, missing fields and control characters", async () => {
  const body = summary({
    components: [{ name: "Actions", status: "partial_outage" }, { name: "Issues", status: "degraded_performance" }],
    incidents: [
      { id: "i1", name: "Disruption with \u001b[2JActions", status: "investigating", impact: "major",
        updated_at: "2026-11-02T08:00:00Z", components: [{ name: "Actions" }] },
      { id: "i2", name: "Copilot is slow", status: "investigating", impact: "minor", components: [{ name: "Copilot" }] },
      { id: "i3" },
    ],
  });
  const result = await fetchGitHubStatus({ url: GITHUB_STATUS_URL, fetchImpl: async () => response(200, body) });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.summary.incidents.map((incident) => incident.id), ["i1", "i3"]);
  const [first, unnamed] = result.summary.incidents;
  assert.equal(first.name.includes("\u001b"), false);
  assert.equal(first.impact, "major");
  assert.equal(unnamed.name, "Unnamed incident");
  const line = githubStatusLine({ enabled: true, summary: result.summary });
  assert.match(line, /^GitHub incident: Disruption with/);
  assert.match(line, /\(\+1 more\)$/);
  assert.equal(githubStatusLine({ enabled: true, summary: { incidents: [], components: result.summary.components } }),
    "GitHub: Actions partial outage, Issues degraded performance");
});

test("fetchGitHubStatus: every failure is unavailable", async () => {
  const cases = {
    "server error": async () => response(500, "oops"),
    "bad json": async () => response(200, "{not json"),
    "bad shape": async () => response(200, { components: "x" }),
    network: async () => { throw new TypeError("fetch failed"); },
    oversize: async () => response(200, `{"components":[],"incidents":[],"pad":"${"x".repeat(300 * 1024)}"}`),
    "declared oversize": async () => response(200, "{}", { "content-length": String(300 * 1024) }),
  };
  assert.equal(GITHUB_STATUS_MAX_BYTES, 256 * 1024);
  for (const [name, fetchImpl] of Object.entries(cases)) {
    const result = await fetchGitHubStatus({ url: GITHUB_STATUS_URL, fetchImpl });
    assert.equal(result.status, "unavailable", name);
  }
});

test("fetchGitHubStatus: a slow server times out", async () => {
  const result = await fetchGitHubStatus({ url: GITHUB_STATUS_URL, timeoutMs: 30,
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason));
    }) });
  assert.equal(result.status, "unavailable");
});

function fakeClock(start = 1_000_000) {
  let at = start;
  const timers = new Map();
  let next = 1;
  return {
    now: () => at,
    setTimer: (fn, ms) => { const id = next++; timers.set(id, { fn, due: at + ms }); return id; },
    clearTimer: (id) => timers.delete(id),
    pending: () => [...timers.values()].map((timer) => timer.due - at).sort((a, b) => a - b),
    async advance(ms) {
      at += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.due <= at) { timers.delete(id); await timer.fn(); }
      }
    },
  };
}

test("monitor: first check, 10-minute cadence, 15-minute backoff, checkNow limit and stop", async () => {
  const clock = fakeClock();
  let calls = 0;
  let fail = false;
  const fetchImpl = async () => { calls += 1; return fail ? response(503, "") : response(200, summary()); };
  const log = createNotificationLog({ now: clock.now });
  const monitor = createGitHubStatusMonitor({ config: githubStatusConfig({}, null), fetchImpl, log,
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  await monitor.ready;
  assert.equal(calls, 1);
  assert.equal(monitor.current().unavailable, false);
  assert.ok(monitor.current().summary);
  assert.deepEqual(clock.pending(), [600_000]);
  assert.equal(await monitor.checkNow(), false, "within 60 s of the last check");
  assert.equal(calls, 1);
  await clock.advance(600_000);
  assert.equal(calls, 2);
  fail = true;
  await clock.advance(61_000);
  assert.equal(await monitor.checkNow(), true);
  assert.equal(calls, 3);
  assert.equal(monitor.current().unavailable, true);
  assert.deepEqual(clock.pending(), [900_000]);
  assert.match(githubStatusLine(monitor.current(), clock.now()), /^GitHub status unavailable; next check \d\d:\d\d$/);
  // One info entry per unavailable episode.
  await clock.advance(900_000);
  assert.equal(log.list().filter((entry) => entry.key === "github:unavailable").length, 1);
  monitor.stop();
  assert.deepEqual(clock.pending(), []);
  assert.equal(await monitor.checkNow(), false);
});

test("monitor: incidents and outages begin, update and resolve in the log", async () => {
  const clock = fakeClock();
  let body = summary();
  const log = createNotificationLog({ now: clock.now });
  let changes = 0;
  const monitor = createGitHubStatusMonitor({ config: githubStatusConfig({}, null),
    fetchImpl: async () => response(200, body), log, now: clock.now, setTimer: clock.setTimer,
    clearTimer: clock.clearTimer, onChange: () => { changes += 1; } });
  await monitor.ready;
  assert.equal(monitor.current().outage, false);
  body = summary({
    components: [{ name: "Actions", status: "major_outage" }],
    incidents: [{ id: "i1", name: "Actions delayed", status: "investigating", impact: "major",
      components: [{ name: "Actions" }] }],
  });
  await clock.advance(600_000);
  assert.equal(monitor.current().outage, true);
  assert.deepEqual(log.list().map((entry) => [entry.key, entry.level]), [
    ["github:component:Actions", "problem"],
    ["github:incident:i1", "problem"],
  ]);
  assert.equal(log.summary().tone, "red");
  body = summary({
    components: [{ name: "Actions", status: "major_outage" }],
    incidents: [{ id: "i1", name: "Actions delayed", status: "identified", impact: "major",
      components: [{ name: "Actions" }] }],
  });
  await clock.advance(600_000);
  // An update coalesces into the open incident entry instead of opening another.
  assert.equal(log.list()[0].key, "github:incident:i1");
  assert.match(log.list()[0].text, /identified/);
  assert.equal(log.list().filter((entry) => entry.key === "github:incident:i1").length, 1);
  body = summary();
  await clock.advance(600_000);
  assert.equal(monitor.current().outage, false);
  const cleared = log.list().filter((entry) => /:cleared$/.test(entry.key)).map((entry) => entry.key).sort();
  assert.deepEqual(cleared, ["github:component:Actions:cleared", "github:incident:i1:cleared"]);
  assert.ok(changes >= 3);
  monitor.stop();
});

test("monitor: a 304 after an unavailable check restores the last good summary", async () => {
  const clock = fakeClock();
  const replies = [() => response(200, summary(), { etag: 'W/"1"' }), () => response(503, ""), () => response(304)];
  const validators = [];
  const log = createNotificationLog({ now: clock.now });
  const monitor = createGitHubStatusMonitor({ config: githubStatusConfig({}, null), log,
    fetchImpl: async (_url, init) => { validators.push(init.headers["if-none-match"] ?? null); return replies.shift()(); },
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  await monitor.ready;
  await clock.advance(600_000);
  assert.match(githubStatusLine(monitor.current(), clock.now()), /unavailable/);
  await clock.advance(900_000);
  assert.deepEqual(validators, [null, 'W/"1"', 'W/"1"']);
  assert.equal(githubStatusLine(monitor.current(), clock.now()), "GitHub status: All systems operational");
  const [episode] = log.list();
  assert.equal(episode.key, "github:unavailable");
  assert.notEqual(episode.endedAt, null);
  monitor.stop();
});

test("monitor: stop() during a fetch aborts it and records nothing", async () => {
  const clock = fakeClock();
  let aborted = false;
  let changes = 0;
  const log = createNotificationLog({ now: clock.now });
  const monitor = createGitHubStatusMonitor({ config: githubStatusConfig({}, null), log,
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => { aborted = true; reject(init.signal.reason); });
    }),
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, onChange: () => { changes += 1; } });
  monitor.stop();
  await monitor.ready;
  assert.equal(aborted, true);
  assert.equal(changes, 0);
  assert.equal(log.size(), 0);
  assert.deepEqual(clock.pending(), []);
});

test("monitor: disabled configuration never fetches or schedules", async () => {
  const clock = fakeClock();
  let calls = 0;
  const monitor = createGitHubStatusMonitor({ config: githubStatusConfig({ GH_GLANCE_GITHUB_STATUS: "off" }, null),
    fetchImpl: async () => { calls += 1; return response(200, summary()); },
    log: createNotificationLog({ now: clock.now }), now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  await monitor.ready;
  assert.equal(await monitor.checkNow(), false);
  assert.equal(calls, 0);
  assert.deepEqual(clock.pending(), []);
  assert.match(githubStatusLine(monitor.current()), /GitHub status checks off/);
});

test("non-TUI commands never request GitHub status, even with an override URL", async (t) => {
  let requests = 0;
  const server = createServer((_request, reply) => { requests += 1; reply.end("{}"); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const home = mkdtempSync(join(tmpdir(), "gh-glance-status-nontui-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: home, GH_CONFIG_DIR: home,
    GH_GLANCE_GITHUB_STATUS: `http://127.0.0.1:${server.address().port}/summary.json` };
  const entry = new URL("../index.mjs", import.meta.url).pathname;
  const version = await run(process.execPath, [entry, "--version"], { env, timeout: 30_000 });
  assert.match(version.stdout, /\d+\.\d+\.\d+/);
  const help = await run(process.execPath, [entry, "--help"], { env, timeout: 30_000 });
  assert.match(help.stdout, /GH_GLANCE_GITHUB_STATUS=off/);
  // Doctor may report missing gh setup and exit non-zero here; it must still run to its report.
  const doctor = await run(process.execPath, [entry, "--doctor"], { env, timeout: 30_000 })
    .catch((error) => error);
  assert.match(`${doctor.stdout ?? ""}${doctor.stderr ?? ""}`, /\S/);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(requests, 0);
});
