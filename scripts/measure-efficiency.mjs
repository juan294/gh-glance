import { createHash, createHmac, generateKeyPairSync } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync,
  readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer as createNetServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  ACQUISITION_CLAIM_TTL_MS,
  acquisitionDiagnostics,
  acquisitionQueryForTab,
  acquisitionStorePath,
  admitGovernorOperation,
  claimProbe,
  createAcquisitionEngine,
  createCollectorAcquisitionRuntime,
  createCollectorService,
  createCollectorSourceAgeTracker,
  createGovernorScope,
  createIdentityCoordinator,
  createQuotaScope,
  createSshCollectorClient,
  createSshCollectorTransport,
  inspectGovernor,
  loadAcquisitionStore,
  maintainControlLease,
  normalizeCollectorConfig,
  publishProbe,
  projectCollectorSnapshot,
  webhookQueuePath,
} from "../index.mjs";
import {
  createOracleState,
  handleOracleRequest,
  identifyOracleRequest,
  oracleEntityKey,
} from "../test/fixtures/request-oracle.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = join(HERE, "..");
const DEFAULT_WORKLOAD = join(REPOSITORY_ROOT, "test/fixtures/workloads/multi-instance-v1.json");
const DEFAULT_BASELINE = join(REPOSITORY_ROOT,
  "docs/plans/2026-09-05-multi-instance-efficiency-phases/phase-1-baseline.json");
const CAPTURE_STARTUP = join(REPOSITORY_ROOT, "test/fixtures/capture-request-baseline.mjs");
const DASHBOARD = join(REPOSITORY_ROOT, "index.mjs");
const FIXTURE_SSH = join(REPOSITORY_ROOT, "test/fixtures/ssh");
const WEBHOOK_EVENTS = JSON.parse(readFileSync(join(REPOSITORY_ROOT,
  "test/fixtures/webhook-events.json"), "utf8"));
const execFileAsync = promisify(execFile);
const START_AT = 1_800_000_000_000;
const ACCESS_FULL = "a".repeat(64);
const ACCESS_RESTRICTED = "b".repeat(64);
const OBSERVER_GRAPHQL = [
  "api", "graphql", "-f",
  "query=query { rateLimit { cost used remaining resetAt } }",
];
let cachedFixturePrivateKeyPem = null;

function deterministicUuid(...parts) {
  const hash = createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function deterministicIdFactory(namespace) {
  let sequence = 0;
  return (...parts) => deterministicUuid(namespace,
    ...(parts.length > 0 ? parts : ["sequence", sequence++]));
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * fraction))];
}

async function within(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(
          typeof message === "function" ? message() : message,
        )), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function fixturePrivateKeyPem() {
  if (cachedFixturePrivateKeyPem === null) {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    cachedFixturePrivateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
  }
  return cachedFixturePrivateKeyPem;
}

async function freeLoopbackPort() {
  const server = createNetServer();
  await new Promise((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePort);
  });
  const port = server.address().port;
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

function postLoopback(port, body, headers) {
  return new Promise((resolvePost, reject) => {
    const request = httpRequest({ hostname: "127.0.0.1", port,
      path: "/webhooks/github", method: "POST", headers }, (response) => {
      response.resume();
      response.once("end", () => resolvePost(response.statusCode));
    });
    request.once("error", reject);
    request.end(body);
  });
}

function actionArgs(repository, etag = null) {
  const args = ["api", "-i", `repos/${repository}/actions/runs?per_page=60&page=1`];
  if (etag) args.push("-H", `If-None-Match: ${etag}`);
  return args;
}

function actionPayload(repository, version = 1, state = "quiet") {
  return {
    workflow_runs: [{
      id: version,
      name: `${repository} CI v${version}`,
      display_title: `${repository} CI v${version}`,
      run_number: version,
      head_branch: "develop",
      status: state === "running" ? "in_progress" : "completed",
      conclusion: state === "running" ? null : "success",
      created_at: "2026-09-05T00:00:00Z",
      updated_at: "2026-09-05T00:01:00Z",
      html_url: `https://github.com/${repository}/actions/runs/${version}`,
    }],
  };
}

function actionRow(repository, payload) {
  const run = payload.workflow_runs[0];
  return {
    databaseId: run.id,
    displayTitle: run.display_title,
    workflowName: run.name,
    number: run.run_number,
    headBranch: run.head_branch,
    status: run.status,
    conclusion: run.conclusion,
    startedAt: run.created_at,
    updatedAt: run.updated_at,
    url: run.html_url ?? `https://github.com/${repository}/actions/runs/${run.id}`,
  };
}

function publication(repository, response, previous, completedAt, floorMs) {
  const changed = response.status === 200;
  const entityBody = changed ? response.body.trim() : previous.entities[0].body;
  const payload = JSON.parse(entityBody);
  const rows = changed ? [actionRow(repository, payload)] : previous.rows;
  return {
    rows,
    pageInfo: { loadedPages: 1, hasNextPage: false },
    raw: JSON.stringify(rows),
    entities: [{ key: "actions\0runs", etag: response.headers.etag, body: entityBody }],
    lastSuccessAt: completedAt,
    lastChangedAt: changed ? completedAt : previous.lastChangedAt,
    nextDueAt: completedAt + floorMs,
    hold: null,
    capabilities: {},
    meta: { at: completedAt, truncated: false },
    securityNotes: [],
    securityBlind: false,
    requestMetrics: {
      httpRequests: 1,
      rest200: changed ? 1 : 0,
      rest304: response.status === 304 ? 1 : 0,
      coreUnits: response.event.cost.core,
      graphqlUnits: response.event.cost.graphql,
      failedRequests: 0,
    },
  };
}

function observerBudget(response, resource) {
  if (resource === "core") {
    return {
      limit: Number(response.headers["x-ratelimit-limit"]),
      used: Number(response.headers["x-ratelimit-used"]),
      remaining: Number(response.headers["x-ratelimit-remaining"]),
      resetMs: Number(response.headers["x-ratelimit-reset"]) * 1000,
      source: "core-observer",
      receivedAt: response.event.at,
      cost: response.event.cost.core,
    };
  }
  const rate = JSON.parse(response.body).data.rateLimit;
  return {
    limit: rate.limit,
    used: rate.used,
    remaining: rate.remaining,
    resetMs: Date.parse(rate.resetAt),
    source: "graphql-observer",
    receivedAt: response.event.at,
    cost: response.event.cost.graphql,
  };
}

function queryFor(repository, accessKey = ACCESS_FULL) {
  return acquisitionQueryForTab("actions", { host: "github.com", accessKey }, repository, 1);
}

function expandRepositories(topology) {
  if (topology.repositoryPattern) {
    return Array.from({ length: topology.panes }, (_, pane) =>
      topology.repositoryPattern.replace("{pane}", String(pane)));
  }
  return Array.from({ length: topology.panes }, (_, pane) =>
    topology.repositories[pane % topology.repositories.length]);
}

function readScenario(path) {
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  const scenario = manifest.scenarios?.find(({ id }) => id === "sustained-hour");
  if (!scenario || scenario.clock !== "injected" || !Array.isArray(scenario.topologies) ||
      !Array.isArray(scenario.timeline)) throw new Error("invalid sustained efficiency workload");
  const responseLatencyMs = manifest.defaults?.responseLatencyMs;
  if (!Number.isSafeInteger(responseLatencyMs) || responseLatencyMs < 0) {
    throw new Error("invalid sustained response latency");
  }
  return { manifest, scenario: { ...scenario, responseLatencyMs } };
}

