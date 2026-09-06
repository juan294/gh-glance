import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { createOracleState, oracleEnvironment } from "../fixtures/request-oracle.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "gh");
const RUNS_PATH = "repos/acme/widget/actions/runs?exclude_pull_requests=true&per_page=100";

function invoke(args, env = {}) {
  return spawnSync(FIXTURE, args, {
    encoding: "utf8",
    env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: tmpdir(), GH_CONFIG_DIR: tmpdir(), GH_GLANCE_FIXTURE_LOG: "/dev/null", ...env },
  });
}

function etag(stdout) {
  return /^etag:\s*(.+)$/im.exec(stdout)?.[1].trim() ?? null;
}

test("the shell fixture finds API paths and conditional headers independent of flag position", () => {
  const first = invoke(["api", "--hostname", "github.com", "-i", RUNS_PATH, "--jq", "."]);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /^HTTP\/2 200 OK\r?$/m);
  assert.match(first.stdout, /ci: pin actions to commit SHAs/);
  const entityTag = etag(first.stdout);
  assert.ok(entityTag);

  const second = invoke([
    "api",
    "-H",
    `If-None-Match: ${entityTag}`,
    "--jq",
    ".",
    "--include",
    RUNS_PATH,
    "--hostname=github.com",
  ]);
  assert.equal(second.status, 1);
  assert.match(second.stdout, /^HTTP\/2 304 Not Modified\r?$/m);
  assert.doesNotMatch(second.stdout, /ci: pin actions/);
});

