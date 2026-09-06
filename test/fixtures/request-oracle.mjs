// Independent synthetic GitHub server. Never import application accounting here.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../pty/fixtures");
const WAIT = new Int32Array(new SharedArrayBuffer(4));
const RESOURCES = ["core", "graphql"];
const copy = (value) => structuredClone(value);
const fixture = (name) => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8"));

export function createOracleState({ now = 1_788_566_400_000, limit = 5000, ...options } = {}) {
  const budget = () => ({ limit, used: 0, remaining: limit, resetMs: now + 3_600_000 });
  return {
    schema: 1, now, accounts: { octocat: { core: budget(), graphql: budget(), httpRequests: 0, secondaryUntil: 0 } },
    credentials: { "fixture-full": { principal: "octocat", repositories: ["*"], permissions: ["*"] } },
    entities: {}, publishedProbes: {}, scriptedEvents: [], events: [], sequence: 0,
    ...options,
  };
}

// Explicit whitelist: neither real tokens nor the developer's config can enter
// a fixture subprocess, even when a caller accidentally supplies them.
export function oracleEnvironment({ root, statePath, credential = "fixture-full", pane = "test", now } = {}) {
  return {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: root,
    XDG_CONFIG_HOME: root, GH_CONFIG_DIR: root,
    GH_GLANCE_REQUEST_ORACLE: statePath, GH_GLANCE_FIXTURE_CREDENTIAL: credential,
    GH_GLANCE_FIXTURE_PANE: pane, GH_GLANCE_FIXTURE_LOG: "/dev/null",
    ...(now === undefined ? {} : { GH_GLANCE_FIXTURE_NOW: String(now) }),
  };
}

