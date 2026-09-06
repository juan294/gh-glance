// Run explicitly before production changes; this is measurement, never a target test.
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { captureAsync } from "../pty/capture.mjs";

// Sample only the owned process tree; never inspect command lines or environments.
// Short-lived children may exit between samples, so CPU is a sampled lower bound.
function sampleWorkloadResources() {
  const cpuByPid = new Map();
  let peakRssKiB = 0;
  let samples = 0;
  let pending = null;
  let failure = null;
  function sample() {
    if (pending) return pending;
    pending = new Promise((resolve, reject) => {
      const child = execFile("ps", ["-axo", "pid=,ppid=,rss=,time="], { encoding: "utf8" }, (error, stdout) => {
        if (error) { reject(error); return; }
        const rows = stdout.trim().split("\n").map((line) => {
          const [pid, parent, rss, time] = line.trim().split(/\s+/);
          const parts = time.split(/[-:]/).map(Number);
          const seconds = parts.reverse().reduce((sum, part, index) => sum + part * [1, 60, 3600, 86400][index], 0);
          return { pid: Number(pid), parent: Number(parent), rss: Number(rss), seconds };
        });
        const owned = new Set([process.pid]);
        let changed = true;
        while (changed) {
          changed = false;
          for (const row of rows) {
            if (row.pid !== child.pid && owned.has(row.parent) && !owned.has(row.pid)) {
              owned.add(row.pid);
              changed = true;
            }
          }
        }
        let rss = 0;
        for (const row of rows) {
          if (row.pid === process.pid || !owned.has(row.pid)) continue;
          rss += row.rss;
          cpuByPid.set(row.pid, Math.max(cpuByPid.get(row.pid) ?? 0, row.seconds));
        }
        peakRssKiB = Math.max(peakRssKiB, rss);
        samples += 1;
        resolve();
      });
    }).finally(() => { pending = null; });
    return pending;
  }
  const timer = setInterval(() => { void sample().catch((error) => { failure = error; }); }, 100);
  return async () => {
    clearInterval(timer);
    if (pending) await pending;
    if (failure) throw failure;
    return { sampleIntervalMs: 100, samples, sampledCpuSeconds: [...cpuByPid.values()].reduce((sum, value) => sum + value, 0), peakSampledRssKiB: peakRssKiB };
  };
}

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const output = process.argv[2];
if (!output) throw new Error("usage: node test/fixtures/capture-request-baseline.mjs <output.json>");
const root = mkdtempSync(join(tmpdir(), "gh-glance-baseline-"));
// captureAsync merges its environment: clear it in this dedicated process so
// no inherited real credential can reach gh or subprocess diagnostics.
const binaryPath = process.env.PATH;
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, { PATH: binaryPath, HOME: root, TERM: "xterm-256color", LANG: "C.UTF-8" });
const baseline = {
  schema: 1, kind: "observed-current-production-baseline", capturedAt: new Date().toISOString(),
  commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim(),
  runtime: process.version, platform: `${process.platform}/${process.arch}`,
  workload: "Actions-active panes; --refresh 40; background defaults; identical/distinct repositories; generous 1000000-unit ten-minute budgets; 100ms fixture delay; fixed 8-second observation window; current legacy fixture transport",
  measurementNotes: ["Counts are fixture invocations, not claims about all HTTP requests hidden inside real gh porcelain commands.", "Charged units are observations from the existing legacy server ledger, which does not debit auth status; the new independent oracle accounts for auth HTTP explicitly.", "Only active Actions data becomes due within this fixed window; this is a startup duplicate-demand baseline, not a sustained all-tab workload."],
  unavailable: { sourceToDisplayLatency: "No content changes injected; request latency is measured, not source-to-display.", coalescedConsumers: "No production metric exposed at baseline.", queueWait: "Not sampled by existing capture harness." },
  resourceMeasurement: "100ms samples of owned descendants (dashboard, shell, fixture); CPU is a sampled lower bound, RSS is aggregate sample peak; excludes measurement parent and sampler.",
  samples: [],
};
try {
  for (const spec of [{ panes: 1 }, { panes: 2 }, { panes: 7 }, { panes: 10 }, { panes: 10, distinct: true }]) {
    const configHome = join(root, `config-${spec.panes}-${Boolean(spec.distinct)}`);
    mkdirSync(configHome);
    const statePath = join(configHome, "server.json");
    const now = Date.now();
    writeFileSync(statePath, JSON.stringify({ createdAt: now, core: { limit: 1_000_000, used: 0, remaining: 1_000_000, resetMs: now + 600_000 }, graphql: { limit: 1_000_000, used: 0, remaining: 1_000_000, resetMs: now + 600_000 }, delayMs: 100, events: [] }), { mode: 0o600 });
    const startedAt = performance.now();
    const stopResources = sampleWorkloadResources();
    let resources;
    let captures;
    try {
      captures = await Promise.all(Array.from({ length: spec.panes }, (_, pane) => captureAsync({
        cols: 70, rows: 20, signal: "none", settle: 12, stdin: "sleep 8; printf q", configHome,
        args: `--repo acme/${spec.distinct ? `project-${pane}` : "widget"} --tab actions --refresh 40`,
        env: { GH_GLANCE_FIXTURE_STATE: statePath, GH_GLANCE_FIXTURE_PANE: String(pane), GH_CONFIG_DIR: configHome },
      })));
    } finally { resources = await stopResources(); }
    const elapsedMs = performance.now() - startedAt;
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    const starts = state.events.filter((event) => event.type === "start");
    const ends = new Map(state.events.filter((event) => event.type === "end").map((event) => [event.sequence, event]));
    const latencies = starts.filter((event) => ends.has(event.sequence)).map((event) => ends.get(event.sequence).at - event.at).sort((a, b) => a - b);
    const percentile = (fraction) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * fraction))] ?? null;
    const observers = starts.filter((event) => event.argv[0] === "api" && (event.argv.includes("rate_limit") || event.argv.includes("user")));
    baseline.samples.push({ ...spec, resources, elapsedMs: Math.round(elapsedMs), subprocessCount: captures.reduce((sum, capture) => sum + capture.fixtureCalls.length, 0), recordedFixtureStarts: starts.length, observers: observers.length, actionsRunRequests: starts.filter((event) => event.argv.some((arg) => arg.includes("/actions/runs?"))).length, coreChargedUnits: state.core.used, graphqlChargedUnits: state.graphql.used, requestLatencyMs: { p50: percentile(0.5), p95: percentile(0.95) }, maxConcurrency: state.maxConcurrency });
    process.stderr.write(`baseline ${spec.panes} ${spec.distinct ? "distinct" : "identical"}: ${starts.length} starts\n`);
  }
  writeFileSync(output, `${JSON.stringify(baseline, null, 2)}\n`);
} finally { rmSync(root, { recursive: true, force: true }); }
