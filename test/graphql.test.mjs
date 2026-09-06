// GraphQL is the phase's answer to opaque porcelain, so these pin the two
// properties that make it an improvement rather than a rewrite: every request
// declares a bound it is then held to, and a response that is unusable as data
// is still usable as evidence.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  GRAPHQL_OBSERVER_POINTS,
  GRAPHQL_PAGE_POINTS,
  GRAPHQL_PAGE_SIZE,
  GRAPHQL_QUERIES,
  admittedRowUrl,
  fetchGraphqlList,
  operationPausedUntil,
  fetchGraphqlPage,
  LIST_LIMIT,
  graphqlArgs,
  graphqlInput,
  operationCost,
  parseGraphqlEnvelope,
  rowBrowserUrl,
} from "../index.mjs";

// Relative, because a reset is bounded: a fixed far-future timestamp is
// exactly the nonsense value parseGraphqlEnvelope now refuses.
const RESET = new Date(Date.now() + 3_600_000).toISOString();
const meter = (cost) => ({ cost, limit: 5000, used: 10, remaining: 4990, resetAt: RESET });
const headers = (status = 200) =>
  `HTTP/2 ${status} OK\r\nx-ratelimit-limit: 5000\r\nx-ratelimit-used: 10\r\n` +
  `x-ratelimit-remaining: 4990\r\nx-ratelimit-reset: 1788696000\r\nx-ratelimit-resource: graphql\r\n\r\n`;
// Explicit variables at every call: without a resolvable repository the
// document cannot be built at all, which is itself the contract D1 restored.
const VARS = { owner: "acme", name: "widget", first: 50, after: null };
const runner = (body, { status = 200, fail = false } = {}) => async () => {
  const stdout = headers(status) + body;
  if (!fail) return stdout;
  throw Object.assign(new Error("gh exited 1"), { stdout });
};

test("GQL-03 every declared query is bounded, typed, and carries its own price", () => {
  for (const [kind, declared] of Object.entries(GRAPHQL_QUERIES)) {
    // No unbounded traversal: a connection must ask for an explicit page.
    if (declared.connection) {
      assert.match(declared.query, new RegExp(`${declared.connection}\\(first:\\$first,after:\\$after`), kind);
      assert.match(declared.query, /states:OPEN,orderBy:\{field:UPDATED_AT,direction:DESC\}/, kind);
    }
    assert.ok(!declared.query.includes("first:100"), kind);
    // Every document meters itself, which is what makes settlement possible.
    assert.match(declared.query, /rateLimit\{cost limit used remaining resetAt\}/, kind);
  }
  const document = JSON.parse(graphqlInput("issues", { owner: "acme", name: "widget", first: GRAPHQL_PAGE_SIZE, after: null }));
  // Typed, not stringified: -f/-F would have turned 50 into "50" and null into "".
  assert.equal(document.variables.first, GRAPHQL_PAGE_SIZE);
  assert.equal(document.variables.after, null);
  assert.ok(GRAPHQL_PAGE_SIZE <= 50);
  assert.deepEqual(operationCost("page:issues"), { core: 0, graphql: GRAPHQL_PAGE_POINTS });
  assert.deepEqual(operationCost("graphql-observer"), { core: 0, graphql: GRAPHQL_OBSERVER_POINTS });
  // The document travels on stdin, so no query text is ever in argv.
  const argv = graphqlArgs("github.com");
  assert.deepEqual(argv.slice(0, 5), ["api", "-i", "graphql", "--input", "-"]);
  assert.ok(!argv.some((argument) => argument.includes("repository(")));
});

test("GQL-02 a rejected or partial envelope keeps its budget evidence and publishes no rows", async () => {
  // HTTP 200 with errors is how GitHub refuses a query. Treating that as a
  // successful empty page would publish "no open issues" for a repository that
  // has plenty.
  const rejected = parseGraphqlEnvelope(JSON.stringify({ errors: [{ message: "no" }], data: null }));
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, "graphql-errors");

  // Partial data: usable meter, unusable rows.
  const partial = parseGraphqlEnvelope(JSON.stringify({ data: { repository: null, rateLimit: meter(2) }, errors: [{ message: "half" }] }));
  assert.equal(partial.ok, false);
  assert.equal(partial.rateLimit.remaining, 4990);
  assert.equal(partial.rateLimit.resource, "graphql");

  for (const body of ["not json at all", "", "null"]) {
    const broken = parseGraphqlEnvelope(body);
    assert.equal(broken.ok, false);
    assert.equal(broken.rateLimit, null);
  }

  const page = await fetchGraphqlPage("issues", {
    operation: "tab:issues",
    variables: VARS,
    run: runner(JSON.stringify({ errors: [{ message: "no" }] })),
  });
  assert.equal(page.ok, false);
  // The headers still carried a meter, so the failed attempt is still an
  // observation rather than a silent hole in the ledger.
  assert.equal(page.observations.length, 1);
  assert.equal(page.observations[0].resource, "graphql");
});

