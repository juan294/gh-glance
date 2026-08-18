#!/usr/bin/env node
import {
  linkSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";

const statePath = process.env.GH_GLANCE_FIXTURE_STATE;
const args = process.argv.slice(2);
const fixtures = dirname(new URL(import.meta.url).pathname);
const waitCell = new Int32Array(new SharedArrayBuffer(4));
const RATE_RESOURCES = ["core", "graphql"];

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

function selector() {
  if (args[0] === "api" && args[1] === "rate_limit") return "rate_limit";
  if (args[0] === "api") return "security";
  if (["run", "issue", "pr", "repo", "auth"].includes(args[0])) return args[0];
  return args[0] ?? "unknown";
}

function cost() {
  if (args[0] === "run") return { core: 2, graphql: 0 };
  if (["issue", "pr"].includes(args[0])) return { core: 0, graphql: 2 };
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
  let dataActive = 0;
  for (const [id, item] of Object.entries(state.inFlight)) {
    if (pidIsDead(item?.pid)) {
      delete state.inFlight[id];
      continue;
    }
    active += 1;
    if (item.isData) dataActive += 1;
  }
  state.active = active;
  state.dataActive = dataActive;
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

const started = withLock((state) => {
  const now = Date.now();
  const isRateProbe = args[0] === "api" && args[1] === "rate_limit";
  if (state.anchorAtFirstProbe === true && isRateProbe && !Number.isFinite(state.createdAt)) {
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
  pruneDeadInflight(state);
  const sequence = state.sequence;
  const debit = cost();
  const isData = debit.core > 0 || debit.graphql > 0;
  state.inFlight[sequence] = {
    pid: process.pid,
    ownerPid: process.ppid,
    pane: process.env.GH_GLANCE_FIXTURE_PANE ?? null,
    isData,
    startedAt: now,
  };
  state.active += 1;
  if (isData) state.dataActive += 1;
  state.maxConcurrency = Math.max(state.maxConcurrency ?? 0, state.active);
  applyResetSequence(state, now);
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
  });
});

if (started.fail) {
  process.stderr.write(`${started.message}\n`);
  process.exit(1);
}

switch (selector()) {
  case "rate_limit": {
    const resources = Object.fromEntries(["core", "graphql"].map((resource) => {
      const budget = started.budgets[resource];
      return [resource, {
        limit: budget.limit,
        used: budget.used,
        remaining: budget.remaining,
        reset: Math.floor(budget.resetMs / 1000),
      }];
    }));
    process.stdout.write(`${JSON.stringify({ resources })}\n`);
    break;
  }
  case "run":
    process.stdout.write(readFileSync(join(fixtures, "runs.json"), "utf8"));
    break;
  case "issue":
    process.stdout.write(readFileSync(join(fixtures, "issues.json"), "utf8"));
    break;
  case "pr":
    process.stdout.write(readFileSync(join(fixtures, "prs.json"), "utf8"));
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
  default:
    process.stdout.write("[]\n");
}
