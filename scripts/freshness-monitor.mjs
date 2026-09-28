#!/usr/bin/env node
// Read-only source-freshness evidence for an independently declared pane cohort.
// Set startedAt after pane subscription is installed. An absent live subscription fails immediately.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

import { doctorAcquisitionLockDiagnostic, loadAcquisitionStore,
  readGovernorState } from "../index.mjs";

const TABS = new Set(["actions", "issues", "prs", "security"]);
const EXCLUDABLE_HOLDS = new Set(["observer", "primary", "secondary", "disconnected"]);
const MIN_SAMPLE_MS = 1000;
const LOCK_BUSY_GRACE_MS = 10_000;
const MAX_SAMPLE_GAP_MS = 15_000;
const INITIAL_WINDOW_MS = 30 * 60_000;
const FULL_WINDOW_MS = 24 * 60 * 60_000;
const HASH = /^[a-f0-9]{64}$/;

function label(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function validManifest(input) {
  if (!input || ![1, 2].includes(input.schema) || !Array.isArray(input.panes) || input.panes.length === 0) {
    throw new Error("manifest requires schema 1 or 2 and a nonempty panes array");
  }
  const qualifying = input.schema === 2;
  if (qualifying && (!HASH.test(input.candidateHash ?? "") ||
      !Number.isSafeInteger(input.requestedDurationMs) || input.requestedDurationMs < MIN_SAMPLE_MS ||
      input.sampleIntervalMs !== 5_000)) {
    throw new Error("qualification manifest requires candidate hash, duration, and 5-second sampling");
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
        qualifying && (!pane.host || !pane.repositoryId || !HASH.test(pane.accessKey ?? "") ||
          pane.exitedAt != null || pane.holds !== undefined) ||
        pane.holds !== undefined && (!Array.isArray(pane.holds) || pane.holds.some((hold) =>
          !hold || !EXCLUDABLE_HOLDS.has(hold.reason) || !Number.isFinite(hold.from) ||
          !Number.isFinite(hold.until) || hold.from < pane.startedAt || hold.until <= hold.from))) {
      throw new Error("invalid or duplicate expected pane");
    }
    ids.add(pane.id);
    return { id: pane.id, pid: pane.pid, repository: pane.repository.toLowerCase(),
      host: pane.host?.toLowerCase() ?? null, repositoryId: pane.repositoryId ?? null,
      accessKey: pane.accessKey ?? null,
      tab: pane.tab, startedAt: pane.startedAt, exitedAt: pane.exitedAt ?? null,
      cadenceMs: pane.cadenceMs, holds: pane.holds?.map((hold) => ({ ...hold })) ?? [] };
  });
  return panes;
}

function samePane(left, right) {
  return left.id === right.id && left.pid === right.pid &&
    left.repository === right.repository && left.host === right.host &&
    left.repositoryId === right.repositoryId && left.tab === right.tab &&
    left.accessKey === right.accessKey &&
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
        pane.repositoryId !== null && query.repositoryId !== pane.repositoryId ||
        pane.accessKey !== null && query.accessKey !== pane.accessKey) return [];
    return [{ subscription, record }];
  });
  return candidates;
}