test("GQL-05 absent cost evidence never refunds and an overrun is recorded in full", async () => {
  // No `rateLimit` in the envelope: the conservative declared bound stands.
  const unmetered = await fetchGraphqlPage("issues", {
    operation: "tab:issues",
    variables: VARS,
    run: runner(JSON.stringify({ data: { repository: { issues: { nodes: [], totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null } } } } })),
  });
  assert.equal(unmetered.observedCost, GRAPHQL_PAGE_POINTS);
  assert.equal(unmetered.overrun, false);

  // A cost above the declared bound is kept at its real value and flagged,
  // rather than clamped to the bound and quietly under-charged.
  const expensive = await fetchGraphqlPage("issues", {
    operation: "tab:issues",
    variables: VARS,
    run: runner(JSON.stringify({ data: { repository: { issues: { nodes: [], totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null } } }, rateLimit: meter(11) } })),
  });
  assert.equal(expensive.observedCost, 11);
  assert.equal(expensive.overrun, true);

  // A non-zero exit still yields its evidence: gh writes the response before
  // exiting on a 4xx, and that body is where the meter is.
  const failed = await fetchGraphqlPage("issues", {
    operation: "tab:issues",
    variables: VARS,
    run: runner(JSON.stringify({ data: { rateLimit: meter(2) } }), { fail: true }),
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.observations.length, 1);
});

test("GQL-08 a row's page is opened from local evidence, never from a request", () => {
  // Issues and PRs carry their own URL; a run's page is derived from the
  // repository and databaseId, both already validated.
  assert.equal(
    rowBrowserUrl("actions", { databaseId: 42 }, { host: "github.com", repo: "acme/widget" }),
    "https://github.com/acme/widget/actions/runs/42",
  );
  assert.equal(
    rowBrowserUrl("issues", { url: "https://github.com/acme/widget/issues/7" }, { host: "github.com" }),
    "https://github.com/acme/widget/issues/7",
  );
  // A row is remote data. Without host and scheme admission a crafted `url`
  // would send the user's browser anywhere, or hand the platform opener a
  // file:/javascript: URL.
  for (const hostile of [
    "https://evil.example/acme/widget/issues/7",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "http://github.com/acme/widget/issues/7",
    "",
    null,
  ]) {
    assert.equal(admittedRowUrl(hostile, "github.com"), null, String(hostile));
  }
  // Security has no per-item page this app can name honestly.
  assert.equal(rowBrowserUrl("security", { url: "https://github.com/x/y" }, { host: "github.com" }), null);
  // Opening spends nothing, so there is no operation left to declare.
  for (const gone of ["open:actions", "open:issues", "open:prs"]) {
    assert.equal(operationCost(gone), null, gone);
  }
});

// The paging loop had no test at all, which is how a settlement that double
// charged every multi-page tab -- and then silently leaked its reservation on
// every poll -- survived a green suite.
function pagedFetcher(pages) {
  const seen = [];
  return {
    seen,
    fetchPage: async (kind, { after = null } = {}) => {
      seen.push(after);
      const index = after === null ? 0 : Number(/^cursor:(\d+)$/.exec(after)[1]);
      return pages[index];
    },
  };
}

function page(nodes, { hasNextPage, cursor, cost = 2, totalCount = 999 }) {
  return {
    ok: true,
    observedCost: cost,
    overrun: false,
    observations: [{ resource: "graphql", limit: 5000, used: cost, remaining: 5000 - cost, resetMs: Date.now() + 3_600_000, source: "response-header", receivedAt: Date.now(), cost }],
    data: {
      repository: {
        issues: { totalCount, pageInfo: { hasNextPage, endCursor: cursor }, nodes },
      },
    },
  };
}

const node = (number) => ({ number, title: `issue ${number}`, url: `https://github.com/acme/widget/issues/${number}`, updatedAt: "2026-09-01T00:00:00Z", author: { login: "octocat" }, labels: { nodes: [] } });

test("GQL-03 the tab envelope is charged for its own page only, never for pages that reserved their own", async () => {
  const { fetchPage, seen } = pagedFetcher([
    page([node(1)], { hasNextPage: true, cursor: "cursor:1" }),
    page([node(2)], { hasNextPage: true, cursor: "cursor:2" }),
    page([node(3)], { hasNextPage: false, cursor: null }),
  ]);
  const admit = async ({ run }) => ({ ok: true, value: await run(undefined) });
  const result = await fetchGraphqlList("issues", (n) => ({ number: n.number }), {
    governor: { scope: {}, leaseId: "lease" },
    fetchPage,
    admit,
  });
  // Three pages were walked, each with an explicit cursor.
  assert.deepEqual(seen, [null, "cursor:1", "cursor:2"]);
  assert.deepEqual(result.parse().map((row) => row.number), [1, 2, 3]);
  // Settlement gets the first page's cost alone. Pages 2 and 3 settled against
  // their own `page:issues` reservations; adding them here charges the same
  // work twice, and a settlement above its reservation is rejected as corrupt.
  assert.equal(result.graphqlSpent, 2);
  assert.equal(result.graphqlSpentTotal, 6);
  assert.equal(result.observations.length, 3);
  assert.equal(result.incomplete, false);
  assert.equal(result.limit, LIST_LIMIT);
});