function fixtureEvent(state, event, now) {
  if (event.type === "externalSpend") {
    state.scriptedEvents.push({ type: "externalSpend", at: now,
      resource: event.resource, amount: event.amount });
  } else if (event.type === "primaryReset") {
    state.scriptedEvents.push({ type: "reset", at: now, resetMs: now + 3_600_000 });
  } else if (event.type === "secondaryHold") {
    state.scriptedEvents.push({ type: "throttle", at: now,
      durationMs: event.durationMs, format: "seconds" });
  }
}

function createVirtualScheduler(startAt, intervalFloorMs = 40_000) {
  let current = startAt;
  let sequence = 0;
  const timers = new Map();
  const pending = new Set();
  const schedule = (callback, delay, interval = null) => {
    const id = ++sequence;
    timers.set(id, { id, callback, at: current + Math.max(0, Number(delay) || 0), interval });
    return { id, unref() {} };
  };
  const clear = (handle) => timers.delete(handle?.id ?? handle);
  const flush = () => new Promise((resolveFlush) => setImmediate(resolveFlush));
  const nextTimer = (target) => {
    let selected = null;
    for (const candidate of timers.values()) {
      if (candidate.at > target) continue;
      if (selected === null || candidate.at < selected.at ||
          (candidate.at === selected.at && candidate.id < selected.id)) selected = candidate;
    }
    return selected;
  };
  return {
    now: () => current,
    set(value) { current = value; },
    elapse(duration) { current += Math.max(0, Number(duration) || 0); },
    setTimeout: (callback, delay) => schedule(callback, delay),
    clearTimeout: clear,
    setInterval: (callback, delay) => {
      const interval = Math.max(intervalFloorMs, Number(delay) || 1);
      return schedule(callback, interval, interval);
    },
    clearInterval: clear,
    async flush() { await flush(); },
    async advanceTo(target) {
      let steps = 0;
      let pendingError = null;
      const runTimer = async (next) => {
        if (++steps > 1_000) throw new Error(
          `virtual timer runaway at ${current - startAt}ms (${timers.size} timers, ${pending.size} polls)`,
        );
        current = Math.max(current, next.at);
        if (next.interval === null) timers.delete(next.id);
        else next.at += next.interval;
        const result = next.callback();
        if (!result || typeof result.then !== "function") return;
        const record = { settled: false };
        pending.add(record);
        result.then(() => { record.settled = true; }, (error) => {
          record.settled = true;
          pendingError ??= error;
        }).finally(() => pending.delete(record));
        while (!record.settled) {
          await flush();
          if (pendingError) throw pendingError;
          const nested = nextTimer(target);
          if (!nested) break;
          await runTimer(nested);
        }
      };
      for (;;) {
        await flush();
        if (pendingError) throw pendingError;
        const next = nextTimer(target);
        if (!next) break;
        await runTimer(next);
      }
      current = Math.max(current, target);
      await flush();
      if (pendingError) throw pendingError;
    },
  };
}

function includedResponse(response) {
  if (!response.include) return response.body;
  const phrase = response.status === 200 ? "OK" : response.status === 304
    ? "Not Modified" : response.status === 429 ? "Too Many Requests" : "Forbidden";
  return `HTTP/2 ${response.status} ${phrase}\r\n${Object.entries(response.headers)
    .map(([name, value]) => `${name}: ${value}`).join("\r\n")}\r\n\r\n${response.body}`;
}

function createOracleTransport(oracle, clock, credential, observations, responseLatencyMs = 0) {
  let active = 0;
  let maximumConcurrent = 0;
  const executeGh = (_command, argv) => {
    let input = null;
    let run;
    const pending = new Promise((resolve, reject) => {
      run = () => {
        active += 1;
        maximumConcurrent = Math.max(maximumConcurrent, active);
        let finishObservation = null;
        try {
          const response = handleOracleRequest(oracle, {
            argv, input, credential: credential(), now: clock.now(),
          });
          finishObservation = observations?.(response) ?? null;
          const latencyMs = Math.max(response.delayMs ?? 0, responseLatencyMs);
          clock.elapse(latencyMs);
          response.event.simulatedCompletedAt = clock.now();
          const complete = () => {
            try {
              const stdout = includedResponse(response);
              if (response.disconnect || response.status !== 200) {
                const error = new Error(response.disconnect ? "fixture transport disconnected" :
                  `fixture HTTP ${response.status}`);
                error.stdout = stdout;
                error.httpStarted = true;
                reject(error);
              } else resolve({ stdout, stderr: "" });
            } finally {
              finishObservation?.();
              active -= 1;
            }
          };
          complete();
        } catch (error) {
          active -= 1;
          reject(error);
        }
      };
    });
    pending.child = { stdin: {
      on() {},
      end(value = "") { input = String(value); queueMicrotask(run); },
    } };
    if (!argv.includes("--input")) queueMicrotask(run);
    return pending;
  };
  return { executeGh, maximumConcurrent: () => maximumConcurrent };
}

function createOracleBudgetReader(oracle, clock, credential) {
  return async (_signal, _host, { resources = ["core", "graphql"] } = {}) => {
    const budgets = {};
    for (const resource of resources) {
      const response = handleOracleRequest(oracle, {
        argv: resource === "core" ? ["api", "-i", "user"] : OBSERVER_GRAPHQL,
        credential: credential(), now: clock.now(),
      });
      if (response.status !== 200) return null;
      const observed = observerBudget(response, resource);
      budgets[resource] = {
        budget: { resource, limit: observed.limit, used: observed.used,
          remaining: observed.remaining, resetMs: observed.resetMs },
        receivedAt: observed.receivedAt,
        cost: observed.cost,
        ...(resource === "core" ? { etag: response.headers.etag } : {}),
      };
    }
    return budgets;
  };
}

function acquisitionEvidence(root, now) {
  const loaded = loadAcquisitionStore(acquisitionStorePath({ env: { XDG_CONFIG_HOME: root } }));
  if (!loaded.ok) throw new Error(`acquisition evidence unavailable: ${loaded.reason}`);
  return { state: loaded.value, diagnostics: acquisitionDiagnostics(loaded.value, { nowMs: now }) };
}

