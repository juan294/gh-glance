#!/usr/bin/env node
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const statePath = process.env.GH_GLANCE_FIXTURE_STATE;
const args = process.argv.slice(2);
const fixtures = dirname(new URL(import.meta.url).pathname);
const waitCell = new Int32Array(new SharedArrayBuffer(4));

function withLock(run) {
  const lock = `${statePath}.lock`;
  for (;;) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      Atomics.wait(waitCell, 0, 0, 5);
    }
  }
  try {
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    const value = run(state);
    const temporary = `${statePath}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    renameSync(temporary, statePath);
    return value;
  } finally {
    rmSync(lock, { recursive: true, force: true });
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

function applyResetSequence(state, now) {
  const elapsed = now - (state.createdAt ?? now);
  for (const step of state.resetSequence ?? []) {
    if (step.offsetMs <= elapsed && !step.applied) {
      for (const resource of ["core", "graphql"]) {
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

const started = withLock((state) => {
  const now = Date.now();
  const isRateProbe = args[0] === "api" && args[1] === "rate_limit";
  if (state.anchorAtFirstProbe === true && isRateProbe && !Number.isFinite(state.createdAt)) {
    state.createdAt = now;
    for (const resource of ["core", "graphql"]) {
      const resetOffsetMs = state[resource]?.resetOffsetMs;
      if (!Number.isFinite(resetOffsetMs)) continue;
      state[resource].resetMs = now + resetOffsetMs;
      delete state[resource].resetOffsetMs;
    }
  }
  if (state.anchorAtFirstProbe !== true) state.createdAt ??= now;
  state.events ??= [];
  state.sequence = (state.sequence ?? 0) + 1;
  state.active = (state.active ?? 0) + 1;
  state.maxConcurrency = Math.max(state.maxConcurrency ?? 0, state.active);
  applyResetSequence(state, now);
  const debit = cost();
  for (const resource of ["core", "graphql"]) {
    const budget = state[resource];
    if (!budget || debit[resource] === 0) continue;
    budget.used += debit[resource];
    budget.remaining = Math.max(0, budget.remaining - debit[resource]);
  }
  const failure = state.failure;
  const fail = failure && failure.remaining > 0 && failure.selector === selector();
  if (fail) failure.remaining -= 1;
  state.events.push({
    sequence: state.sequence,
    type: "start",
    at: now,
    pid: process.pid,
    pane: process.env.GH_GLANCE_FIXTURE_PANE ?? null,
    argv: args,
    cost: debit,
  });
  return {
    sequence: state.sequence,
    delayMs: state.delayByCommand?.[selector()] ?? state.delayMs ?? 0,
    fail,
    message: failure?.message ?? "fixture failure",
    budgets: { core: state.core, graphql: state.graphql },
  };
});

if (started.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, started.delayMs));

withLock((state) => {
  state.active = Math.max(0, (state.active ?? 1) - 1);
  state.events.push({
    sequence: started.sequence,
    type: "end",
    at: Date.now(),
    pid: process.pid,
    pane: process.env.GH_GLANCE_FIXTURE_PANE ?? null,
    argv: args,
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
