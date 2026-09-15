import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  applyGitHubAppSecurityPolicy,
  createCollectorAcquisitionRuntime,
  createCollectorSnapshotAssembler,
  createGitHubAppProvider,
  claimProbe,
  fetchGraphqlPage,
  githubAppAccessIdentity,
  githubAppChildEnvironment,
  githubAppResourceCapabilities,
  githubAppSecurityPolicy,
  encodeCollectorSnapshotFrames,
  maintainControlLease,
  mapWebhookInvalidations,
  normalizeCollectorConfig,
  publishProbe,
  projectCollectorSnapshot,
  readInstallationCoreBudget,
  refreshSharedBudget,
  requestGitHubAppToken,
  runGh,
  signGitHubAppJwt,
  validateCollectorClientMessage,
} from "../index.mjs";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" });
const BASE_PROVIDER = {
  type: "github-app",
  host: "github.com",
  clientId: "Iv1.fixture-client",
  installationId: 123456,
  privateKeyFile: "/private/app.pem",
  repositoryIds: [101, 202],
  permissions: { metadata: "read", actions: "read", issues: "read", pull_requests: "read" },
};

function decodePart(value) {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

function tokenResponse(token, expiresAt, overrides = {}) {
  return tokenResponseFor(BASE_PROVIDER, token, expiresAt, overrides);
}

function tokenResponseFor(provider, token, expiresAt, overrides = {}) {
  return {
    status: 201,
    headers: { "x-ratelimit-resource": "core", "x-ratelimit-remaining": "4999" },
    body: JSON.stringify({ token, expires_at: new Date(expiresAt).toISOString(),
      repositories: provider.repositoryIds.map((id) => ({ id })), permissions: provider.permissions }),
    ...overrides,
  };
}

function ghResponse(resource, body, now = Date.now(), resetMs = now + 3_600_000) {
  return `HTTP/2 200 OK\r\nx-ratelimit-resource: ${resource}\r\n` +
    `x-ratelimit-limit: 5000\r\nx-ratelimit-used: 1\r\nx-ratelimit-remaining: 4999\r\n` +
    `x-ratelimit-reset: ${Math.ceil(resetMs / 1000)}\r\netag: fixture-etag\r\n\r\n${JSON.stringify(body)}`;
}

function resolvedGhChild(stdout) {
  const pending = Promise.resolve({ stdout, stderr: "" });
  pending.child = { stdin: { on() {}, end() {} } };
  return pending;
}

function privatePathOptions(t) {
  const root = mkdtempSync(join(tmpdir(), "gh-glance-app-auth-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { env: { XDG_CONFIG_HOME: root }, platform: "linux", home: root };
}

async function within(promise, timeoutMs = 2_000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("app collector timed out")), timeoutMs);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

function appPublication(resource, at = Date.now()) {
  return { rows: [], entities: [], raw: "[]", pageInfo: resource === "issues" || resource === "prs"
    ? { loadedPages: 1, hasNextPage: false } : null,
  lastSuccessAt: at, lastChangedAt: at, nextDueAt: at + 60_000, hold: null,
  capabilities: {}, requestMetrics: {}, uncertainReceipts: [],
  repositoryIdentity: { id: "R_fixture", nameWithOwner: "acme/widget" },
  meta: { at, truncated: false }, securityNotes: [], securityBlind: false };
}

test("APP-01: RS256 JWT claims and strict provider configuration are bounded", (t) => {
  const now = 2_000_000_000_000;
  const jwt = signGitHubAppJwt(BASE_PROVIDER, { now: () => now, readPrivateKey: () => PRIVATE_KEY });
  const [header, payload, signature] = jwt.split(".");
  assert.deepEqual(decodePart(header), { alg: "RS256", typ: "JWT" });
  assert.deepEqual(decodePart(payload), { iat: Math.floor(now / 1000) - 60,
    exp: Math.floor(now / 1000) + 540, iss: BASE_PROVIDER.clientId });
  assert.equal(verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), publicKey,
    Buffer.from(signature, "base64url")), true);
  assert.throws(() => signGitHubAppJwt(BASE_PROVIDER, { readPrivateKey: () => "not-a-key" }),
    /GitHub App private key is invalid/);
  const keyRoot = mkdtempSync(join(tmpdir(), "gh-glance-app-key-"));
  t.after(() => rmSync(keyRoot, { recursive: true, force: true }));
  const keyPath = join(keyRoot, "fixture.pem");
  writeFileSync(keyPath, PRIVATE_KEY, { mode: 0o600 });
  assert.match(signGitHubAppJwt({ ...BASE_PROVIDER, privateKeyFile: keyPath }), /^[^.]+\.[^.]+\.[^.]+$/);
  chmodSync(keyPath, 0o644);
  assert.throws(() => signGitHubAppJwt({ ...BASE_PROVIDER, privateKeyFile: keyPath }),
    (error) => error.message === "GitHub App private key is unavailable" && !error.message.includes(keyPath));

  const config = { version: 1, providers: { app: BASE_PROVIDER },
    targets: [{ host: "github.com", repo: "acme/widget", provider: "app" }] };
  assert.deepEqual(normalizeCollectorConfig(config).providers.app, BASE_PROVIDER);
  assert.equal(normalizeCollectorConfig({ ...config, providers: { app: { ...BASE_PROVIDER,
    permissions: { ...BASE_PROVIDER.permissions, contents: "write" } } } }), null);
  assert.equal(normalizeCollectorConfig({ ...config, providers: { app: { ...BASE_PROVIDER,
    repositoryIds: [] } } }), null);
  assert.equal(normalizeCollectorConfig({ ...config, providers: { app: { ...BASE_PROVIDER,
    host: "https://github.com/redirect" } } }), null);
});