test("the shared fixture makes conditional core observations free and pins rate_limit core wrong", (t) => {
  const root = mkdtempSync(join(tmpdir(), "gh-glance-fixture-api-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const statePath = join(root, "state.json");
  const now = Date.now();
  writeFileSync(statePath, `${JSON.stringify({
    createdAt: now,
    core: { limit: 5000, used: 10, remaining: 4990, resetMs: now + 3_600_000 },
    graphql: { limit: 5000, used: 0, remaining: 5000, resetMs: now + 3_600_000 },
    events: [],
  })}\n`, { mode: 0o600 });
  const env = { GH_GLANCE_FIXTURE_STATE: statePath };

  const first = invoke(["api", "-i", RUNS_PATH, "--jq", "."], env);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /^HTTP\/2 200 OK\r?$/m);
  const entityTag = etag(first.stdout);
  assert.ok(entityTag);
  assert.equal(JSON.parse(readFileSync(statePath, "utf8")).core.used, 11);

  const second = invoke([
    "api",
    "--jq",
    ".",
    "-H",
    `If-None-Match: ${entityTag}`,
    "--hostname",
    "github.com",
    "-i",
    RUNS_PATH,
  ], env);
  assert.equal(second.status, 1);
  assert.match(second.stdout, /^HTTP\/2 304 Not Modified\r?$/m);
  const after304 = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(after304.core.used, 11);
  assert.deepEqual(after304.events.filter((event) => event.type === "start").at(-1).cost, {
    core: 0,
    graphql: 0,
  });

  const forced = invoke(["api", "-i", RUNS_PATH, "--jq", "."], env);
  assert.equal(forced.status, 0, forced.stderr);
  assert.equal(JSON.parse(readFileSync(statePath, "utf8")).core.used, 12);

  const probe = invoke(["api", "rate_limit"], env);
  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(JSON.parse(probe.stdout).resources.core.used, 0);
  assert.doesNotMatch(probe.stdout, /HTTP\//);

  const observer = invoke(["api", "-i", "user"], env);
  assert.equal(observer.status, 0, observer.stderr);
  assert.match(observer.stdout, /x-ratelimit-used: 13/i);
  const observerEtag = etag(observer.stdout);
  const conditionalObserver = invoke([
    "api",
    "-i",
    "user",
    "-H",
    `If-None-Match: ${observerEtag}`,
  ], env);
  assert.equal(conditionalObserver.status, 1);
  assert.match(conditionalObserver.stdout, /^HTTP\/2 304 Not Modified\r?$/m);
  assert.equal(JSON.parse(readFileSync(statePath, "utf8")).core.used, 13);

  const exhaustedState = JSON.parse(readFileSync(statePath, "utf8"));
  exhaustedState.core.used = exhaustedState.core.limit;
  exhaustedState.core.remaining = 0;
  writeFileSync(statePath, `${JSON.stringify(exhaustedState)}\n`, { mode: 0o600 });
  const exhaustedObserver = invoke([
    "api",
    "-i",
    "user",
    "-H",
    `If-None-Match: ${observerEtag}`,
  ], env);
  assert.equal(exhaustedObserver.status, 1);
  assert.match(exhaustedObserver.stdout, /^HTTP\/2 403 Forbidden\r?$/m);
  assert.match(exhaustedObserver.stdout, /x-ratelimit-used: 5000/i);
  assert.match(exhaustedObserver.stdout, /x-ratelimit-remaining: 0/i);
  const finalState = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(finalState.core.used, 5000);
  assert.deepEqual(finalState.events.filter((event) => event.type === "start").at(-1).cost, {
    core: 0,
    graphql: 0,
  });
});


test("the shell fixture routes opt-in oracle GraphQL JSON input with independent charged evidence", (t) => {
  const root = mkdtempSync(join(tmpdir(), "gh-glance-oracle-api-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const statePath = join(root, "server.json");
  writeFileSync(statePath, JSON.stringify(createOracleState()), { mode: 0o600 });
  const response = spawnSync(FIXTURE, ["api", "-i", "graphql", "--input", "-"], {
    encoding: "utf8",
    input: JSON.stringify({ query: "query { rateLimit { cost used remaining resetAt } }" }),
    env: oracleEnvironment({ root, statePath }),
  });
  assert.equal(response.status, 0, response.stderr);
  assert.match(response.stdout, /x-ratelimit-resource: graphql/);
  assert.match(response.stdout, /"cost":1/);
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(state.accounts.octocat.graphql.used, 1);
  assert.equal(state.events[0].operation, "graphql.observer");
  assert.ok(state.events[0].completedAt >= state.events[0].startedAt);
});


test("fixture token lookup is synthetic and local; user responses expose the chosen principal", (t) => {
  const root = mkdtempSync(join(tmpdir(), "gh-glance-fixture-identity-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const token = invoke(["auth", "token", "--hostname", "github.com"], {
    GH_GLANCE_FIXTURE_TOKEN: "fixture-synthetic-keyring",
    // A local lookup must not even require the synthetic HTTP ledger to exist.
    GH_GLANCE_FIXTURE_STATE: join(root, "absent-server.json"),
  });
  assert.equal(token.status, 0, token.stderr);
  assert.equal(token.stdout, "fixture-synthetic-keyring\n");
  const user = invoke(["api", "-i", "user"], {
    GH_GLANCE_FIXTURE_USER_ID: "42", GH_GLANCE_FIXTURE_LOGIN: "fixture-other",
  });
  assert.equal(user.status, 0, user.stderr);
  assert.deepEqual(JSON.parse(user.stdout.split(/\r?\n\r?\n/)[1]), { id: 42, login: "fixture-other" });
  assert.match(user.stdout, /x-ratelimit-resource: core/);

  const statePath = join(root, "server.json");
  writeFileSync(statePath, JSON.stringify({
    core: { limit: 5000, used: 0, remaining: 5000, resetMs: Date.now() + 3600000 },
    graphql: { limit: 5000, used: 0, remaining: 5000, resetMs: Date.now() + 3600000 },
    user: { id: 84, login: "fixture-state-user" }, events: [],
  }), { mode: 0o600 });
  const stateUser = invoke(["api", "-i", "user"], { GH_GLANCE_FIXTURE_STATE: statePath });
  assert.equal(stateUser.status, 0, stateUser.stderr);
  assert.deepEqual(JSON.parse(stateUser.stdout.split(/\r?\n\r?\n/)[1]), { id: 84, login: "fixture-state-user" });
  assert.equal(JSON.parse(readFileSync(statePath, "utf8")).core.used, 1);
});


test("oracle token lookup emits only synthetic credentials without recording an HTTP request", (t) => {
  const root = mkdtempSync(join(tmpdir(), "gh-glance-oracle-token-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const statePath = join(root, "server.json");
  writeFileSync(statePath, JSON.stringify(createOracleState()), { mode: 0o600 });
  const response = spawnSync(FIXTURE, ["auth", "token", "--hostname", "github.com"], {
    encoding: "utf8", env: oracleEnvironment({ root, statePath }),
  });
  assert.equal(response.status, 0, response.stderr);
  assert.equal(response.stdout, "fixture-full\n");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(state.events.length, 0);
  assert.equal(state.accounts.octocat.httpRequests, 0);
});


test("a workflows fixture completes independently when it owns the only HTTP slot", (t) => {
  const root = mkdtempSync(join(tmpdir(), "gh-glance-workflows-independent-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const statePath = join(root, "state.json");
  const now = Date.now();
  writeFileSync(statePath, JSON.stringify({
    createdAt: now,
    core: { limit: 5000, used: 0, remaining: 5000, resetMs: now + 3_600_000 },
    graphql: { limit: 5000, used: 0, remaining: 5000, resetMs: now + 3_600_000 },
    events: [],
  }), { mode: 0o600 });
  const result = spawnSync(process.execPath, [join(HERE, "fixtures", "gh-state.mjs"),
    "api", "-i", "repos/acme/widget/actions/workflows?page=1&per_page=100"], {
    encoding: "utf8", timeout: 2000,
    env: { GH_GLANCE_FIXTURE_STATE: statePath },
  });
  assert.equal(result.error, undefined, "workflows waited for a runs request that cannot own the HTTP slot yet");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^HTTP\/2 200 OK\r?$/m);
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(state.core.used, 1);
  assert.equal(state.events.filter((event) => event.type === "start").length, 1);
  assert.equal(state.events.filter((event) => event.type === "end").length, 1);
});
