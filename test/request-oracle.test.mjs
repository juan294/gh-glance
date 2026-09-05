import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createOracleState, handleOracleRequest, identifyOracleRequest, oracleEntityKey, oracleEnvironment } from "./fixtures/request-oracle.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const GH = join(ROOT, "pty/fixtures/gh");
const RUNS = ["api", "-i", "repos/acme/widget/actions/runs?per_page=60"];
const QUERY = ["api", "-i", "graphql", "-f", "query=query FixtureIssues { repository(owner: $owner, name: $name) { issues(first: 50, after: $cursor) { nodes { id title } pageInfo { hasNextPage endCursor } } } rateLimit { cost used remaining resetAt } }", "-f", "owner=acme", "-f", "name=widget"];
const request = (state, argv, extra = {}) => handleOracleRequest(state, { argv, ...extra });
const body = (response) => JSON.parse(response.body);

function processRequest(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(GH, args, { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (value) => { stdout += value; });
    child.stderr.on("data", (value) => { stderr += value; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("ORACLE-01: pinned and sliding probes diverge from actual GraphQL charge", () => {
  for (const mode of ["pinned", "sliding"]) {
    const state = createOracleState({ publishedProbes: { graphql: { mode } } });
    const before = body(request(state, ["api", "rate_limit"])).resources.graphql;
    request(state, QUERY);
    request(state, QUERY);
    const after = body(request(state, ["api", "rate_limit"], { now: state.now + 10_000 })).resources.graphql;
    assert.equal(after.used, before.used);
    assert.equal(after.remaining, before.remaining);
    assert.equal(after.reset - before.reset, mode === "sliding" ? 10 : 0);
    assert.equal(state.accounts.octocat.graphql.used, 2);
    assert.equal(state.events.reduce((sum, event) => sum + event.cost.graphql, 0), 2);
  }
});

test("ORACLE-02: 304 consumes HTTP capacity but no primary units; observers are identifiable", () => {
  const state = createOracleState();
  const first = request(state, RUNS);
  const second = request(state, [...RUNS, "-H", `If-None-Match: ${first.headers.etag}`]);
  assert.equal(first.status, 200);
  assert.equal(second.status, 304);
  assert.equal(second.body, "");
  assert.equal(state.accounts.octocat.core.used, 1);
  assert.equal(state.accounts.octocat.httpRequests, 2);
  request(state, ["api", "user"]);
  request(state, ["api", "rate_limit"]);
  request(state, ["api", "graphql", "-f", "query=query { rateLimit { cost remaining resetAt } }"]);
  assert.deepEqual(state.events.map((event) => event.observer), [false, false, true, true, true]);
  assert.equal(state.accounts.octocat.core.used, 2);
});

test("ORACLE-03: seven concurrent processes across 3+4 configuration roots share one independent ledger", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gh-glance-oracle-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const statePath = join(root, "server.json");
  writeFileSync(statePath, JSON.stringify(createOracleState()), { mode: 0o600 });
  const results = await Promise.all(Array.from({ length: 7 }, (_, index) => processRequest(QUERY,
    oracleEnvironment({ root: join(root, index < 3 ? "machine-a" : "machine-b"), statePath, pane: `pane-${index}` }))));
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(state.accounts.octocat.graphql.used, 7);
  assert.equal(state.accounts.octocat.httpRequests, 7);
  assert.deepEqual(state.events.map((event) => event.sequence), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(new Set(state.events.map((event) => event.pid)).size, 7);
  assert.equal(new Set(state.events.map((event) => event.configRoot)).size, 2);
  assert.equal(state.events.filter((event) => event.configRoot.endsWith("machine-a")).length, 3);
  assert.ok(state.events.every((event) => Number.isFinite(event.startedAt)));
});

test("ORACLE-04: retry dates/seconds, partial errors, wrong epochs and missing/unexpected costs are deterministic", () => {
  for (const format of ["date", "seconds"]) {
    const state = createOracleState({ scriptedEvents: [{ type: "throttle", durationMs: 60_000, format }] });
    const response = request(state, RUNS);
    assert.equal(response.status, 429);
    assert.equal(response.headers["retry-after"], format === "date" ? new Date(state.now + 60_000).toUTCString() : "60");
    assert.equal(state.accounts.octocat.core.used, 0);
    assert.equal(request(state, RUNS, { now: state.now + 30_000 }).status, 429);
    assert.equal(request(state, RUNS, { now: state.now + 30_001 }).status, 200);
  }
  const state = createOracleState({ scriptedEvents: [
    { type: "response", response: { graphqlErrors: [{ type: "FORBIDDEN", message: "fixture partial" }], actualCost: 9, evidenceResetMs: 123_000 } },
  ] });
  const partial = request(state, QUERY);
  assert.equal(partial.status, 200);
  assert.equal(body(partial).errors[0].type, "FORBIDDEN");
  assert.equal(body(partial).data.rateLimit.cost, 9);
  assert.equal(partial.headers["x-ratelimit-reset"], "123");
  assert.notEqual(state.accounts.octocat.graphql.resetMs, 123_000);
  state.scriptedEvents.push({ type: "response", response: { absentCost: true } });
  assert.equal(Object.hasOwn(body(request(state, QUERY)).data.rateLimit, "cost"), false);
  assert.equal(state.accounts.octocat.graphql.used, 10);
  state.publishedProbes.graphql = { mode: "missing" };
  assert.equal(Object.hasOwn(body(request(state, ["api", "rate_limit"])).resources, "graphql"), false);
});

test("ORACLE-05: repository versions, permissions and credential switches never share payload evidence", () => {
  const state = createOracleState();
  state.credentials["fixture-restricted"] = { principal: "octocat", repositories: ["acme/other"], permissions: ["actions.runs"] };
  state.entities[oracleEntityKey(identifyOracleRequest(RUNS))] = { version: 1, payload: { workflow_runs: [{ id: 1, name: "private" }] } };
  const first = request(state, RUNS);
  assert.match(first.body, /private/);
  const denied = request(state, RUNS, { credential: "fixture-restricted" });
  assert.equal(denied.status, 403);
  assert.doesNotMatch(denied.body, /private/);
  const other = request(state, ["api", "repos/acme/other/actions/runs?per_page=60"], { credential: "fixture-restricted" });
  assert.equal(other.status, 200);
  assert.doesNotMatch(other.body, /private/);
  state.scriptedEvents.push({ type: "change", entity: { version: 2, payload: { workflow_runs: [{ id: 1, name: "updated" }] } } });
  const changed = request(state, [...RUNS, "-H", `If-None-Match: ${first.headers.etag}`]);
  assert.equal(changed.status, 200);
  assert.match(changed.body, /updated/);
  assert.notEqual(changed.headers.etag, first.headers.etag);
  assert.throws(() => request(state, RUNS, { credential: "not-a-fixture" }), /unknown fixture credential/);
  assert.throws(() => request(state, ["api", "unknown"]), /unknown fixture API path/);
  assert.throws(() => request(state, ["api", "graphql", "-f", "query=query { nonsense }"]), /unknown fixture GraphQL/);
});

test("oracle scripted external burn/reset/delay/disconnect uses injected time and bounded explicit pages", () => {
  const state = createOracleState();
  const rows = Array.from({ length: 150 }, (_, index) => ({ id: `I_${index}`, title: `issue ${index}` }));
  for (const cursor of [null, "cursor:50", "cursor:100"]) {
    const shape = identifyOracleRequest(cursor ? [...QUERY, "-f", `cursor=${cursor}`] : QUERY);
    state.entities[oracleEntityKey(shape)] = { version: 1, payload: rows };
  }
  let cursor;
  const seen = [];
  do {
    const response = body(request(state, cursor ? [...QUERY, "-f", `cursor=${cursor}`] : QUERY));
    const page = response.data.repository.issues;
    assert.equal(page.nodes.length, 50);
    seen.push(...page.nodes);
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  assert.equal(new Set(seen.map((row) => row.id)).size, 150);
  state.scriptedEvents.push({ type: "externalSpend", resource: "graphql", amount: 100 });
  request(state, QUERY);
  assert.equal(state.accounts.octocat.graphql.used, 104);
  state.scriptedEvents.push({ type: "reset", at: state.now + 3_600_000 }, { type: "delay", ms: 100 }, { type: "disconnect" });
  const disconnected = request(state, QUERY, { now: state.now + 3_600_000 });
  assert.equal(disconnected.disconnect, true);
  assert.equal(disconnected.delayMs, 100);
  assert.equal(state.accounts.octocat.graphql.used, 1);
  assert.throws(() => request(state, ["api", "repos/acme/widget/actions/runs?per_page=151"]), /unbounded/);
});

test("oracle rejects malformed cursors before changing server truth or consuming scripted events", () => {
  const state = createOracleState({ scriptedEvents: [{ type: "externalSpend", resource: "graphql", amount: 100 }] });
  const before = structuredClone(state);
  for (const cursor of ["garbage", "cursor:-1", "cursor:1.5", "cursor:9007199254740992", "50", ""]) {
    assert.throws(() => request(state, [...QUERY, "-f", `cursor=${cursor}`]), /unknown fixture cursor/);
    assert.deepEqual(state, before);
  }
});

test("fixture environment is an allowlist and versioned workloads declare future gates without asserting them early", () => {
  const env = oracleEnvironment({ root: "/tmp/oracle", statePath: "/tmp/oracle/server.json", GH_TOKEN: "must-not-survive" });
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "SSH_AUTH_SOCK"]) assert.equal(Object.hasOwn(env, name), false);
  const workloads = JSON.parse(readFileSync(join(ROOT, "fixtures/workloads/multi-instance-v1.json"), "utf8"));
  assert.equal(workloads.schema, 1);
  assert.deepEqual([...new Set(workloads.scenarios.map((scenario) => scenario.panes))].sort((a, b) => a - b), [1, 2, 7, 10]);
  assert.ok(workloads.scenarios.some((scenario) => scenario.clientsByRoot?.join(",") === "3,4"));
  for (const scenario of workloads.scenarios) {
    assert.ok(scenario.id);
    assert.ok(scenario.activationPhase > 1 && scenario.activationPhase <= 12);
    assert.ok(scenario.targets);
  }
});


test("oracle authorization and quota are host-partitioned and query filters retain distinct versions", () => {
  const state = createOracleState();
  const github = structuredClone(state.accounts.octocat);
  state.accounts["enterprise.example|octocat"] = github;
  state.credentials["fixture-enterprise"] = {
    principal: "octocat", hosts: ["enterprise.example"], repositories: ["*"], permissions: ["*"],
  };
  assert.throws(() => request(state, [...RUNS, "--hostname", "enterprise.example"]), /host mismatch/);
  request(state, [...RUNS, "--hostname", "enterprise.example"], { credential: "fixture-enterprise" });
  assert.equal(state.accounts["enterprise.example|octocat"].core.used, 1);
  assert.equal(state.accounts.octocat.core.used, 0);
  const auth = request(state, ["auth", "status", "--active", "--json", "hosts"]);
  assert.equal(auth.event.operation, "cli.auth");
  assert.equal(auth.event.httpRequests, 1);
  assert.equal(state.accounts.octocat.core.used, 1);
  const high = identifyOracleRequest(["api", "repos/acme/widget/dependabot/alerts?per_page=30&severity=high"]);
  const critical = identifyOracleRequest(["api", "repos/acme/widget/dependabot/alerts?severity=critical&per_page=30"]);
  assert.notEqual(oracleEntityKey(high), oracleEntityKey(critical));
  const reordered = identifyOracleRequest(["api", "repos/acme/widget/dependabot/alerts?severity=high&per_page=30"]);
  assert.equal(oracleEntityKey(high), oracleEntityKey(reordered));
});


test("oracle rejects undeclared GraphQL roots, combined connections, aliases and unbounded labels before charging", () => {
  const state = createOracleState();
  const invalid = [
    'query { rateLimit { cost } viewer { login } }',
    'query { repository(owner: "acme", name: "widget") { issues(first: 50) { nodes { id } } pullRequests(first: 50) { nodes { id } } } }',
    'query { repository(owner: "acme", name: "widget") { issues(first: 50) { nodes { comments(first: 100) { nodes { id } } } } } }',
    'query { first: repository(owner: "acme", name: "widget") { id } second: repository(owner: "acme", name: "other") { id } }',
    'query { repository(owner: "acme", name: "widget") { issues(first: 50) { nodes { labels(first: 100) { nodes { name } } } } } }',
    'query { repository(owner: "acme", name: "widget") { issues { nodes { id } } } }',
    'query { rateLimit { cost } rateLimit { cost } }',
    'query { rateLimit { cost } } query { rateLimit { cost } }',
  ];
  for (const query of invalid) assert.throws(() => request(state, ["api", "graphql", "-f", `query=${query}`]), /fixture GraphQL/);
  assert.equal(state.accounts.octocat.httpRequests, 0);
  assert.equal(state.events.length, 0);
  const bounded = request(state, ["api", "graphql", "-f", 'query=query Issues($owner: String!, $name: String!, $first: Int!) { repository(owner: $owner, name: $name) { id issues(first: $first, states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { id labels(first: 1) { nodes { name } } } pageInfo { hasNextPage endCursor } totalCount } } rateLimit { cost } }', "-f", "owner=acme", "-f", "name=widget", "-f", "first=50"]);
  assert.equal(bounded.event.operation, "issues.page");
  assert.equal(bounded.event.cost.graphql, 1);
});

test("oracle identity responses distinguish repositories and principals, while same-principal credentials agree", () => {
  const state = createOracleState();
  state.accounts.hubot = structuredClone(state.accounts.octocat);
  state.credentials["fixture-hubot"] = { principal: "hubot", repositories: ["*"], permissions: ["*"] };
  state.credentials["fixture-octocat-second"] = { principal: "octocat", repositories: ["*"], permissions: ["*"] };
  const widget = body(request(state, ["repo", "view", "--repo", "acme/widget"]));
  const other = body(request(state, ["repo", "view", "--repo", "acme/other"]));
  const graphqlIdentity = body(request(state, ["api", "graphql", "-f", 'query=query { repository(owner: "acme", name: "widget") { id nameWithOwner } }'])).data.repository;
  assert.notEqual(widget.id, other.id);
  assert.equal(widget.id, graphqlIdentity.id);
  const octocat = body(request(state, ["api", "user"]));
  const hubot = body(request(state, ["api", "user"], { credential: "fixture-hubot" }));
  const octocatSecond = body(request(state, ["api", "user"], { credential: "fixture-octocat-second" }));
  assert.notEqual(octocat.id, hubot.id);
  assert.equal(hubot.login, "hubot");
  assert.deepEqual(octocat, octocatSecond);
  assert.equal(body(request(state, ["auth", "status", "--json", "hosts"], { credential: "fixture-hubot" }))[0].login, "hubot");
});

test("pinned probe snapshots are independent per host and principal", () => {
  const state = createOracleState({ publishedProbes: { graphql: { mode: "pinned" } } });
  state.accounts.hubot = structuredClone(state.accounts.octocat);
  state.accounts.hubot.graphql.used = 20;
  state.accounts.hubot.graphql.remaining -= 20;
  state.accounts["enterprise.example|octocat"] = structuredClone(state.accounts.octocat);
  state.accounts["enterprise.example|octocat"].graphql.used = 40;
  state.accounts["enterprise.example|octocat"].graphql.remaining -= 40;
  state.credentials["fixture-hubot"] = { principal: "hubot", repositories: ["*"], permissions: ["*"] };
  state.credentials["fixture-enterprise"] = { principal: "octocat", hosts: ["enterprise.example"], repositories: ["*"], permissions: ["*"] };
  const probe = (credential, host = "github.com") => body(request(state, ["api", "rate_limit", "--hostname", host], { credential })).resources.graphql;
  assert.equal(probe("fixture-full").used, 0);
  assert.equal(probe("fixture-hubot").used, 20);
  assert.equal(probe("fixture-enterprise", "enterprise.example").used, 40);
  request(state, QUERY);
  request(state, QUERY, { credential: "fixture-hubot" });
  request(state, [...QUERY, "--hostname", "enterprise.example"], { credential: "fixture-enterprise" });
  assert.equal(probe("fixture-full").used, 0);
  assert.equal(probe("fixture-hubot").used, 20);
  assert.equal(probe("fixture-enterprise", "enterprise.example").used, 40);
  assert.equal(Object.keys(state.probeSnapshots).length, 3);
});


test("oracle reads positional repo view targets and host-qualified porcelain repository selectors", () => {
  const positional = identifyOracleRequest(["repo", "view", "acme/other", "--json", "id,nameWithOwner"]);
  assert.equal(positional.repository, "acme/other");
  const state = createOracleState();
  const payload = body(request(state, ["repo", "view", "acme/other", "--json", "id,nameWithOwner"]));
  assert.equal(payload.nameWithOwner, "acme/other");
  assert.equal(payload.id, body(request(state, ["repo", "view", "--repo", "acme/other"])).id);
  for (const argv of [
    ["repo", "view", "enterprise.example/acme/widget", "--json", "id"],
    ["repo", "view", "https://enterprise.example/acme/widget", "--json", "id"],
    ["issue", "list", "--repo", "enterprise.example/acme/widget", "--limit", "150"],
    ["pr", "list", "-R", "enterprise.example/acme/widget", "--limit", "150"],
    ["pr", "list", "--repo=enterprise.example/acme/widget", "--limit", "150"],
  ]) {
    const identified = identifyOracleRequest(argv);
    assert.equal(identified.host, "enterprise.example");
    assert.equal(identified.repository, "acme/widget");
    assert.throws(() => request(state, argv), /credential host mismatch/);
  }
  state.accounts["enterprise.example|octocat"] = structuredClone(state.accounts.octocat);
  state.credentials["fixture-enterprise"] = { principal: "octocat", hosts: ["enterprise.example"], repositories: ["acme/widget"], permissions: ["*"] };
  const enterprise = request(state, ["repo", "view", "enterprise.example/acme/widget", "--json", "id"], { credential: "fixture-enterprise" });
  assert.equal(enterprise.event.host, "enterprise.example");
  assert.match(body(enterprise).url, /^https:\/\/enterprise\.example\/acme\/widget$/);
  assert.equal(state.accounts["enterprise.example|octocat"].graphql.used, 3);
  assert.throws(() => identifyOracleRequest(["repo", "view", "enterprise.example/acme/widget", "--hostname", "github.com"]), /conflicting fixture repository host/);
});