test("APP-02: concurrent callers share one mint and actual expiry drives early renewal", async (t) => {
  let now = 1_000_000;
  let requests = 0;
  const provider = createGitHubAppProvider({ name: "app", provider: BASE_PROVIDER,
    pathOptions: privatePathOptions(t),
    now: () => now, readPrivateKey: () => PRIVATE_KEY,
    requestToken: async () => { requests += 1; return tokenResponse(`token-${requests}`, now + 3_600_000); } });
  const values = await Promise.all(Array.from({ length: 12 }, () => provider.resolve()));
  assert.equal(requests, 1);
  assert.equal(new Set(values.map((value) => value.environment.GH_TOKEN)).size, 1);
  now += 3_299_999;
  await provider.resolve();
  assert.equal(requests, 1);
  now += 2;
  assert.equal((await provider.resolve()).environment.GH_TOKEN, "token-2");
  assert.equal(requests, 2);
  provider.close();
});

test("APP-02: separate collector processes share one durable in-flight mint", async (t) => {
  let releaseMint;
  let firstRequests = 0;
  let secondRequests = 0;
  const pathOptions = privatePathOptions(t);
  const first = createGitHubAppProvider({ name: "app", provider: BASE_PROVIDER, pathOptions,
    pid: 111, kill: () => undefined,
    readPrivateKey: () => PRIVATE_KEY,
    requestToken: () => {
      firstRequests += 1;
      return new Promise((resolve) => { releaseMint = resolve; });
    } });
  const second = createGitHubAppProvider({ name: "app", provider: BASE_PROVIDER, pathOptions,
    pid: 222, kill: () => undefined,
    readPrivateKey: () => PRIVATE_KEY,
    requestToken: async () => {
      secondRequests += 1;
      return tokenResponse("second-token", Date.now() + 3_600_000);
    } });
  const pending = first.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(second.resolve(), /GitHub App token unavailable/);
  assert.deepEqual([firstRequests, secondRequests], [1, 0]);
  releaseMint(tokenResponse("first-token", Date.now() + 3_600_000));
  assert.equal((await pending).environment.GH_TOKEN, "first-token");
  first.close();
  second.close();
});

test("APP-02/06: an abandoned mint owner imposes crash backoff before takeover", async (t) => {
  let now = 500_000;
  let releaseMint;
  let takeoverRequests = 0;
  const pathOptions = privatePathOptions(t);
  const abandoned = createGitHubAppProvider({ name: "app", provider: BASE_PROVIDER, pathOptions,
    now: () => now, pid: 111, kill: () => false, readPrivateKey: () => PRIVATE_KEY,
    requestToken: () => new Promise((resolve) => { releaseMint = resolve; }) });
  const stale = abandoned.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  const takeover = createGitHubAppProvider({ name: "app", provider: BASE_PROVIDER, pathOptions,
    now: () => now, pid: 222, kill: (pid) => {
      if (pid === 111) { const error = new Error("dead"); error.code = "ESRCH"; throw error; }
    }, readPrivateKey: () => PRIVATE_KEY,
    requestToken: async () => { takeoverRequests += 1;
      return tokenResponse("takeover-token", now + 3_600_000); } });
  await assert.rejects(takeover.resolve(), (error) =>
    error.message === "GitHub App token unavailable" && error.retryAt === now + 60_000);
  assert.equal(takeoverRequests, 0);
  releaseMint(tokenResponse("abandoned-token", now + 3_600_000));
  await assert.rejects(stale, /GitHub App token unavailable/);
  now += 60_000;
  assert.equal((await takeover.resolve()).environment.GH_TOKEN, "takeover-token");
  assert.equal(takeoverRequests, 1);
  abandoned.close();
  takeover.close();
});

test("APP-02/05: authority generation survives restart and fences an older mint", async (t) => {
  const pathOptions = privatePathOptions(t);
  let releaseMint;
  const first = createGitHubAppProvider({ name: "app", provider: BASE_PROVIDER, pathOptions,
    readPrivateKey: () => PRIVATE_KEY,
    requestToken: () => new Promise((resolve) => { releaseMint = resolve; }) });
  const stale = first.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  first.invalidate("authority-changed");
  releaseMint(tokenResponse("stale-token", Date.now() + 3_600_000));
  await assert.rejects(stale, /GitHub App token unavailable/);
  assert.equal(first.current(), null);
  assert.equal(first.inspect().generation, 2);
  first.close();

  const restarted = createGitHubAppProvider({ name: "app", provider: BASE_PROVIDER, pathOptions,
    readPrivateKey: () => PRIVATE_KEY,
    requestToken: async () => tokenResponse("fresh-token", Date.now() + 3_600_000) });
  assert.equal(restarted.inspect().generation, 2);
  assert.equal((await restarted.resolve()).identity.generation, 2);
  restarted.close();
});

