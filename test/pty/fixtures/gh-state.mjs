#!/usr/bin/env node
import {
  appendFileSync,
  linkSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";

import { graphqlHeaders, graphqlResponseFor, readGraphqlDocument } from "./graphql-response.mjs";

if (process.env.GH_GLANCE_REQUEST_ORACLE) {
  const { runOracleFixture } = await import("../../fixtures/request-oracle.mjs");
  await runOracleFixture();
  process.exit(process.exitCode ?? 0);
}

const statePath = process.env.GH_GLANCE_FIXTURE_STATE;
const args = process.argv.slice(2);
// An isolated test account file models a local gh account switch. It is read
// once per child, so a delayed response keeps the account selected at start.
const accountFixture = process.env.GH_GLANCE_FIXTURE_ACCOUNT_FILE
  ? JSON.parse(readFileSync(process.env.GH_GLANCE_FIXTURE_ACCOUNT_FILE, "utf8")) : null;
// Token lookup is local credential access, not a synthetic HTTP operation.
if (args[0] === "auth" && args[1] === "token") {
  process.stdout.write(`${accountFixture?.token ?? process.env.GH_GLANCE_FIXTURE_TOKEN ?? "fixture-keyring-token"}\n`);
  process.exit(0);
}
const fixtures = dirname(new URL(import.meta.url).pathname);
const waitCell = new Int32Array(new SharedArrayBuffer(4));
const RATE_RESOURCES = ["core", "graphql"];

function parseApiInvocation(argv) {
  if (argv[0] !== "api") return null;
  let path = null;
  let include = false;
  let ifNoneMatch = null;
  let hostname = null;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (["-i", "--include"].includes(argument)) {
      include = true;
      continue;
    }
    if (["-H", "--header"].includes(argument)) {
      const header = argv[index + 1] ?? "";
      index += 1;
      const match = /^if-none-match:\s*(.+)$/i.exec(header);
      if (match) ifNoneMatch = match[1];
      continue;
    }
    const inlineHeader = /^-H(.+)$/.exec(argument);
    if (inlineHeader) {
      const match = /^if-none-match:\s*(.+)$/i.exec(inlineHeader[1]);
      if (match) ifNoneMatch = match[1];
      continue;
    }
    if (["--hostname", "--jq", "-X", "--method", "-f", "--raw-field", "-F", "--field", "--input"]
      .includes(argument)) {
      // The host is needed to build row URLs that will survive the app's
      // host admission, so it is captured rather than merely skipped.
      if (argument === "--hostname") hostname = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    const inlineHost = /^--hostname=(.+)$/.exec(argument);
    if (inlineHost) { hostname = inlineHost[1]; continue; }
    if (/^(?:--hostname|--jq|--method|--raw-field|--field|--input)=/.test(argument) ||
      argument.startsWith("-")) continue;
    if (path === null) path = argument;
  }
  return { path, include, ifNoneMatch, hostname };
}

const apiInvocation = parseApiInvocation(args);

// A GraphQL document arrives on stdin, so it must be read before anything
// decides what this invocation costs: an observer and a data page share one
// argv and have very different prices.
const graphqlDocument = apiInvocation?.path === "graphql"
  ? readGraphqlDocument(readStdin())
  : null;
const graphqlAnswer = graphqlDocument
  // Hard-coding github.com made every row URL fail host admission under an
  // enterprise capture, so Enter would silently do nothing there.
  ? graphqlResponseFor(graphqlDocument, { host: apiInvocation?.hostname ?? "github.com" })
  : null;

// The shell fixture logs argv for every call, but argv cannot distinguish an
// observer from a page. Both fixture paths therefore log the parsed operation
// in the same form, so a test written against one works against the other.
if (graphqlAnswer && process.env.GH_GLANCE_FIXTURE_LOG && process.env.GH_GLANCE_FIXTURE_LOG !== "/dev/null") {
  const shape = graphqlDocument.ok ? graphqlDocument.shape : null;
  try {
    appendFileSync(process.env.GH_GLANCE_FIXTURE_LOG,
      `graphql ${graphqlAnswer.operation} first=${shape?.pageSize ?? "-"} after=${shape?.cursor ?? "-"}\n`);
  } catch { /* the log is diagnostic; never fail a response over it */ }
}

function bodyEtag(body) {
  return `"fixture-${createHash("sha256").update(body).digest("hex").slice(0, 16)}"`;
}

function defaultApiBody(path) {
  if (path === "user") return JSON.stringify({
    id: Number(process.env.GH_GLANCE_FIXTURE_USER_ID ?? 1),
    login: process.env.GH_GLANCE_FIXTURE_LOGIN ?? "octocat",
  });
  if (path?.includes("/actions/runs?")) {
    return readFileSync(join(fixtures, "actions-runs.json"), "utf8");
  }
  if (path?.includes("/actions/workflows?")) {
    return readFileSync(join(fixtures, "actions-workflows.json"), "utf8");
  }
  return "[]\n";
}

function apiEntity(state, path, fallback) {
  const user = accountFixture?.user ?? state.user;
  if (path === "user" && user) {
    const body = JSON.stringify(user);
    fallback = { body, etag: bodyEtag(body) };
  }
  const configured = accountFixture?.apiEntities?.[path] ?? state.apiEntities?.[path];
  let entity = configured;
  if (Array.isArray(configured?.sequence) && configured.sequence.length > 0) {
    const sequenceIndex = Math.min(configured.calls ?? 0, configured.sequence.length - 1);
    entity = configured.sequence[sequenceIndex];
    configured.calls = (configured.calls ?? 0) + 1;
  }
  const configuredBody = typeof entity?.body === "string";
  const body = configuredBody ? entity.body : fallback.body;
  const etag = typeof entity?.etag === "string"
    ? entity.etag
    : configuredBody ? bodyEtag(body) : fallback.etag;
  return {
    status: apiInvocation?.ifNoneMatch === etag ? 304 : 200,
    etag,
    body,
  };
}

const fallbackApiEntity = apiInvocation?.path && apiInvocation.path !== "rate_limit"
  ? (() => {
      const body = defaultApiBody(apiInvocation.path);
      return { body, etag: bodyEtag(body) };
    })()
  : null;

function writeExclusive(path, contents) {
  const candidate = `${path}.candidate-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(candidate, contents, { mode: 0o600 });
    linkSync(candidate, path);
  } finally {
    rmSync(candidate, { force: true });
  }
}

function normalizeOwner(owner) {
  if (!owner || typeof owner !== "object" || Array.isArray(owner)) return null;
  const keys = Object.keys(owner).sort();
  return keys.length === 2 && keys[0] === "nonce" && keys[1] === "pid" &&
    Number.isSafeInteger(owner.pid) && owner.pid > 0 &&
    typeof owner.nonce === "string" && owner.nonce.length > 0 ? owner : null;
}

function lockOwner(path) {
  try {
    return normalizeOwner(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

function ownerIsDead(owner) {
  if (!owner) return false;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    return error?.code === "ESRCH";
  }
}

function pidIsDead(pid) {
  return ownerIsDead({ pid, nonce: "fixture-process" });
}

function removeOwned(path, nonce) {
  try {
    if (lockOwner(path)?.nonce === nonce) rmSync(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function recoveryPaths(lock) {
  try {
    const prefix = `${basename(lock)}.recovery-`;
    return readdirSync(dirname(lock))
      .filter((name) => name.startsWith(prefix))
      .map((name) => join(dirname(lock), name));
  } catch {
    return [];
  }
}

function recoveryActive(lock) {
  let active = false;
  for (const path of recoveryPaths(lock)) {
    const owner = lockOwner(path);
    if (!ownerIsDead(owner)) active = true;
    else removeOwned(path, owner.nonce);
  }
  return active || recoveryPaths(lock).length > 0;
}

function sameOwner(left, right) {
  return Boolean(left) && Boolean(right) && left.pid === right.pid && left.nonce === right.nonce;
}

function quarantineDeadLock(lock, expected) {
  const recoveryOwner = { pid: process.pid, nonce: randomUUID() };
  const recovery = `${lock}.recovery-${recoveryOwner.nonce}`;
  try {
    writeExclusive(recovery, `${JSON.stringify(recoveryOwner)}\n`);
  } catch (error) {
    if (error?.code === "EEXIST") return;
    throw error;
  }
  const quarantine = `${lock}.quarantine-${randomUUID()}`;
  try {
    const confirmed = lockOwner(lock);
    if (!sameOwner(confirmed, expected) || !ownerIsDead(confirmed)) return;
    const beforeRename = lockOwner(lock);
    if (!sameOwner(beforeRename, expected)) return;
    renameSync(lock, quarantine);
    const quarantined = lockOwner(quarantine);
    if (!sameOwner(quarantined, expected)) {
      renameSync(quarantine, lock);
      return;
    }
    rmSync(quarantine);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  } finally {
    removeOwned(recovery, recoveryOwner.nonce);
  }
}

function acquireLock() {
  const lock = `${statePath}.lock`;
  for (;;) {
    if (recoveryActive(lock)) {
      Atomics.wait(waitCell, 0, 0, 5);
      continue;
    }
    const owner = { pid: process.pid, nonce: randomUUID() };
    const serialized = `${JSON.stringify(owner)}\n`;
    try {
      writeExclusive(lock, serialized);
      if (recoveryActive(lock)) {
        removeOwned(lock, owner.nonce);
        Atomics.wait(waitCell, 0, 0, 5);
        continue;
      }
      return { lock, owner };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }

    let observed;
    let parsed;
    try {
      observed = readFileSync(lock, "utf8");
      parsed = normalizeOwner(JSON.parse(observed));
    } catch (error) {
      if (error?.code !== "ENOENT") Atomics.wait(waitCell, 0, 0, 5);
      continue;
    }
    if (!ownerIsDead(parsed)) {
      Atomics.wait(waitCell, 0, 0, 5);
      continue;
    }
    quarantineDeadLock(lock, parsed);
  }
}

function withLock(run) {
  const acquired = acquireLock();
  try {
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    const value = run(state);
    const temporary = `${statePath}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    renameSync(temporary, statePath);
    return value;
  } finally {
    removeOwned(acquired.lock, acquired.owner.nonce);
  }
}

