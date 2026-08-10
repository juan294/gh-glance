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
const inferred = capture({ cols: 80, rows: 24 });
const slugOnly = capture({ cols: 80, rows: 24, args: "--repo acme/widget" });
const hostQualified = capture({ cols: 80, rows: 24, args: `--repo ${HOST}/acme/widget` });

const listCalls = (result) => result.fixtureCalls.filter((call) => /^(run|issue|pr) /.test(call));
// The alert endpoints only. `api rate_limit` is the adaptive throttle's budget
// probe: it is deliberately host-agnostic and carries no repository path, so it
// would fail every assertion below about where an alert endpoint was routed.
const apiCalls = (result) =>
  result.fixtureCalls.filter((call) => call.startsWith("api ") && !call.startsWith("api rate_limit"));

function assertReachedTheDataLayer(result, label) {
  assert.ok(result.fixtureCalls.length > 0, `${label}: the fixture gh was never invoked`);
  assert.ok(listCalls(result).length > 0, `${label}: no list subcommand was called`);
  assert.ok(apiCalls(result).length > 0, `${label}: no alert endpoint was called`);
}

test("with no --repo, the argv vector is byte-identical to the default", () => {
  // The regression guard for "the default path did not change". Both flags are
  // built by functions that return an empty array when unconfigured, so an
  // unconfigured run must produce neither.
  assertReachedTheDataLayer(inferred, "inferred");
  for (const call of inferred.fixtureCalls) {
    assert.ok(!call.includes("--hostname"), `--hostname leaked into: ${call}`);
    assert.ok(!call.includes("--repo"), `--repo leaked into: ${call}`);
  }
});

test("a two-part --repo passes --repo and never --hostname", () => {
  assertReachedTheDataLayer(slugOnly, "slug-only");
  for (const call of listCalls(slugOnly)) {
    assert.ok(call.includes("--repo acme/widget"), call);
  }
  for (const call of slugOnly.fixtureCalls) {
    assert.ok(!call.includes("--hostname"), `--hostname on a default-host target: ${call}`);
  }
  for (const call of apiCalls(slugOnly)) {
    assert.ok(call.includes("repos/acme/widget/"), call);
  }
});

test("a host-qualified --repo routes BOTH halves to the host", () => {
  assertReachedTheDataLayer(hostQualified, "host-qualified");

  for (const call of listCalls(hostQualified)) {
    assert.ok(call.includes(`--repo ${HOST}/acme/widget`), call);
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