test("APP-02/06: mint failures use the bounded 60/120/240/480 retry ladder", async (t) => {
  let now = 10_000;
  let requests = 0;
  const provider = createGitHubAppProvider({ name: "app", provider: BASE_PROVIDER,
    pathOptions: privatePathOptions(t),
    now: () => now, readPrivateKey: () => PRIVATE_KEY,
    requestToken: async () => { requests += 1; throw new Error("contains-secret-and-path"); } });
  for (const delay of [60_000, 120_000, 240_000, 480_000]) {
    await assert.rejects(provider.resolve(), /GitHub App token unavailable/);
    const before = requests;
    await assert.rejects(provider.resolve(), /GitHub App token unavailable/);
    assert.equal(requests, before);
    now += delay;
  }
  await assert.rejects(provider.resolve(), /GitHub App token unavailable/);
  assert.equal(requests, 5);
  assert.deepEqual(provider.inspect().retryDelays, [60_000, 120_000, 240_000, 480_000]);
  assert.doesNotMatch(provider.inspect().lastError, /secret|path/i);
});

test("APP-02/06: a collector restart cannot replenish the persisted mint allowance", async (t) => {
  let now = 50_000;
  const pathOptions = privatePathOptions(t);
  const first = createGitHubAppProvider({ name: "app", provider: BASE_PROVIDER, pathOptions,
    now: () => now, readPrivateKey: () => PRIVATE_KEY,
    requestToken: async () => { throw new Error("offline"); } });
  await assert.rejects(first.resolve(), /GitHub App token unavailable/);
  first.close();
  let restartedRequests = 0;
  const restarted = createGitHubAppProvider({ name: "app", provider: BASE_PROVIDER, pathOptions,
    now: () => now, readPrivateKey: () => PRIVATE_KEY,
    requestToken: async () => { restartedRequests += 1; return tokenResponse("token", now + 3_600_000); } });
  await assert.rejects(restarted.resolve(), /GitHub App token unavailable/);
  assert.equal(restartedRequests, 0);
  now += 60_000;
  assert.equal((await restarted.resolve()).environment.GH_TOKEN, "token");
  assert.equal(restartedRequests, 1);
});

test("APP-03: installation token environment excludes competing credentials", () => {
  const env = githubAppChildEnvironment("github.com", "installation-token", {
    PATH: "/bin", GH_TOKEN: "personal-a", GITHUB_TOKEN: "personal-b",
    GH_ENTERPRISE_TOKEN: "enterprise-a", GITHUB_ENTERPRISE_TOKEN: "enterprise-b",
  });
  assert.deepEqual(env, { PATH: "/bin", GH_TOKEN: "installation-token" });
  const enterprise = githubAppChildEnvironment("ghe.example.com", "installation-token", env);
  assert.deepEqual(enterprise, { PATH: "/bin", GH_ENTERPRISE_TOKEN: "installation-token" });
});

test("APP-03/04: collector subscriptions share the production app provider context", async (t) => {
  const pathOptions = privatePathOptions(t);
  const config = normalizeCollectorConfig({ version: 1, providers: { app: BASE_PROVIDER },
    targets: [{ host: "github.com", repo: "acme/widget", provider: "app" }] });
  let mints = 0;
  const environments = [];
  let appContext;
  const runtime = createCollectorAcquisitionRuntime({ config, pathOptions,
    githubAppOptions: { readPrivateKey: () => PRIVATE_KEY,
      requestToken: async () => { mints += 1; return tokenResponse("installation-token", Date.now() + 3_600_000); } },
    resolveTargetIdentity: async () => ({ id: "R_fixture", nameWithOwner: "acme/widget" }),
    async produce({ resource, provider, markStarted }) {
      appContext = provider;
      environments.push(provider.scope.credentialEnvironment);
      await markStarted();
      return appPublication(resource);
    },
  });
  t.after(() => runtime.close());
  const subscribe = (resource) => within(
    new Promise((resolve, reject) => runtime.subscribe({ target: config.targets[0], resource,
      demand: { active: true, background: true, floorMs: 5_000, pages: 1 }, onSnapshot: resolve,
      onHold: (hold) => reject(new Error(`unexpected ${hold} hold`)) })));
  await Promise.all([subscribe("actions"), subscribe("issues")]);
  assert.equal(mints, 1);
  assert.equal(environments.length, 2);
  assert.equal(environments.every((env) => env.GH_TOKEN === "installation-token" &&
    env.GITHUB_TOKEN === undefined && env.GH_ENTERPRISE_TOKEN === undefined), true);
  assert.equal(appContext.coordinator.current()?.accessKey, appContext.scope.accessKey);
  const lease = maintainControlLease(appContext.scope, appContext.leaseId, 5_000, "actions", Date.now());
  assert.equal(lease.ok, true, lease.reason);
  await runtime.close();
  const persisted = readdirSync(pathOptions.env.XDG_CONFIG_HOME, { recursive: true })
    .filter((entry) => typeof entry === "string" && entry.endsWith(".json"))
    .map((entry) => readFileSync(join(pathOptions.env.XDG_CONFIG_HOME, entry), "utf8")).join("\n");
  assert.equal(persisted.includes("installation-token"), false);
  assert.equal(persisted.includes("PRIVATE KEY"), false);
});

