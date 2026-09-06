// Drives the real fixture binary the way the app does, so the price of a
// GraphQL request is measured by something that did not learn it from the app.
// The unit tests pin what the app believes it spends; these pin what it
// actually asked for.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "gh");

function invoke(document, env = {}) {
  return spawnSync(FIXTURE, ["api", "-i", "graphql", "--input", "-", "--hostname", "github.com"], {
    encoding: "utf8",
    input: typeof document === "string" ? document : JSON.stringify(document),
    env: {
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: tmpdir(),
      GH_CONFIG_DIR: tmpdir(),
      GH_GLANCE_FIXTURE_LOG: "/dev/null",
      ...env,
    },
  });
}

function envelope(result) {
  const separator = /\r?\n\r?\n/.exec(result.stdout);
  return JSON.parse(result.stdout.slice(separator.index + separator[0].length));
}

const PAGE = (connection, after = null) => ({
  query: `query($owner:String!,$name:String!,$first:Int!,$after:String){
  repository(owner:$owner,name:$name){
    id
    name
    nameWithOwner
    url
    ${connection}(first:$first,after:$after,states:OPEN,orderBy:{field:UPDATED_AT,direction:DESC}){
      totalCount
      pageInfo{hasNextPage endCursor}
      nodes{id number title url updatedAt author{login}${connection === "issues" ? " labels(first:1){nodes{name}}" : " headRefName isDraft reviewDecision"}}
    }
  }
  rateLimit{cost limit used remaining resetAt}
}`,
  variables: { owner: "acme", name: "widget", first: 50, after },
});

test("GQL-01 the observer and a data page are priced apart, and both meter themselves", () => {
  const observer = invoke({ query: "query{rateLimit{cost limit used remaining resetAt}}", variables: {} });
  assert.equal(observer.status, 0, observer.stderr);
  assert.match(observer.stdout, /x-ratelimit-resource: graphql/);
  assert.equal(envelope(observer).data.rateLimit.cost, 1);

  const page = invoke(PAGE("issues"));
  assert.equal(page.status, 0, page.stderr);
  const body = envelope(page).data;
  assert.equal(body.rateLimit.cost, 2, "a page must not be priced as an observer");
  assert.ok(body.repository.issues.nodes.length > 0);
  // Only the fields a row renders, and each one carries its own page URL so the
  // browser never needs a request to find it.
  for (const node of body.repository.issues.nodes) {
    assert.match(node.url, /^https:\/\/github\.com\/acme\/widget\/issues\/\d+$/);
    assert.ok(Object.hasOwn(node, "updatedAt"));
  }
});

test("GQL-03 cursors advance explicitly and each page reports its own completeness", () => {
  const first = invoke(PAGE("issues"));
  const page = envelope(first).data.repository.issues;
  assert.ok(Number.isSafeInteger(page.totalCount));
  assert.equal(typeof page.pageInfo.hasNextPage, "boolean");
  assert.match(page.pageInfo.endCursor, /^cursor:\d+$/);

  // The second page is a separate request with an explicit cursor; nothing
  // walks the connection on the app's behalf.
  const second = invoke(PAGE("issues", page.pageInfo.endCursor));
  assert.equal(second.status, 0, second.stderr);
  assert.equal(envelope(second).data.rateLimit.cost, 2);
});

test("GQL-04 the fixture refuses a document the app should never send", () => {
  // An unbounded page. GitHub would charge for this; the fixture refuses it, so
  // a regression that drops the bound fails here rather than passing quietly.
  const unbounded = invoke({
    query: `query{repository(owner:"acme",name:"widget"){issues(first:1000){nodes{number}}}}`,
    variables: {},
  });
  assert.equal(unbounded.status, 0, "a refusal is a 200 with errors, like GitHub's");
  assert.ok(envelope(unbounded).errors?.length > 0);
  assert.equal(envelope(unbounded).data, undefined);

  // A field outside the declared selection.
  const unknown = invoke({
    query: `query{repository(owner:"acme",name:"widget"){issues(first:5){nodes{number body}}}}`,
    variables: {},
  });
  assert.ok(envelope(unknown).errors?.length > 0);

  // Two connections in one document: that is the completion barrier the phase
  // removed, and it must not come back.
  const combined = invoke({
    query: `query{repository(owner:"acme",name:"widget"){issues(first:5){nodes{number}} pullRequests(first:5){nodes{number}}}}`,
    variables: {},
  });
  assert.ok(envelope(combined).errors?.length > 0);
});

test("GQL-06 the stateful fixture debits GraphQL by document and never by command shape", (t) => {
  const root = mkdtempSync(join(tmpdir(), "gh-glance-graphql-budget-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const statePath = join(root, "state.json");
  const now = Date.now();
  writeFileSync(statePath, `${JSON.stringify({
    createdAt: now,
    core: { limit: 5000, used: 0, remaining: 5000, resetMs: now + 3_600_000 },
    graphql: { limit: 5000, used: 0, remaining: 5000, resetMs: now + 3_600_000 },
    events: [],
  })}\n`, { mode: 0o600 });
  const env = { GH_GLANCE_FIXTURE_STATE: statePath };
  const read = () => JSON.parse(readFileSync(statePath, "utf8")).graphql;

  const observer = invoke({ query: "query{rateLimit{cost limit used remaining resetAt}}", variables: {} }, env);
  assert.equal(observer.status, 0, observer.stderr);
  assert.equal(read().used, 1, "the observer is not free");

  const page = invoke(PAGE("pullRequests"), env);
  assert.equal(page.status, 0, page.stderr);
  assert.equal(read().used, 3, "a page costs two, on top of the observer's one");
  // The envelope's meter agrees with the ledger, so what the app settles on and
  // what the fixture recorded cannot drift apart.
  assert.equal(envelope(page).data.rateLimit.used, 3);
  assert.equal(envelope(page).data.rateLimit.remaining, 4997);
});

test("GQL-03 a connection larger than one page is walked by explicit cursors", (t) => {
  const root = mkdtempSync(join(tmpdir(), "gh-glance-graphql-pages-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { GH_GLANCE_FIXTURE_GRAPHQL_ROWS: "120" };
  const first = invoke(PAGE("issues"), env);
  const page = envelope(first).data.repository.issues;
  assert.equal(page.totalCount, 120);
  assert.equal(page.nodes.length, 50);
  assert.equal(page.pageInfo.hasNextPage, true);

  const second = envelope(invoke(PAGE("issues", page.pageInfo.endCursor), env)).data.repository.issues;
  assert.equal(second.nodes.length, 50);
  assert.equal(second.pageInfo.hasNextPage, true);
  // No overlap: a cursor that returned the same window would make the app's
  // 150-row cap look reached while the connection had barely moved.
  const firstNumbers = new Set(page.nodes.map((node) => node.number));
  assert.ok(second.nodes.every((node) => !firstNumbers.has(node.number)));

  const third = envelope(invoke(PAGE("issues", second.pageInfo.endCursor), env)).data.repository.issues;
  assert.equal(third.nodes.length, 20);
  assert.equal(third.pageInfo.hasNextPage, false);
});