// Deliberately small, explicit GraphQL grammar. Unknown fields, aliases,
// fragments and extra connections fail closed instead of getting a cheap answer.
export function graphqlShape(query, variables) {
  const tokens = [];
  const scanner = /\s+|#[^\n]*|"(?:[^"\\]|\\.)*"|[A-Za-z_][A-Za-z_0-9]*|[0-9]+|[!$():{},[\]]/gy;
  let position = 0;
  while (position < query.length) {
    scanner.lastIndex = position;
    const token = scanner.exec(query)?.[0];
    if (!token) throw new Error("unknown fixture GraphQL query token");
    position = scanner.lastIndex;
    if (!/^\s|^#|^,$/.test(token)) tokens.push(token);
  }
  let index = 0;
  const take = (expected) => {
    if (tokens[index++] !== expected) throw new Error("unknown fixture GraphQL query shape");
  };
  const name = () => {
    const value = tokens[index++];
    if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(value ?? "")) throw new Error("unknown fixture GraphQL field");
    return value;
  };
  function value() {
    const token = tokens[index++];
    if (token === "$") return variables[name()];
    if (token === "[") {
      const list = [];
      while (tokens[index] !== "]" && index < tokens.length) list.push(value());
      take("]");
      return list;
    }
    if (token === "{") {
      const object = {};
      while (tokens[index] !== "}" && index < tokens.length) {
        const key = name(); take(":"); object[key] = value();
      }
      take("}");
      return object;
    }
    if (/^"/.test(token ?? "")) return JSON.parse(token);
    if (/^[0-9]+$/.test(token ?? "")) return Number(token);
    if (/^[A-Za-z_][A-Za-z_0-9]*$/.test(token ?? "")) return token;
    throw new Error("unknown fixture GraphQL argument");
  }
  function selection() {
    take("{");
    const fields = {};
    while (tokens[index] !== "}" && index < tokens.length) {
      const field = name();
      if (Object.hasOwn(fields, field)) throw new Error("duplicate fixture GraphQL field");
      const args = {};
      if (tokens[index] === "(") {
        index += 1;
        while (tokens[index] !== ")" && index < tokens.length) {
          const key = name();
          if (Object.hasOwn(args, key)) throw new Error("duplicate fixture GraphQL argument");
          take(":"); args[key] = value();
        }
        take(")");
      }
      fields[field] = { args, children: tokens[index] === "{" ? selection() : null };
    }
    take("}");
    return fields;
  }
  if (tokens[index] === "query") {
    index += 1;
    if (/^[A-Za-z_]/.test(tokens[index] ?? "")) index += 1;
    if (tokens[index] === "(") {
      let depth = 0;
      do {
        if (tokens[index] === "(") depth += 1;
        if (tokens[index++] === ")") depth -= 1;
      } while (depth > 0 && index < tokens.length);
      if (depth !== 0) throw new Error("unknown fixture GraphQL variable declaration");
    }
  }
  const root = selection();
  if (index !== tokens.length) throw new Error("unknown fixture GraphQL extra operation");
  const leaf = null;
  const author = { login: leaf };
  const node = { id: leaf, number: leaf, title: leaf, url: leaf, createdAt: leaf, updatedAt: leaf, author,
    headRefName: leaf, isDraft: leaf, reviewDecision: leaf, labels: { nodes: { name: leaf } } };
  const connection = { nodes: node, totalCount: leaf, pageInfo: { hasNextPage: leaf, endCursor: leaf } };
  const schema = { rateLimit: { cost: leaf, limit: leaf, used: leaf, remaining: leaf, resetAt: leaf },
    repository: { id: leaf, name: leaf, nameWithOwner: leaf, url: leaf, viewerPermission: leaf, issues: connection, pullRequests: connection } };
  function validate(fields, expected) {
    for (const [field, definition] of Object.entries(fields)) {
      if (!expected || !Object.hasOwn(expected, field)) throw new Error(`unknown fixture GraphQL field: ${field}`);
      const allowedArgs = field === "repository" ? ["owner", "name"] :
        ["issues", "pullRequests"].includes(field) ? ["first", "after", "states", "orderBy"] : field === "labels" ? ["first"] : [];
      if (Object.keys(definition.args).some((key) => !allowedArgs.includes(key))) throw new Error("unknown fixture GraphQL argument");
      if (field === "labels" && Number(definition.args.first) !== 1) throw new Error("unbounded fixture GraphQL labels");
      if (expected[field] === null) {
        if (definition.children) throw new Error("unknown fixture GraphQL leaf selection");
      } else {
        if (!definition.children || Object.keys(definition.children).length === 0) throw new Error("missing fixture GraphQL selection");
        validate(definition.children, expected[field]);
      }
    }
  }
  validate(root, schema);
  const repository = root.repository?.children;
  const connections = ["issues", "pullRequests"].filter((field) => repository?.[field]);
  if (connections.length > 1 || Object.keys(root).length === 0) throw new Error("unknown fixture GraphQL combined query");
  const field = connections[0];
  const pageSize = field ? Number(repository[field].args.first) : 50;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new Error("unbounded fixture GraphQL page");
  const cursor = field ? repository[field].args.after ?? null : null;
  const pageOffset = cursor === null ? 0 : Number(/^cursor:([0-9]+)$/.exec(cursor)?.[1]);
  if (!Number.isSafeInteger(pageOffset)) throw new Error("unknown fixture cursor");
  return { operation: field === "issues" ? "issues.page" : field === "pullRequests" ? "pulls.page" : repository ? "repository.identity" : "graphql.observer",
    pageSize, cursor, pageOffset,
    repository: root.repository ? `${root.repository.args.owner ?? variables.owner ?? "acme"}/${root.repository.args.name ?? variables.name ?? "widget"}` : null };
}

export function identifyOracleRequest(argv, { input = null } = {}) {
  if (argv[0] === "--version") return { operation: "cli.version", local: true };
  if (argv[0] === "auth" && argv[1] === "token") return { operation: "cli.token", local: true };

  const fields = {};
  let path;
  const positionals = [];
  let explicitHost = false;
  let host = "github.com";
  let ifNoneMatch;
  let include = false;
  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index];
    if (["-i", "--include"].includes(value)) { include = true; continue; }
    if (["-f", "--raw-field", "-F", "--field"].includes(value)) {
      const pair = argv[++index] ?? "";
      const separator = pair.indexOf("=");
      fields[pair.slice(0, separator)] = pair.slice(separator + 1);
      continue;
    }
    if (["-H", "--header"].includes(value)) {
      ifNoneMatch = /^if-none-match:\s*(.+)$/i.exec(argv[++index] ?? "")?.[1] ?? ifNoneMatch;
      continue;
    }
    if (value === "--hostname") { host = argv[++index]; explicitHost = true; continue; }
    if (value.startsWith("--hostname=")) { host = value.slice(11); explicitHost = true; continue; }
    if (value.startsWith("--repo=")) { fields["--repo"] = value.slice(7); continue; }
    if (["--jq", "--json", "-X", "--method", "--repo", "-R", "--limit", "--state", "--search"].includes(value)) {
      fields[value] = argv[++index]; continue;
    }
    if (!value.startsWith("-")) {
      if (path === undefined) path = value;
      else positionals.push(value);
    }
  }
  let repository = (argv[0] === "repo" && path === "view" ? positionals[0] : undefined) ?? fields["--repo"] ?? fields["-R"] ?? "acme/widget";
  let repositoryHost;
  if (/^https?:\/\//.test(repository)) {
    const url = new URL(repository);
    repositoryHost = url.host;
    repository = url.pathname.replace(/^\/|\/$/g, "");
  } else {
    const parts = repository.split("/");
    if (parts.length === 3) {
      repositoryHost = parts.shift();
      repository = parts.join("/");
    }
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("unknown fixture repository target");
  if (repositoryHost) {
    if (explicitHost && host !== repositoryHost) throw new Error("conflicting fixture repository host");
    host = repositoryHost;
  }
  const base = { host, include, ifNoneMatch, fields, path, repository };
  if (argv[0] === "auth" && path === "status") return { ...base, operation: "cli.auth", resource: "core", cost: 1 };
  if (argv[0] === "repo" && path === "view") return { ...base, operation: "repository.identity", resource: "graphql", cost: 1 };
  if (["issue", "pr"].includes(argv[0]) && path === "list") {
    return { ...base, operation: argv[0] === "issue" ? "issues.legacy" : "pulls.legacy", resource: "graphql", cost: 2, pageSize: Number(fields["--limit"] ?? 150) };
  }
  if (argv[0] !== "api") throw new Error(`unknown fixture command: ${argv[0]} ${path ?? ""}`);
  if (path === "rate_limit") return { ...base, operation: "quota.probe", observer: true, resource: "core", cost: 0 };
  if (path === "user") return { ...base, operation: "core.observer", observer: true, resource: "core", cost: 1 };
  if (path === "graphql") {
    // `--input -` carries a typed JSON document on stdin, so the query and its
    // variables are read from there rather than from -f/-F fields, which would
    // have stringified every variable.
    let typed = null;
    if (fields["--input"] === "-" || argv.includes("--input")) {
      if (typeof input !== "string") throw new Error("fixture graphql input was not supplied");
      try { typed = JSON.parse(input); } catch { throw new Error("fixture graphql input was not JSON"); }
      if (!typed || typeof typed.query !== "string") throw new Error("fixture graphql input declared no query");
      if (typed.variables !== undefined && (typeof typed.variables !== "object" || typed.variables === null || Array.isArray(typed.variables))) {
        throw new Error("fixture graphql variables were not an object");
      }
    }
    const query = typed ? typed.query : fields.query ?? "";
    const shape = graphqlShape(query, typed ? (typed.variables ?? {}) : fields);
    // Priced per operation, identically to test/pty/fixtures/graphql-response.mjs.
    // A flat price of 1 modelled economics no server has and hid a real
    // double-charge that only appears at three points or more.
    const cost = { "graphql.observer": 1, "repository.identity": 1, "issues.page": 2, "pulls.page": 2 }[shape.operation] ?? 1;
    return { ...base, ...shape, observer: shape.operation === "graphql.observer", resource: "graphql", cost,
      repository: shape.repository ?? repository };

  }
  const match = /^repos\/([^/]+\/[^/]+)\/(actions\/runs|actions\/workflows|dependabot\/alerts|code-scanning\/alerts|secret-scanning\/alerts)(?:\?(.*))?$/.exec(path ?? "");
  if (!match) throw new Error(`unknown fixture API path: ${path}`);
  const operations = { "actions/runs": "actions.runs", "actions/workflows": "actions.workflows", "dependabot/alerts": "security.dependabot", "code-scanning/alerts": "security.code", "secret-scanning/alerts": "security.secret" };
  const params = new URLSearchParams(match[3]);
  const pageSize = Number(params.get("per_page") ?? 30);
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new Error("unbounded fixture REST page");
  return { ...base, repository: match[1], operation: operations[match[2]], resource: "core", cost: 1, pageSize, cursor: params.get("page") };
}