test("APP-04: installation quota survives token rotation while access scope fences changes", () => {
  const first = githubAppAccessIdentity("app", BASE_PROVIDER, 1);
  const rotated = githubAppAccessIdentity("app", BASE_PROVIDER, 1);
  const restricted = githubAppAccessIdentity("app", { ...BASE_PROVIDER,
    permissions: { ...BASE_PROVIDER.permissions, security_events: "read" } }, 1);
  const nextGeneration = githubAppAccessIdentity("app", BASE_PROVIDER, 2);
  assert.equal(first.quotaKey, rotated.quotaKey);
  assert.equal(first.quotaKey, restricted.quotaKey);
  assert.equal(first.accessKey, rotated.accessKey);
  assert.notEqual(first.accessKey, restricted.accessKey);
  assert.notEqual(first.accessKey, nextGeneration.accessKey);
  assert.notEqual(first.quotaKey, githubAppAccessIdentity("app", { ...BASE_PROVIDER,
    installationId: 654321 }, 1).quotaKey);
});

test("APP-05: invalidation and expired refresh failure retain no usable credential", async (t) => {
  let now = 20_000;
  let fail = false;
  const provider = createGitHubAppProvider({ name: "app", provider: BASE_PROVIDER,
    pathOptions: privatePathOptions(t),
    now: () => now, readPrivateKey: () => PRIVATE_KEY,
    requestToken: async () => fail ? Promise.reject(new Error("401 token-value"))
      : tokenResponse("installation-token", now + 360_000) });
  assert.equal((await provider.resolve()).environment.GH_TOKEN, "installation-token");
  fail = true;
  provider.invalidate("unauthorized");
  await assert.rejects(provider.resolve(), /GitHub App token unavailable/);
  assert.equal(provider.current(), null);
  assert.equal(provider.inspect().generation, 1);
  provider.invalidate("authority-changed");
  assert.equal(provider.inspect().generation, 2);

  const config = normalizeCollectorConfig({ version: 1, providers: { app: BASE_PROVIDER },
    targets: [{ host: "github.com", repo: "acme/widget", provider: "app" }],
    webhook: { enabled: true, address: "127.0.0.1", port: 8787, secretFile: "/secret",
      targets: [{ host: "github.com", repo: "acme/widget", provider: "app",
        resources: ["actions", "issues", "prs", "security"] }] } });
  const mapped = mapWebhookInvalidations({ event: "installation",
    payload: { action: "suspend", installation: { id: BASE_PROVIDER.installationId } }, config });
  assert.equal(mapped.invalidations.length, 4);
  assert.equal(mapped.invalidations.every((item) => item.accessRemoved), true);
  assert.deepEqual(mapWebhookInvalidations({ event: "installation",
    payload: { action: "suspend", installation: { id: 999 } }, config }).invalidations, []);
  assert.deepEqual(mapWebhookInvalidations({ event: "installation",
    payload: { action: "created", installation: { id: BASE_PROVIDER.installationId } }, config }).invalidations, []);

  const mixed = normalizeCollectorConfig({ version: 1,
    providers: { app: BASE_PROVIDER, personal: { type: "gh", host: "github.com" } },
    targets: [
      { host: "github.com", repo: "acme/widget", provider: "app" },
      { host: "github.com", repo: "acme/other", provider: "personal" },
    ],
    webhook: { enabled: true, address: "127.0.0.1", port: 8787, secretFile: "/secret",
      targets: [{ host: "github.com", repo: "acme/widget", provider: "app", resources: ["issues"] }] } });
  const installation = mapWebhookInvalidations({ event: "installation",
    payload: { action: "suspend", installation: { id: BASE_PROVIDER.installationId } }, config: mixed });
  assert.equal(installation.invalidations.length, 4);
  assert.equal(installation.invalidations.every((item) => item.provider === "app"), true);
});

test("APP-05: 401 permits one equivalent remint before a bounded hold", async (t) => {
  let now = 100_000;
  let requests = 0;
  const provider = createGitHubAppProvider({ name: "app", provider: BASE_PROVIDER,
    pathOptions: privatePathOptions(t), now: () => now, readPrivateKey: () => PRIVATE_KEY,
    requestToken: async () => { requests += 1; return tokenResponse(`token-${requests}`, now + 3_600_000); } });
  const first = await provider.resolve();
  provider.invalidate("unauthorized");
  const refreshed = await provider.resolve();
  assert.equal(requests, 2);
  assert.equal(first.identity.accessKey, refreshed.identity.accessKey);
  provider.invalidate("unauthorized");
  await assert.rejects(provider.resolve(), (error) => error.message === "GitHub App token unavailable" &&
    error.retryAt === now + 60_000);
  assert.equal(requests, 2);
});

