import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import {
  dashboardCachePath,
  dashboardCacheTarget,
  loadDashboardCache,
  saveDashboardCache,
  serializeDashboardCache,
} from "../index.mjs";

function withTemporaryRoot(run) {
  const root = mkdtempSync(join(tmpdir(), "gh-glance-dashboard-cache-"));
  try {
    return run(root);
  } finally {
    // The root came from this exact mkdtempSync call. Never broaden cleanup to
    // tmpdir() or to a cache parent supplied by somebody else.
    rmSync(root, { recursive: true, force: true });
  }
}

function cachePath(root) {
  return join(root, "config", "gh-glance", "dashboard-cache.json");
}

const NOW = 1_723_456_789_000;

function actionsTab(title = "cached action") {
  return {
    data: [
      {
        databaseId: 101,
        displayTitle: title,
        workflowName: "CI",
        number: 12,
        headBranch: "develop",
        status: "completed",
        conclusion: "success",
        startedAt: "2026-08-11T05:00:00Z",
        updatedAt: "2026-08-11T05:01:00Z",
      },
    ],
    meta: { at: NOW, truncated: false },
    lastOk: NOW,
  };
}

function issuesTab(title = "cached issue") {
  return {
    data: [
      {
        number: 42,
        title,
        author: "octocat",
        label: "bug",
        updatedAt: "2026-08-11T05:02:00Z",
      },
    ],
    meta: { at: NOW + 1, truncated: false },
    lastOk: NOW + 1,
  };
}

function securityTab() {
  return {
    data: [],
    meta: { at: NOW + 2, truncated: false },
    lastOk: NOW + 2,
  };
}

function cacheFor(
  target,
  tabs = { actions: actionsTab() },
  { securityNotes = [], securityBlind = false, updatedAt = NOW } = {},
) {
  return { [target]: { tabs, securityNotes, securityBlind, updatedAt } };
}

test("dashboard cache path shares the private gh-glance config directory", () => {
  withTemporaryRoot((root) => {
    assert.equal(
      dashboardCachePath({ env: { XDG_CONFIG_HOME: root }, platform: process.platform, home: root }),
      join(root, "gh-glance", "dashboard-cache.json"),
    );
  });
});

test("missing, corrupt, and future dashboard caches return no entry without throwing", () => {
  withTemporaryRoot((root) => {
    const path = cachePath(root);
    const target = dashboardCacheTarget({ repo: "acme/widget", host: "github.com", cwd: root });

    const missing = loadDashboardCache(path, target);
    assert.equal(missing.entry, null);
    assert.equal(missing.error ?? null, null);

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "not json\n", "utf8");
    const corrupt = loadDashboardCache(path, target);
    assert.equal(corrupt.entry, null);
    assert.ok(corrupt.error instanceof Error, "corrupt JSON should retain nonfatal metadata");

    const futureDocument = JSON.parse(serializeDashboardCache(cacheFor(target)));
    futureDocument.version += 1;
    writeFileSync(path, `${JSON.stringify(futureDocument)}\n`, "utf8");
    const future = loadDashboardCache(path, target);
    assert.equal(future.entry, null);
  });
});

test("valid dashboard data round-trips by target and tab", () => {
  withTemporaryRoot((root) => {
    const path = cachePath(root);
    const firstTarget = dashboardCacheTarget({
      repo: "acme/one",
      host: "github.com",
      cwd: join(root, "ignored-one"),
    });
    const secondTarget = dashboardCacheTarget({
      repo: "tenant.example/acme/two",
      host: "tenant.example",
      cwd: join(root, "ignored-two"),
    });
    const cache = Object.freeze({
      [firstTarget]: Object.freeze({
        tabs: Object.freeze({
          actions: Object.freeze(actionsTab("first target")),
          security: Object.freeze(securityTab()),
        }),
        securityNotes: Object.freeze(["Code scanning: not enabled"]),
        securityBlind: true,
        updatedAt: NOW + 2,
      }),
      [secondTarget]: Object.freeze({
        tabs: Object.freeze({ issues: Object.freeze(issuesTab("second target")) }),
        securityNotes: Object.freeze([]),
        securityBlind: false,
        updatedAt: NOW + 1,
      }),
    });
    const before = structuredClone(cache);

    assert.equal(saveDashboardCache(path, cache).ok, true);
    assert.deepEqual(loadDashboardCache(path, firstTarget).entry, before[firstTarget]);
    assert.deepEqual(loadDashboardCache(path, secondTarget).entry, before[secondTarget]);
    assert.deepEqual(cache, before, "cache persistence must not mutate live session state");
  });
});

