#!/usr/bin/env node
// Read-only source-freshness evidence for an independently declared pane cohort.
// Set startedAt after pane subscription is installed. An absent live subscription fails immediately.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { doctorAcquisitionLockDiagnostic, loadAcquisitionStore } from "../index.mjs";

const TABS = new Set(["actions", "issues", "prs", "security"]);
const EXCLUDABLE_HOLDS = new Set(["observer", "primary", "secondary", "disconnected"]);
const MIN_SAMPLE_MS = 1000;
const LOCK_BUSY_GRACE_MS = 10_000;

function label(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function validManifest(input) {
  if (!input || input.schema !== 1 || !Array.isArray(input.panes) || input.panes.length === 0) {
    throw new Error("manifest requires schema 1 and a nonempty panes array");
  }
  const ids = new Set();
  const panes = input.panes.map((pane) => {
    if (!pane || typeof pane.id !== "string" || !pane.id || ids.has(pane.id) ||
        !Number.isSafeInteger(pane.pid) || pane.pid <= 0 ||
        typeof pane.repository !== "string" || !/^[^\s/]+\/[^\s/]+$/.test(pane.repository) ||
        !TABS.has(pane.tab) || !Number.isFinite(pane.startedAt) ||
        !Number.isFinite(pane.cadenceMs) || pane.cadenceMs < MIN_SAMPLE_MS ||
        pane.exitedAt != null && (!Number.isFinite(pane.exitedAt) ||
          pane.exitedAt < pane.startedAt) ||
        pane.host !== undefined && (typeof pane.host !== "string" || !pane.host) ||
        pane.repositoryId !== undefined && (typeof pane.repositoryId !== "string" || !pane.repositoryId) ||
        pane.holds !== undefined && (!Array.isArray(pane.holds) || pane.holds.some((hold) =>
          !hold || !EXCLUDABLE_HOLDS.has(hold.reason) || !Number.isFinite(hold.from) ||
          !Number.isFinite(hold.until) || hold.from < pane.startedAt || hold.until <= hold.from))) {
      throw new Error("invalid or duplicate expected pane");
    }
    ids.add(pane.id);
    return { id: pane.id, pid: pane.pid, repository: pane.repository.toLowerCase(),
      host: pane.host?.toLowerCase() ?? null, repositoryId: pane.repositoryId ?? null,
      tab: pane.tab, startedAt: pane.startedAt, exitedAt: pane.exitedAt ?? null,
      cadenceMs: pane.cadenceMs, holds: pane.holds?.map((hold) => ({ ...hold })) ?? [] };
  });
  return panes;
}

function samePane(left, right) {
  return left.id === right.id && left.pid === right.pid &&
    left.repository === right.repository && left.host === right.host &&
    left.repositoryId === right.repositoryId && left.tab === right.tab &&
    left.startedAt === right.startedAt && left.cadenceMs === right.cadenceMs &&
    JSON.stringify(left.holds) === JSON.stringify(right.holds);
}

function matchSubscriptions(state, pane) {
  const candidates = Object.values(state.subscriptions ?? {}).flatMap((subscription) => {
    const record = state.queries?.[subscription.queryKey];
    const query = record?.query;
    if (subscription.pid !== pane.pid || query?.resource !== pane.tab ||
        query.repository?.toLowerCase() !== pane.repository ||
        pane.host !== null && query.host?.toLowerCase() !== pane.host ||
        pane.repositoryId !== null && query.repositoryId !== pane.repositoryId) return [];
    return [{ subscription, record }];
  });
  return candidates;
}

function createFreshnessMonitor({ manifest, storePath, now = Date.now,
  readStore = loadAcquisitionStore, inspectLock = doctorAcquisitionLockDiagnostic,
  emit = () => {} }) {
  if (typeof storePath !== "string" || !storePath) throw new Error("storePath is required");
  let panes = validManifest(manifest);
  const history = new Map(panes.map((pane) => [pane.id, {
    successes: 0, lastSuccessAt: null, lastChangedAt: null, eligibleFrom: pane.startedAt,
    releasedAt: null, hold: null, holdStartedAt: null, holdLastSeenAt: null,
    holdUntil: null, holdIntervals: [],
    demand: null, activeSinceAt: null, activeNeedsSuccess: false,
    maxEligibleGapMs: 0, maxOverdueMs: 0, state: "awaiting-first", failed: false,
  }]));
  let failed = false;
  let samples = 0;
  let lockBusySince = null;
  let maxLockBusyMs = 0;

  function updateManifest(next) {
    const updated = validManifest(next);
    if (updated.length !== panes.length || updated.some((pane, index) =>
      !samePane(pane, panes[index]) ||
      panes[index].exitedAt !== null && pane.exitedAt !== panes[index].exitedAt)) {
      throw new Error("expected panes may only gain an explicit exitedAt timestamp");
    }
    panes = updated;
  }

  function sample() {
    const at = now();
    if (!Number.isFinite(at)) throw new Error("invalid monitor clock");
    const lockResult = (() => {
      try { return inspectLock(`${storePath}.lock`, { nowMs: at }); }
      catch { return { status: "unavailable", ageMs: null }; }
    })();
    const lock = { status: typeof lockResult?.status === "string" ? lockResult.status : "unavailable",
      ageMs: Number.isFinite(lockResult?.ageMs) ? lockResult.ageMs : null };
    const fileMissing = readStore === loadAcquisitionStore && !existsSync(storePath);
    let loaded;
    try { loaded = readStore(storePath); } catch { loaded = { ok: false, reason: "corrupt" }; }
    const storeState = fileMissing || loaded?.missing ||
      readStore === loadAcquisitionStore && !existsSync(storePath)
      ? "missing-store" : !loaded?.ok ? "corrupt-store" : null;
    if (lock.status === "busy") {
      const observedStart = at - Math.max(0, lock.ageMs ?? 0);
      lockBusySince = lockBusySince === null ? observedStart :
        Number.isFinite(lock.ageMs) ? Math.max(lockBusySince, observedStart) : lockBusySince;
      maxLockBusyMs = Math.max(maxLockBusyMs, at - lockBusySince);
    } else lockBusySince = null;
    const lockBlocked = lock.status === "busy"
      ? at - lockBusySince > LOCK_BUSY_GRACE_MS || lock.ageMs > LOCK_BUSY_GRACE_MS
      : lock.status !== "unobstructed";
    lock.blockedMs = lock.status === "busy" ? at - lockBusySince : 0;
    lock.healthy = !lockBlocked;
    if (lockBlocked) failed = true;
    const results = panes.map((pane) => {
      const entry = history.get(pane.id);
      const publicRow = { pane: label(`pane:${pane.id}`), target: label(`target:${pane.repository}:${pane.tab}`),
        tab: pane.tab, demand: null, lastSuccessAt: entry.lastSuccessAt,
        lastChangedAt: entry.lastChangedAt, nextDueAt: null, hold: null,
        maxEligibleGapMs: entry.maxEligibleGapMs, maxOverdueMs: entry.maxOverdueMs,
        state: entry.state };
      if (pane.exitedAt !== null && pane.exitedAt <= at) {
        if (entry.holdStartedAt !== null) {
          entry.holdIntervals.push({ reason: entry.hold, from: entry.holdStartedAt,
            until: entry.holdLastSeenAt });
          entry.holdStartedAt = null;
          entry.holdLastSeenAt = null;
        }
        entry.state = "exited";
        return { ...publicRow, state: "exited", exitedAt: pane.exitedAt };
      }
      if (at < pane.startedAt) {
        entry.state = "not-started";
        return { ...publicRow, state: entry.state };
      }
      if (storeState) {
        entry.state = storeState;
        entry.failed = failed = true;
        return { ...publicRow, state: entry.state };
      }
      const matches = matchSubscriptions(loaded.value, pane);
      const live = matches.filter(({ subscription }) => subscription.expiresAt > at);
      if (live.length !== 1) {
        entry.state = live.length > 1 ? "ambiguous-subscription" : "missing-subscription";
        entry.failed = failed = true;
        return { ...publicRow, state: entry.state };
      }
      const { subscription, record } = live[0];
      const snapshot = record.snapshot;
      const hold = record.hold?.reason ?? null;
      const declaredHold = pane.holds.find((window) => window.reason === hold &&
        Number.isFinite(record.hold?.at) && record.hold.at <= at &&
        window.from <= at && at < window.until && record.hold.at < window.until);
      const excluded = Boolean(declaredHold);
      if (entry.holdStartedAt !== null && (!excluded || entry.hold !== hold)) {
        // A cleared hold may have ended anywhere since the last sample. Only
        // exclude through the last instant at which the runtime still held it.
        const continuedThroughEnd = hold === entry.hold &&
          Number.isFinite(record.hold?.at) && record.hold.at <= entry.holdLastSeenAt &&
          at >= entry.holdUntil;
        const closedAt = continuedThroughEnd ? entry.holdUntil : entry.holdLastSeenAt;
        entry.holdIntervals.push({ reason: entry.hold, from: entry.holdStartedAt,
          until: closedAt });
        entry.hold = null;
        entry.holdStartedAt = null;
        entry.holdLastSeenAt = null;
        entry.holdUntil = null;
        entry.releasedAt = closedAt;
        entry.eligibleFrom = closedAt;
      }
      if (excluded && entry.holdStartedAt === null) {
        entry.hold = hold;
        entry.holdStartedAt = Math.max(pane.startedAt, record.hold.at, declaredHold.from);
        entry.holdUntil = declaredHold.until;
      }
      if (excluded) entry.holdLastSeenAt = at;
      const demand = subscription.demand?.active ? "active" : "background";
      if (entry.demand !== demand) {
        if (demand === "active") {
          entry.activeSinceAt = entry.demand === null ? pane.startedAt : at;
          entry.activeNeedsSuccess = true;
        } else {
          entry.activeSinceAt = null;
          entry.activeNeedsSuccess = false;
        }
        entry.demand = demand;
      }
      publicRow.demand = demand;
      publicRow.nextDueAt = snapshot?.nextDueAt ?? null;
      publicRow.hold = hold;
      const successAt = snapshot?.lastSuccessAt ?? null;
      if (successAt !== null && successAt > at) {
        entry.state = "future-success";
        entry.failed = failed = true;
      } else if (successAt !== null && entry.lastSuccessAt !== null && successAt < entry.lastSuccessAt) {
        entry.state = "regressed-success";
        entry.failed = failed = true;
      } else {
        if (successAt !== null && successAt >= pane.startedAt &&
            (entry.lastSuccessAt === null || successAt > entry.lastSuccessAt)) {
          if (!excluded) entry.maxEligibleGapMs = Math.max(entry.maxEligibleGapMs,
            Math.max(0, successAt - entry.eligibleFrom));
          entry.successes += 1;
          entry.lastSuccessAt = successAt;
          entry.lastChangedAt = snapshot.lastChangedAt;
          entry.eligibleFrom = successAt;
        }
        if (entry.activeNeedsSuccess && successAt !== null &&
            successAt >= entry.activeSinceAt) entry.activeNeedsSuccess = false;
        const allowance = Math.max(2 * pane.cadenceMs, 15_000);
        const sourceDueAt = snapshot?.nextDueAt ?? entry.lastSuccessAt + pane.cadenceMs;
        // A prior background grant can have a distant nextDueAt. Once this
        // pane becomes active, require one new observation at its active floor
        // before trusting that old deadline again. Later successful snapshots
        // carry their own admitted cadence, including the quiet policy.
        const demandDueAt = entry.activeNeedsSuccess
          ? Math.min(sourceDueAt, entry.activeSinceAt + pane.cadenceMs)
          : sourceDueAt;
        const dueAt = entry.lastSuccessAt === null
          ? Math.max(pane.startedAt, entry.releasedAt ?? pane.startedAt) + allowance
          : Math.max(demandDueAt,
            (entry.releasedAt ?? 0) + pane.cadenceMs) + allowance;
        if (!excluded) {
          entry.maxEligibleGapMs = Math.max(entry.maxEligibleGapMs,
            Math.max(0, at - entry.eligibleFrom));
          const overdue = Math.max(0, at - dueAt);
          entry.maxOverdueMs = Math.max(entry.maxOverdueMs, overdue);
          entry.state = overdue > 0 ? "overdue" : entry.lastSuccessAt === null
            ? "awaiting-first" : "eligible";
          if (overdue > 0) entry.failed = failed = true;
        } else entry.state = "held";
      }
      return { ...publicRow, lastSuccessAt: entry.lastSuccessAt,
        lastChangedAt: entry.lastChangedAt, maxEligibleGapMs: entry.maxEligibleGapMs,
        maxOverdueMs: entry.maxOverdueMs, state: entry.state };
    });
    samples += 1;
    const report = { schema: 1, type: "sample", at, ok: !failed, lock, panes: results };
    emit(JSON.stringify(report));
    return report;
  }

  function summary() {
    return { schema: 1, type: "summary", ok: !failed &&
      panes.every((pane) => history.get(pane.id).successes > 0), samples,
      maxLockBusyMs,
      panes: panes.map((pane) => {
        const entry = history.get(pane.id);
        const holdIntervals = entry.holdStartedAt === null ? entry.holdIntervals :
          [...entry.holdIntervals, { reason: entry.hold, from: entry.holdStartedAt, until: null }];
        return { pane: label(`pane:${pane.id}`), target: label(`target:${pane.repository}:${pane.tab}`),
          tab: pane.tab, successes: entry.successes, lastSuccessAt: entry.lastSuccessAt,
          maxEligibleGapMs: entry.maxEligibleGapMs, maxOverdueMs: entry.maxOverdueMs,
          holdIntervals, exitedAt: pane.exitedAt, unmeasured: entry.successes === 0,
          failed: entry.failed || entry.successes === 0 };
      }) };
  }

  return { sample, summary, updateManifest };
}

function cliArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!["--manifest", "--store", "--report", "--interval-ms", "--duration-ms", "--once"].includes(key)) {
      throw new Error(`unknown option: ${key}`);
    }
    if (key === "--once") { options.once = true; continue; }
    const value = argv[++index];
    if (value === undefined) throw new Error(`missing value for ${key}`);
    options[key.slice(2)] = value;
  }
  if (!options.manifest || !options.store || !options.report) {
    throw new Error("usage: freshness-monitor.mjs --manifest path --store path --report path [--interval-ms n] [--duration-ms n|--once]");
  }
  const intervalMs = options["interval-ms"] === undefined ? 5_000 : Number(options["interval-ms"]);
  const durationMs = options["duration-ms"] === undefined ? null : Number(options["duration-ms"]);
  if (!Number.isSafeInteger(intervalMs) || intervalMs < MIN_SAMPLE_MS ||
      durationMs !== null && (!Number.isSafeInteger(durationMs) || durationMs < 0) ||
      !options.once && durationMs === null) throw new Error("invalid interval or duration");
  return { manifestPath: resolve(options.manifest), storePath: resolve(options.store),
    reportPath: resolve(options.report), intervalMs, durationMs, once: options.once === true };
}