test("APP-05: collector GraphQL 401 performs one controlled App remint", async (t) => {
  const pathOptions = privatePathOptions(t);
  const config = normalizeCollectorConfig({ version: 1, providers: { app: BASE_PROVIDER },
    targets: [{ host: "github.com", repo: "acme/widget", provider: "app" }] });
  let mints = 0;
  let graphCalls = 0;
  const accessKeys = [];
  const runtime = createCollectorAcquisitionRuntime({ config, pathOptions,
    githubAppOptions: { readPrivateKey: () => PRIVATE_KEY,
      requestToken: async () => { mints += 1;
        return tokenResponse(`installation-token-${mints}`, Date.now() + 3_600_000); } },
    resolveTargetIdentity: async () => ({ id: "R_fixture", nameWithOwner: "acme/widget" }),
    async produce({ resource, provider, markStarted }) {
      accessKeys.push(provider.identity.accessKey);
      await markStarted();
      graphCalls += 1;
      if (graphCalls === 1) {
        const page = await fetchGraphqlPage("issues", { operation: "page:issues", run: async () => {
          const error = new Error("graphql unauthorized");
          error.stdout = "HTTP/1.1 401 Unauthorized\r\n\r\n{\"message\":\"Bad credentials\"}";
          throw error;
        } });
        throw page.failure;
      }
      return appPublication(resource);
    },
  });
  t.after(() => runtime.close());
  const holds = [];
  const snapshot = await within(new Promise((resolve) => runtime.subscribe({ target: config.targets[0], resource: "issues",
    demand: { active: true, background: true, floorMs: 5_000, pages: 1 }, onSnapshot: resolve,
    onHold: (hold) => holds.push(hold) })), 3_000);
  assert.equal(snapshot.rows.length, 0);
  assert.equal(mints, 2);
  assert.equal(graphCalls, 2);
  assert.equal(new Set(accessKeys).size, 1);
  assert.deepEqual(holds, ["disconnected"]);
  await runtime.close();
});

test("APP-06: mint request is exact-host/exact-scope and response scope cannot widen", async (t) => {
  assert.equal(validateCollectorClientMessage({ type: "mint", provider: "app" }), null);
  let captured;
  const provider = createGitHubAppProvider({ name: "app", provider: BASE_PROVIDER,
    pathOptions: privatePathOptions(t),
    now: () => 100_000, readPrivateKey: () => PRIVATE_KEY,
    requestToken: async (request) => { captured = request;
      return tokenResponse("installation-token", 3_700_000); } });
  await provider.resolve();
  assert.equal(captured.host, "api.github.com");
  assert.equal(captured.path, "/app/installations/123456/access_tokens");
  assert.deepEqual(JSON.parse(captured.body), { repository_ids: [101, 202], permissions: BASE_PROVIDER.permissions });
  assert.match(captured.headers.authorization, /^Bearer [^.]+\.[^.]+\.[^.]+$/);
  assert.equal(JSON.stringify(provider.inspect()).includes("installation-token"), false);

  let enterpriseRequest;
  const enterprise = createGitHubAppProvider({ name: "enterprise", provider: { ...BASE_PROVIDER,
    host: "ghe.example.com" }, pathOptions: privatePathOptions(t), now: () => 100_000,
  readPrivateKey: () => PRIVATE_KEY, requestToken: async (request) => {
    enterpriseRequest = request;
    return tokenResponse("enterprise-token", 3_700_000);
  } });
  await enterprise.resolve();
  assert.deepEqual({ host: enterpriseRequest.host, path: enterpriseRequest.path },
    { host: "ghe.example.com", path: "/api/v3/app/installations/123456/access_tokens" });

  const widened = createGitHubAppProvider({ name: "app", provider: BASE_PROVIDER,
    pathOptions: privatePathOptions(t),
    now: () => 100_000, readPrivateKey: () => PRIVATE_KEY,
    requestToken: async () => tokenResponse("token", 3_700_000, { body: JSON.stringify({ token: "token",
      expires_at: new Date(3_700_000).toISOString(), repositories: [{ id: 101 }, { id: 202 }, { id: 303 }],
      permissions: { ...BASE_PROVIDER.permissions, contents: "write" } }) }) });
  await assert.rejects(widened.resolve(), /GitHub App token unavailable/);

  let redirectRequests = 0;
  const redirected = createGitHubAppProvider({ name: "redirect", provider: BASE_PROVIDER,
    pathOptions: privatePathOptions(t), now: () => 100_000, readPrivateKey: () => PRIVATE_KEY,
    requestToken: async () => { redirectRequests += 1; return { status: 302,
      headers: { location: "https://evil.example/token" }, body: "redirect-token" }; } });
  await assert.rejects(redirected.resolve(), (error) => error.message === "GitHub App token unavailable" &&
    !error.message.includes("evil.example"));
  assert.equal(redirectRequests, 1);

  const invalidTls = createGitHubAppProvider({ name: "tls", provider: BASE_PROVIDER,
    pathOptions: privatePathOptions(t), now: () => 100_000, readPrivateKey: () => PRIVATE_KEY,
    requestToken: async () => { throw new Error("self signed certificate at /private/key.pem"); } });
  await assert.rejects(invalidTls.resolve(), (error) => error.message === "GitHub App token unavailable" &&
    !error.message.includes("certificate") && !error.message.includes("key.pem"));

  const secondary = createGitHubAppProvider({ name: "secondary", provider: BASE_PROVIDER,
    pathOptions: privatePathOptions(t), now: () => 100_000, readPrivateKey: () => PRIVATE_KEY,
    requestToken: async () => ({ status: 403, headers: { "retry-after": "120" }, body: "{}" }) });
  await assert.rejects(secondary.resolve(), (error) => error.message === "GitHub App token unavailable" &&
    error.retryAt === 220_000);
});