function readStdin() {
  try { return readFileSync(0, "utf8"); } catch { return ""; }
}

function selector() {
  if (args[0] === "api" && apiInvocation?.path === "rate_limit") return "rate_limit";
  if (args[0] === "api" && apiInvocation?.path === "user") return "core-observer";
  // The observer is control-plane work and a page is data. Charging them alike,
  // or calling both simply "graphql", is the generic treatment this fixture
  // exists to stop.
  if (args[0] === "api" && apiInvocation?.path === "graphql") {
    return graphqlAnswer?.operation === "graphql.observer" ? "graphql-observer" : "graphql-data";
  }
  if (args[0] === "api" && apiInvocation?.path?.includes("/actions/")) return "actions";
  if (args[0] === "api") return "security";
  if (["run", "repo", "auth"].includes(args[0])) return args[0];
  return args[0] ?? "unknown";
}

function cost(apiResponse = null) {
  if ([304, 403, 429].includes(apiResponse?.status)) return { core: 0, graphql: 0 };
  if (args[0] === "run") return { core: 2, graphql: 0 };
  // Priced from the document actually sent, not from the command shape: a page
  // and an observer differ, and a rejected document buys nothing.
  if (graphqlAnswer) return { core: 0, graphql: graphqlAnswer.cost };
  if (args[0] === "repo" && args[1] === "view") return { core: 0, graphql: 1 };
  if (args[0] === "api" && args[1] !== "rate_limit") return { core: 1, graphql: 0 };
  return { core: 0, graphql: 0 };
}