export function oracleEntityKey(request) {
  const filters = request.path?.includes("?")
    ? [...new URLSearchParams(request.path.split("?")[1])].sort(([a], [b]) => a.localeCompare(b))
    : Object.entries(request.fields ?? {}).filter(([key]) => !["--jq", "--json", "--repo", "-R", "cursor", "after", "first"].includes(key)).sort(([a], [b]) => a.localeCompare(b));
  return [request.host, request.repository, request.operation, request.pageSize ?? "", request.cursor ?? "", JSON.stringify(filters)].join("|");
}

function applyEvents(state, account, request, now) {
  const overrides = {};
  for (const event of state.scriptedEvents) {
    if (event.applied || (event.at !== undefined && event.at > now) ||
      (event.sequence !== undefined && event.sequence > state.sequence) ||
      (event.operation && event.operation !== request.operation) ||
      (event.repository && event.repository !== request.repository)) continue;
    event.applied = true;
    switch (event.type) {
      case "externalSpend": {
        const budget = account[event.resource];
        budget.used += event.amount;
        budget.remaining = Math.max(0, budget.remaining - event.amount);
        break;
      }
      case "reset":
        for (const resource of event.resources ?? RESOURCES) {
          account[resource].used = 0;
          account[resource].remaining = account[resource].limit;
          account[resource].resetMs = event.resetMs ?? now + 3_600_000;
        }
        break;
      case "change": state.entities[event.key ?? oracleEntityKey(request)] = copy(event.entity); break;
      case "throttle":
        account.secondaryUntil = now + event.durationMs;
        overrides.status = event.status ?? 429;
        overrides.retryAfter = event.format === "date" ? new Date(account.secondaryUntil).toUTCString() : String(Math.ceil(event.durationMs / 1000));
        break;
      case "response": Object.assign(overrides, event.response); break;
      case "delay": overrides.delayMs = event.ms; break;
      case "disconnect": overrides.disconnect = true; break;
      default: throw new Error(`unknown oracle event: ${event.type}`);
    }
  }
  return overrides;
}

