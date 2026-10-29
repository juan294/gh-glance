// One GraphQL answer shared by both fixture paths: the shell fixture's
// responder and the stateful oracle. Two copies of this would drift, and a
// fixture that disagrees with itself about what a query costs is worse than no
// fixture at all.
//
// The document is parsed with the request oracle's grammar rather than
// pattern-matched, so an unbounded page, an unknown field, or two connections
// in one document fail here instead of being answered generically.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { graphqlShape } from "../../fixtures/request-oracle.mjs";

const DIR = dirname(fileURLToPath(import.meta.url));
// The checked-in payloads hold a handful of rows, so `hasNextPage` is always
// false and the app's paging loop -- cursors, per-page admission, the
// incomplete marker -- is unreachable from a capture. This knob synthesizes a
// larger set so that path can actually be driven.
const SYNTHETIC_ROWS = Number.parseInt(process.env.GH_GLANCE_FIXTURE_GRAPHQL_ROWS ?? "", 10);

function attentionFixture(){try{return process.env.GH_GLANCE_ATTENTION_FILE?JSON.parse(readFileSync(process.env.GH_GLANCE_ATTENTION_FILE,'utf8')):{};}catch{return {};}}
function rows(name) {
  const overridden=attentionFixture().sources?.[name.replace('.json','')];if(Array.isArray(overridden))return overridden;
  const real = JSON.parse(readFileSync(join(DIR, name), "utf8"));
  if (!Number.isSafeInteger(SYNTHETIC_ROWS) || SYNTHETIC_ROWS <= real.length) return real;
  return Array.from({ length: SYNTHETIC_ROWS }, (_, index) => {
    const template = real[index % real.length];
    return { ...template, number: 1000 + index, title: `${template.title} #${index}` };
  });
}

export const GRAPHQL_COSTS = { "graphql.observer": 1, "repository.identity": 1, "issues.page": 2, "pulls.page": 2, "attention.details":2 };

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
  if(shape.operation==='attention.details'){
    const config=attentionFixture();if(process.env.GH_GLANCE_ATTENTION_EVENTS)appendFileSync(process.env.GH_GLANCE_ATTENTION_EVENTS,JSON.stringify({kind:'start',numbers:shape.candidates.map(c=>c.number)})+'\n');if(config.delay)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,config.delay);
    const viewerId=Number(process.env.GH_GLANCE_FIXTURE_USER_ID??1),login=process.env.GH_GLANCE_FIXTURE_LOGIN??'octocat',connection=(nodes=[])=>({totalCount:nodes.length,pageInfo:{hasNextPage:false},nodes});
    const slots={};for(const candidate of shape.candidates){
      const issue=rows('issues.json').find(r=>r.number===candidate.number),pr=rows('prs.json').find(r=>r.number===candidate.number),row=issue??pr;
      slots[candidate.alias]=Object.hasOwn(config.details??{},candidate.number)?config.details[candidate.number]:!row?null:{__typename:issue?'Issue':'PullRequest',id:`${issue?'I':'PR'}_${row.number}`,number:row.number,closed:false,updatedAt:row.updatedAt,viewerDidAuthor:!issue,assignees:connection([{id:`U_${viewerId}`,login}]),...(!issue?{isDraft:row.isDraft??false,reviewDecision:row.reviewDecision??null,reviewRequests:connection([{requestedReviewer:{__typename:'User',id:`U_${viewerId}`,login}}])}:{})};
    }
    const data={viewer:config.viewer??{id:`U_${viewerId}`,databaseId:viewerId,login},repository:{...base,...slots},rateLimit};
    const body=config.oversize?' '.repeat(2*1024*1024+1):JSON.stringify({data,...(config.errors?{errors:[{message:'synthetic permission denial'}]}:{})});
    if(config.responseGateFile&&existsSync(config.responseGateFile)){
      const event=kind=>{if(process.env.GH_GLANCE_ATTENTION_EVENTS)appendFileSync(process.env.GH_GLANCE_ATTENTION_EVENTS,JSON.stringify({kind,at:Date.now()})+'\n');};
      event('attention-response-gate-enter');
      const deadline=Date.now()+12000,waitCell=new Int32Array(new SharedArrayBuffer(4));
      while(existsSync(config.responseGateFile)&&Date.now()<deadline)Atomics.wait(waitCell,0,0,20);
      if(existsSync(config.responseGateFile)){event('attention-response-gate-expired');throw new Error('Synthetic attention response gate timed out');}
      event('attention-response-gate-released');
    }
    if(process.env.GH_GLANCE_ATTENTION_EVENTS)appendFileSync(process.env.GH_GLANCE_ATTENTION_EVENTS,JSON.stringify({kind:'end',numbers:shape.candidates.map(c=>c.number)})+'\n');
    return {operation:shape.operation,status:config.status??200,cost,body};
  }
  if(['issues.page','pulls.page'].includes(shape.operation)&&attentionFixture().sourceDelay)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,attentionFixture().sourceDelay);
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