function commandDelay(state, command) {
  const configured = state.delayByCommand?.[command] ?? state.delayMs ?? 0;
  if (typeof configured === "number") return configured;
  if (
    configured && typeof configured === "object" &&
    Number.isFinite(configured.ms) && configured.ms >= 0 &&
    Number.isSafeInteger(configured.remaining) && configured.remaining > 0
  ) {
    configured.remaining -= 1;
    return configured.ms;
  }
  return 0;
}

function resourceSnapshot(state, resources = RATE_RESOURCES) {
  return Object.fromEntries(resources.map((resource) => {
    const budget = state[resource];
    return [resource, budget ? {
      limit: budget.limit,
      used: budget.used,
      remaining: budget.remaining,
      resetMs: budget.resetMs,
    } : null];
  }));
}

function pruneDeadInflight(state) {
  state.inFlight ??= {};
  let active = 0;
  const dataOwners = new Set();
  for (const [id, item] of Object.entries(state.inFlight)) {
    if (pidIsDead(item?.pid)) {
      delete state.inFlight[id];
      continue;
    }
    active += 1;
    if (item.isData) dataOwners.add(item.ownerPid ?? item.pid);
  }
  state.active = active;
  state.dataActive = dataOwners.size;
}

function applyResetSequence(state, now) {
  const elapsed = now - (state.createdAt ?? now);
  for (const step of state.resetSequence ?? []) {
    if (step.offsetMs <= elapsed && !step.applied) {
      for (const resource of RATE_RESOURCES) {
        if (!step[resource]) continue;
        const { resetOffsetMs, ...budget } = step[resource];
        Object.assign(state[resource], budget);
        if (Number.isFinite(resetOffsetMs)) {
          state[resource].resetMs = state.createdAt + resetOffsetMs;
        }
      }
      step.applied = true;
    }
  }
}