test("APP-06: native HTTPS mint adapter is exact-host, bounded, and absolute-deadline limited", async () => {
  const calls = [];
  const adapter = (plan) => (options, onResponse) => {
    const request = new EventEmitter();
    request.destroyed = false;
    request.destroy = () => { request.destroyed = true; };
    request.end = (body) => {
      calls.push({ options, body });
      queueMicrotask(() => {
        if (request.destroyed) return;
        const response = new EventEmitter();
        response.statusCode = plan.status;
        response.headers = plan.headers ?? {};
        response.resume = () => {};
        onResponse(response);
        for (const chunk of plan.chunks ?? []) response.emit("data", chunk);
        response.emit("end");
      });
    };
    return request;
  };
  const input = { host: "api.github.com", path: "/app/installations/123/access_tokens",
    headers: { authorization: "Bearer redacted" }, body: "{}" };
  const response = await requestGitHubAppToken(input,
    { request: adapter({ status: 201, headers: { etag: "fixture" }, chunks: [Buffer.from("{\"ok\":true}")] }) });
  assert.deepEqual(response, { status: 201, headers: { etag: "fixture" }, body: "{\"ok\":true}" });
  assert.deepEqual({ protocol: calls[0].options.protocol, hostname: calls[0].options.hostname,
    port: calls[0].options.port, path: calls[0].options.path, method: calls[0].options.method,
    rejectUnauthorized: calls[0].options.rejectUnauthorized, body: calls[0].body },
  { protocol: "https:", hostname: "api.github.com", port: 443,
    path: "/app/installations/123/access_tokens", method: "POST", rejectUnauthorized: true, body: "{}" });
  await assert.rejects(requestGitHubAppToken(input, { request: adapter({ status: 302 }) }),
    (error) => error.message === "GitHub App token request failed");
  await assert.rejects(requestGitHubAppToken(input,
    { request: adapter({ status: 201, chunks: [Buffer.alloc(1024 * 1024 + 1)] }) }),
  (error) => error.message === "GitHub App token request failed");
  let deadline;
  await assert.rejects(requestGitHubAppToken(input, {
    request: adapter({ status: 201 }),
    setTimeout(callback, milliseconds) {
      assert.equal(milliseconds, 10_000);
      deadline = { unref() {} };
      queueMicrotask(callback);
      return deadline;
    },
    clearTimeout(timer) { assert.equal(timer, deadline); },
  }), (error) => error.message === "GitHub App token request failed");
});

test("APP-07: permission capabilities are per surface and gh providers remain unchanged", () => {
  const capabilities = githubAppResourceCapabilities(BASE_PROVIDER);
  assert.equal(capabilities.actions, true);
  assert.equal(capabilities.issues, true);
  assert.equal(capabilities.prs, true);
  assert.deepEqual(capabilities.security, {
    dependabot: false, codeScanning: false, secretScanning: false,
  });
  const partial = githubAppSecurityPolicy({ ...BASE_PROVIDER,
    permissions: { ...BASE_PROVIDER.permissions, security_events: "read" } }, 10_000);
  assert.deepEqual(partial.sources.map((source) => source.key), ["codeScanning"]);
  assert.deepEqual(Object.keys(partial.capabilities), ["dependabot", "secretScanning"]);
  assert.equal(partial.blind, false);
  assert.deepEqual(partial.notes, [
    "Dependabot alerts: permission not granted",
    "Secret scanning: permission not granted",
  ]);
  const protectedResult = applyGitHubAppSecurityPolicy({ capabilities: {},
    parse: () => ({ alerts: [], notes: [], blind: false, truncated: false }) }, partial);
  assert.deepEqual(protectedResult.parse(), {
    alerts: [], notes: partial.notes, blind: false, truncated: false,
  });
  assert.deepEqual(Object.keys(protectedResult.capabilities), ["dependabot", "secretScanning"]);
  assert.deepEqual(normalizeCollectorConfig({ version: 1,
    providers: { personal: { type: "gh", host: "github.com" } },
    targets: [{ host: "github.com", repo: "acme/widget", provider: "personal" }] }).providers.personal,
  { type: "gh", host: "github.com" });
});