test("GQL-03 a denied later page keeps the rows already gathered and says so", async () => {
  const { fetchPage } = pagedFetcher([
    page([node(1)], { hasNextPage: true, cursor: "cursor:1" }),
    page([node(2)], { hasNextPage: false, cursor: null }),
  ]);
  const denied = async () => ({ ok: false, error: new Error("API budget paused") });
  const result = await fetchGraphqlList("issues", (n) => ({ number: n.number }), {
    governor: { scope: {}, leaseId: "lease" },
    fetchPage,
    admit: denied,
  });
  // Page one survives a refusal of page two -- losing it would turn a budget
  // decision into data loss.
  assert.deepEqual(result.parse().map((row) => row.number), [1]);
  assert.equal(result.incomplete, true);
  // limit equals the rows held, so the existing truncation indicator fires
  // rather than presenting a partial list as a complete one.
  assert.equal(result.limit, 1);
  assert.equal(result.graphqlSpent, 2);
});

test("GQL-03 walking without a governor stops after the first page instead of paging unadmitted", async () => {
  const { fetchPage, seen } = pagedFetcher([
    page([node(1)], { hasNextPage: true, cursor: "cursor:1" }),
    page([node(2)], { hasNextPage: false, cursor: null }),
  ]);
  const result = await fetchGraphqlList("issues", (n) => ({ number: n.number }), { fetchPage });
  assert.deepEqual(seen, [null]);
  assert.equal(result.incomplete, true);
  assert.equal(result.graphqlSpent, 2);
});

test("GQL-05 a cost above its declared bound suspends the operation until reset", async () => {
  const reset = Date.now() + 3_600_000;
  const expensive = {
    ok: true,
    observedCost: 11,
    overrun: true,
    observations: [{ resource: "graphql", limit: 5000, used: 11, remaining: 4989, resetMs: reset, source: "response-header", receivedAt: Date.now(), cost: 11 }],
    data: { repository: { issues: { totalCount: 1, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } },
  };
  const result = await fetchGraphqlList("prs", (n) => n, { fetchPage: async () => expensive });
  // Recorded at its real cost, not clamped to the bound -- a clamp under-charges
  // the ledger exactly when the estimate has been shown to be wrong.
  assert.equal(result.graphqlSpent, 11);
  // And the operation is actually suspended, not merely noted. Spending against
  // a bound already known to be wrong is how a reserve gets crossed while every
  // individual request still looks admissible.
  const paused = operationPausedUntil("tab:prs", Date.now());
  assert.ok(paused !== null, "an overrun did not suspend its operation");
  assert.ok(paused > Date.now());
  assert.equal(operationPausedUntil("tab:issues", Date.now()), null, "unrelated operations must be unaffected");
  // It lifts on its own once the window it was waiting for has passed.
  assert.equal(operationPausedUntil("tab:prs", reset + 60_000), null);
});

test("GQL-07 an unsupported Enterprise schema is a scoped query rejection, never a porcelain fallback", async () => {
  // What a GHES server returns when its schema predates a field this build
  // selects. It is HTTP 200, so the only thing distinguishing it from data is
  // the envelope.
  const schemaError = JSON.stringify({
    errors: [{ message: "Field 'reviewDecision' doesn't exist on type 'PullRequest'" }],
  });
  const parsed = parseGraphqlEnvelope(schemaError);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.reason, "graphql-errors");
  assert.equal(parsed.data, null);

  const page = await fetchGraphqlPage("prs", {
    operation: "tab:prs",
    variables: VARS,
    run: runner(schemaError),
  });
  assert.equal(page.ok, false);
  // Scoped to the query that was refused, and reported as such. The property
  // that matters most is the absence of a fallback: there is no porcelain left
  // to silently retry through, so a rejected schema surfaces instead of
  // becoming an ungoverned `gh pr list` at an unobservable price.
  await assert.rejects(
    fetchGraphqlList("prs", (n) => n, { fetchPage: async () => page }),
    /GraphQL prs page unavailable \(graphql-errors\)/,
  );
});

test("no porcelain remains in acquisition for GraphQL to fall back to", () => {
  // Comment lines are excluded deliberately: several explain *why* the porcelain
  // was removed and name it to do so, and a check that cannot tell an
  // explanation from a call site would either fail on prose or be deleted.
  const code = readFileSync(new URL("../index.mjs", import.meta.url), "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  for (const porcelain of ["--paginate", "--web", "issue list", "pr list"]) {
    assert.ok(!code.includes(porcelain), `acquisition still contains ${porcelain}`);
  }
  // The one surviving `gh repo` spawn is the interactive missing-remote setup,
  // which is user-consented, creates a repository rather than reading one, and
  // predates this phase.
  const repoSpawns = [...code.matchAll(/spawn\("gh", \["repo", "([a-z]+)"/g)].map((match) => match[1]);
  assert.deepEqual(repoSpawns, ["create"]);
  assert.ok(!/\brunGh\(\s*\[\s*"(issue|pr|repo)"/.test(code), "a list/view porcelain call site survives");
});