if (args[0] === "--fixture-burn") {
  const resource = args[1];
  const amount = Number(args[2]);
  if (!["core", "graphql"].includes(resource) || !Number.isSafeInteger(amount) || amount <= 0) {
    process.stderr.write("usage: gh-state.mjs --fixture-burn <core|graphql> <positive integer>\n");
    process.exit(2);
  }
  const event = withLock((state) => {
    const now = Date.now();
    state.createdAt ??= now;
    state.events ??= [];
    state.sequence = (state.sequence ?? 0) + 1;
    pruneDeadInflight(state);
    applyResetSequence(state, now);
    const before = resourceSnapshot(state, [resource]);
    const budget = state[resource];
    if (!budget) throw new Error(`missing fixture ${resource} budget`);
    budget.used += amount;
    budget.remaining = Math.max(0, budget.remaining - amount);
    const burn = {
      sequence: state.sequence,
      type: "external-burn",
      at: now,
      pid: process.pid,
      ownerPid: process.ppid,
      pane: process.env.GH_GLANCE_FIXTURE_PANE ?? null,
      resource,
      amount,
      before,
      after: resourceSnapshot(state, [resource]),
    };
    state.events.push(burn);
    return burn;
  });
  process.stdout.write(`${JSON.stringify(event)}\n`);
  process.exit(0);
}

// Each Actions endpoint is an independent HTTP request. Its fixture must not
// wait for a sibling request: the caller may hold the host's sole HTTP permit.
const started = withLock((state) => {
  const now = Date.now();
  const isBudgetObserver = args[0] === "api" && ["rate_limit", "user"].includes(apiInvocation?.path);
  if (state.anchorAtFirstProbe === true && isBudgetObserver && !Number.isFinite(state.createdAt)) {
    state.createdAt = now;
    for (const resource of RATE_RESOURCES) {
      const resetOffsetMs = state[resource]?.resetOffsetMs;
      if (!Number.isFinite(resetOffsetMs)) continue;
      state[resource].resetMs = now + resetOffsetMs;
      delete state[resource].resetOffsetMs;
    }
  }
  if (state.anchorAtFirstProbe !== true) state.createdAt ??= now;
  state.events ??= [];
  state.sequence = (state.sequence ?? 0) + 1;
  state.inFlight ??= {};
  const sequence = state.sequence;
  applyResetSequence(state, now);
  const apiResponse = selector() === "rate_limit" || apiInvocation === null || graphqlAnswer !== null
    ? null
    : apiEntity(state, apiInvocation.path, fallbackApiEntity);
  if (selector() === "core-observer" && state.core.remaining === 0) apiResponse.status = 403;
  const debit = cost(apiResponse);
  const isData = debit.core > 0 || debit.graphql > 0;
  state.inFlight[sequence] = {
    pid: process.pid,
    ownerPid: process.ppid,
    pane: process.env.GH_GLANCE_FIXTURE_PANE ?? null,
    isData,
    startedAt: now,
  };
  pruneDeadInflight(state);
  state.maxConcurrency = Math.max(state.maxConcurrency ?? 0, state.active);
  const chargedResources = RATE_RESOURCES.filter((resource) => debit[resource] > 0);
  const before = isData ? resourceSnapshot(state, chargedResources) : null;
  for (const resource of RATE_RESOURCES) {
    const budget = state[resource];
    if (!budget || debit[resource] === 0) continue;
    budget.used += debit[resource];
    budget.remaining = Math.max(0, budget.remaining - debit[resource]);
  }
  const after = isData ? resourceSnapshot(state, chargedResources) : null;
  if (isData) {
    state.maxDataConcurrency = Math.max(state.maxDataConcurrency ?? 0, state.dataActive);
  }
  const failure = state.failure;
  const fail = failure && failure.remaining > 0 && failure.selector === selector();
  if (fail) failure.remaining -= 1;
  state.events.push({
    sequence,
    type: "start",
    at: now,
    pid: process.pid,
    ownerPid: process.ppid,
    pane: process.env.GH_GLANCE_FIXTURE_PANE ?? null,
    argv: args,
    // argv cannot tell an observer from a page -- both are `api -i graphql
    // --input -` -- so the operation is recorded from the parsed document.
    // Without it a test can only assert that "some GraphQL happened".
    ...(graphqlAnswer ? { graphqlOperation: graphqlAnswer.operation } : {}),
    cost: debit,
    ...(isData ? { before, after } : {}),
  });
  return {
    sequence,
    delayMs: commandDelay(state, selector()),
    fail,
    message: failure?.message ?? "fixture failure",
    budgets: { core: state.core, graphql: state.graphql },
    isData,
    apiResponse,
  };
});