test("APP-07: permitted Security rows and known-unavailable sources survive collector protocol projection", async (t) => {
  const provider = { ...BASE_PROVIDER,
    permissions: { ...BASE_PROVIDER.permissions, security_events: "read" } };
  const config = normalizeCollectorConfig({ version: 1, providers: { app: provider },
    targets: [{ host: "github.com", repo: "acme/widget", provider: "app" }] });
  const startedAt = Date.now();
  const resetMs = startedAt + 60_000;
  const executeGh = (command, args) => {
    assert.equal(command, "gh");
    if (args.includes("graphql")) {
      return resolvedGhChild(ghResponse("graphql", { data: { rateLimit: { cost: 1, limit: 5_000,
        used: 1, remaining: 4_999, resetAt: new Date(resetMs).toISOString() } } }, startedAt, resetMs));
    }
    assert.equal(args.some((arg) => String(arg).includes("code-scanning/alerts")), true);
    return resolvedGhChild(ghResponse("core", [{ number: 7, state: "open", created_at: "2026-09-15T00:00:00Z",
      severity: "high", title: "SQL injection", detail: "src/query.mjs" }], startedAt, resetMs));
  };
  const runtime = createCollectorAcquisitionRuntime({ config, pathOptions: privatePathOptions(t),
    executeGh,
    githubAppOptions: { readPrivateKey: () => PRIVATE_KEY,
      requestToken: async () => tokenResponseFor(provider, "installation-token", Date.now() + 3_600_000) },
    readInstallationCore: async () => ({ budget: { resource: "core", limit: 5_000,
      remaining: 4_999, used: 1, resetMs }, etag: "app-core", receivedAt: Date.now(), cost: 1 }),
    resolveTargetIdentity: async () => ({ id: "R_fixture", nameWithOwner: "acme/widget" }),
  });
  t.after(() => runtime.close());
  const holds = [];
  const snapshot = await within(new Promise((resolve) => runtime.subscribe({ target: config.targets[0],
    resource: "security", demand: { active: true, background: true, floorMs: 5_000, pages: 1 },
    onSnapshot: resolve, onHold: (hold) => holds.push(hold) })), 10_000);
  assert.deepEqual(snapshot.rows.map((row) => row.kind), ["CodeQL"]);
  assert.deepEqual(snapshot.securityNotes, [
    "Dependabot alerts: permission not granted",
    "Secret scanning: permission not granted",
  ]);
  assert.equal(snapshot.securityBlind, false);
  assert.deepEqual(Object.keys(snapshot.capabilities), ["dependabot", "secretScanning"]);
  assert.equal(holds.every((hold) => hold === "shared-wait"), true);
  let projected;
  const assembler = createCollectorSnapshotAssembler({ onSnapshot: (value) => { projected = value; },
    resourceForId: () => "security" });
  const protocolSnapshot = projectCollectorSnapshot(snapshot, "security");
  const frames = encodeCollectorSnapshotFrames("security-sub", "server-epoch", protocolSnapshot);
  assert.equal(frames.length, 1);
  assert.deepEqual(assembler.accept(frames[0]), { ok: true, complete: true });
  assert.deepEqual(projected.securityNotes, snapshot.securityNotes);
  assert.equal(projected.securityBlind, false);
  assert.deepEqual(Object.keys(projected.capabilities), ["dependabot", "secretScanning"]);
  await runtime.close();
});

test("APP-08: installation core observer uses conditional installation endpoint and 200/304 cost", async () => {
  const calls = [];
  const run = async (args, options) => {
    calls.push({ args, options });
    if (args[0] === "user") throw new Error("user endpoint forbidden");
    const status = options.etag ? 304 : 200;
    return { status, etag: "fixture-etag", rateLimit: { resource: "core", limit: 5000,
      remaining: status === 200 ? 4999 : 4999, used: 1, resetMs: 3_600_000 }, body: status === 200 ? "{}" : "" };
  };
  const first = await readInstallationCoreBudget(null, "github.com", null, { run });
  const second = await readInstallationCoreBudget(null, "github.com", first.etag, { run });
  assert.deepEqual(calls.map((call) => call.args), [
    ["installation/repositories?per_page=1", "--hostname", "github.com"],
    ["installation/repositories?per_page=1", "--hostname", "github.com"],
  ]);
  assert.deepEqual([first.cost, second.cost], [1, 0]);
  assert.deepEqual(calls.map((call) => call.options.etag), [null, "fixture-etag"]);
});

