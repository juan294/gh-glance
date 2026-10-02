// Deterministic, virtual-time production-function recovery exercise. GitHub
// responses and counters come from the independent request oracle in test/.
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  acquisitionQueryForTab, admitGovernorOperation, claimProbe, createAcquisitionEngine,
  createGovernorScope, GOVERNOR_LEASE_TTL_MS, graphqlArgs, graphqlInput,
  inspectGovernor, issueGovernorDispatch, publishProbe, registerLease,
  releaseGovernorLock, runAdmittedOperation, runGh, startReservation, tabRequestCost,
  IDENTITY_UNCERTAIN_MAX_MS,
} from "../index.mjs";
import { createOracleState, handleOracleRequest } from "../test/fixtures/request-oracle.mjs";

const START = 1_800_000_000_000;
const HOUR = 3_600_000;
const DURATION = 72 * HOUR;
const COHORTS = [
  { id: "single", panes: [{ repo: "acme/single", tab: "actions" }], operations: 200,
    cadenceMs: 30 * 60_000, limit: 5_000, sleep: { at: START + 24 * HOUR, ms: 30_000 } },
  { id: "mixed", panes: [
    { repo: "acme/widget", tab: "actions" }, { repo: "acme/widget", tab: "actions" },
    { repo: "acme/widget", tab: "issues" }, { repo: "acme/widget", tab: "prs" },
    { repo: "acme/widget", tab: "security" }, { repo: "acme/other", tab: "actions" },
  ], operations: 900, cadenceMs: 30 * 60_000, limit: 5_000,
  sleep: { at: START + 48 * HOUR, ms: HOUR } },
  { id: "distinct", panes: Array.from({ length: 10 }, (_, index) => ({
    repo: `acme/repo-${index}`, tab: ["actions", "issues", "prs", "security"][index % 4],
  })), operations: 11_000, cadenceMs: 5 * 60_000, limit: 15_000, identityChange: true },
];