if (started.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, started.delayMs));

withLock((state) => {
  state.inFlight ??= {};
  delete state.inFlight[started.sequence];
  pruneDeadInflight(state);
  state.events.push({
    sequence: started.sequence,
    type: "end",
    at: Date.now(),
    pid: process.pid,
    ownerPid: process.ppid,
    pane: process.env.GH_GLANCE_FIXTURE_PANE ?? null,
    argv: args,
    failed: started.fail,
    ...(started.apiResponse ? { status: started.apiResponse.status } : {}),
  });
});

if (started.fail) {
  process.stderr.write(`${started.message}\n`);
  process.exit(1);
}

switch (selector()) {
  case "rate_limit": {
    const graphql = started.budgets.graphql;
    const resources = {
      core: {
        limit: started.budgets.core.limit,
        used: 0,
        remaining: started.budgets.core.limit,
        reset: Math.floor(Date.now() / 1000) + 3600,
      },
      graphql: {
        limit: graphql.limit,
        used: graphql.used,
        remaining: graphql.remaining,
        reset: Math.floor(graphql.resetMs / 1000),
      },
    };
    process.stdout.write(`${JSON.stringify({ resources })}\n`);
    break;
  }
  case "run":
    process.stdout.write(readFileSync(join(fixtures, "runs.json"), "utf8"));
    break;
  case "repo":
    process.stdout.write('{"nameWithOwner":"acme/widget","url":"https://github.com/acme/widget","viewerPermission":"READ"}\n');
    break;
  case "auth":
    process.stdout.write(args.includes("--json")
      ? '[{"host":"github.com","login":"octocat"}]\n'
      : "github.com\n  Logged in to github.com account octocat (keyring)\n");
    break;
  case "--version":
    process.stdout.write("gh version 2.97.0 (fixture)\n");
    break;
  case "graphql-observer":
  case "graphql-data": {
    const graphql = started.budgets.graphql;
    process.stdout.write(graphqlHeaders(graphqlAnswer.status, {
      limit: graphql.limit,
      used: graphql.used,
      remaining: graphql.remaining,
      resetMs: graphql.resetMs,
    }));
    // The envelope's own meter is what the app settles on, so it has to agree
    // with the ledger this fixture keeps rather than be invented per call.
    const envelope = JSON.parse(graphqlAnswer.body);
    if (envelope.data?.rateLimit) {
      envelope.data.rateLimit = {
        cost: graphqlAnswer.cost,
        limit: graphql.limit,
        used: graphql.used,
        remaining: graphql.remaining,
        resetAt: new Date(graphql.resetMs).toISOString(),
      };
    }
    process.stdout.write(JSON.stringify(envelope));
    break;
  }
  default:
    if (started.apiResponse) {
      if (apiInvocation.include) {
        const phrase = started.apiResponse.status === 304
          ? "Not Modified"
          : started.apiResponse.status === 403 ? "Forbidden" : "OK";
        process.stdout.write(
          `HTTP/2 ${started.apiResponse.status} ${phrase}\r\n` +
          `etag: ${started.apiResponse.etag}\r\n` +
          `x-ratelimit-limit: ${started.budgets.core.limit}\r\n` +
          `x-ratelimit-used: ${started.budgets.core.used}\r\n` +
          `x-ratelimit-remaining: ${started.budgets.core.remaining}\r\n` +
          `x-ratelimit-reset: ${Math.floor(started.budgets.core.resetMs / 1000)}\r\n` +
          "x-ratelimit-resource: core\r\n\r\n",
        );
      }
      if (started.apiResponse.status === 200) process.stdout.write(started.apiResponse.body);
      else process.exitCode = 1;
    } else {
      process.stdout.write("[]\n");
    }
}
