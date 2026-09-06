// What argv actually reaches the `gh` subprocess.
//
// This is the gap the host-routing defect lived in: `--repo host/owner/name`
// made the four list-driven tabs correct while the three alert endpoints, which
// go through `gh api` and have no --repo to carry a host, kept querying
// github.com -- 404ed, and rendered as "not enabled". Unit tests cover the
// parser; only the fixture log covers the vector.
//
// So these assert on the fixture log and never on rendered frame content. The
// log is deterministic in a way a frame is not, and `npm run test:pty` is
// advisory in CI -- a flake here would buy nothing and cost the only automated
// protection against that defect recurring.

import assert from "node:assert/strict";
import { test } from "node:test";

import { capture } from "./capture.mjs";

const HOST = "tenant.ghe.com";

// Captures cost several seconds each, so each is taken once at module scope.
const inferred = capture({ cols: 80, rows: 24, settle: 7, args: "--tab security" });
const slugOnly = capture({
  cols: 80,
  rows: 24,
  settle: 7,
  args: "--repo acme/widget --tab security",
  env: { GH_HOST: HOST, GH_REPO: `${HOST}/other/repo` },
});
const hostQualified = capture({
  cols: 80,
  rows: 24,
  settle: 7,
  args: `--repo ${HOST}/acme/widget --tab security`,
});

// The list tabs are GraphQL documents now, so their routing evidence is the
// `gh api -i graphql` argv rather than a `--repo` flag. The document that says
// which query it was travels on stdin and is therefore irrelevant to routing --
// which is exactly why routing is asserted on argv and nothing else.
const graphqlCalls = (result) => result.fixtureCalls.filter((call) => call.startsWith("api -i graphql"));
// The fixture's semantic log line, which proves the observer document was
// actually sent. It carries no argv, so it can never be used for routing.
const observerDocuments = (result) => result.fixtureCalls.filter((call) => call.startsWith("graphql graphql.observer"));
// The REST endpoints only. `api rate_limit` and `api -i user` are control-plane
// reads that address no repository, and the GraphQL vector has its own helper
// above; all three would fail the request-path assertions below.
const apiCalls = (result) =>
  result.fixtureCalls.filter((call) => call.startsWith("api ") &&
    !call.startsWith("api rate_limit") && !call.startsWith("api -i user") && !call.startsWith("api -i graphql"));

function assertReachedTheDataLayer(result, label) {
  assert.ok(result.fixtureCalls.length > 0, `${label}: the fixture gh was never invoked`);
  assert.ok(apiCalls(result).length > 0, `${label}: no alert endpoint was called`);
}

test("with no --repo, all-remotes inference routes API calls to github.com", () => {
  assertReachedTheDataLayer(inferred, "inferred");
  for (const call of apiCalls(inferred)) {
    assert.ok(call.includes("--hostname github.com"), call);
    assert.ok(!call.includes("--repo"), `--repo leaked into: ${call}`);
  }
});

test("a two-part --repo pins github.com despite conflicting environment targets", () => {
  assertReachedTheDataLayer(slugOnly, "slug-only");
  for (const call of graphqlCalls(slugOnly)) {
    assert.ok(call.includes("--hostname github.com"), `list vector was not routed: ${call}`);
  }
  for (const call of apiCalls(slugOnly)) {
    assert.ok(call.includes("--hostname github.com"), `default host was not explicit: ${call}`);
  }
  for (const call of apiCalls(slugOnly)) {
    assert.ok(call.includes("repos/acme/widget/"), call);
  }
});

test("a host-qualified --repo routes BOTH halves to the host", () => {
  assertReachedTheDataLayer(hostQualified, "host-qualified");

  for (const call of graphqlCalls(hostQualified)) {
    assert.ok(call.includes(`--hostname ${HOST}`), `list vector was not routed to the host: ${call}`);
    // The host is an argument here too, never part of a path or a document.
    assert.ok(!call.includes(`repos/${HOST}/`), `the host reached a request path: ${call}`);
  }
  for (const call of apiCalls(hostQualified)) {
    // The defect guard: without this flag these three calls go to github.com
    // while the list tabs above read the tenant.
    assert.ok(call.includes(`--hostname ${HOST}`), `alert endpoint not routed to the host: ${call}`);
    // The host travels as an argument and is never interpolated into a request
    // path -- only the validated owner/name slug is.
    assert.ok(call.includes("repos/acme/widget/"), call);
    assert.ok(!call.includes(`repos/${HOST}/`), `the host reached a request path: ${call}`);
  }
});

test("the budget probe is routed to the host too", () => {
  // A rate limit is per token *per server*. Unrouted, the shared governor
  // reads github.com's budget while the pane spends against the tenant, and then
  // throttles -- or fails to -- against a number from an unrelated limit.
  // `--repo host/owner/name` is the case that needs the flag: it sets the host
  // without setting GH_HOST, which `gh` would otherwise have honoured on its own.
  // Two halves: the observer document was genuinely sent, and every GraphQL
  // invocation carried the host. Asserting a hostname against the semantic log
  // line cannot work -- it contains no argv at all.
  assert.ok(
    observerDocuments(hostQualified).length > 0,
    "the budget probe never ran on the host-qualified target",
  );
  const routed = graphqlCalls(hostQualified);
  assert.ok(routed.length > 0, "no GraphQL invocation was recorded");
  for (const call of routed) {
    assert.ok(call.includes(`--hostname ${HOST}`), `budget probe not routed to the host: ${call}`);
  }
});