function deterministicId(...parts) {
  const hash = createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function sourceArgs(tab, repo) {
  if (tab === "actions") return [{ operation: "tab:actions-runs",
    argv: ["api", "-i", `repos/${repo}/actions/runs?per_page=60&page=1`] }];
  if (tab === "issues" || tab === "prs") {
    const [owner, name] = repo.split("/");
    return [{ operation: `page:${tab}`, argv: graphqlArgs("github.com"),
      input: graphqlInput(tab, { owner, name, first: 50, after: null }) }];
  }
  return ["dependabot", "code-scanning", "secret-scanning"].flatMap((source) =>
    [1, 2].map((page) => ({ operation: "tab:security-endpoint",
      argv: ["api", "-i", `repos/${repo}/${source}/alerts?per_page=30&page=${page}`] })));
}

function includedResponse(response) {
  const phrase = response.status === 200 ? "OK" : response.status === 304
    ? "Not Modified" : response.status === 429 ? "Too Many Requests" : "Forbidden";
  return `HTTP/2 ${response.status} ${phrase}\r\n${Object.entries(response.headers)
    .map(([key, value]) => `${key}: ${value}`).join("\r\n")}\r\n\r\n${response.body}`;
}

function oracleExecutor(oracle, request, now, credential, interrupt, onResponse) {
  return () => {
    const child = new EventEmitter();
    child.pid = process.pid;
    const response = handleOracleRequest(oracle, { argv: request.argv,
      input: request.input ?? null, credential, now });
    onResponse?.(response.event, interrupt ? "interrupted" : "success");
    const stdout = includedResponse(response);
    const failure = interrupt || response.status >= 400;
    const pending = failure
      ? Promise.reject(Object.assign(new Error("fixture request interrupted"), { stdout }))
      : Promise.resolve({ stdout });
    pending.child = child;
    queueMicrotask(() => child.emit("close", failure ? 1 : 0));
    return pending;
  };
}

function publishBudgets(scope, leaseId, oracle, clock, credential, onResponse) {
  const account = oracle.accounts[credential === "fixture-second" ? "successor" : "octocat"];
  if (clock >= account.core.resetMs) {
    for (const resource of ["core", "graphql"]) {
      account[resource].used = 0;
      account[resource].remaining = account[resource].limit;
      account[resource].resetMs = clock + HOUR;
    }
  }
  let resets = 0;
  for (const resource of ["core", "graphql"]) {
    const previousEpoch = inspectGovernor(scope, clock).value.epochs[resource];
    const claim = claimProbe(scope, leaseId, clock, resource);
    if (!claim.ok) throw new Error(`probe claim ${resource}: ${claim.reason}`);
    if (claim.value.status !== "claimed") continue;
    const request = resource === "core"
      ? { argv: ["api", "user"] }
      : { argv: ["api", "graphql", "-f", "query=query{rateLimit{cost limit used remaining resetAt}}"] };
    const response = handleOracleRequest(oracle, { ...request, credential, now: clock });
    onResponse?.(response.event, "success");
    if (response.status !== 200) throw new Error(`observer response ${resource}: ${response.status}`);
    const budget = account[resource];
    const published = publishProbe(scope, leaseId, claim.value.nonce, { [resource]: {
      limit: budget.limit, used: budget.used, remaining: budget.remaining,
      resetMs: budget.resetMs, cost: response.event.cost[resource], receivedAt: clock,
    } }, clock, resource);
    if (!published.ok) throw new Error(`probe publication ${resource}: ${published.reason}`);
    if (previousEpoch !== null && published.value.epochs[resource] !== previousEpoch) resets += 1;
  }
  return resets;
}

function initialOracle(limit, principal, accessKey) {
  const budget = () => ({ limit, used: 0, remaining: limit, resetMs: START + HOUR });
  return createOracleState({ now: START, limit,
    accounts: { [principal]: { core: budget(), graphql: budget(), httpRequests: 0,
      secondaryUntil: 0 } },
    credentials: { [principal === "octocat" ? "fixture-full" : "fixture-second"]: {
      principal, accessKey, repositories: ["*"], permissions: ["*"],
    } },
  });
}

const REQUEST_COSTS = Object.freeze({
  "core.observer": 1, "graphql.observer": 1, "actions.runs": 1,
  "issues.page": 2, "pulls.page": 2,
  "security.dependabot": 1, "security.code": 1, "security.secret": 1,
});

function reconciliationFailures(trace) {
  const issues = new Map(trace.issues.map((item) => [item.id, item]));
  const finishes = new Map(trace.finishes.map((item) => [item.id, item]));
  const failures = [];
  if (issues.size !== trace.issues.length || finishes.size !== trace.finishes.length) {
    failures.push("request issue or finish identity was duplicated");
  }
  const requestsByReservation = new Map();
  for (const issue of issues.values()) {
    if (issue.reservationId === null) continue;
    if (!requestsByReservation.has(issue.reservationId)) {
      requestsByReservation.set(issue.reservationId, []);
    }
    requestsByReservation.get(issue.reservationId).push(issue);
  }
  for (const [id, issue] of issues) {
    const finish = finishes.get(id);
    if (!finish || finish.at < issue.at || finish.actualCost > issue.cost || finish.actualCost < 0 ||
        finish.counterDelta !== finish.actualCost) {
      failures.push(`request ${id} lacks a valid finish`);
    }
  }
  if (finishes.size !== issues.size) failures.push("request issue/finish count differs");
  for (const reservation of trace.reservations ?? []) {
    const requests = requestsByReservation.get(reservation.id) ?? [];
    const actual = { core: 0, graphql: 0 };
    for (const request of requests) actual[request.resource] += finishes.get(request.id)?.actualCost ?? 0;
    for (const resource of ["core", "graphql"]) {
      if (actual[resource] > reservation.declaredCost[resource]) {
        failures.push(`reservation ${reservation.id} spent excess ${resource}`);
      }
    }
    if (reservation.status === "success" && requests.length !== reservation.expectedRequests) {
      failures.push(`reservation ${reservation.id} missed a request`);
    }
    if (reservation.status === "success" && (reservation.governorStatus !== "completed" ||
        ["core", "graphql"].some((resource) =>
          reservation.governorActual[resource] !== actual[resource]))) {
      failures.push(`reservation ${reservation.id} governor charge differs from oracle`);
    }
    if (reservation.status === "interrupted" &&
        (reservation.governorStatus === "started" ?
          reservation.governorActual !== null :
          ["core", "graphql"].some((resource) =>
            reservation.governorActual[resource] !== reservation.declaredCost[resource]))) {
      failures.push(`reservation ${reservation.id} lost uncertain charge`);
    }
  }
  for (const source of trace.sources) {
    const finish = finishes.get(source.id);
    if (!finish || finish.status !== "success" || source.at < finish.at ||
        !Number.isSafeInteger(source.generation) || source.generation < 1) {
      failures.push(`source ${source.id} lacks a finished response`);
    }
  }
  const generations = new Map();
  const sourceResponses = new Set();
  for (const source of trace.sources) {
    if (sourceResponses.has(source.id)) failures.push(`source ${source.id} reused a response`);
    sourceResponses.add(source.id);
    if (!source.key) continue;
    const previous = generations.get(source.key) ?? 0;
    if (source.generation <= previous) {
      failures.push(`source ${source.id} generation did not advance`);
    }
    generations.set(source.key, source.generation);
  }
  if (trace.governor) {
    for (const resource of ["core", "graphql"]) {
      if (trace.governor.outstandingUnits?.[resource] <
          (trace.expectedUnterminalizedCharge?.[resource] ?? 0)) {
        failures.push(`${resource} outstanding charge was dropped: ` +
          `expected ${trace.expectedUnterminalizedCharge[resource]}, ` +
          `observed ${trace.governor.outstandingUnits?.[resource]}`);
      }
    }
  }
  return failures;
}

export function reconcileSustainedTrace(trace) {
  const failures = reconciliationFailures(trace);
  return { ok: failures.length === 0, failures };
}

async function runCohort(definition, seed) {
  const root = mkdtempSync(join(tmpdir(), `gh-glance-sustained-${definition.id}-`));
  let clock = START;
  let credential = "fixture-full";
  let accessKey = "a".repeat(64);
  let oracle = initialOracle(definition.limit, "octocat", accessKey);
  let scope = createGovernorScope({ effectiveHost: "github.com",
    authIdentity: `${definition.id}-primary`, env: { XDG_CONFIG_HOME: root },
    now: () => clock }).value;
  const scopes = [scope];
  let timerWake = null;
  const engine = createAcquisitionEngine({ pathOptions: { env: { XDG_CONFIG_HOME: root } },
    now: () => clock, setInterval: (callback) => { timerWake = callback; return 1; },
    clearInterval: () => { timerWake = null; } });
  const queries = [...new Map(definition.panes.map((pane) => [`${pane.repo}:${pane.tab}`, pane])).values()];
  const trace = { issues: [], finishes: [], sources: [], reservations: [],
    expectedUnterminalizedCharge: { core: 0, graphql: 0 } };
  const unterminalizedReceipts = [];
  const issueById = new Map();
  const observeReservation = (trackedScope, id, declaredCost, status, expectedRequests) => {
    const observed = inspectGovernor(trackedScope, clock);
    if (!observed.ok) throw new Error(`reservation inspection: ${observed.reason}`);
    const reservation = observed.value.reservations[id];
    if (!reservation) throw new Error(`reservation vanished before accounting: ${id}`);
    trace.reservations.push({ id, declaredCost, status, expectedRequests,
      governorStatus: reservation.status, governorActual: reservation.actualCosts });
  };
  const latestSource = new Map();
  const sleepSpanningGaps = [];
  const cohortStarts = new Map();
  const paneProgress = definition.panes.map(() => ({ successes: 0, lastAt: null,
    maxGapMs: 0 }));
  let subscriptionIds = [];
  let slept = false;
  let resumeAt = null;
  let resumeBurstRemaining = 0;
  let resumeBurstCursor = 1;
  const resumeFirst = new Map();
  const subscribeCohort = () => {
    subscriptionIds = definition.panes.map((pane, paneIndex) => {
      const subscribed = engine.subscribe(acquisitionQueryForTab(pane.tab,
        { host: "github.com", accessKey }, pane.repo),
      { active: paneIndex === 0, floorMs: definition.cadenceMs }, (snapshot) => {
        const progress = paneProgress[paneIndex];
        if (progress.lastAt !== null && snapshot.lastSuccessAt <= progress.lastAt) return;
        progress.maxGapMs = Math.max(progress.maxGapMs,
          snapshot.lastSuccessAt - (progress.lastAt ?? clock));
        progress.lastAt = snapshot.lastSuccessAt;
        progress.successes += 1;
      });
      if (!subscribed.ok) throw new Error(`persistent subscription: ${subscribed.reason}`);
      return subscribed.value.id;
    });
    for (const pane of definition.panes) {
      const key = `${pane.repo}:${pane.tab}:${credential}`;
      if (!cohortStarts.has(key)) cohortStarts.set(key, clock);
    }
  };
  const tickUntil = (at) => {
    while (clock + 30_000 < at) { clock += 30_000; timerWake?.(); }
    clock = at;
    timerWake?.();
  };
  const advanceTo = (at) => {
    let resumed = false;
    if (definition.sleep && !slept && at >= definition.sleep.at) {
      tickUntil(definition.sleep.at);
      for (const id of subscriptionIds) engine.unsubscribe(id);
      clock = definition.sleep.at + definition.sleep.ms;
      slept = true;
      resumeAt = clock;
      resumeBurstRemaining = queries.length - 1;
      subscribeCohort();
      resumed = true;
    }
    tickUntil(resumed ? clock : Math.max(clock, at));
  };
  const recordRequest = (event, status, reservationId = null) => {
    const id = `${definition.id}:${credential}:${event.sequence}`;
    const resource = event.resource;
    const issue = { id, reservationId, resource,
      cost: REQUEST_COSTS[event.operation], at: event.at };
    if (!Number.isSafeInteger(issue.cost)) throw new Error(`unknown request ${event.operation}`);
    trace.issues.push(issue);
    issueById.set(id, issue);
    trace.finishes.push({ id, status, actualCost: event.cost[resource],
      counterDelta: event.after[resource].used - event.before[resource].used,
      at: event.simulatedCompletedAt });
    return id;
  };
  let admitted = 0;
  let interrupted = 0;
  let resets = 0;
  let maximumLedgerBytes = 0;
  let maximumDetailedReceipts = 0;
  let maximumDebtGroups = 0;
  let identityChanges = 0;
  let admissionDenials = 0;
  const completionFaults = [];
  try {
    subscribeCohort();
    for (let index = 0; index < definition.operations; index += 1) {
      const query = queries[index % queries.length];
      const switchIndex = Math.floor(definition.operations / 2);
      const firstBurst = index < queries.length;
      const switchBurst = definition.identityChange && index >= switchIndex &&
        index < switchIndex + queries.length;
      let plannedAt = firstBurst ? START + index * 5_000 : switchBurst
        ? START + Math.floor(DURATION / 2) + (index - switchIndex) * 5_000 :
        START + 60_000 + Math.floor((index - queries.length) *
          (DURATION - 60_000) / Math.max(1, definition.operations - queries.length - 1));
      if (resumeBurstRemaining > 0) {
        plannedAt = resumeAt + resumeBurstCursor * 5_000;
        resumeBurstRemaining -= 1;
        resumeBurstCursor += 1;
      }
      advanceTo(Math.max(clock, plannedAt));
      if (definition.identityChange && index === switchIndex) {
        for (const id of subscriptionIds) engine.unsubscribe(id);
        credential = "fixture-second";
        accessKey = "b".repeat(64);
        oracle = initialOracle(definition.limit, "successor", accessKey);
        oracle.accounts.successor.core.resetMs = clock + HOUR;
        oracle.accounts.successor.graphql.resetMs = clock + HOUR;
        scope = createGovernorScope({ effectiveHost: "github.com",
          authIdentity: `${definition.id}-successor`, env: { XDG_CONFIG_HOME: root },
          now: () => clock }).value;
        scopes.push(scope);
        identityChanges += 1;
        subscribeCohort();
      }
      const leaseId = deterministicId(seed, definition.id, "lease", index);
      const lease = registerLease(scope, { id: leaseId,
        expiresAt: clock + GOVERNOR_LEASE_TTL_MS, floorMs: 5_000,
        activeTab: query.tab, phaseSeed: { seed: leaseId, registeredAt: clock },
        demand: tabRequestCost(query.tab) });
      if (!lease.ok) throw new Error(`lease ${index}: ${lease.reason}`);
      resets += publishBudgets(scope, leaseId, oracle, clock, credential,
        (event, status) => recordRequest(event, status));
      const resumeBurst = resumeAt !== null && clock <= resumeAt + queries.length * 5_000;
      const completionFault = index === queries.length + 11;
      const interrupt = !firstBurst && !switchBurst && !resumeBurst && !completionFault &&
        (index + seed) % 9 === 0;
      const unterminalizedWindow = interrupt && index % 2 === 0;
      const beforeEvents = oracle.events.length;
      if (unterminalizedWindow) {
        let admittedUnterminalized = admitGovernorOperation(scope, leaseId,
          `tab:${query.tab}`, "active", clock);
        if (admittedUnterminalized.ok && admittedUnterminalized.value.status === "scheduled") {
          advanceTo(Math.max(clock, admittedUnterminalized.value.notBefore));
          admittedUnterminalized = startReservation(scope,
            admittedUnterminalized.value.reservationId, clock);
        }
        if (!admittedUnterminalized.ok || admittedUnterminalized.value.status !== "started") {
          admissionDenials += 1;
          continue;
        }
        admitted += 1;
        interrupted += 1;
        const firstRequest = sourceArgs(query.tab, query.repo)[0];
        const issued = issueGovernorDispatch(scope,
          admittedUnterminalized.value.receiptCapability, firstRequest.operation, clock);
        if (!issued.ok) throw new Error(`unterminalized dispatch: ${issued.reason}`);
        const response = handleOracleRequest(oracle, { argv: firstRequest.argv,
          input: firstRequest.input ?? null, credential, now: clock });
        recordRequest(response.event, "interrupted", admittedUnterminalized.value.reservationId);
        // This virtual owner stops participating after HTTP issue. The harness
        // PID stays live, so no child-close or completion proof exists. The
        // separate real-process crash test proves the SIGKILL boundary.
        const cost = tabRequestCost(query.tab);
        observeReservation(scope, admittedUnterminalized.value.reservationId, cost, "interrupted",
          sourceArgs(query.tab, query.repo).length);
        unterminalizedReceipts.push({ scopeHash: scope.hash,
          id: admittedUnterminalized.value.reservationId, at: clock, cost });
        continue;
      }
      let reservationId = null;
      let faultNonce = null;
      const result = await runAdmittedOperation({ scope, leaseId,
        operation: `tab:${query.tab}`, priority: "active", now: () => clock,
        waitMs: 10_000, wait: async (ms) => { clock += ms; return true; },
        run: async () => {
          const requests = sourceArgs(query.tab, query.repo);
          const metrics = { coreUnits: 0, graphqlUnits: 0 };
          for (const [requestIndex, request] of requests.entries()) {
            await runGh(request.argv, { operation: request.operation,
              input: request.input ?? null,
              execute: oracleExecutor(oracle, request, clock, credential,
                interrupt && requestIndex === requests.length - 1,
                (event, status) => recordRequest(event, status, reservationId)) });
            const event = oracle.events.at(-1);
            metrics.coreUnits += event.cost.core;
            metrics.graphqlUnits += event.cost.graphql;
          }
          if (completionFault) {
            faultNonce = deterministicId(seed, definition.id, "completion-lock", index);
            writeFileSync(`${scope.path}.lock`, JSON.stringify({ pid: process.pid,
              nonce: faultNonce }), { mode: 0o600 });
          }
          return { ok: true, requestMetrics: metrics };
        } });
      if (faultNonce) {
        const beforeRetry = JSON.parse(readFileSync(scope.path, "utf8"));
        if (beforeRetry.reservations[result.reservationId]?.status !== "started") {
          throw new Error("completion fault did not retain the original receipt");
        }
        if (!releaseGovernorLock(`${scope.path}.lock`, faultNonce)) {
          throw new Error("completion fault lock did not release");
        }
        const retryDeadline = Date.now() + 15_000;
        let settled = false;
        while (Date.now() < retryDeadline) {
          const state = inspectGovernor(scope, clock);
          settled = state.ok && state.value.reservations[result.reservationId]?.status === "completed";
          if (settled) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (!settled) throw new Error("completion fault did not retry the original receipt");
        const requestCount = oracle.events.slice(beforeEvents).filter((event) => !event.observer).length;
        if (requestCount !== sourceArgs(query.tab, query.repo).length) {
          throw new Error("completion retry repeated HTTP");
        }
        completionFaults.push({ index, cost: tabRequestCost(query.tab),
          retainedBeforeRetry: true, settledAfterRetry: true, requestCount });
      }
      if (!result.reservationId) { admissionDenials += 1; continue; }
      reservationId = result.reservationId;
      admitted += 1;
      const events = oracle.events.slice(beforeEvents).filter((event) => !event.observer);
      for (const event of events) {
        const issue = issueById.get(`${definition.id}:${credential}:${event.sequence}`);
        if (issue) issue.reservationId = reservationId;
      }
      observeReservation(scope, reservationId, tabRequestCost(query.tab),
        result.ok ? "success" : "interrupted", sourceArgs(query.tab, query.repo).length);
      if (!result.ok) { interrupted += 1; continue; }
      const publisherIndex = definition.panes.findIndex((pane) => pane.repo === query.repo && pane.tab === query.tab);
      const published = await engine.refresh(subscriptionIds[publisherIndex], { force: true,
        acquire: async () => ({ rows: [], pageInfo: null, raw: "[]", entities: [],
          lastSuccessAt: clock, lastChangedAt: clock, nextDueAt: clock + definition.cadenceMs,
          hold: null, capabilities: {}, meta: { at: clock, truncated: false },
          securityNotes: [], securityBlind: false }) });
      if (!published.ok) throw new Error(`acquisition publication: ${published.reason}`);
      const generation = published.value.snapshot.generation;
      const sourceEvent = events.at(-1);
      const id = `${definition.id}:${credential}:${sourceEvent.sequence}`;
      const key = `${query.repo}:${query.tab}:${credential}`;
      trace.sources.push({ id, key, at: clock, generation });
      if (resumeAt !== null && clock >= resumeAt && !resumeFirst.has(key)) {
        resumeFirst.set(key, clock);
      }
      const previous = latestSource.get(key);
      const rawGapMs = previous ? clock - previous.lastAt : clock - cohortStarts.get(key);
      const sleepGapMs = definition.sleep && slept && previous &&
        previous.lastAt <= definition.sleep.at && clock >= resumeAt
        ? definition.sleep.ms : 0;
      if (sleepGapMs > 0) sleepSpanningGaps.push({
        queryIndex: queries.findIndex((item) => item.repo === query.repo && item.tab === query.tab),
        rawGapMs,
        eligibleGapMs: rawGapMs - sleepGapMs, excludedSleepMs: sleepGapMs });
      latestSource.set(key, { firstAt: previous?.firstAt ?? clock,
        lastAt: clock, maximumRawGapMs: Math.max(previous?.maximumRawGapMs ?? 0, rawGapMs),
        maximumEligibleGapMs: Math.max(previous?.maximumEligibleGapMs ?? 0,
          rawGapMs - sleepGapMs),
        successes: (previous?.successes ?? 0) + 1 });
      if (index % 100 === 0 || index === definition.operations - 1) {
        for (const tracked of scopes) {
          const state = inspectGovernor(tracked, clock);
          if (!state.ok) throw new Error(`ledger inspection: ${state.reason}`);
          maximumLedgerBytes = Math.max(maximumLedgerBytes, statSync(tracked.path).size);
          maximumDetailedReceipts = Math.max(maximumDetailedReceipts,
            Object.values(state.value.reservations).filter((item) => item.receipt).length);
          maximumDebtGroups = Math.max(maximumDebtGroups, Object.keys(state.value.debtGroups).length);
        }
      }
    }
    const unresolvedUnits = { core: 0, graphql: 0 };
    const detailedStartedUnits = { core: 0, graphql: 0 };
    let detailedUnterminalizedReceipts = 0;
    let detailedUnterminalizedDispatches = 0;
    for (const tracked of scopes) {
      const state = inspectGovernor(tracked, clock);
      if (!state.ok) throw new Error(`final ledger: ${state.reason}`);
      for (const resource of ["core", "graphql"]) {
        unresolvedUnits[resource] += state.value.debt[resource].unresolvedUnits +
          state.value.debt[resource].quiescentUnits;
      }
      for (const [id, reservation] of Object.entries(state.value.reservations)) {
        if (reservation.status !== "started" || !reservation.receipt) continue;
        for (const resource of ["core", "graphql"]) {
          detailedStartedUnits[resource] += reservation.costs[resource];
        }
        if (unterminalizedReceipts.some((item) =>
          item.scopeHash === tracked.hash && item.id === id)) {
          detailedUnterminalizedReceipts += 1;
          detailedUnterminalizedDispatches += reservation.receipt.dispatches.filter((item) =>
            item.terminalAt === null).length;
        }
      }
    }
    // An uncertain charge may be released one window after its debt group's
    // newest charge, which is never earlier than the charge itself. Only the
    // charges issued within the final window must therefore still be held.
    for (const receipt of unterminalizedReceipts) {
      if (clock - receipt.at >= IDENTITY_UNCERTAIN_MAX_MS) continue;
      trace.expectedUnterminalizedCharge.core += receipt.cost.core;
      trace.expectedUnterminalizedCharge.graphql += receipt.cost.graphql;
    }
    const outstandingUnits = { core: unresolvedUnits.core + detailedStartedUnits.core,
      graphql: unresolvedUnits.graphql + detailedStartedUnits.graphql };
    trace.governor = { outstandingUnits };
    const firstSuccessDelayMs = Math.max(...[...latestSource.entries()]
      .map(([key, source]) => source.firstAt - cohortStarts.get(key)));
    const maximumRawSourceGapMs = Math.max(...[...latestSource.values()]
      .map((source) => source.maximumRawGapMs));
    const maximumSourceGapMs = Math.max(...[...latestSource.values()]
      .map((source) => source.maximumEligibleGapMs));
    const resumeDelayMs = resumeAt === null ? null : Math.max(...[...cohortStarts.keys()]
      .map((key) => (resumeFirst.get(key) ?? Number.POSITIVE_INFINITY) - resumeAt));
    const allowedSourceGapMs = definition.cadenceMs + Math.max(2 * definition.cadenceMs, 15_000);
    const missingSources = [...cohortStarts.keys()].filter((key) => !latestSource.has(key));
    if (missingSources.length) throw new Error(`missing source success: ${missingSources.join(",")}`);
    if (firstSuccessDelayMs > 60_000) throw new Error(`first source success late: ${firstSuccessDelayMs}`);
    const paneCoverage = paneProgress.map((progress, index) => ({ pane: index,
      successes: progress.successes, maximumGapMs: progress.maxGapMs }));
    if (paneCoverage.some((pane) => pane.successes === 0)) throw new Error("pane lacked source publication");
    return { id: definition.id, panes: definition.panes.length,
      plannedOperations: definition.operations, limit: definition.limit,
      declaredCadenceMs: definition.cadenceMs, sleepMs: definition.sleep?.ms ?? 0,
      duplicateRepositories: definition.panes.some((pane, index) =>
        definition.panes.findIndex((other) => other.repo === pane.repo && other.tab === pane.tab) < index),
      tabs: [...new Set(definition.panes.map((pane) => pane.tab))], admitted,
      interrupted, resets, identityChanges, admissionDenials,
      completionFaults,
      unterminalizedCharge: trace.expectedUnterminalizedCharge,
      outstandingCharge: outstandingUnits,
      aggregateDebt: unresolvedUnits, detailedStartedUnits,
      unterminalizedReceipts: unterminalizedReceipts.length,
      detailedUnterminalizedReceipts,
      detailedUnterminalizedDispatches,
      firstSuccessDelayMs, resumeDelayMs, maximumRawSourceGapMs,
      maximumSourceGapMs, allowedSourceGapMs, sleepSpanningGaps,
      sourceCadenceMet: maximumSourceGapMs <= allowedSourceGapMs,
      paneCoverage, peakSampling: { operationStride: 100, includesFinal: true },
      maximumSampledLedgerBytes: maximumLedgerBytes,
      maximumSampledDetailedReceipts: maximumDetailedReceipts,
      maximumSampledDebtGroups: maximumDebtGroups,
      sourceSuccesses: trace.sources.length,
      externalRequests: trace.finishes.length,
      reconciliation: reconcileSustainedTrace(trace) };
  } finally {
    engine.close();
    rmSync(root, { recursive: true, force: true });
  }
}

export async function runSustainedRecovery({ seed = 0x20260928,
  operationsPerCohort = null } = {}) {
  if (!Number.isSafeInteger(seed)) throw new Error("invalid sustained fixture seed");
  const cohorts = [];
  for (const definition of COHORTS) {
    cohorts.push(await runCohort({ ...definition,
      operations: operationsPerCohort?.[definition.id] ?? definition.operations }, seed));
  }
  return { schema: 1, kind: "sustained-recovery", seed, durationMs: DURATION,
    cohorts, admitted: cohorts.reduce((sum, item) => sum + item.admitted, 0),
    interrupted: cohorts.reduce((sum, item) => sum + item.interrupted, 0),
    resets: cohorts.reduce((sum, item) => sum + item.resets, 0),
    peakSampling: { operationStride: 100, includesFinal: true },
    maximumSampledLedgerBytes: Math.max(...cohorts.map((item) => item.maximumSampledLedgerBytes)),
    maximumSampledDetailedReceipts: Math.max(...cohorts.map((item) => item.maximumSampledDetailedReceipts)),
    maximumSampledDebtGroups: Math.max(...cohorts.map((item) => item.maximumSampledDebtGroups)),
    reconciliation: { ok: cohorts.every((item) => item.reconciliation.ok),
      failures: cohorts.flatMap((item) => item.reconciliation.failures) } };
}