function fixtureId(kind, ...identity) {
  return `${kind}_fixture_${createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 20)}`;
}

function defaultPayload(request, identity) {
  switch (request.operation) {
    case "actions.runs": return fixture("actions-runs");
    case "actions.workflows": return fixture("actions-workflows");
    case "issues.legacy": return fixture("issues");
    case "pulls.legacy": return fixture("prs");
    case "repository.identity": return { id: fixtureId("R", request.host, request.repository), nameWithOwner: request.repository, url: `https://${request.host}/${request.repository}`, viewerPermission: "READ" };
    case "core.observer": return { id: identity.id ?? Number.parseInt(createHash("sha256").update(JSON.stringify([request.host, identity.principal])).digest("hex").slice(0, 12), 16), login: identity.principal };
    case "cli.auth": return [{ host: request.host, login: identity.principal }];
    default: return [];
  }
}

function probeBudget(state, host, principal, resource, budget, now) {
  const probe = state.publishedProbes[resource] ?? { mode: "accurate" };
  if (probe.mode === "missing") return undefined;
  if (!["accurate", "pinned", "sliding"].includes(probe.mode)) throw new Error("unknown oracle probe mode");
  const scope = JSON.stringify([host, principal, resource]);
  state.probeSnapshots ??= {};
  if (probe.mode !== "accurate") state.probeSnapshots[scope] ??= copy(budget);
  const value = copy(probe.mode === "accurate" ? budget : state.probeSnapshots[scope]);
  if (probe.mode === "sliding") value.resetMs = now + 3_600_000;
  return { limit: value.limit, used: value.used, remaining: value.remaining, reset: Math.floor(value.resetMs / 1000) };
}