function externalOutages(evidence, panes, observedAt) {
  if (!Array.isArray(evidence)) throw new Error("external evidence must be an array");
  return evidence.flatMap((item) => {
    if (item?.type !== "raw-http" || typeof item.response !== "string" ||
        Buffer.byteLength(item.response) > 16_384 ||
        !Number.isSafeInteger(item.issuedAt) || !Number.isSafeInteger(item.finishedAt) ||
        item.finishedAt < item.issuedAt || item.finishedAt - item.issuedAt > 60_000 ||
        item.finishedAt > observedAt) {
      throw new Error("external outage requires a captured provider response");
    }
    const [head] = item.response.split(/\r?\n\r?\n/, 1);
    const [statusLine, ...headerLines] = head.split(/\r?\n/);
    const status = Number(/^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s|$)/.exec(statusLine)?.[1]);
    if (![403, 429].includes(status)) return [];
    const headers = {};
    for (const line of headerLines) {
      const match = /^([a-z0-9-]+):\s*([^\r\n]{1,256})$/i.exec(line);
      if (!match) throw new Error("invalid external response header");
      const name = match[1].toLowerCase();
      if (Object.hasOwn(headers, name)) throw new Error("duplicate external response header");
      headers[name] = match[2];
    }
    if (headers["x-ratelimit-resource"] !== item.resource) {
      throw new Error("external response resource mismatch");
    }
    if (status === 403 && headers["x-ratelimit-remaining"] !== "0") return [];
    const validScope = panes.some((pane) => pane.host === item?.host &&
      pane.accessKey === item?.accessKey &&
      (pane.tab === "actions" || pane.tab === "security" ? "core" : "graphql") === item?.resource);
    const retrySeconds = Number(headers["retry-after"]);
    // The exclusion window is derived from a separately captured request
    // response. A manifest or app hold cannot declare its own start/end.
    const provider = (status === 429 || headers["x-ratelimit-remaining"] === "0") &&
      typeof headers["retry-after"] === "string" &&
      Number.isSafeInteger(retrySeconds) && retrySeconds > 0;
    if (!validScope || !provider) {
      throw new Error("external outage requires a scoped independent request response");
    }
    return [{ type: "provider-rejection", origin: "raw-provider-response",
      host: item.host, accessKey: item.accessKey, resource: item.resource,
      from: item.finishedAt, until: item.finishedAt + retrySeconds * 1_000 }];
  });
}

function coveredDuration(intervals, start, end) {
  let total = 0;
  let coveredTo = start;
  for (const interval of intervals.filter((item) => item.until > start && item.from < end)
    .sort((left, right) => left.from - right.from)) {
    const from = Math.max(start, interval.from, coveredTo);
    const until = Math.min(end, interval.until);
    if (until > from) total += until - from;
    coveredTo = Math.max(coveredTo, until);
  }
  return total;
}

function quotaMatchesCohort(path, panes) {
  if (!path) return false;
  try {
    const registryPath = join(dirname(path), "registry.json");
    const stat = lstatSync(registryPath);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return false;
    const registry = JSON.parse(readFileSync(registryPath, "utf8"));
    if (!registry?.identities || typeof registry.identities !== "object" ||
        Array.isArray(registry.identities)) return false;
    return panes.every((pane) => {
      const matches = Object.values(registry.identities).filter((identity) =>
        identity?.host === pane.host && identity?.accessKey === pane.accessKey &&
        HASH.test(identity?.quotaKey ?? ""));
      return matches.length === 1 && path === join(dirname(path), `quota-${matches[0].quotaKey}.json`);
    });
  } catch { return false; }
}

function processLiveness(pid) {
  try { process.kill(pid, 0); return "live"; }
  catch (error) { return error?.code === "ESRCH" ? "dead"
    : error?.code === "EPERM" ? "live" : "unavailable"; }
}

