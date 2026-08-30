import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "gh");
const RUNS_PATH = "repos/acme/widget/actions/runs?exclude_pull_requests=true&per_page=100";

function invoke(args, env = {}) {
  return spawnSync(FIXTURE, args, {
    encoding: "utf8",
    env: { ...process.env, GH_GLANCE_FIXTURE_LOG: "/dev/null", ...env },
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