test("APP-08: unsupported installation observer pauses the production provider explicitly", async (t) => {
  const unavailable = new Error("fixture 404");
  unavailable.apiResponse = { status: 404, headers: {}, body: "{}" };
  const unsupported = await readInstallationCoreBudget(null, "ghe.example.com", null,
    { run: async () => { throw unavailable; } });
  assert.deepEqual(unsupported, {
    unsupported: true,
    capability: "installation-core-observer-unsupported",
  });

  const provider = { ...BASE_PROVIDER, host: "ghe.example.com" };
  const config = normalizeCollectorConfig({ version: 1, providers: { app: provider },
    targets: [{ host: "ghe.example.com", repo: "acme/widget", provider: "app" }] });
  const now = Date.now();
  const diagnostics = [];
  const runtime = createCollectorAcquisitionRuntime({ config, pathOptions: privatePathOptions(t), now: () => now,
    onDiagnostic: (event) => diagnostics.push(event),
    executeGh: (command, args) => {
      assert.equal(command, "gh");
      assert.equal(args.includes("graphql"), true);
      return resolvedGhChild(ghResponse("graphql", { data: { rateLimit: { cost: 1, limit: 5_000,
        used: 1, remaining: 4_999, resetAt: new Date(now + 3_600_000).toISOString() } } }, now));
    },
    githubAppOptions: { readPrivateKey: () => PRIVATE_KEY,
      requestToken: async () => tokenResponseFor(provider, "enterprise-token", now + 3_600_000) },
    readInstallationCore: async () => unsupported,
    resolveTargetIdentity: async () => ({ id: "R_fixture", nameWithOwner: "acme/widget" }),
  });
  t.after(() => runtime.close());
  const hold = await within(new Promise((resolve) => runtime.subscribe({ target: config.targets[0],
    resource: "actions", demand: { active: true, background: true, floorMs: 5_000, pages: 1 },
    onSnapshot() {}, onHold: resolve })), 3_000);
  assert.equal(hold, "observer");
  assert.equal(diagnostics.some((event) => event.stage === "acquire" &&
    /installation-core-observer-unsupported/.test(event.reason)), true);
  await runtime.close();
});

test("APP-08: collector reuses the access-partition core validator after restart", async (t) => {
  let now = Date.now();
  const pathOptions = privatePathOptions(t);
  const etags = [];
  const childEnvironments = [];
  const executeGh = async (command, args, options) => {
    assert.equal(command, "gh");
    assert.deepEqual(args, ["--version"]);
    childEnvironments.push(options.env);
    return { stdout: "gh version fixture" };
  };
  const readInstallationCore = async (signal, host, etag) => {
    assert.equal(host, "github.com");
    etags.push(etag);
    await runGh(["--version"], { signal, operation: "version" });
    return { budget: { resource: "core", limit: 5_000, remaining: 4_999, used: 1,
      resetMs: now + 3_600_000 }, etag: "persisted-app-etag", receivedAt: now,
    cost: etag ? 0 : 1 };
  };
  const start = async (provider = BASE_PROVIDER) => {
    const config = normalizeCollectorConfig({ version: 1, providers: { app: provider },
      targets: [{ host: "github.com", repo: "acme/widget", provider: "app" }] });
    let context;
    let diagnostic = "none";
    let resolveContext;
    let rejectContext;
    const contextReady = new Promise((resolve, reject) => { resolveContext = resolve; rejectContext = reject; });
    const runtime = createCollectorAcquisitionRuntime({ config, pathOptions, now: () => now,
      onDiagnostic: (event) => { diagnostic = `${event.stage}:${event.reason}`; },
      githubAppOptions: { readPrivateKey: () => PRIVATE_KEY,
        requestToken: async () => tokenResponseFor(provider, "installation-token", now + 3_600_000) },
      executeGh,
      readInstallationCore,
      resolveTargetIdentity: async () => ({ id: "R_fixture", nameWithOwner: "acme/widget" }),
      async produce({ resource, provider, markStarted }) {
        context = provider;
        resolveContext();
        await markStarted();
        return appPublication(resource, now);
      },
    });
    runtime.subscribe({ target: config.targets[0], resource: "issues",
      demand: { active: true, background: true, floorMs: 5_000, pages: 1 }, onSnapshot() {},
      onHold: (hold) => rejectContext(new Error(`unexpected ${hold} hold (${diagnostic})`)) });
    await within(contextReady);
    return { runtime, context };
  };
  const observeCore = async (context) => {
    assert.equal(maintainControlLease(context.scope, context.leaseId, 5_000, "issues", now).ok, true);
    const graphql = claimProbe(context.scope, context.leaseId, now, "graphql");
    if (graphql.value.status === "claimed") {
      assert.equal(publishProbe(context.scope, context.leaseId, graphql.value.nonce, { graphql: {
        source: "graphql-observer", receivedAt: now,
        budget: { limit: 5_000, remaining: 4_999, used: 1, resetMs: now + 3_600_000 },
      } }, now, "graphql").ok, true);
    }
    const refreshed = await refreshSharedBudget(context.scope, context.leaseId, null,
      { readBudgets: context.readBudgets, onObserverPublished: context.onObserverPublished,
        now: () => now });
    assert.equal(refreshed.ok, true, refreshed.reason);
    assert.equal(refreshed.value.resources.includes("core"), true);
  };

  const first = await start();
  await observeCore(first.context);
  await first.runtime.close();
  now += 61_000;
  const restarted = await start();
  await observeCore(restarted.context);
  await restarted.runtime.close();
  now += 61_000;
  const changed = await start({ ...BASE_PROVIDER,
    permissions: { ...BASE_PROVIDER.permissions, security_events: "read" } });
  await observeCore(changed.context);
  await changed.runtime.close();
  assert.deepEqual(etags, [null, "persisted-app-etag", null]);
  assert.equal(childEnvironments.every((env) => env.GH_TOKEN === "installation-token" &&
    env.GITHUB_TOKEN === undefined && env.GH_ENTERPRISE_TOKEN === undefined), true);
});