async function main(argv = process.argv.slice(2)) {
  let options;
  try { options = cliArgs(argv); } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }
  let manifest;
  try { manifest = JSON.parse(readFileSync(options.manifestPath, "utf8")); }
  catch { process.stderr.write("manifest is unavailable or invalid\n"); return 2; }
  let output = () => {};
  let monitor;
  try { monitor = createFreshnessMonitor({ manifest, storePath: options.storePath,
    emit: (line) => output(line) }); }
  catch (error) { process.stderr.write(`${error.message}\n`); return 2; }
  try { writeFileSync(options.reportPath, "", { flag: "wx", mode: 0o600 }); }
  catch { process.stderr.write("report path cannot be created\n"); return 2; }
  output = (line) => appendFileSync(options.reportPath, `${line}\n`, { mode: 0o600 });
  const until = Date.now() + (options.durationMs ?? 0);
  let stop = false;
  process.once("SIGINT", () => { stop = true; });
  let running = true;
  while (running) {
    try {
      monitor.updateManifest(JSON.parse(readFileSync(options.manifestPath, "utf8")));
      monitor.sample();
    } catch (error) {
      output(JSON.stringify({ schema: 1, type: "monitor-error", at: Date.now(),
        reason: "manifest-or-sample-error" }));
      process.stderr.write(`${error.message}\n`);
      return 2;
    }
    if (options.once || stop || Date.now() >= until) running = false;
    else await new Promise((resolve) => setTimeout(resolve,
      Math.min(options.intervalMs, until - Date.now())));
  }
  const result = monitor.summary();
  output(JSON.stringify(result));
  return result.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}

export { createFreshnessMonitor, main, validManifest };