test("invalid tabs are ignored independently", () => {
  withTemporaryRoot((root) => {
    const path = cachePath(root);
    const target = dashboardCacheTarget({ repo: "acme/widget", host: "github.com", cwd: root });
    const cache = cacheFor(target, {
      actions: actionsTab(),
      issues: issuesTab(),
      security: securityTab(),
    });
    const document = JSON.parse(serializeDashboardCache(cache));
    document.targets[target].tabs.issues.data = "not an array";
    document.targets[target].tabs.security.lastOk = -1;
    document.targets[target].tabs.prs = {
      data: [],
      meta: { at: "yesterday", truncated: false },
      lastOk: NOW,
    };
    document.targets[target].securityNotes = ["valid note", 42];
    document.targets[target].securityBlind = "yes";
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(document)}\n`, "utf8");

    const loaded = loadDashboardCache(path, target).entry;
    assert.deepEqual(loaded.tabs.actions, cache[target].tabs.actions);
    assert.equal(Object.hasOwn(loaded.tabs, "issues"), false);
    assert.equal(Object.hasOwn(loaded.tabs, "prs"), false);
    assert.equal(Object.hasOwn(loaded.tabs, "security"), false);
    assert.deepEqual(loaded.securityNotes, ["valid note"]);
    assert.equal(loaded.securityBlind, false);
  });
});

test("explicit repositories and inferred host-directory targets remain isolated", () => {
  withTemporaryRoot((root) => {
    const path = cachePath(root);
    const explicitOne = dashboardCacheTarget({
      repo: "acme/one",
      host: "github.com",
      cwd: join(root, "checkout-one"),
    });
    const explicitTwo = dashboardCacheTarget({
      repo: "acme/two",
      host: "github.com",
      cwd: join(root, "checkout-one"),
    });
    const explicitFromEnvironment = dashboardCacheTarget({
      repo: null,
      ghRepo: "acme/environment",
      host: "github.com",
      cwd: join(root, "checkout-one"),
    });
    const inferredOne = dashboardCacheTarget({
      repo: null,
      ghRepo: null,
      host: "github.com",
      cwd: join(root, "checkout-one"),
    });
    const inferredTwo = dashboardCacheTarget({
      repo: null,
      ghRepo: null,
      host: "github.com",
      cwd: join(root, "checkout-two"),
    });
    const inferredOtherHost = dashboardCacheTarget({
      repo: null,
      ghRepo: null,
      host: "tenant.example",
      cwd: join(root, "checkout-one"),
    });

    assert.equal(
      new Set([
        explicitOne,
        explicitTwo,
        explicitFromEnvironment,
        inferredOne,
        inferredTwo,
        inferredOtherHost,
      ]).size,
      6,
    );
    assert.equal(
      dashboardCacheTarget({
        repo: "acme/one",
        ghRepo: "ignored/environment",
        host: "github.com",
        cwd: join(root, "different-checkout"),
      }),
      explicitOne,
      "--repo identity must take precedence over GH_REPO and cwd",
    );
    assert.equal(saveDashboardCache(path, cacheFor(explicitOne)).ok, true);
    assert.ok(loadDashboardCache(path, explicitOne).entry);
    for (const target of [
      explicitTwo,
      explicitFromEnvironment,
      inferredOne,
      inferredTwo,
      inferredOtherHost,
    ]) {
      assert.equal(loadDashboardCache(path, target).entry, null, target);
    }
  });
});

test("repeated dashboard saves atomically replace content without leaving a temp file", () => {
  withTemporaryRoot((root) => {
    const path = cachePath(root);
    const target = dashboardCacheTarget({ repo: "acme/widget", host: "github.com", cwd: root });
    const first = cacheFor(target, { actions: actionsTab("first") });
    const latest = cacheFor(target, {
      actions: actionsTab("latest"),
      issues: issuesTab(),
    });

    assert.equal(saveDashboardCache(path, first).ok, true);
    assert.equal(saveDashboardCache(path, latest).ok, true);

    assert.equal(readFileSync(path, "utf8"), serializeDashboardCache(latest));
    assert.deepEqual(readdirSync(dirname(path)), ["dashboard-cache.json"]);
  });
});

test("saving a dashboard cache requests private directory and file permissions", () => {
  withTemporaryRoot((root) => {
    const path = cachePath(root);
    const target = dashboardCacheTarget({ repo: "acme/widget", host: "github.com", cwd: root });
    mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
    if (process.platform !== "win32") chmodSync(dirname(path), 0o755);

    assert.equal(saveDashboardCache(path, cacheFor(target)).ok, true);
    if (process.platform !== "win32") {
      assert.equal(statSync(dirname(path)).mode & 0o777, 0o700);
      assert.equal(statSync(path).mode & 0o777, 0o600);
    }
  });
});

test("a blocked dashboard cache parent is nonfatal and preserves the caller snapshot", () => {
  withTemporaryRoot((root) => {
    const blockedParent = join(root, "not-a-directory");
    const path = join(blockedParent, "dashboard-cache.json");
    const target = dashboardCacheTarget({ repo: "acme/widget", host: "github.com", cwd: root });
    const cache = Object.freeze({
      [target]: Object.freeze({
        tabs: Object.freeze({ actions: Object.freeze(actionsTab()) }),
        securityNotes: Object.freeze([]),
        securityBlind: false,
        updatedAt: NOW,
      }),
    });
    const before = structuredClone(cache);
    writeFileSync(blockedParent, "occupied\n", "utf8");

    const saved = saveDashboardCache(path, cache);

    assert.equal(saved.ok, false);
    assert.ok(saved.error instanceof Error);
    assert.deepEqual(cache, before, "failed storage must preserve live session state");
    assert.deepEqual(readdirSync(root), ["not-a-directory"]);
  });
});