function createFreshnessMonitor({ manifest, storePath, now = Date.now,
  monotonicNow = () => performance.now(), candidateHash = null, externalEvidence = [],
  quotaPath = null, readQuota = (path, at) => readGovernorState(path, at, { persistMigration: false }),
  verifyQuotaScope = quotaMatchesCohort, isPidAlive = processLiveness,
  readStore = loadAcquisitionStore, inspectLock = doctorAcquisitionLockDiagnostic,
  emit = () => {} }) {
  if (typeof storePath !== "string" || !storePath) throw new Error("storePath is required");
  let panes = validManifest(manifest);
  const qualifying = manifest.schema === 2;
  if (qualifying && candidateHash !== manifest.candidateHash) {
    throw new Error("candidate hash does not match the qualification manifest");
  }
  let outages = qualifying ? externalOutages(externalEvidence, panes, now()) : [];
  let evidenceDigests = externalEvidence.map((item) =>
    createHash("sha256").update(JSON.stringify(item)).digest("hex"));
  const quotaBound = !qualifying || verifyQuotaScope(quotaPath, panes);
  const history = new Map(panes.map((pane) => [pane.id, {
    successes: 0, lastSuccessAt: null, lastChangedAt: null, eligibleFrom: pane.startedAt,
    releasedAt: null, hold: null, holdStartedAt: null, holdLastSeenAt: null,
    holdUntil: null, holdIntervals: [],
    demand: null, activeSinceAt: null, activeNeedsSuccess: false,
    generation: null,
    maxEligibleGapMs: 0, maxOverdueMs: 0, state: "awaiting-first", failed: false,
  }]));
  let failed = false;
  let samples = 0;
  let lockBusySince = null;
  let maxLockBusyMs = 0;
  let firstAt = null;
  let firstMono = null;
  let lastAt = null;
  let lastMono = null;
  let coverageGaps = 0;
  let clockFaults = 0;
  let uninterruptedFrom = null;

  function updateManifest(next) {
    const updated = validManifest(next);
    if (next.schema !== manifest.schema || qualifying &&
      (next.candidateHash !== manifest.candidateHash ||
        next.requestedDurationMs !== manifest.requestedDurationMs ||
        next.sampleIntervalMs !== manifest.sampleIntervalMs) ||
      updated.length !== panes.length || updated.some((pane, index) =>
      !samePane(pane, panes[index]) ||
      panes[index].exitedAt !== null && pane.exitedAt !== panes[index].exitedAt)) {
      throw new Error("expected panes may only gain an explicit exitedAt timestamp");
    }
    panes = updated;
  }

  function updateExternalEvidence(next) {
    if (!qualifying) return;
    if (!Array.isArray(next) || next.length < evidenceDigests.length ||
        evidenceDigests.some((digest, index) => digest !== createHash("sha256")
          .update(JSON.stringify(next[index])).digest("hex"))) {
      throw new Error("external trace changed earlier evidence");
    }
    const updated = externalOutages(next, panes, now());
    evidenceDigests = next.map((item) => createHash("sha256")
      .update(JSON.stringify(item)).digest("hex"));
    outages = updated;
  }

  function sample() {
    const at = now();
    if (!Number.isFinite(at)) throw new Error("invalid monitor clock");
    const mono = monotonicNow();
    if (!Number.isFinite(mono)) throw new Error("invalid monotonic clock");
    if (firstAt === null) {
      firstAt = at;
      firstMono = mono;
      uninterruptedFrom = mono;
    } else if (qualifying) {
      const wallStep = at - lastAt;
      const monoStep = mono - lastMono;
      if (monoStep < 0 || wallStep < 0 || Math.abs(wallStep - monoStep) > 5_000) {
        clockFaults += 1;
        failed = true;
        uninterruptedFrom = mono;
      }
      if (monoStep > MAX_SAMPLE_GAP_MS) {
        coverageGaps += 1;
        failed = true;
        uninterruptedFrom = mono;
      }
    }
    lastAt = at;
    lastMono = mono;
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
    let quota = null;
    if (qualifying) {
      try {
        const read = quotaBound && quotaPath ? readQuota(quotaPath, at) : null;
        quota = read?.ok && !read.missing ? read.value : null;
      } catch { quota = null; }
      if (!quota) failed = true;
    }
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
        if (qualifying) entry.failed = failed = true;
        return { ...publicRow, state: entry.state };
      }
      if (qualifying) {
        const liveness = isPidAlive(pane.pid);
        if (liveness !== "live") {
          entry.state = liveness === "dead" ? "pane-disappeared" : "pane-liveness-unavailable";
          entry.failed = failed = true;
          return { ...publicRow, state: entry.state };
        }
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
      const outageIntervals = qualifying ? outages.filter((item) =>
        item.host === pane.host && item.accessKey === pane.accessKey &&
        item.resource === (pane.tab === "actions" || pane.tab === "security" ? "core" : "graphql")) : [];
      const outage = qualifying ? outageIntervals.some((item) => item.from <= at && at < item.until) : false;
      const declaredHold = pane.holds.find((window) => window.reason === hold &&
        Number.isFinite(record.hold?.at) && record.hold.at <= at &&
        window.from <= at && at < window.until && record.hold.at < window.until);
      const externalProviderHold = hold === null || hold === "primary" || hold === "secondary";
      const excluded = qualifying ? outage && externalProviderHold : Boolean(declaredHold);
      if (qualifying && hold !== null && !excluded) entry.failed = failed = true;
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
        entry.holdStartedAt = qualifying ? Math.max(pane.startedAt,
          outageIntervals.find((item) => item.from <= at && at < item.until)?.from ?? at)
          : Math.max(pane.startedAt, record.hold.at, declaredHold.from);
        entry.holdUntil = qualifying ? outageIntervals.find((item) => item.from <= at && at < item.until)?.until
          : declaredHold.until;
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
      if (qualifying && snapshot && (!Number.isFinite(snapshot.lastSuccessAt) ||
          !Number.isFinite(snapshot.lastChangedAt) ||
          snapshot.lastChangedAt > snapshot.lastSuccessAt ||
          snapshot.lastChangedAt > at ||
          !Number.isSafeInteger(snapshot.generation) || snapshot.generation < 1 ||
          entry.generation !== null && snapshot.generation < entry.generation ||
          entry.lastSuccessAt !== null && snapshot.lastSuccessAt > entry.lastSuccessAt &&
            snapshot.generation <= entry.generation ||
          entry.lastChangedAt !== null && snapshot.lastChangedAt < entry.lastChangedAt)) {
        entry.state = "invalid-source-clock";
        entry.failed = failed = true;
      } else if (successAt !== null && successAt > at) {
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
          entry.generation = snapshot.generation ?? entry.generation;
          entry.eligibleFrom = successAt;
        }
        if (entry.activeNeedsSuccess && successAt !== null &&
            successAt >= entry.activeSinceAt) entry.activeNeedsSuccess = false;
        const allowance = Math.max(2 * pane.cadenceMs, 15_000);
        const sourceDueAt = qualifying ? (entry.lastSuccessAt ?? pane.startedAt) + pane.cadenceMs
          : snapshot?.nextDueAt ?? entry.lastSuccessAt + pane.cadenceMs;
        // A prior background grant can have a distant nextDueAt. Once this
        // pane becomes active, require one new observation at its active floor
        // before trusting that old deadline again. Later successful snapshots
        // carry their own admitted cadence, including the quiet policy.
        const demandDueAt = entry.activeNeedsSuccess
          ? Math.min(sourceDueAt, entry.activeSinceAt + pane.cadenceMs)
          : sourceDueAt;
        const dueAt = qualifying && entry.lastSuccessAt === null
          ? Math.max(pane.startedAt, entry.releasedAt ?? pane.startedAt) + 60_000
          : entry.lastSuccessAt === null
          ? Math.max(pane.startedAt, entry.releasedAt ?? pane.startedAt) + allowance
          : Math.max(demandDueAt,
            (entry.releasedAt ?? 0) + pane.cadenceMs) + allowance;
        if (!excluded) {
          const externalMs = qualifying ? coveredDuration(outageIntervals, entry.eligibleFrom, at) : 0;
          entry.maxEligibleGapMs = Math.max(entry.maxEligibleGapMs,
            Math.max(0, at - entry.eligibleFrom - externalMs));
          const baseAt = entry.lastSuccessAt ?? Math.max(pane.startedAt, entry.releasedAt ?? pane.startedAt);
          const activeBaseAt = entry.activeNeedsSuccess ? Math.max(baseAt, entry.activeSinceAt) : baseAt;
          const elapsed = at - activeBaseAt - coveredDuration(outageIntervals, activeBaseAt, at);
          const allowed = entry.activeNeedsSuccess ? 60_000
            : entry.lastSuccessAt === null ? 60_000 : pane.cadenceMs + allowance;
          const overdue = qualifying ? Math.max(0, elapsed - allowed)
            : Math.max(0, at - dueAt);
          entry.maxOverdueMs = Math.max(entry.maxOverdueMs, overdue);
          entry.state = overdue > 0 ? "overdue" : entry.lastSuccessAt === null
            ? "awaiting-first" : "eligible";
          if (overdue > 0) entry.failed = failed = true;
        } else entry.state = "held";
      }
      return { ...publicRow, lastSuccessAt: entry.lastSuccessAt,
        lastChangedAt: entry.lastChangedAt, generation: entry.generation,
        maxEligibleGapMs: entry.maxEligibleGapMs,
        maxOverdueMs: entry.maxOverdueMs, state: entry.state };
    });
    samples += 1;
    const diagnostics = qualifying ? { status: quota ? "available" : "unavailable",
      observers: Object.fromEntries(["core", "graphql"].map((resource) => [resource,
        quota?.observers?.[resource] ? { outcome: quota.observers[resource].outcome,
          nextAt: quota.observers[resource].nextAt } : null])),
      debt: Object.fromEntries(["core", "graphql"].map((resource) => [resource,
        quota?.debt?.[resource] ? { unresolvedUnits: quota.debt[resource].unresolvedUnits,
          quiescentUnits: quota.debt[resource].quiescentUnits } : null])) } : null;
    const report = { schema: qualifying ? 2 : 1, type: "sample", at,
      elapsedMs: mono - firstMono, ok: !failed, lock, panes: results,
      ...(qualifying ? { diagnostics } : {}) };
    emit(JSON.stringify(report));
    return report;
  }

  function summary() {
    const actualElapsedMs = firstMono === null ? 0 : Math.max(0, lastMono - firstMono);
    const uninterruptedMs = lastMono === null ? 0 : Math.max(0, lastMono - uninterruptedFrom);
    const wallMs = firstAt === null ? 0 : Math.max(0, lastAt - firstAt);
    const externalOutageMs = qualifying && firstAt !== null
      ? coveredDuration(outages, firstAt, lastAt) : 0;
    return { schema: qualifying ? 2 : 1, type: "summary", qualifying,
      candidateHash: qualifying ? manifest.candidateHash : null,
      requestedDurationMs: qualifying ? manifest.requestedDurationMs : null,
      windowClass: !qualifying ? "diagnostic" : manifest.requestedDurationMs >= FULL_WINDOW_MS
        ? "full" : manifest.requestedDurationMs >= INITIAL_WINDOW_MS ? "initial" : "short",
      actualElapsedMs, uninterruptedMs, wallMs, externalOutageMs,
      eligibleMs: Math.max(0, wallMs - externalOutageMs), coverageGaps, clockFaults,
      externalEvidenceSources: qualifying ? [...new Set(outages.map((item) => item.origin))] : [],
      ok: !failed && (!qualifying || uninterruptedMs >= manifest.requestedDurationMs) &&
      panes.every((pane) => history.get(pane.id).successes > 0), samples,
      maxLockBusyMs,
      panes: panes.map((pane) => {
        const entry = history.get(pane.id);
        const holdIntervals = entry.holdStartedAt === null ? entry.holdIntervals :
          [...entry.holdIntervals, { reason: entry.hold, from: entry.holdStartedAt, until: null }];
        return { pane: label(`pane:${pane.id}`), target: label(`target:${pane.repository}:${pane.tab}`),
          tab: pane.tab, successes: entry.successes, lastSuccessAt: entry.lastSuccessAt,
          maxEligibleGapMs: entry.maxEligibleGapMs, maxOverdueMs: entry.maxOverdueMs,
          externalOutageMs: qualifying && firstAt !== null ? coveredDuration(outages.filter((item) =>
            item.host === pane.host && item.accessKey === pane.accessKey &&
            item.resource === (pane.tab === "actions" || pane.tab === "security" ? "core" : "graphql")),
            firstAt, lastAt) : 0,
          holdIntervals, exitedAt: pane.exitedAt, unmeasured: entry.successes === 0,
          failed: entry.failed || entry.successes === 0 };
      }) };
  }

  return { sample, summary, updateManifest, updateExternalEvidence };
}

function cliArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!["--manifest", "--store", "--report", "--candidate", "--quota",
      "--external-evidence", "--interval-ms", "--duration-ms", "--once"].includes(key)) {
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
    reportPath: resolve(options.report), candidatePath: options.candidate ? resolve(options.candidate) : null,
    quotaPath: options.quota ? resolve(options.quota) : null,
    externalEvidencePath: options["external-evidence"] ? resolve(options["external-evidence"]) : null,
    intervalMs, durationMs, once: options.once === true };
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
  if (manifest.schema === 2 && (!options.candidatePath || !options.quotaPath ||
      options.intervalMs !== 5_000 || options.durationMs !== manifest.requestedDurationMs || options.once)) {
    process.stderr.write("qualification requires candidate, quota, 5-second sampling and exact duration\n");
    return 2;
  }
  if (manifest.schema === 1 && !options.once) {
    process.stderr.write("schema 1 permits diagnostics only; qualification requires schema 2\n");
    return 2;
  }
  let candidateHash = null;
  let externalEvidence = [];
  const readExternalTrace = () => {
    const trace = JSON.parse(readFileSync(options.externalEvidencePath, "utf8"));
    if (trace?.schema !== 1 || !Array.isArray(trace.events)) throw new Error("invalid external trace");
    return trace.events;
  };
  try {
    if (options.candidatePath) candidateHash = createHash("sha256")
      .update(readFileSync(options.candidatePath)).digest("hex");
    if (options.externalEvidencePath) externalEvidence = readExternalTrace();
  } catch { process.stderr.write("candidate or external evidence is unavailable\n"); return 2; }
  let output = () => {};
  let monitor;
  try { monitor = createFreshnessMonitor({ manifest, storePath: options.storePath,
    candidateHash, externalEvidence, quotaPath: options.quotaPath,
    emit: (line) => output(line) }); }
  catch (error) { process.stderr.write(`${error.message}\n`); return 2; }
  try { writeFileSync(options.reportPath, "", { flag: "wx", mode: 0o600 }); }
  catch { process.stderr.write("report path cannot be created\n"); return 2; }
  output = (line) => appendFileSync(options.reportPath, `${line}\n`, { mode: 0o600 });
  let until = null;
  let stop = false;
  let wake = null;
  const onSignal = () => { stop = true; wake?.(); };
  process.once("SIGINT", onSignal);
  let running = true;
  try { while (running) {
    try {
      monitor.updateManifest(JSON.parse(readFileSync(options.manifestPath, "utf8")));
      if (options.externalEvidencePath) monitor.updateExternalEvidence(readExternalTrace());
      monitor.sample();
      if (until === null) until = performance.now() + (options.durationMs ?? 0);
    } catch (error) {
      output(JSON.stringify({ schema: 1, type: "monitor-error", at: Date.now(),
        reason: "manifest-or-sample-error" }));
      process.stderr.write(`${error.message}\n`);
      return 2;
    }
    // The timer can fire after its deadline while the sample's monotonic
    // timestamp was captured just before it. Qualify from sampled coverage,
    // not from the wall time at the end of this loop.
    if (options.once || stop || monitor.summary().actualElapsedMs >= options.durationMs) running = false;
    else await new Promise((resolve) => {
      const timer = setTimeout(() => { wake = null; resolve(); },
        Math.min(options.intervalMs, until - performance.now()));
      wake = () => { clearTimeout(timer); wake = null; resolve(); };
    });
  } } finally { process.off("SIGINT", onSignal); }
  const result = monitor.summary();
  output(JSON.stringify(result));
  return result.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}

export { createFreshnessMonitor, main, validManifest };