export function handleOracleRequest(state, { argv, input = null, credential = "fixture-full", now = state.now, pane = null, configRoot = null, pid = process.pid } = {}) {
  if (state.schema !== 1) throw new Error("unsupported oracle schema");
  const identity = state.credentials[credential];
  if (!identity) throw new Error("unknown fixture credential");
  const request = identifyOracleRequest(argv, { input });
  if (request.local) return {
    status: 200,
    body: request.operation === "cli.token" ? `${credential}\n` : "gh version 2.97.0 (fixture)\n",
    local: true,
  };
  if (!(identity.hosts ?? ["github.com"]).includes(request.host)) throw new Error("fixture credential host mismatch");
  const account = state.accounts[`${request.host}|${identity.principal}`] ??
    (request.host === "github.com" ? state.accounts[identity.principal] : undefined);
  if (!account) throw new Error("unknown fixture principal");
  state.sequence += 1;
  state.now = now;
  const before = copy(account);
  const overrides = applyEvents(state, account, request, now);
  const allowed = request.observer || ["quota.probe", "cli.auth"].includes(request.operation) ||
    (identity.repositories.includes("*") || identity.repositories.includes(request.repository)) &&
    (identity.permissions.includes("*") || identity.permissions.includes(request.operation));
  const entityKey = oracleEntityKey(request);
  const entity = state.entities[entityKey] ?? { version: 1, payload: defaultPayload(request, identity) };
  let payload = copy(entity.payload);
  if (Buffer.byteLength(JSON.stringify(payload)) > 1024 * 1024) throw new Error("oversized oracle entity");
  const tag = `"oracle-${createHash("sha256").update(JSON.stringify([credential, entityKey, entity.version, payload])).digest("hex").slice(0, 16)}"`;
  let status = allowed ? 200 : 403;
  if (allowed && request.ifNoneMatch === tag && request.resource === "core") status = 304;
  if (account.secondaryUntil > now) status = overrides.status ?? 429;
  if (account[request.resource].remaining === 0) status = 403;
  status = overrides.status ?? status;
  const charge = [200, 201].includes(status) ? (overrides.actualCost ?? request.cost) : 0;
  account.httpRequests += 1;
  account[request.resource].used += charge;
  account[request.resource].remaining = Math.max(0, account[request.resource].remaining - charge);
  const budget = account[request.resource];
  const headers = {
    etag: tag, "x-ratelimit-resource": request.resource,
    "x-ratelimit-limit": String(budget.limit), "x-ratelimit-used": String(budget.used),
    "x-ratelimit-remaining": String(budget.remaining), "x-ratelimit-reset": String(Math.floor((overrides.evidenceResetMs ?? budget.resetMs) / 1000)),
  };
  if (overrides.retryAfter !== undefined) headers["retry-after"] = overrides.retryAfter;
  else if (account.secondaryUntil > now) headers["retry-after"] = String(Math.ceil((account.secondaryUntil - now) / 1000));
  if (request.operation === "quota.probe") {
    payload = { resources: Object.fromEntries(RESOURCES.map((resource) => [resource, probeBudget(state, request.host, identity.principal, resource, account[resource], now)]).filter(([, value]) => value !== undefined)) };
  } else if (request.path === "graphql") {
    const rateLimit = { limit: budget.limit, used: budget.used, remaining: budget.remaining, resetAt: new Date(overrides.evidenceResetMs ?? budget.resetMs).toISOString(), ...(overrides.absentCost ? {} : { cost: charge }) };
    let data = { rateLimit };
    if (["issues.page", "pulls.page"].includes(request.operation)) {
      const offset = request.pageOffset;
      const rows = Array.isArray(payload) ? payload : [];
      const nodes = rows.slice(offset, offset + request.pageSize);
      data.repository = { id: fixtureId("R", request.host, request.repository), [request.operation === "issues.page" ? "issues" : "pullRequests"]: { nodes, totalCount: rows.length, pageInfo: { hasNextPage: offset + nodes.length < rows.length, endCursor: nodes.length ? `cursor:${offset + nodes.length}` : null } } };
    } else if (request.operation === "repository.identity") data.repository = payload;
    if (overrides.data !== undefined) data = overrides.data;
    payload = { data, ...(overrides.graphqlErrors ? { errors: overrides.graphqlErrors } : {}) };
  }
  if (status >= 400) payload = { message: allowed ? "fixture rate limit" : "fixture permission denied" };
  if (overrides.payload !== undefined) payload = overrides.payload;
  const body = status === 304 ? "" : `${JSON.stringify(payload)}\n`;
  const event = {
    sequence: state.sequence, type: "request", operation: request.operation, host: request.host,
    repository: request.repository, variant: entityKey, principal: identity.principal,
    credential, pane, configRoot, pid, observer: request.observer === true,
    at: now, startedAt: Date.now(), simulatedCompletedAt: now + (overrides.delayMs ?? 0),
    status, cost: { core: 0, graphql: 0, [request.resource]: charge }, httpRequests: 1,
    before, after: copy(account), ...(overrides.disconnect ? { disconnected: true } : {}),
  };
  state.events.push(event);
  return { status, headers, body, include: request.include, delayMs: overrides.delayMs ?? 0, disconnect: overrides.disconnect === true, event };
}