async function runCollectorCohort(now) {
  const root = mkdtempSync("/tmp/gge-remote-");
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  symlinkSync(DASHBOARD, join(bin, "gh-glance"));
  chmodSync(FIXTURE_SSH, 0o755);
  const config = normalizeCollectorConfig({
    version: 1,
    providers: { fixture: { type: "gh", host: "github.com" } },
    targets: [{ host: "github.com", repo: "acme/widget", provider: "fixture" }],
  });
  const target = config.targets[0];
  let releaseProvider;
  const providerGate = new Promise((resolveGate) => { releaseProvider = resolveGate; });
  let starts = 0;
  const serverOracle = createOracleState({ now });
  serverOracle.entities[oracleEntityKey(identifyOracleRequest(actionArgs("acme/widget")))] = {
    version: 1, payload: actionPayload("acme/widget"),
  };
  const diagnostics = [];
  const acquisitionRuntime = createCollectorAcquisitionRuntime({
    config,
    pathOptions: { env: { XDG_CONFIG_HOME: root }, platform: "linux" },
    now: () => now,
    setTimeout: () => ({ unref() {} }),
    clearTimeout: () => {},
    onDiagnostic: (event) => diagnostics.push(event),
    async resolveProvider() {
      await providerGate;
      return { host: "github.com", accessKey: ACCESS_FULL, generation: 1 };
    },
    async resolveTargetIdentity() {
      return { id: "R_efficiency", nameWithOwner: "acme/widget" };
    },
    async produce({ markStarted }) {
      const started = await markStarted();
      if (!started.ok) throw new Error(`collector start failed: ${started.reason}`);
      const response = handleOracleRequest(serverOracle, { argv: actionArgs("acme/widget"), now });
      starts = serverOracle.events.filter(({ operation }) => operation === "actions.runs").length;
      return publication("acme/widget", response, null, now, 60_000);
    },
  });
  let subscribed = 0;
  let releaseSubscribed;
  const allSubscribed = new Promise((resolveSubscribed) => { releaseSubscribed = resolveSubscribed; });
  const runtime = {
    ...acquisitionRuntime,
    subscribe(options) {
      const handle = acquisitionRuntime.subscribe(options);
      subscribed += 1;
      if (subscribed === 7) releaseSubscribed();
      return handle;
    },
  };
  const pathOptions = { env: { XDG_CONFIG_HOME: root }, platform: process.platform, home: root };
  const service = await createCollectorService({ config, runtime, pathOptions });
  const clientProcessStarts = [];
  const clients = Array.from({ length: 7 }, (_, index) => {
    const clientRoot = index < 3 ? "client-a" : "client-b";
    return createSshCollectorClient({
      alias: `fixture-${index}`,
      random: () => 0,
      createTransport: () => createSshCollectorTransport({
        alias: `fixture-${index}`,
        env: { PATH: `${bin}:${process.env.PATH}`, HOME: root },
        spawn_(command, args, options) {
          clientProcessStarts.push({ command, args: [...args], clientRoot });
          return spawn(FIXTURE_SSH, args, {
            ...options,
            env: { ...options.env, PATH: `${bin}:${process.env.PATH}`, HOME: root,
              GH_GLANCE_CLIENT_ROOT: clientRoot },
          });
        },
      }),
    });
  });
  try {
    const deliveries = clients.map((client, index) => new Promise((resolveDelivery) => {
      client.subscribe({
        id: `remote-${index}`,
        host: target.host,
        repo: target.repo,
        resource: "actions",
        demand: { active: true, background: true, floorMs: 5_000, pages: 1 },
        onSnapshot: resolveDelivery,
        onHold() {},
      });
    }));
    await within(allSubscribed, 5_000, "remote subscriptions timed out");
    releaseProvider();
    const snapshots = await within(Promise.all(deliveries), 5_000, () =>
      `collector cohort timed out (${subscribed} subscribed, ${starts} starts, ${JSON.stringify(diagnostics.slice(-3))})`);
    return {
      starts,
      deliveries: snapshots.length,
      generations: new Set(snapshots.map(({ generation }) => generation)).size,
      clientGithubRequests: clientProcessStarts.filter(({ command }) => command === "gh").length,
      clientRoots: new Set(clientProcessStarts.map(({ clientRoot }) => clientRoot)).size,
      clientProcessStarts: clientProcessStarts.length,
      sshOnly: clientProcessStarts.every(({ command, args }) => command === "ssh" &&
        args.at(-1) === "gh-glance --collector-stdio"),
      transport: "service+stdio+fake-ssh",
    };
  } finally {
    try {
      for (const client of clients) client.close();
    } finally {
      try {
        await service.close();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  }
}

async function runTopology(scenario, topology, root) {
  mkdirSync(root, { recursive: true });
  const clock = createVirtualScheduler(START_AT);
  const createId = deterministicIdFactory(topology.id);
  const oracle = createOracleState({ now: START_AT, limit: 5_000,
    publishedProbes: scenario.publishedProbes });
  oracle.scriptedEvents.push({ type: "reset", at: START_AT + 1,
    resetMs: START_AT + 3_601_000 });
  oracle.credentials["fixture-restricted"] = {
    principal: "octocat",
    repositories: ["*"],
    permissions: ["actions.runs", "actions.workflows"],
  };
  const repositories = expandRepositories(topology);
  for (const repository of new Set(repositories)) {
    const request = identifyOracleRequest(actionArgs(repository));
    oracle.entities[oracleEntityKey(request)] = { version: 1, payload: actionPayload(repository) };
  }
  const pinnedBefore = JSON.parse(handleOracleRequest(oracle,
    { argv: ["api", "rate_limit"], now: clock.now() }).body).resources.graphql.used;
  let credentialName = "fixture-full";
  let accessGeneration = 1;
  const latestTransportStart = new Map();
  const activeProducerStarts = new Map();
  const maximumProducerStarts = new Map();
  const transport = createOracleTransport(oracle, clock, () => credentialName, (response) => {
    if (response.event.operation === "actions.runs") {
      latestTransportStart.set(response.event.repository, response.event.at);
      const loaded = loadAcquisitionStore(acquisitionStorePath({ env: { XDG_CONFIG_HOME: root } }));
      const active = loaded.ok ? Object.values(loaded.value.queries).filter(({ query, claim }) =>
        query.resource === "actions" && claim?.started) : [];
      const record = active.find(({ query }) => query.repository?.toLowerCase() ===
        response.event.repository.toLowerCase()) ?? (active.length === 1 ? active[0] : null);
      if (record) {
        const key = `${record.query.queryKey}:${record.claim.generation}`;
        const active = (activeProducerStarts.get(key) ?? 0) + 1;
        activeProducerStarts.set(key, active);
        maximumProducerStarts.set(key, Math.max(maximumProducerStarts.get(key) ?? 0, active));
        return () => activeProducerStarts.set(key, active - 1);
      }
    }
  }, scenario.responseLatencyMs);
  const config = normalizeCollectorConfig({ version: 1,
    providers: { fixture: { type: "gh", host: "github.com" } },
    targets: [...new Set(repositories)].map((repo) => ({ host: "github.com", repo, provider: "fixture" })),
  });
  let providerContext;
  const runtimeDiagnostics = [];
  const makeProvider = async () => {
    providerContext?.coordinator?.close();
    const coordinator = createIdentityCoordinator({
      host: "github.com",
      pathOptions: { env: { XDG_CONFIG_HOME: root } },
      env: { GH_TOKEN: `efficiency-${credentialName}` },
      now: clock.now,
      requestIdentity: async () => {
        const response = handleOracleRequest(oracle, {
          argv: ["api", "-i", "user"], credential: credentialName, now: clock.now(),
        });
        const budget = observerBudget(response, "core");
        return { status: response.status, body: JSON.parse(response.body),
          rateLimit: { resource: "core", limit: budget.limit, used: budget.used,
            remaining: budget.remaining, resetMs: budget.resetMs },
          etag: response.headers.etag };
      },
    });
    const resolved = await coordinator.refresh();
    if (!resolved.ok) throw new Error(`efficiency identity unavailable: ${resolved.reason}`);
    const identity = resolved.value;
    const scope = { ...createQuotaScope(identity, { root: coordinator.root, now: clock.now,
      identityProvider: coordinator.current }), identityCoordinator: coordinator,
    executeGh: transport.executeGh, providerType: "gh",
    httpWait: async (delay) => clock.elapse(delay) };
    providerContext = { coordinator, identity, scope, definition: { type: "gh", host: "github.com" },
      leaseId: deterministicUuid(topology.id, "provider", accessGeneration),
      credentialEnvironment: null, capabilities: null, readBudgets: null };
    return providerContext;
  };
  await makeProvider();
  clock.elapse(2);
  const providerForTarget = (target) => ({ ...providerContext,
    scope: { ...providerContext.scope, repository: target.repo } });
  const runtime = createCollectorAcquisitionRuntime({
    config,
    pathOptions: { env: { XDG_CONFIG_HOME: root }, platform: "linux", home: root },
    now: clock.now,
    createId,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
    resolveProvider: async (_name, target) => providerForTarget(target),
    refreshProvider: async (_name, target) => providerForTarget(target),
    resolveTargetIdentity: async ({ target }) => ({ id: `R_${target.repo.replace(/[^A-Za-z0-9]/g, "_")}`,
      nameWithOwner: target.repo }),
    readBudgets: createOracleBudgetReader(oracle, clock, () => credentialName),
    onDiagnostic: (event) => runtimeDiagnostics.push({ ...event, at: clock.now() }),
  });
  const driveHandle = async (handle, repository) => {
    let settled = false;
    let failure = null;
    const operation = handle.whenCurrentPollSettled().then(
      () => { settled = true; },
      (error) => { settled = true; failure = error; },
    );
    for (let step = 0; !settled && step < 200; step += 1) {
      await clock.advanceTo(clock.now() + 1_000);
    }
    if (!settled) throw new Error(`efficiency ${repository} poll did not settle`);
    await operation;
    if (failure) throw failure;
  };
  const acknowledgments = [];
  const queueDelays = [];
  const latestChangeAt = new Map();
  const deliveries = new Map();
  const dueGenerations = new Map([...new Set(repositories)].map((repository) =>
    [repository.toLowerCase(), new Set()]));
  const handles = [];
  for (const repository of repositories) {
    let firstDelivery = false;
    const handle = runtime.subscribe({
      target: config.targets.find((target) => target.repo === repository),
      resource: "actions",
      demand: { active: true, background: true, floorMs: scenario.tickMs, pages: 1 },
      onSnapshot(snapshot) {
        firstDelivery = true;
        if (Number.isSafeInteger(snapshot.generation)) {
          dueGenerations.get(repository.toLowerCase())?.add(snapshot.generation);
        }
        const deliveryKey = `${repository}:${snapshot.generation}`;
        const delivered = deliveries.get(deliveryKey) ?? 0;
        deliveries.set(deliveryKey, delivered + 1);
        if (delivered > 0 && latestTransportStart.has(repository)) {
          queueDelays.push(Math.max(0, clock.now() - latestTransportStart.get(repository)));
        }
        const changedAt = latestChangeAt.get(repository);
        if (changedAt !== undefined && snapshot.rows.some(({ databaseId }) => Number(databaseId) > 1)) {
          acknowledgments.push(Math.max(0, clock.now() - changedAt));
          latestChangeAt.delete(repository);
        }
      },
      onHold() {},
    });
    handles.push(handle);
    for (let turn = 0; !firstDelivery; turn += 1) {
      if (turn >= 200) throw new Error(`efficiency ${repository} initialization timed out: ${JSON.stringify({
        handle: handle.inspect(), diagnostics: runtimeDiagnostics.slice(-5),
        oracle: oracle.events.slice(-5).map(({ at, operation, status }) => ({ at, operation, status })),
        acquisition: acquisitionEvidence(root, clock.now()).diagnostics,
      })}`);
      await driveHandle(handle, repository);
    }
  }
  const advance = async (at) => {
    try {
      while (clock.now() < at) {
        await clock.advanceTo(Math.min(at, clock.now() + scenario.tickMs));
      }
    } catch (error) {
      error.message += `; diagnostics=${JSON.stringify(runtimeDiagnostics.slice(-5))}`;
      error.message += `; oracle=${JSON.stringify(oracle.events.slice(-5).map(({ at, operation, status }) => ({ at, operation, status })))}`;
      throw error;
    }
  };
  try {
    await clock.flush();
    for (const event of scenario.timeline) {
      await advance(START_AT + event.atMs - 1);
      clock.set(START_AT + event.atMs);
      if (event.type === "change") {
          const repository = repositories.includes(event.repository) ? event.repository : repositories[0];
          const key = oracleEntityKey(identifyOracleRequest(actionArgs(repository)));
          oracle.entities[key] = { version: event.version,
            payload: actionPayload(repository, event.version, event.state) };
          latestChangeAt.set(repository, clock.now());
      } else if (["externalSpend", "primaryReset", "secondaryHold"].includes(event.type)) {
        fixtureEvent(oracle, event, clock.now());
        if (event.type === "secondaryHold") {
          for (const handle of handles.slice(1)) {
            handle.updateDemand({ active: false, background: false,
              floorMs: scenario.tickMs, pages: 1 });
          }
        }
      } else if (event.type === "producerLoss") {
        // The durable owner-death injection is exercised once by
        // runCombinedSafetyEvidence; ordinary cadence remains production-owned here.
      } else if (event.type === "accountSwitch") {
        credentialName = event.credential;
        accessGeneration += 1;
        await makeProvider();
        oracle.scriptedEvents.push({ type: "reset", at: clock.now() + 1,
          resetMs: clock.now() + 3_601_000 });
        clock.elapse(2);
      } else if (event.type === "forceRefresh") {
        const refresh = handles[0].refresh(true);
        await advance(clock.now() + scenario.tickMs);
        await refresh;
      } else if (event.type === "recovery" && event.from === "secondaryHold") {
        for (const handle of handles.slice(1)) {
          handle.updateDemand({ active: true, background: true,
            floorMs: scenario.tickMs, pages: 1 });
        }
      }
      await advance(clock.now());
    }
    await advance(START_AT + scenario.durationMs - 1);
    const { diagnostics: diagnostic } = acquisitionEvidence(root, clock.now());
    const pinnedAfter = JSON.parse(handleOracleRequest(oracle,
      { argv: ["api", "rate_limit"], now: clock.now() }).body).resources.graphql.used;
    const account = oracle.accounts.octocat;
    const maximumProducersPerGeneration = Math.max(0, ...maximumProducerStarts.values());
    const duplicateProducerPerGeneration = [...maximumProducerStarts.values()].filter((starts) => starts > 1).length;
    const switchAt = START_AT + (scenario.timeline.find(({ type }) => type === "accountSwitch")?.atMs ?? Infinity);
    const afterSwitch = oracle.events.filter(({ at, observer }) => at > switchAt && !observer);
    const holdRecoveryAt = START_AT + (scenario.timeline.find(({ type, from }) =>
      type === "recovery" && from === "secondaryHold")?.atMs ?? Infinity);
    const resetAt = START_AT + (scenario.timeline.find(({ type }) => type === "primaryReset")?.atMs ?? Infinity);
    const minimumCoreRemaining = Math.min(...oracle.events.map(({ after }) => after.core.remaining));
    const repositoryProgress = Object.fromEntries([...new Set(repositories)].sort().map((repository) => {
      const requests = oracle.events.filter(({ operation, repository: eventRepository }) =>
        operation === "actions.runs" && eventRepository?.toLowerCase() === repository.toLowerCase());
      const successes = requests.filter(({ status }) => status < 400);
      return [repository.toLowerCase(), {
        dueGenerations: dueGenerations.get(repository.toLowerCase())?.size ?? 0,
        requests: requests.length,
        successes: successes.length,
        postHoldSuccesses: successes.filter(({ at }) => at >= holdRecoveryAt).length,
        postResetSuccesses: successes.filter(({ at }) => at >= resetAt).length,
      }];
    }));
    return {
      id: topology.id,
      panes: topology.panes,
      ...(topology.clientsByRoot ? { clientsByRoot: topology.clientsByRoot } : {}),
      simulatedDurationMs: scenario.durationMs,
      attributableStreams: new Set(repositories).size,
      maximumProducersPerGeneration,
      maximumConcurrentProducerRequests: transport.maximumConcurrent(),
      duplicateProducerPerGeneration,
      coalescedConsumers: Math.max(0, ...diagnostic.queries.map(({ coalescedConsumers }) => coalescedConsumers)),
      metrics: diagnostic.metrics,
      oracleEvents: oracle.events,
      acknowledgments,
      queueDelays,
      accountSwitchIsolated: afterSwitch.some(({ credential }) => credential === "fixture-restricted") &&
        afterSwitch.every(({ credential }) => credential === "fixture-restricted"),
      progressAfterReset: oracle.events.some(({ at, status, observer }) =>
        !observer && status < 400 && at > resetAt),
      secondaryHoldObserved: oracle.events.some(({ status }) => status === 429),
      minimumCoreRemaining,
      minimumGraphqlRemaining: Math.min(...oracle.events.map(({ after }) => after.graphql.remaining)),
      pinnedGraphqlProbe: { before: pinnedBefore, after: pinnedAfter,
        actualUsed: account.graphql.used },
      repositoryProgress,
    };
  } finally {
    for (const handle of handles) handle.close();
    await runtime.close();
  }
}

function actionPublication(repository, version, at) {
  const body = JSON.stringify(actionPayload(repository, version));
  return publication(repository, {
    status: 200,
    headers: { etag: `"safety-${version}"` },
    body,
    event: { cost: { core: 1, graphql: 0 } },
  }, null, at, 60_000);
}

async function claimAndStart(engine, subscriptionId, label) {
  const claimed = await engine.refresh(subscriptionId, { force: true });
  if (!claimed.ok || claimed.value.role !== "producer") {
    throw new Error(`safety ${label} claim unavailable`);
  }
  const started = await engine.refresh(subscriptionId, { started: claimed.value });
  if (!started.ok) throw new Error(`safety ${label} start failed: ${started.reason}`);
  return claimed.value;
}

async function runCombinedSafetyEvidence(root) {
  mkdirSync(root, { recursive: true });
  let now = START_AT;
  const timers = { setInterval: () => ({ unref() {} }), clearInterval: () => {} };
  const pathOptions = { env: { XDG_CONFIG_HOME: root } };
  const old = createAcquisitionEngine({ pathOptions, now: () => now, pid: 111, kill: () => {}, ...timers });
  const query = queryFor("acme/widget");
  const demand = { active: true, background: true, floorMs: 60_000, pages: 1 };
  const first = old.subscribe(query, demand);
  if (!first.ok) throw new Error(`safety subscription failed: ${first.reason}`);
  const initialClaim = await claimAndStart(old, first.value.id, "initial");
  const initialPublished = await old.refresh(first.value.id, { claim: { ...initialClaim, accessKey: ACCESS_FULL },
    publish: actionPublication("acme/widget", 1, now) });
  if (!initialPublished.ok) throw new Error(`safety initial publish failed: ${initialPublished.reason}`);
  const abandonedClaim = await claimAndStart(old, first.value.id, "abandoned");
  const retainedUncertainCoreUnits = old.diagnostics().value.metrics.uncertainCoreUnits;
  const retainedUncertainty = retainedUncertainCoreUnits >= 1;

  now += ACQUISITION_CLAIM_TTL_MS + 1;
  const deadOwner = (pid) => {
    if (pid === 111) { const error = new Error("dead"); error.code = "ESRCH"; throw error; }
  };
  const successor = createAcquisitionEngine({ pathOptions, now: () => now, pid: 222, kill: deadOwner, ...timers });
  const next = successor.subscribe(query, demand);
  const takeover = await claimAndStart(successor, next.value.id, "takeover");
  const takeoverPublished = await successor.refresh(next.value.id, { claim: { ...takeover, accessKey: ACCESS_FULL },
    publish: actionPublication("acme/widget", 2, now) });
  if (!takeoverPublished.ok) throw new Error(`safety takeover publish failed: ${takeoverPublished.reason}`);
  const stale = await old.refresh(first.value.id, { claim: { ...abandonedClaim, accessKey: ACCESS_FULL },
    publish: actionPublication("acme/widget", 99, now) });
  const retained = successor.inspect(next.value.id).value.snapshot;

  const restricted = successor.subscribe(queryFor("acme/widget", ACCESS_RESTRICTED), demand);
  const isolated = restricted.ok && restricted.value.snapshot === null;
  const restarted = createAcquisitionEngine({ pathOptions, now: () => now, pid: 333, kill: deadOwner, ...timers });
  const resumed = restarted.subscribe(query, demand, () => {}, { resumeFreshSnapshot: true });

  let wall = now;
  let monotonic = 0;
  const source = createCollectorSourceAgeTracker({ now: () => wall, monotonicNow: () => monotonic });
  const firstAge = source.observe({ lastSuccessAt: retained.lastSuccessAt, serverNow: now });
  const checkpoint = source.checkpoint();
  wall += 1_000;
  monotonic += 1_000;
  const reconnected = createCollectorSourceAgeTracker({ now: () => wall,
    monotonicNow: () => monotonic, checkpoint });
  const reconnectAge = reconnected.observe({ lastSuccessAt: retained.lastSuccessAt, serverNow: now + 1_000 });

  const note = "Dependabot alerts: permission not granted";
  const projected = projectCollectorSnapshot({
    resource: "security", generation: 1,
    rows: [{ id: "code-1", kind: "CodeQL", severity: "high", title: "SQL injection",
      detail: "src/query.mjs", createdAt: "2026-09-15T00:00:00Z" }],
    pageInfo: { loadedPages: 1, hasNextPage: false },
    lastSuccessAt: now, lastChangedAt: now, nextDueAt: now + 60_000,
    hold: null, meta: { at: now, truncated: false }, securityNotes: [note], securityBlind: false,
    capabilities: { dependabot: { verdict: "unavailable", until: now + 60_000, step: 0, note } },
  }, "security");

  const evidence = {
    staleCompletionFenced: !stale.ok && retained.rows[0].databaseId === 2,
    accessPartitionIsolated: isolated,
    securityCapabilityTruth: projected?.securityBlind === false &&
      projected?.securityNotes[0] === note && projected?.capabilities.dependabot?.verdict === "unavailable",
    restartRetention: resumed.ok && resumed.value.snapshot?.rows[0]?.databaseId === 2,
    reconnectAgeNonRegressing: reconnectAge >= firstAge + 1_000,
    producerLossRetainedUncertainty: retainedUncertainty,
    uncertainCoreUnits: retainedUncertainCoreUnits,
    producerLossRecovered: retained.rows[0].databaseId === 2,
  };
  old.close();
  successor.close();
  restarted.close();
  return evidence;
}

async function runAppWebhookEvidence(root) {
  mkdirSync(root, { recursive: true });
  const keyFile = join(root, "app.pem");
  const secretFile = join(root, "webhook-secret");
  const webhookSecret = Buffer.from("phase-twelve-webhook-secret");
  const installationToken = "phase-twelve-installation-token";
  writeFileSync(keyFile, fixturePrivateKeyPem(), { mode: 0o600 });
  writeFileSync(secretFile, webhookSecret, { mode: 0o600 });
  const port = await freeLoopbackPort();
  const providerDefinition = {
    type: "github-app", host: "github.com", clientId: "Iv1.efficiency",
    installationId: 101, privateKeyFile: keyFile, repositoryIds: [101],
    permissions: { metadata: "read", actions: "read", issues: "read", pull_requests: "read" },
  };
  const config = normalizeCollectorConfig({
    version: 1, providers: { app: providerDefinition },
    targets: [{ host: "github.com", repo: "acme/widget", provider: "app" }],
    webhook: {
      enabled: true, address: "127.0.0.1", port, secretFile,
      targets: [{ host: "github.com", repo: "acme/widget", provider: "app", resources: ["security"] }],
    },
  });
  let starts = 0;
  let snapshots = 0;
  let mints = 0;
  let jwtSigned = false;
  let tokenBound = false;
  let resolveInitial;
  const initial = new Promise((resolveInitial_) => { resolveInitial = resolveInitial_; });
  let resolveInvalidated;
  const invalidated = new Promise((resolveInvalidated_) => { resolveInvalidated = resolveInvalidated_; });
  const pathOptions = { env: { XDG_CONFIG_HOME: root }, platform: "linux", home: root };
  const runtime = createCollectorAcquisitionRuntime({
    config, pathOptions,
    githubAppOptions: {
      requestToken: async ({ headers }) => {
        mints += 1;
        const jwt = headers.authorization?.replace(/^Bearer /, "");
        jwtSigned = typeof jwt === "string" && jwt.split(".").length === 3;
        return { status: 201,
          headers: { "x-ratelimit-resource": "core", "x-ratelimit-remaining": "4999" },
          body: JSON.stringify({ token: installationToken,
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            repositories: [{ id: 101 }], permissions: providerDefinition.permissions }) };
      },
    },
    resolveTargetIdentity: async () => ({ id: "101", nameWithOwner: "acme/widget" }),
    async produce({ markStarted, provider }) {
      const started = await markStarted();
      if (!started.ok) throw new Error(`App efficiency start failed: ${started.reason}`);
      starts += 1;
      tokenBound ||= provider.scope.credentialEnvironment?.GH_TOKEN === installationToken &&
        provider.coordinator.current()?.accessKey === provider.scope.accessKey;
      const at = Date.now();
      const note = "Dependabot alerts: permission not granted";
      const rows = [{ id: `code-${starts}`, kind: "CodeQL", severity: "high", title: "SQL injection",
        detail: "src/query.mjs", createdAt: "2026-09-15T00:00:00Z" }];
      return {
        rows, pageInfo: { loadedPages: 1, hasNextPage: false }, raw: JSON.stringify(rows), entities: [],
        lastSuccessAt: at, lastChangedAt: at, nextDueAt: at + 60_000, hold: null,
        capabilities: { dependabot: { verdict: "unavailable", until: at + 60_000, step: 0, note } },
        meta: { at, truncated: false }, securityNotes: [note], securityBlind: false,
        requestMetrics: { httpRequests: 1, rest200: 1, coreUnits: 1 }, uncertainReceipts: [],
        repositoryIdentity: { id: "101", nameWithOwner: "acme/widget" },
      };
    },
  });
  const handle = runtime.subscribe({
    target: config.targets[0], resource: "security",
    demand: { active: true, background: true, floorMs: 60_000, pages: 1 },
    onSnapshot(snapshot) {
      snapshots += 1;
      if (snapshots === 1) resolveInitial(snapshot);
      else resolveInvalidated(snapshot);
    },
    onHold() {},
  });
  const service = await createCollectorService({ config, pathOptions, runtime });
  try {
    const first = await within(initial, 2_000, "App efficiency subscription timed out");
    const body = Buffer.from(JSON.stringify(WEBHOOK_EVENTS.code_scanning_alert));
    const delivery = "12121212-1212-4212-8212-121212121212";
    const status = await postLoopback(port, body, {
      "content-type": "application/json", "content-length": String(body.length),
      "x-github-delivery": delivery, "x-github-event": "code_scanning_alert",
      "x-hub-signature-256": `sha256=${createHmac("sha256", webhookSecret).update(body).digest("hex")}`,
    });
    await within(invalidated, 4_000, "App webhook invalidation timed out");
    const queue = readFileSync(webhookQueuePath(pathOptions), "utf8");
    const persisted = readdirSync(root, { recursive: true }).filter((entry) =>
      typeof entry === "string" && entry.endsWith(".json")).map((entry) => {
      try { return readFileSync(join(root, entry), "utf8"); } catch { return ""; }
    }).join("\n");
    const emitted = JSON.stringify({ first, status, starts, snapshots });
    const noSecretLeak = !`${persisted}\n${emitted}`.includes(installationToken) &&
      !`${persisted}\n${emitted}`.includes(webhookSecret.toString()) &&
      !`${persisted}\n${emitted}`.includes("PRIVATE KEY");
    return {
      githubAppProvider: mints === 1 && jwtSigned && tokenBound &&
        first.capabilities.dependabot?.verdict === "unavailable",
      webhookInvalidation: status === 202 && starts === 2 && snapshots >= 2 &&
        queue.includes(delivery) && noSecretLeak,
    };
  } finally {
    handle.close();
    await service.close();
  }
}

function runReserveBoundaryEvidence(root) {
  mkdirSync(root, { recursive: true });
  const scope = createGovernorScope({ effectiveHost: "github.com", authIdentity: "efficiency-reserve",
    env: { XDG_CONFIG_HOME: root }, now: () => START_AT });
  if (!scope.ok) throw new Error(`reserve governor unavailable: ${scope.reason}`);
  const leaseId = deterministicUuid("reserve-boundary", "lease");
  const maintained = maintainControlLease(scope.value, leaseId, 60_000, "actions", START_AT);
  if (!maintained.ok) throw new Error(`reserve lease unavailable: ${maintained.reason}`);
  const budgets = {
    core: { limit: 5_000, used: 4_000, remaining: 1_000, resetMs: START_AT + 3_600_000 },
    graphql: { limit: 5_000, used: 4_000, remaining: 1_000, resetMs: START_AT + 3_600_000 },
  };
  for (const resource of ["core", "graphql"]) {
    const claim = claimProbe(scope.value, leaseId, START_AT, resource);
    if (!claim.ok || claim.value.status !== "claimed") throw new Error(`reserve ${resource} probe unavailable`);
    const published = publishProbe(scope.value, leaseId, claim.value.nonce, budgets, START_AT, resource);
    if (!published.ok) throw new Error(`reserve ${resource} publication unavailable`);
  }
  const admission = admitGovernorOperation(scope.value, leaseId, "tab:actions", "active", START_AT);
  const observed = inspectGovernor(scope.value, START_AT);
  if (!admission.ok || !observed.ok) throw new Error("reserve evidence unavailable");
  return {
    coreRemaining: observed.value.budgets.core.remaining,
    requestedCoreUnits: 1,
    status: admission.value.status,
    reason: admission.value.reason,
    refused: admission.value.status === "paused" && admission.value.reason === "reserve",
  };
}

function aggregateEvents(topologies) {
  const events = topologies.flatMap(({ oracleEvents }) => oracleEvents);
  const data = events.filter(({ observer }) => !observer);
  return {
    httpRequests: events.length,
    dataHttpRequests: data.length,
    rest200: data.filter(({ status, operation }) => status === 200 && operation.startsWith("actions.")).length,
    rest304: data.filter(({ status }) => status === 304).length,
    coreUnits: events.reduce((total, event) => total + event.cost.core, 0),
    graphqlUnits: events.reduce((total, event) => total + event.cost.graphql, 0),
    observerCalls: events.filter(({ observer }) => observer).length,
    observerCost: events.filter(({ observer }) => observer)
      .reduce((total, event) => total + event.cost.core + event.cost.graphql, 0),
    failedRequests: events.filter(({ status }) => status >= 400).length,
    provenCoreUnits: topologies.reduce((total, sample) => total + sample.metrics.coreUnits, 0),
    provenGraphqlUnits: topologies.reduce((total, sample) => total + sample.metrics.graphqlUnits, 0),
    uncertainCoreUnits: topologies.reduce((total, sample) => total + sample.metrics.uncertainCoreUnits, 0),
    uncertainGraphqlUnits: topologies.reduce((total, sample) =>
      total + sample.metrics.uncertainGraphqlUnits, 0),
    coalescedConsumers: Math.max(...topologies.map(({ coalescedConsumers }) => coalescedConsumers)),
    maximumConcurrentProducerRequests: Math.max(...topologies.map(
      ({ maximumConcurrentProducerRequests = 1 }) => maximumConcurrentProducerRequests)),
    costEvidence: {
      oracleCharged: true,
      acquisitionPersisted: true,
      oracleFields: ["coreUnits", "graphqlUnits", "observerCalls", "observerCost"],
      acquisitionFields: ["provenCoreUnits", "provenGraphqlUnits", "uncertainCoreUnits",
        "uncertainGraphqlUnits"],
    },
    perOperation: Object.fromEntries([...new Set(events.map(({ operation }) => operation))].sort().map((operation) => {
      const selected = events.filter((event) => event.operation === operation);
      return [operation, {
        httpRequests: selected.length,
        status200: selected.filter(({ status }) => status === 200).length,
        status304: selected.filter(({ status }) => status === 304).length,
        coreUnits: selected.reduce((total, event) => total + event.cost.core, 0),
        graphqlUnits: selected.reduce((total, event) => total + event.cost.graphql, 0),
      }];
    })),
  };
}

function sustainedBaselineComparison(baseline, workload) {
  const reasons = ["workload", "measurement-method"];
  if (baseline.runtime !== process.version) reasons.push("runtime");
  if (baseline.platform !== `${process.platform}/${process.arch}`) reasons.push("platform");
  return {
    status: "incompatible",
    baselineCommit: baseline.commit,
    baselineRuntime: baseline.runtime,
    baselinePlatform: baseline.platform,
    currentWorkload: workload,
    reasons,
    improvementPercent: null,
    note: "The Phase 1 sample is an eight-second legacy Actions-only PTY capture; this is an accelerated sustained-hour production-policy run. No numeric improvement is claimed.",
  };
}

function sampleKey(sample) {
  return `${sample.panes}:${sample.distinct === true ? "distinct" : "duplicate"}`;
}

function comparableMetric(baseline, current, lowerIsBetter = true) {
  if (!Number.isFinite(baseline) || !Number.isFinite(current)) {
    return { status: "unavailable", baseline: baseline ?? null, current: current ?? null,
      delta: null, improvementPercent: null };
  }
  const improvement = baseline === 0 ? null
    : (lowerIsBetter ? baseline - current : current - baseline) / baseline * 100;
  return { status: "comparable", baseline, current, delta: current - baseline,
    improvementPercent: improvement === null ? null : Number(improvement.toFixed(2)) };
}

export function compareStartupSlice(baseline, current) {
  const reasons = [];
  if (baseline.workload !== current.workload) reasons.push("workload");
  if (baseline.resourceMeasurement !== current.resourceMeasurement) reasons.push("measurement-method");
  if (baseline.runtime !== current.runtime) reasons.push("runtime");
  if (baseline.platform !== current.platform) reasons.push("platform");
  if (reasons.length > 0) {
    return {
      status: "incompatible",
      reasons,
      improvementPercent: null,
      samples: [],
      unavailable: {
        sourceToDisplayLatency: "The Phase 1 workload injected no source changes.",
        coalescedConsumers: "The Phase 1 capture exposed no coalescing metric.",
        queueWait: "The Phase 1 capture exposed no queue-wait metric.",
      },
    };
  }
  const baselineByKey = new Map(baseline.samples.map((sample) => [sampleKey(sample), sample]));
  const samples = current.samples.map((sample) => {
    const previous = baselineByKey.get(sampleKey(sample));
    if (!previous) return { key: sampleKey(sample), status: "unavailable", metrics: {} };
    return {
      key: sampleKey(sample),
      status: "comparable",
      metrics: {
        actionsRunRequests: comparableMetric(previous.actionsRunRequests, sample.actionsRunRequests),
        recordedFixtureStarts: comparableMetric(previous.recordedFixtureStarts, sample.recordedFixtureStarts),
        observers: comparableMetric(previous.observers, sample.observers),
        coreChargedUnits: comparableMetric(previous.coreChargedUnits, sample.coreChargedUnits),
        graphqlChargedUnits: comparableMetric(previous.graphqlChargedUnits, sample.graphqlChargedUnits),
        subprocessCount: comparableMetric(previous.subprocessCount, sample.subprocessCount),
        elapsedMs: comparableMetric(previous.elapsedMs, sample.elapsedMs),
        sampledCpuSeconds: comparableMetric(previous.resources?.sampledCpuSeconds,
          sample.resources?.sampledCpuSeconds),
        peakSampledRssKiB: comparableMetric(previous.resources?.peakSampledRssKiB,
          sample.resources?.peakSampledRssKiB),
        requestLatencyP50Ms: comparableMetric(previous.requestLatencyMs?.p50,
          sample.requestLatencyMs?.p50),
        requestLatencyP95Ms: comparableMetric(previous.requestLatencyMs?.p95,
          sample.requestLatencyMs?.p95),
        maxConcurrency: comparableMetric(previous.maxConcurrency, sample.maxConcurrency),
      },
    };
  });
  const baselineRequests = baseline.samples.reduce((total, sample) => total + sample.actionsRunRequests, 0);
  const currentRequests = current.samples.reduce((total, sample) => total + sample.actionsRunRequests, 0);
  const headline = comparableMetric(baselineRequests, currentRequests);
  return {
    status: "compatible",
    reasons: [],
    improvementPercent: headline.improvementPercent,
    headline: { metric: "actionsRunRequests", ...headline },
    samples,
    unavailable: {
      sourceToDisplayLatency: "The compatible Phase 1 workload injected no source changes.",
      coalescedConsumers: "The Phase 1 capture exposed no coalescing metric.",
      queueWait: "The Phase 1 capture exposed no queue-wait metric.",
    },
  };
}

export function efficiencyReleaseGate(comparison) {
  if (comparison.status !== "compatible") {
    return { passed: false, reason: comparison.status === "not-measured"
      ? "startup-slice-not-measured" : "incompatible-startup-slice" };
  }
  if (!(comparison.improvementPercent > 0)) {
    return { passed: false, reason: "non-positive-request-improvement" };
  }
  return { passed: true, reason: "positive-request-improvement" };
}

async function captureStartupSlice(root) {
  const output = join(root, "startup-slice.json");
  await execFileAsync(process.execPath, [CAPTURE_STARTUP, output], {
    cwd: REPOSITORY_ROOT,
    env: process.env,
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(readFileSync(output, "utf8"));
}

export async function runEfficiencyMeasurement({
  workloadPath = DEFAULT_WORKLOAD,
  baselinePath = DEFAULT_BASELINE,
  includeResources = true,
  includeStartupSlice = true,
  topologyIds = null,
} = {}) {
  const { manifest, scenario } = readScenario(workloadPath);
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  const root = mkdtempSync("/tmp/gge-");
  const cpuBefore = process.cpuUsage();
  const rssBefore = process.memoryUsage().rss;
  const wallStartedAt = performance.now();
  try {
    const topologies = [];
    const selectedTopologies = topologyIds === null
      ? scenario.topologies
      : scenario.topologies.filter(({ id }) => topologyIds.includes(id));
    for (const topology of selectedTopologies) {
      const sample = await runTopology(scenario, topology, join(root, topology.id));
      if (topology.transport === "collector") {
        const cohort = await runCollectorCohort(START_AT);
        Object.assign(sample, {
          clientGithubRequests: cohort.clientGithubRequests,
          clientRoots: cohort.clientRoots,
          collectorStreams: cohort.starts,
          collectorDeliveries: cohort.deliveries,
          collectorGenerations: cohort.generations,
          clientProcessStarts: cohort.clientProcessStarts,
          sshOnly: cohort.sshOnly,
          transport: cohort.transport,
        });
      }
      topologies.push(sample);
    }
    const wallTimeMs = Math.round(performance.now() - wallStartedAt);
    const cpu = process.cpuUsage(cpuBefore);
    const rssAfter = process.memoryUsage().rss;
    const metrics = aggregateEvents(topologies);
    const acknowledgments = topologies.flatMap(({ acknowledgments: values }) => values);
    const queueValues = topologies.flatMap(({ queueDelays: values }) => values);
    const remote = topologies.find(({ id }) => id === "two-machines");
    const safety = await runCombinedSafetyEvidence(join(root, "combined-safety"));
    const appWebhook = await runAppWebhookEvidence(join(root, "app-webhook"));
    const reserveBoundary = runReserveBoundaryEvidence(join(root, "reserve-boundary"));
    metrics.uncertainCoreUnits += safety.uncertainCoreUnits;
    const reportTopologies = topologies.map(({ oracleEvents: _oracleEvents, acknowledgments: _acknowledgments,
      queueDelays: _queueDelays, metrics: _metrics, ...sample }) => sample);
    const startupSlice = includeStartupSlice ? await captureStartupSlice(root) : null;
    const startupComparison = startupSlice
      ? compareStartupSlice(baseline, startupSlice)
      : { status: "not-measured", reasons: ["disabled"], improvementPercent: null, samples: [] };
    return {
      schema: 1,
      kind: "deterministic-efficiency-measurement",
      runtime: process.version,
      platform: `${process.platform}/${process.arch}`,
      workload: {
        manifestSchema: manifest.schema,
        id: scenario.id,
        simulatedDurationMs: scenario.durationMs,
        tickMs: scenario.tickMs,
      },
      topologies: reportTopologies,
      metrics,
      freshness: { sourceToDisplayMs: {
        samples: acknowledgments.length,
        p50: percentile(acknowledgments, 0.5),
        p95: percentile(acknowledgments, 0.95),
      } },
      queueDelayMs: {
        kind: "shared-follower-delivery-after-producer-start",
        samples: queueValues.length,
        p50: percentile(queueValues, 0.5),
        p95: percentile(queueValues, 0.95),
        ...(queueValues.length === 0
          ? { unavailableReason: "No separate follower callback was observed in the accelerated in-process sample." }
          : {}),
      },
      correctness: {
        duplicateProducerPerGeneration: topologies.reduce((total, sample) =>
          total + sample.duplicateProducerPerGeneration, 0),
        remoteClientGithubRequests: remote?.clientGithubRequests ?? null,
        producerLossRecovered: safety.producerLossRecovered,
        accountSwitchIsolated: topologies.every(({ accountSwitchIsolated }) => accountSwitchIsolated),
        progressAfterReset: topologies.every(({ progressAfterReset }) => progressAfterReset),
        secondaryHoldObserved: topologies.every(({ secondaryHoldObserved }) => secondaryHoldObserved),
        producerLossRetainedUncertainty: safety.producerLossRetainedUncertainty,
        staleCompletionFenced: safety.staleCompletionFenced,
        accessPartitionIsolated: safety.accessPartitionIsolated,
        securityCapabilityTruth: safety.securityCapabilityTruth,
        restartRetention: safety.restartRetention,
        reconnectAgeNonRegressing: safety.reconnectAgeNonRegressing,
        reserveBoundaryApproached: reserveBoundary.coreRemaining === 1_000,
        reserveCrossingRefused: reserveBoundary.refused,
        reserveBoundary,
        minimumCoreRemaining: Math.min(...topologies.map(({ minimumCoreRemaining }) => minimumCoreRemaining)),
        minimumGraphqlRemaining: Math.min(...topologies.map(({ minimumGraphqlRemaining }) => minimumGraphqlRemaining)),
        pinnedGraphqlProbeStable: topologies.every(({ pinnedGraphqlProbe }) =>
          pinnedGraphqlProbe.before === pinnedGraphqlProbe.after &&
          pinnedGraphqlProbe.actualUsed > pinnedGraphqlProbe.after),
        e2e4Combinations: {
          standalone: safety.staleCompletionFenced && safety.producerLossRecovered,
          localCollector: remote?.collectorDeliveries === remote?.panes,
          sshClients: remote?.sshOnly === true && remote?.clientGithubRequests === 0,
          webhookInvalidation: appWebhook.webhookInvalidation,
          githubAppProvider: appWebhook.githubAppProvider,
        },
      },
      resources: includeResources ? {
        subprocessCount: remote?.clientProcessStarts ?? 0,
        wallTimeMs,
        sampledCpuSeconds: (cpu.user + cpu.system) / 1_000_000,
        peakSampledRssKiB: Math.ceil(Math.max(rssBefore, rssAfter) / 1024),
        note: "Accelerated runtime plus the observed SSH client bridge cohort; CPU/RSS cover the parent measurement process only and are not compared with the Phase 1 PTY sample.",
      } : {
        subprocessCount: remote?.clientProcessStarts ?? 0,
        wallTimeMs: null,
        sampledCpuSeconds: null,
        peakSampledRssKiB: null,
        note: "CPU/RSS sampling disabled; subprocessCount is the observed SSH client bridge cohort.",
      },
      baselineComparison: sustainedBaselineComparison(baseline, scenario.id),
      compatibleStartup: { measurement: startupSlice, comparison: startupComparison },
      releaseGate: efficiencyReleaseGate(startupComparison),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function formatEfficiencyMarkdown(report) {
  const freshness = report.freshness.sourceToDisplayMs;
  return [
    "# gh-glance efficiency measurement",
    "",
    `- Workload: ${report.workload.id}, ${report.workload.simulatedDurationMs} simulated ms`,
    `- Runtime: ${report.runtime} (${report.platform})`,
    `- Oracle requests: ${report.metrics.httpRequests} (${report.metrics.dataHttpRequests} data, ${report.metrics.observerCalls} observer)`,
    `- Actions REST data responses: ${report.metrics.rest200} 200, ${report.metrics.rest304} 304`,
    `- Oracle charged cost: ${report.metrics.coreUnits} core, ${report.metrics.graphqlUnits} GraphQL`,
    `- Acquisition proven/uncertain cost: ${report.metrics.provenCoreUnits}/${report.metrics.uncertainCoreUnits} core, ${report.metrics.provenGraphqlUnits}/${report.metrics.uncertainGraphqlUnits} GraphQL`,
    `- Observer calls/combined charged units: ${report.metrics.observerCalls}/${report.metrics.observerCost}`,
    `- Source-to-display p50/p95: ${freshness.p50 ?? "unavailable"}/${freshness.p95 ?? "unavailable"} ms`,
    `- Shared follower-delivery delay p50/p95: ${report.queueDelayMs.p50 ?? "unavailable"}/${report.queueDelayMs.p95 ?? "unavailable"} ms`,
    ...(report.queueDelayMs.unavailableReason ? [`- Follower-delivery delay note: ${report.queueDelayMs.unavailableReason}`] : []),
    `- Baseline comparison: ${report.baselineComparison.status}`,
    `- Improvement: not claimed (${report.baselineComparison.reasons.join(", ")})`,
    `- Compatible startup slice: ${report.compatibleStartup.comparison.status}`,
    `- Compatible startup request improvement: ${report.compatibleStartup.comparison.improvementPercent === null
      ? "not claimed" : `${report.compatibleStartup.comparison.improvementPercent}%`}`,
    "",
    report.baselineComparison.note,
    "",
  ].join("\n");
}

function parseOutputs(argv) {
  const outputs = { json: null, markdown: null };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (!["--json", "--markdown"].includes(option) || !argv[index + 1]) {
      throw new Error("usage: node scripts/measure-efficiency.mjs [--json path] [--markdown path]");
    }
    outputs[option.slice(2)] = resolve(argv[++index]);
  }
  return outputs;
}

async function main() {
  const outputs = parseOutputs(process.argv.slice(2));
  const report = await runEfficiencyMeasurement();
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const markdown = formatEfficiencyMarkdown(report);
  if (outputs.json) writeFileSync(outputs.json, json);
  if (outputs.markdown) writeFileSync(outputs.markdown, markdown);
  if (!outputs.json && !outputs.markdown) process.stdout.write(`${markdown}\n\`\`\`json\n${json}\`\`\`\n`);
  if (!report.releaseGate.passed) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
