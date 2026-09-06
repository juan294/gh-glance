// One GraphQL answer shared by both fixture paths: the shell fixture's
// responder and the stateful oracle. Two copies of this would drift, and a
// fixture that disagrees with itself about what a query costs is worse than no
// fixture at all.
//
// The document is parsed with the request oracle's grammar rather than
// pattern-matched, so an unbounded page, an unknown field, or two connections
// in one document fail here instead of being answered generically.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { graphqlShape } from "../../fixtures/request-oracle.mjs";

const DIR = dirname(fileURLToPath(import.meta.url));
// The checked-in payloads hold a handful of rows, so `hasNextPage` is always
// false and the app's paging loop -- cursors, per-page admission, the
// incomplete marker -- is unreachable from a capture. This knob synthesizes a
// larger set so that path can actually be driven.
const SYNTHETIC_ROWS = Number.parseInt(process.env.GH_GLANCE_FIXTURE_GRAPHQL_ROWS ?? "", 10);

function rows(name) {
  const real = JSON.parse(readFileSync(join(DIR, name), "utf8"));
  if (!Number.isSafeInteger(SYNTHETIC_ROWS) || SYNTHETIC_ROWS <= real.length) return real;
  return Array.from({ length: SYNTHETIC_ROWS }, (_, index) => {
    const template = real[index % real.length];
    return { ...template, number: 1000 + index, title: `${template.title} #${index}` };
  });
}

export const GRAPHQL_COSTS = { "graphql.observer": 1, "repository.identity": 1, "issues.page": 2, "pulls.page": 2 };

// Returns the parsed shape, or a rejection describing why the document was
// refused. GitHub answers a rejected query with HTTP 200 and an errors array,
// so a refusal here is a response, not a crash.
export function readGraphqlDocument(input) {
  let document;
  try { document = JSON.parse(input); } catch { return { ok: false, message: "input was not JSON" }; }
  if (!document || typeof document.query !== "string") return { ok: false, message: "input declared no query" };
  if (document.variables !== undefined &&
    (typeof document.variables !== "object" || document.variables === null || Array.isArray(document.variables))) {
    return { ok: false, message: "variables were not a typed object" };
  }
  try {
    return { ok: true, shape: graphqlShape(document.query, document.variables ?? {}) };
  } catch (error) {
    return { ok: false, message: String(error.message) };
  }
}

function meter(cost, { limit = 5000, used = null, remaining = null, resetMs = null } = {}) {
  const spent = used ?? cost;
  return {
    cost,
    limit,
    used: spent,
    remaining: remaining ?? limit - spent,
    resetAt: new Date(resetMs ?? Date.now() + 3_600_000).toISOString(),
  };
}

function connection(items, mapNode, pageSize, offset) {
  const page = items.slice(offset, offset + pageSize);
  return {
    totalCount: items.length,
    pageInfo: { hasNextPage: offset + page.length < items.length, endCursor: `cursor:${offset + page.length}` },
    nodes: page.map(mapNode),
  };
}

export function graphqlResponseFor(parsed, { host = "github.com", budget = null } = {}) {
  if (!parsed.ok) {
    return { operation: "graphql.rejected", status: 200, cost: 0, body: JSON.stringify({ errors: [{ message: parsed.message }] }) };
  }
  const { shape } = parsed;
  const repository = shape.repository ?? "acme/widget";
  const [owner, name] = repository.split("/");
  const cost = GRAPHQL_COSTS[shape.operation] ?? 1;
  const rateLimit = meter(cost, budget ?? {});
  const base = {
    id: `R_${owner}_${name}`,
    name,
    nameWithOwner: repository,
    url: `https://${host}/${repository}`,
    viewerPermission: "READ",
  };
  if (shape.operation === "graphql.observer") {
    return { operation: shape.operation, status: 200, cost, body: JSON.stringify({ data: { rateLimit } }) };
  }
  if (shape.operation === "repository.identity") {
    return { operation: shape.operation, status: 200, cost, body: JSON.stringify({ data: { repository: base, rateLimit } }) };
  }
  if (shape.operation === "issues.page") {
    const issues = connection(rows("issues.json"), (row) => ({
      id: `I_${row.number}`,
      number: row.number,
      title: row.title,
      url: `https://${host}/${repository}/issues/${row.number}`,
      updatedAt: row.updatedAt,
      author: { login: row.author?.login ?? null },
      labels: { nodes: (row.labels ?? []).slice(0, 1).map((label) => ({ name: label.name })) },
    }), shape.pageSize, shape.pageOffset);
    return { operation: shape.operation, status: 200, cost, body: JSON.stringify({ data: { repository: { ...base, issues }, rateLimit } }) };
  }
  if (shape.operation === "pulls.page") {
    const pullRequests = connection(rows("prs.json"), (row) => ({
      id: `PR_${row.number}`,
      number: row.number,
      title: row.title,
      url: `https://${host}/${repository}/pull/${row.number}`,
      updatedAt: row.updatedAt,
      author: { login: row.author?.login ?? null },
      headRefName: row.headRefName,
      isDraft: row.isDraft,
      reviewDecision: row.reviewDecision,
    }), shape.pageSize, shape.pageOffset);
    return { operation: shape.operation, status: 200, cost, body: JSON.stringify({ data: { repository: { ...base, pullRequests }, rateLimit } }) };
  }
  return { operation: shape.operation, status: 200, cost: 0, body: JSON.stringify({ errors: [{ message: `unhandled operation ${shape.operation}` }] }) };
}

export function graphqlHeaders(status, { limit = 5000, used = 1, remaining = 4999, resetMs = null } = {}) {
  const reset = Math.floor((resetMs ?? Date.now() + 3_600_000) / 1000);
  return `HTTP/2 ${status} ${status === 200 ? "OK" : "Error"}\r\n` +
    `x-ratelimit-limit: ${limit}\r\nx-ratelimit-used: ${used}\r\n` +
    `x-ratelimit-remaining: ${remaining}\r\nx-ratelimit-reset: ${reset}\r\n` +
    "x-ratelimit-resource: graphql\r\n\r\n";
}