// Oracle lock/root are wholly separate from application coordination. An owner
// killed in a request never holds this lock: it is released before simulated I/O.
export function withOracleState(path, operation) {
  const lock = `${path}.oracle-lock`;
  const deadline = Date.now() + 10_000;
  for (;;) {
    try { mkdirSync(lock, { mode: 0o700 }); break; } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new Error("oracle lock timeout", { cause: error });
      Atomics.wait(WAIT, 0, 0, 2);
    }
  }
  try {
    const state = JSON.parse(readFileSync(path, "utf8"));
    const result = operation(state);
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
    return result;
  } finally { rmSync(lock, { recursive: true, force: true }); }
}

export async function runOracleFixture(argv = process.argv.slice(2), env = process.env) {
  // gh api graphql --input - sends one JSON body, not hidden requests.
  // The document stays on stdin and is handed through as-is. Rewriting it into
  // -f fields -- which this used to do -- put the query back in argv and turned
  // every typed variable into a string, so `first: 50` became "50" and
  // `after: null` vanished. That is precisely what stdin exists to prevent, and
  // it meant the oracle path verified none of it.
  let stdin = null;
  const inputIndex = argv.indexOf("--input");
  if (inputIndex !== -1) {
    if (argv[inputIndex + 1] !== "-") throw new Error("oracle only accepts stdin fixture input");
    let input = "";
    for await (const chunk of process.stdin) {
      input += chunk;
      if (Buffer.byteLength(input) > 1024 * 1024) throw new Error("oversized oracle input");
    }
    stdin = input;
  }
  const response = withOracleState(env.GH_GLANCE_REQUEST_ORACLE, (state) => handleOracleRequest(state, {
    argv, input: stdin, credential: env.GH_GLANCE_FIXTURE_CREDENTIAL,
    now: env.GH_GLANCE_FIXTURE_NOW === undefined ? Date.now() : Number(env.GH_GLANCE_FIXTURE_NOW),
    pane: env.GH_GLANCE_FIXTURE_PANE, configRoot: env.XDG_CONFIG_HOME,
  }));
  if (env.GH_GLANCE_FIXTURE_READY) writeFileSync(env.GH_GLANCE_FIXTURE_READY, `${JSON.stringify({ pid: process.pid, at: Date.now() })}\n`, { mode: 0o600 });
  if (response.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, response.delayMs));
  if (response.event) withOracleState(env.GH_GLANCE_REQUEST_ORACLE, (state) => {
    state.events.find((event) => event.sequence === response.event.sequence).completedAt = Date.now();
  });
  if (response.disconnect) { process.exitCode = 1; return; }
  if (response.include) {
    process.stdout.write(`HTTP/2 ${response.status} ${response.status === 200 ? "OK" : response.status === 304 ? "Not Modified" : response.status === 429 ? "Too Many Requests" : "Forbidden"}\r\n`);
    for (const [name, value] of Object.entries(response.headers)) process.stdout.write(`${name}: ${value}\r\n`);
    process.stdout.write("\r\n");
  }
  process.stdout.write(response.body);
  if (response.status !== 200) process.exitCode = 1;
}
