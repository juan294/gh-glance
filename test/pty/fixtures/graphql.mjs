#!/usr/bin/env node
// The shell fixture's GraphQL responder. All of the semantics live in
// graphql-response.mjs so that the stateful oracle answers identically.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

import { graphqlHeaders, graphqlResponseFor, readGraphqlDocument } from "./graphql-response.mjs";

let input;
try { input = readFileSync(0, "utf8"); } catch { input = ""; }

const parsed = readGraphqlDocument(input);
const response = graphqlResponseFor(parsed, { host: process.env.GH_GLANCE_FIXTURE_GRAPHQL_HOST ?? "github.com" });

// argv cannot tell an observer from a data page -- both are `api -i graphql
// --input -` -- so the operation the document actually asked for is logged from
// the parsed document. Without it a test cannot assert that no data query was
// sent while the control observer legitimately was.
const log = process.env.GH_GLANCE_FIXTURE_LOG;
if (log && log !== "/dev/null") {
  const shape = parsed.ok ? parsed.shape : null;
  try {
    appendFileSync(log, `graphql ${response.operation} first=${shape?.pageSize ?? "-"} after=${shape?.cursor ?? "-"}\n`);
  } catch { /* the log is diagnostic; never fail a response over it */ }
}

// Failure injection that needs the parsed document. `graphql-data` selects the
// pages and the repository query while leaving the claimed observer readable,
// which is what lets a test show a failed tab instead of a starved budget.
const isObserver = response.operation === "graphql.observer";

function selects(list) {
  return (list ?? "").split(",").some((selector) =>
    (selector === "graphql-data" && !isObserver) ||
    (selector === "graphql-observer" && isObserver) ||
    selector === "graphql");
}

// Same caller-owned counter protocol the shell fixture uses: one matching
// invocation consumes one unit, so recovery is deterministic without timing a
// race. Evaluated here because only the parsed document knows which it is.
function consumeCounter(path, list) {
  if (!path || !selects(list)) return false;
  let remaining;
  try { remaining = Number.parseInt(readFileSync(path, "utf8").split("\n")[0], 10); } catch { return false; }
  if (!Number.isSafeInteger(remaining) || remaining <= 0) return false;
  try { writeFileSync(path, `${remaining - 1}\n`); } catch { return false; }
  return true;
}

if (consumeCounter(process.env.GH_GLANCE_FIXTURE_EMPTY_FIRST_FILE, process.env.GH_GLANCE_FIXTURE_EMPTY_FIRST_ON)) {
  process.exit(0);
}
if (consumeCounter(process.env.GH_GLANCE_FIXTURE_FAIL_FIRST_FILE, process.env.GH_GLANCE_FIXTURE_FAIL_FIRST_ON)) {
  process.stderr.write(`${process.env.GH_GLANCE_FIXTURE_FAIL_FIRST_MESSAGE ?? "temporary fixture failure"}\n`);
  process.exit(1);
}
const failure = process.env.GH_GLANCE_FIXTURE_FAIL;
if (failure && (process.env.GH_GLANCE_FIXTURE_FAIL_ON ?? "").split(",").some((selector) =>
  (selector === "graphql-data" && !isObserver) || (selector === "graphql-observer" && isObserver))) {
  process.stderr.write(`${failure}\n`);
  process.exit(1);
}

// Headers derived from the same answer as the envelope. Letting them disagree
// makes pickRateLimit's documented fallback wrong by construction, so a
// regression that starts trusting headers would pass here and fail in the world.
const meter = JSON.parse(response.body).data?.rateLimit;
process.stdout.write(graphqlHeaders(response.status, meter
  ? { limit: meter.limit, used: meter.used, remaining: meter.remaining, resetMs: Date.parse(meter.resetAt) }
  : {}) + response.body);
