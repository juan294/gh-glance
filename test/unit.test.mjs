// Node's built-in test runner -- no framework, no config, no build step, which
// is the only way to add tests without contradicting the project's no-build
// stance (see CONTRIBUTING.md).
//
// Importing index.mjs is inert: everything with a side effect hangs off its
// main-module check, so this does not parse argv, enter the alternate screen,
// or start the dashboard.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  safe,
  shortErr,
  isUnavailable,
  isRateLimited,
  isAuthProblem,
  isMissingRemote,
  forwardSignalToChild,
  classify,
  toTabError,
  formatTabError,
  parseRepoContext,
  parseAuthContext,
  buildFailureContext,
  failureTargetHost,
  unavailableRemedy,
  createFailureContextCoordinator,
  AUTH_RETRY_MS,
  BACKOFF_STEPS_MS,
  formatAge,
  formatDuration,
  usableSize,
  severityRank,
  pick,
  TABS,
  columnProps,
  adjustableWidthKeys,
  selectWidthKey,
  cycleWidthKey,
  resolveHeader,
  fitHeaderToFrame,
  adjustWidth,
  updateWidthPreference,
  resetWidthPreference,
  resetTabWidthPreferences,
  widthStatusText,
  headerGutterKey,
  parseSgrMouse,
  dividerHandles,
  hitDivider,
  beginDividerDrag,
  draggedWidth,
  createTerminalLifecycle,
  HeaderCells,
  minimumWidthFor,
  WIDTH_PREFERENCES_VERSION,
  widthPreferencesPath,
  parseWidthPreferences,
  serializeWidthPreferences,
  createWidthPreferenceWriter,
  runStatusIcon,
  RUN_STATUS_ICON,
  SEVERITY_STYLE,
  REVIEW_LABEL,
  MIN_TABLE_WIDTH,
  OCT_NERD,
  OCT_UNICODE,
  KEY_TABLE,
  KEY_HINTS,
  REMOTE_SETUP_HINTS,
  REMOTE_SETUP_LINES,
  REMOTE_SETUP_NONINTERACTIVE_LINES,
  VERDICT_REMEDY,
  RATE_LIMIT_RETRY_MS,
  FAILURE_LADDER,
  REPO_PATTERN,
  TAB_KEYS,
  ALERT_SOURCES,
  REST_PER_FETCH,
  GRAPHQL_PER_FETCH,
  OPERATION_COSTS,
  operationCost,
  tabRequestCost,
  projectedHourlyCost,
  REFRESH_MS,
  BACKGROUND_EVERY,
  adaptiveRefreshMs,
  adaptiveChangeWorthApplying,
  externalSampleIsUsable,
  nextExternalSampleWindow,
  restPerTick,
  MAX_ADAPTIVE_REFRESH_MS,
  BUDGET_SAFETY,
  BUDGET_RESERVE_FRACTION,
  BUDGET_SNAPSHOT_TTL_MS,
  GOVERNOR_HEARTBEAT_MS,
  GOVERNOR_LEASE_TTL_MS,
  GOVERNOR_PROBE_LEASE_MS,
  GOVERNOR_ACTIVE_PROBE_LEASE_MS,
  BUDGET_RESET_GRACE_MS,
  GOVERNOR_PHASE_WINDOW_MS,
  BUDGET_PROBE_MS,
  MIN_SAMPLE_CALLS,
  REQUEST_PRIORITIES,
  normalizeBudgetResource,
  budgetEpoch,
  resourceReserve,
  availableForGrant,
  nextExternalFactor,
  resourceDecision,
  governorPhaseOffset,
  scheduleIntents,
} from "../index.mjs";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const NUL = String.fromCharCode(0);
const DEL = String.fromCharCode(127);
const C1 = String.fromCharCode(155);
const NO_LOGIN_ERROR = "You are not logged into any GitHub hosts. To log in, run: gh auth login";
const REPOSITORY_RESOLUTION_ERROR =
  "GraphQL: Could not resolve to a Repository with the name 'Nvteca/cashflor-forecast'. (repository)";
const NO_REMOTE_ERROR = "failed to determine base repo: no git remotes found";
const MISSING_REPOSITORY_CONTEXT = {
  ok: false,
  verdict: "other",
  raw: "Repository context unavailable",
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolve_, reject_) => {
    resolve = resolve_;
    reject = reject_;
  });
  return { promise, resolve, reject };
}

async function within(promise, milliseconds = 1000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timed out waiting for test result")), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("safe() strips the escape classes that survive ink's own sanitizer", () => {
  // Each of these was verified to reach the terminal unmodified through ink.
  //
  // The guarantee is that no control character survives, so nothing an attacker
  // wrote can be *interpreted* by the terminal. The inert payload text of an OSC
  // sequence is deliberately left visible rather than deleted: stripping only
  // control characters can never remove legitimate content, and a user who sees
  // `]8;;https://evil.example click me` has been shown something obviously
  // suspicious instead of a clean, invisible spoof.
  const osc8 = safe(`${ESC}]8;;https://evil.example${BEL}click me${ESC}]8;;${BEL}`);
  assert.ok(!osc8.includes(ESC), "no ESC, so the terminal creates no hyperlink");
  assert.ok(!osc8.includes(BEL), "no BEL, so the sequence cannot terminate");
  assert.ok(osc8.includes("click me"), "the human-readable part survives");

  assert.equal(safe("AAAA\rBBBB"), "AAAA BBBB", "CR rewinds the cursor over drawn columns");
  assert.equal(safe(`ding${BEL}dong`), "ding dong", "BEL rings once per redraw");
  assert.equal(safe("line1\nline2\nline3"), "line1 line2 line3", "LF evicts neighbouring rows");
  assert.equal(safe(`a${NUL}b`), "a b", "NUL");
  assert.equal(safe(`a${C1}b`), "a b", "C1 introducer");
  assert.equal(safe(`a${DEL}b`), "a b", "DEL");
  assert.ok(!safe(`x${ESC}[2J${ESC}[Hy`).includes(ESC), "screen clear cannot be reassembled");
  assert.ok(!safe(`t${ESC}[31mu`).includes(ESC), "no attacker-chosen colour");
});

test("safe() preserves the legitimate content the UI depends on", () => {
  // A "strip non-printable" sanitizer would erase every status icon in the
  // tool and desynchronize ink's column arithmetic.
  assert.equal(safe("héllo 👍 日本語 é"), "héllo 👍 日本語 é");
  assert.equal(safe("👨‍💻 team"), "👨‍💻 team", "ZWJ sequences must not be split");
  assert.equal(safe("é"), "é", "combining marks must stay attached");
  assert.equal(safe("אב rtl"), "אב rtl");
  assert.equal(safe(OCT_NERD.shield), OCT_NERD.shield, "private-use glyphs must survive");
});

test("safe() clamps by codepoint, never mid-surrogate", () => {
  const clamped = safe("👍".repeat(400));
  const points = Array.from(clamped);
  assert.equal(points.length, 300);
  assert.ok(points.every((c) => c === "👍"), "no severed surrogate pairs");
  assert.equal(safe(undefined), "");
  assert.equal(safe(null), "");
  assert.equal(safe(42), "42");
});

test("shortErr() prefers stderr and drops the reconstructed command line", () => {
  const err = Object.assign(new Error("Command failed: gh run list --json a,b,c\ngh: Not Found (HTTP 404)\n"), {
    stderr: "gh: Not Found (HTTP 404)\n",
    code: 1,
  });
  assert.equal(shortErr(err), "gh: Not Found (HTTP 404)");
});

test("shortErr() falls back to message when stderr is empty (the ENOENT case)", () => {
  // Verified real shape: a missing binary has no stderr at all.
  const err = Object.assign(new Error("spawn gh ENOENT"), { stderr: "", code: "ENOENT" });
  assert.equal(shortErr(err), "spawn gh ENOENT");
});

test("shortErr() never returns a newline and stays within one rendered line", () => {
  const err = Object.assign(new Error("Command failed: gh x\nline one\nline two\n"), {
    stderr: "line one\nline two\n",
  });
  const out = shortErr(err);
  assert.ok(!out.includes("\n"), "an embedded newline forces a second row ink has not budgeted");
  assert.ok(out.length <= 120);
  assert.ok(shortErr({ stderr: "y".repeat(500) }).length <= 120);
});

test("shortErr() names a timeout rather than rendering a blank line", () => {
  // A killed child rejects with an empty stderr, which would otherwise render
  // as an empty red row saying nothing.
  assert.match(shortErr({ killed: true, signal: "SIGKILL", stderr: "" }), /timed out/);
});

test("error classification keys off HTTP status, not the process exit code", () => {
  assert.ok(isUnavailable({ stderr: "gh: Not Found (HTTP 404)" }));
  assert.ok(isUnavailable({ stderr: "gh: Forbidden (HTTP 403)" }));
  assert.ok(!isUnavailable({ stderr: "gh: Bad Gateway (HTTP 502)" }));
  assert.ok(!isUnavailable({ code: 1, stderr: "dial tcp: lookup api.github.com" }));
  // Rate limiting also arrives as 403 but means the opposite of "not enabled",
  // so it must never latch the backoff.
  assert.ok(isRateLimited({ stderr: "HTTP 403: API rate limit exceeded" }));
  assert.ok(!isRateLimited({ stderr: "gh: Not Found (HTTP 404)" }));
});

test("fresh gh login failures are auth problems", () => {
  for (const message of [
    NO_LOGIN_ERROR,
    "To get started with GitHub CLI, please run: gh auth login",
    "none of the git remotes configured for this repository\npoint to a known GitHub host",
  ]) {
    assert.equal(isAuthProblem({ stderr: message }), true, message);
    assert.equal(classify({ stderr: message }), "auth-problem", message);
  }
});

test("a local repository without remotes is an onboarding state", () => {
  for (const message of [NO_REMOTE_ERROR, "no git remotes found"]) {
    const error = { stderr: message };
    assert.equal(isMissingRemote(error), true, message);
    assert.equal(classify(error), "no-remote", message);
    assert.equal(formatTabError(toTabError(error)), VERDICT_REMEDY["no-remote"]);
  }
  assert.equal(isMissingRemote({ stderr: "no git repository found" }), false);
});

test("the screenshot GraphQL resolution failure is unavailable", () => {
  const error = { stderr: REPOSITORY_RESOLUTION_ERROR };
  assert.equal(isUnavailable(error), true);
  assert.equal(classify(error), "unavailable");
});

test("unrelated GraphQL errors remain other", () => {
  const error = { stderr: "GraphQL: Something went wrong while executing your query" };
  assert.equal(isUnavailable(error), false);
  assert.equal(classify(error), "other");
});

test("structured tab errors select actionable one-line remedies", () => {
  const repositoryError = toTabError({ stderr: REPOSITORY_RESOLUTION_ERROR });
  assert.equal(formatTabError(repositoryError), VERDICT_REMEDY.unavailable);

  const authError = toTabError({ stderr: NO_LOGIN_ERROR });
  assert.equal(formatTabError(authError), VERDICT_REMEDY["auth-problem"]);

  const raw = "dial tcp: lookup api.github.com: no such host";
  assert.equal(formatTabError(toTabError({ stderr: raw })), raw);
  assert.equal(formatTabError({ kind: "text", text: "browser launch failed" }), "browser launch failed");
  assert.equal(formatTabError(null), null);

  for (const remedy of Object.values(VERDICT_REMEDY)) {
    assert.equal(remedy.includes("\n"), false, remedy);
    assert.ok(remedy.length <= 120, remedy);
  }
});

test("repository context parsing validates and sanitizes every required field", () => {
  assert.deepEqual(
    parseRepoContext(
      JSON.stringify({
        nameWithOwner: "acme/\nwidget",
        url: "https://github.com/acme/\rwidget",
        viewerPermission: "WR\u202eITE",
      }),
    ),
    {
      ok: true,
      nameWithOwner: "acme/ widget",
      url: "https://github.com/acme/ widget",
      viewerPermission: "WRITE",
    },
  );

  for (const raw of [
    "not json",
    "null",
    "[]",
    JSON.stringify({ url: "https://github.com/acme/widget", viewerPermission: "READ" }),
    JSON.stringify({ nameWithOwner: "acme/widget", viewerPermission: "READ" }),
    JSON.stringify({ nameWithOwner: "acme/widget", url: "https://github.com/acme/widget" }),
    JSON.stringify({
      nameWithOwner: 42,
      url: "https://github.com/acme/widget",
      viewerPermission: "READ",
    }),
    JSON.stringify({
      nameWithOwner: "acme/widget",
      url: null,
      viewerPermission: "READ",
    }),
    JSON.stringify({
      nameWithOwner: "acme/widget",
      url: "https://github.com/acme/widget",
      viewerPermission: ["READ"],
    }),
  ]) {
    assert.equal(parseRepoContext(raw), null, raw);
  }
});

test("auth context parsing filters rows, sanitizes identity, and never retains tokens", () => {
  const secret = "ghp_PLANTED_SECRET";
  const parsed = parseAuthContext(
    JSON.stringify([
      {
        host: "git\nhub.com",
        login: "ju\u202ean",
        token: secret,
        scopes: ["repo"],
      },
      { host: "tenant.ghe.com", login: "alice" },
      null,
      [],
      { host: "missing-login.example.com" },
      { login: "missing-host" },
      { host: 42, login: "number-host" },
      { host: "number-login.example.com", login: 42 },
    ]),
  );

  assert.deepEqual(parsed, [
    { host: "git hub.com", login: "juan" },
    { host: "tenant.ghe.com", login: "alice" },
  ]);
  const serialized = JSON.stringify(parsed);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes("token"), false);

  for (const raw of ["not json", "null", "{}", JSON.stringify({ hosts: [] })]) {
    assert.equal(parseAuthContext(raw), null, raw);
  }
  assert.deepEqual(parseAuthContext(JSON.stringify([null, {}, { host: "github.com" }])), []);
});

test("failure context building normalizes valid, malformed, and rejected settlements", () => {
  const repository = {
    nameWithOwner: "acme/widget",
    url: "https://github.com/acme/widget",
    viewerPermission: "READ",
  };
  const accounts = [{ host: "github.com", login: "alice" }];

  assert.deepEqual(
    buildFailureContext(
      { status: "fulfilled", value: JSON.stringify(repository) },
      { status: "fulfilled", value: JSON.stringify(accounts) },
    ),
    { repo: { ok: true, ...repository }, accounts },
  );

  assert.deepEqual(
    buildFailureContext(
      { status: "fulfilled", value: "malformed repository JSON" },
      { status: "fulfilled", value: "malformed auth JSON" },
    ),
    { repo: MISSING_REPOSITORY_CONTEXT, accounts: null },
  );

  assert.deepEqual(
    buildFailureContext(
      { status: "rejected", reason: { stderr: REPOSITORY_RESOLUTION_ERROR } },
      { status: "rejected", reason: new Error("unsupported gh auth flags") },
    ),
    {
      repo: { ok: false, verdict: "unavailable", raw: REPOSITORY_RESOLUTION_ERROR },
      accounts: null,
    },
  );

  assert.deepEqual(
    buildFailureContext(
      { status: "fulfilled", value: JSON.stringify(repository) },
      { status: "rejected", reason: new Error("auth context unavailable") },
    ),
    { repo: { ok: true, ...repository }, accounts: null },
  );
});

test("unavailable formatting distinguishes a visible repository from a failed target", () => {
  const error = toTabError({ stderr: REPOSITORY_RESOLUTION_ERROR });
  assert.equal(
    formatTabError(error, {
      repo: { ok: true, nameWithOwner: "acme/widget", url: "https://github.com/acme/widget" },
      accounts: [{ host: "github.com", login: "alice" }],
    }),
    "not available for this repository",
  );
  assert.equal(
    formatTabError(error, { repo: MISSING_REPOSITORY_CONTEXT, accounts: null }),
    VERDICT_REMEDY.unavailable,
  );
});

test("failure target host follows explicit sources before an unambiguous account host", () => {
  const soleAccount = [{ host: "accounts.example.com", login: "alice" }];
  assert.equal(
    failureTargetHost({
      runtimeHost: "runtime.example.com",
      ghHost: "env.example.com",
      ghRepo: "repo.example.com/acme/widget",
      accounts: soleAccount,
    }),
    "runtime.example.com",
  );
  assert.equal(
    failureTargetHost({
      runtimeHost: null,
      ghHost: "env.example.com",
      ghRepo: "repo.example.com/acme/widget",
      accounts: soleAccount,
    }),
    "env.example.com",
  );
  assert.equal(
    failureTargetHost({
      runtimeHost: null,
      ghHost: null,
      ghRepo: "repo.example.com/acme/widget",
      accounts: soleAccount,
    }),
    "repo.example.com",
  );
  assert.equal(
    failureTargetHost({ ghRepo: "acme/widget", accounts: soleAccount }),
    "accounts.example.com",
  );
  assert.equal(
    failureTargetHost({
      ghRepo: "https://repo.example.com/acme/widget",
      accounts: soleAccount,
    }),
    "accounts.example.com",
  );
  assert.equal(
    failureTargetHost({
      accounts: [
        { host: "same.example.com", login: "alice" },
        { host: "same.example.com", login: "bob" },
      ],
    }),
    "same.example.com",
  );
  assert.equal(
    failureTargetHost({
      accounts: [
        { host: "one.example.com", login: "alice" },
        { host: "two.example.com", login: "bob" },
      ],
    }),
    null,
  );
  assert.equal(failureTargetHost({ accounts: [] }), null);
  assert.equal(failureTargetHost({ accounts: null }), null);
});

test("unavailable remedy personalizes one matching account only within the line budget", () => {
  const host = "tenant.ghe.com";
  const account = { host, login: "alice" };
  assert.equal(
    unavailableRemedy([account, { host: "github.com", login: "bob" }], host),
    "Repository not found or inaccessible to alice@tenant.ghe.com -- check the target or run `gh auth switch`",
  );
  for (const [accounts, targetHost] of [
    [[], host],
    [[{ host: "github.com", login: "bob" }], host],
    [[account], null],
    [[account, { host, login: "charlie" }], host],
  ]) {
    assert.equal(unavailableRemedy(accounts, targetHost), VERDICT_REMEDY.unavailable);
  }

  const prefix = "Repository not found or inaccessible to ";
  const suffix = " -- check the target or run `gh auth switch`";
  const boundaryHost = "g.io";
  const exactLogin = "x".repeat(120 - prefix.length - 1 - boundaryHost.length - suffix.length);
  const exact = unavailableRemedy([{ host: boundaryHost, login: exactLogin }], boundaryHost);
  assert.equal(exact.length, 120);
  assert.equal(exact.includes("\n"), false);
  assert.equal(
    unavailableRemedy([{ host: boundaryHost, login: `${exactLogin}x` }], boundaryHost),
    VERDICT_REMEDY.unavailable,
  );
});

test("failure context coordinator deduplicates and caches one resolution per epoch", async () => {
  const pending = deferred();
  const signal = { name: "test signal" };
  const context = { repo: { ok: true }, accounts: [] };
  const commits = [];
  let resolveCalls = 0;
  const coordinator = createFailureContextCoordinator({
    resolve: (receivedSignal) => {
      resolveCalls += 1;
      assert.equal(receivedSignal, signal);
      return pending.promise;
    },
    commit: (value) => commits.push(value),
    fallback: { repo: MISSING_REPOSITORY_CONTEXT, accounts: null },
  });

  const first = coordinator.ensure(signal);
  const duplicate = coordinator.ensure(signal);
  await Promise.resolve();
  assert.equal(resolveCalls, 1);
  pending.resolve(context);
  assert.deepEqual(await Promise.all([first, duplicate]), [true, true]);
  assert.deepEqual(commits, [context]);

  assert.equal(await coordinator.ensure(signal), true);
  assert.equal(resolveCalls, 1);
  assert.deepEqual(commits, [context]);
});

test("failure context coordinator caches a resolver rejection as a non-fatal fallback", async () => {
  const fallback = { repo: MISSING_REPOSITORY_CONTEXT, accounts: null };
  const commits = [];
  let resolveCalls = 0;
  const coordinator = createFailureContextCoordinator({
    resolve: () => {
      resolveCalls += 1;
      throw new Error("resolver failed unexpectedly");
    },
    commit: (value) => commits.push(value),
    fallback,
  });

  assert.equal(await coordinator.ensure(), false);
  assert.deepEqual(commits, [fallback]);
  await coordinator.ensure();
  assert.equal(resolveCalls, 1);
  assert.deepEqual(commits, [fallback]);
});

test("failure context coordinator does not reinterpret commit failures as resolver failures", async () => {
  let commitCalls = 0;
  const coordinator = createFailureContextCoordinator({
    resolve: () => ({ repo: { ok: true }, accounts: [] }),
    commit: () => {
      commitCalls += 1;
      throw new Error("commit failed");
    },
    fallback: { repo: MISSING_REPOSITORY_CONTEXT, accounts: null },
  });

  await assert.rejects(coordinator.ensure(), /commit failed/);
  assert.equal(commitCalls, 1);
});

for (const staleSettlement of ["fulfilled", "rejected"]) {
  test(`invalidating a pending ${staleSettlement} context prevents its stale commit`, async () => {
    const pending = [];
    const commits = [];
    let resolveCalls = 0;
    const coordinator = createFailureContextCoordinator({
      resolve: () => {
        resolveCalls += 1;
        const next = deferred();
        pending.push(next);
        return next.promise;
      },
      commit: (value) => commits.push(value),
      fallback: { repo: MISSING_REPOSITORY_CONTEXT, accounts: null },
    });

    const stale = coordinator.ensure();
    await Promise.resolve();
    coordinator.invalidate();
    assert.deepEqual(commits, [null]);

    const fresh = coordinator.ensure();
    await Promise.resolve();
    assert.equal(resolveCalls, 2);

    if (staleSettlement === "fulfilled") {
      pending[0].resolve({ repo: { ok: true, nameWithOwner: "old/repo" }, accounts: [] });
    } else {
      pending[0].reject(new Error("stale resolver failed"));
    }
    assert.equal(await stale, false);
    assert.deepEqual(commits, [null]);

    const current = { repo: { ok: true, nameWithOwner: "new/repo" }, accounts: [] };
    pending[1].resolve(current);
    assert.equal(await fresh, true);
    assert.deepEqual(commits, [null, current]);
  });
}

test("a SAML/SSO 403 is an auth problem, not a disabled feature", () => {
  // The forms GitHub and gh actually emit. On an EMU tenant the SAML session
  // expires periodically and is re-authorized in the browser; reporting that as
  // "not enabled for this repository" is a confident claim about the repo's
  // configuration that is simply false, and latching it for an hour means the
  // tab stays wrong long after the user fixed it.
  for (const s of [
    "HTTP 403: Resource protected by organization SAML enforcement. You must grant your OAuth token access to this organization (https://api.github.com/repos/acme/widget/code-scanning/alerts)",
    "HTTP 403: Although you appear to have the correct authorization credentials, the organization has enabled OAuth App access restrictions",
    "HTTP 401: Bad credentials",
    "HTTP 403: Your token has not been granted the required scopes to execute this query",
  ]) {
    assert.equal(isAuthProblem({ stderr: s }), true, s);
  }
});

test("a genuine not-enabled 403/404 is not an auth problem", () => {
  // "Advanced Security must be enabled" contains no auth marker and not even
  // the substring "authoriz", which is what keeps the real not-enabled path
  // intact. If a future marker breaks this assertion, that marker is too broad.
  for (const s of [
    "HTTP 404: Not Found",
    "HTTP 403: Advanced Security must be enabled for this repository",
  ]) {
    assert.equal(isAuthProblem({ stderr: s }), false, s);
    // The combination fetchAlertSource actually evaluates.
    assert.ok(isUnavailable({ stderr: s }) && !isAuthProblem({ stderr: s }), s);
  }
});

test("a rate-limit message is still not an auth problem", () => {
  assert.equal(isAuthProblem({ stderr: "HTTP 403: API rate limit exceeded" }), false);
});

test("the auth ladder is short, fixed, and far below the unavailable ladder", () => {
  assert.equal(AUTH_RETRY_MS.length, 1, "an auth lapse must not escalate");
  assert.ok(
    AUTH_RETRY_MS[0] < BACKOFF_STEPS_MS[0],
    `${AUTH_RETRY_MS[0]}ms must be below the first unavailable step (${BACKOFF_STEPS_MS[0]}ms)`,
  );
});

test("formatAge() returns a placeholder instead of NaN for unusable dates", () => {
  const now = new Date("2026-08-03T12:00:00Z");
  for (const bad of [undefined, "", null, "not-a-date", "0001-01-01T00:00:00Z"]) {
    const out = formatAge(new Date(bad), now);
    assert.ok(!/NaN/.test(out), `formatAge(${JSON.stringify(bad)}) => ${out}`);
  }
  assert.equal(formatAge(new Date("2026-08-03T11:59:59Z"), now), "just now");
});

test("formatAge() in-range behaviour is unchanged", () => {
  const now = new Date("2026-08-03T12:00:00Z");
  assert.equal(formatAge(new Date("2026-08-03T11:58:00Z"), now), "2m ago");
  assert.equal(formatAge(new Date("2026-08-03T09:00:00Z"), now), "3h ago");
  assert.equal(formatAge(new Date("2026-07-31T12:00:00Z"), now), "3d ago");
  assert.equal(formatAge(new Date("2027-01-01T00:00:00Z"), now), "just now", "future clamps");
});

test("formatDuration() guards non-finite input and keeps in-range output", () => {
  assert.equal(formatDuration(NaN), "-");
  assert.equal(formatDuration(Infinity), "-");
  assert.equal(formatDuration(-Infinity), "-");
  assert.equal(formatDuration(59999), "59s");
  assert.equal(formatDuration(3600000), "1h0m");
  assert.equal(formatDuration(-5), "0s");
});

test("placeholders fit the fixed column widths they render into", () => {
  // TIME is 7 wide and UPDATED is 8; a longer fallback would change density.
  assert.ok(formatDuration(NaN).length <= 7);
  assert.ok(formatAge(new Date(undefined), new Date()).length <= 8);
});

test("usableSize() falls back for the sizes pty wrappers actually report", () => {
  assert.equal(usableSize(0, 30), 30);
  assert.equal(usableSize(undefined, 30), 30);
  assert.equal(usableSize(-1, 30), 30);
  assert.equal(usableSize(NaN, 30), 30);
  assert.equal(usableSize(45, 30), 45);
});

test("pick() ignores inherited keys so remote strings cannot crash the render", () => {
  // Verified: SEVERITY_COLOR["constructor"] returned a function, which reaches
  // ink's color prop and throws. Code-scanning severity comes from uploaded
  // SARIF, so it is genuinely attacker-influenced.
  for (const hostile of ["constructor", "__proto__", "toString", "valueOf", "hasOwnProperty"]) {
    assert.equal(pick(SEVERITY_STYLE, hostile, SEVERITY_STYLE.unknown), SEVERITY_STYLE.unknown);
    assert.equal(pick(REVIEW_LABEL, hostile, null), null);
    assert.equal(pick(RUN_STATUS_ICON, hostile, null), null);
  }
  assert.equal(pick(SEVERITY_STYLE, "critical", null).short, "crit");
  assert.equal(pick(SEVERITY_STYLE, "notacolor", SEVERITY_STYLE.unknown), SEVERITY_STYLE.unknown);
  assert.equal(pick(SEVERITY_STYLE, 42, SEVERITY_STYLE.unknown), SEVERITY_STYLE.unknown);
});

test("every style entry yields a string colour ink can accept", () => {
  for (const [key, value] of Object.entries(SEVERITY_STYLE)) {
    assert.equal(typeof value.color, "string", `${key} colour`);
    assert.equal(typeof value.short, "string", `${key} short`);
  }
  for (const [key, value] of Object.entries(RUN_STATUS_ICON)) {
    assert.equal(typeof value.color, "string", `${key} colour`);
    assert.equal(typeof value.icon, "string", `${key} icon`);
    assert.ok(value.label, `${key} needs a screen-reader label`);
  }
});

test("runStatusIcon() covers every GitHub conclusion plus an unknown one", () => {
  const conclusions = [
    "success",
    "failure",
    "cancelled",
    "skipped",
    "timed_out",
    "action_required",
    "neutral",
    "stale",
    "startup_failure",
  ];
  for (const conclusion of conclusions) {
    const { icon, color, label } = runStatusIcon({ status: "completed", conclusion }, "x");
    assert.ok(icon && color && label, conclusion);
  }
  // GitHub adds conclusions over time; an unrecognised one must fall back
  // visibly rather than render blank or throw.
  const unknown = runStatusIcon({ status: "completed", conclusion: "brand_new" }, "x");
  assert.equal(unknown.icon, "?");
  // Queued deliberately does not spin -- standing still is how it reads as
  // queued -- and a running row falls back to a static glyph when animation is
  // off rather than silently becoming indistinguishable from queued.
  assert.notEqual(runStatusIcon({ status: "queued" }, "x").icon, "x");
  assert.equal(runStatusIcon({ status: "in_progress" }, "x").icon, "x");
  assert.notEqual(runStatusIcon({ status: "in_progress" }, null).icon, runStatusIcon({ status: "queued" }, null).icon);
});

test("severityRank() puts critical first and unknown last, total and stable", () => {
  assert.ok(severityRank("critical") < severityRank("high"));
  assert.ok(severityRank("high") < severityRank("medium"));
  assert.ok(severityRank("medium") < severityRank("low"));
  assert.ok(severityRank("low") < severityRank("unknown"));
  // An unrecognised value must sort with unknown, not to the top and not out.
  assert.equal(severityRank("brand-new"), severityRank("unknown"));
  assert.equal(severityRank("__proto__"), severityRank("unknown"));
  assert.equal(severityRank(undefined), severityRank("unknown"));
});

test("the two glyph tables are key-for-key identical and width-1", () => {
  // A missing key renders an empty cell -- the exact symptom the fallback
  // exists to fix.
  assert.deepEqual(Object.keys(OCT_NERD).sort(), Object.keys(OCT_UNICODE).sort());
  for (const [key, glyph] of Object.entries(OCT_UNICODE)) {
    assert.equal(Array.from(glyph).length, 1, `${key} must be a single cell`);
    assert.ok(glyph.codePointAt(0) < 128, `${key} must be ASCII, not East-Asian-Ambiguous`);
  }
  for (const [key, glyph] of Object.entries(OCT_NERD)) {
    assert.ok(glyph.length > 0, `${key} must not be empty`);
  }
});

test("the minimum-width guard is derived from the widest header", () => {
  const narrow = minimumWidthFor([{ label: "", props: { width: 3 } }]);
  const wide = minimumWidthFor([
    { label: "", props: { width: 3 } },
    { label: "X", props: { width: 12 } },
  ]);
  assert.ok(wide > narrow);
  // The measured collapse: at 52 columns the TITLE column rendered completely
  // empty while the frame still looked correct.
  assert.ok(MIN_TABLE_WIDTH > 52, `guard must exceed the observed silent-failure band (got ${MIN_TABLE_WIDTH})`);
  assert.ok(MIN_TABLE_WIDTH < 80, "must not reject an ordinary 80-column terminal");
});

const EXPECTED_COLUMN_GEOMETRY = {
  actions: {
    full: [
      ["status", { width: 3 }],
      ["title", { grow: true }],
      ["workflow", { width: 10 }],
      ["branch", { width: 14 }],
      ["time", { width: 7 }],
      ["updated", { width: 8 }],
    ],
    compact: [
      ["status", { width: 3 }],
      ["title", { grow: true }],
      ["updated", { width: 8 }],
    ],
  },
  issues: {
    full: [
      ["status", { width: 3 }],
      ["title", { grow: true }],
      ["author", { width: 12 }],
      ["label", { width: 14 }],
      ["updated", { width: 8 }],
    ],
    compact: [
      ["status", { width: 3 }],
      ["title", { grow: true }],
      ["updated", { width: 8 }],
    ],
  },
  prs: {
    full: [
      ["status", { width: 3 }],
      ["title", { grow: true }],
      ["author", { width: 12 }],
      ["branch", { width: 14 }],
      ["review", { width: 10 }],
      ["updated", { width: 8 }],
    ],
    compact: [
      ["status", { width: 3 }],
      ["title", { grow: true }],
      ["review", { width: 10 }],
    ],
  },
  security: {
    full: [
      ["status", { width: 3 }],
      ["severity", { width: 4 }],
      ["package", { width: 16 }],
      ["summary", { grow: true }],
      ["age", { width: 8 }],
    ],
    compact: [
      ["status", { width: 3 }],
      ["severity", { width: 4 }],
      ["summary", { grow: true }],
    ],
  },
};

const EXPECTED_ADJUSTABLE_COLUMNS = {
  actions: { workflow: 5, branch: 6, time: 5, updated: 6 },
  issues: { author: 6, label: 6, updated: 6 },
  prs: { author: 6, branch: 6, review: 7, updated: 6 },
  security: { package: 6, age: 6 },
};

const actionsHeader = TABS.find(({ key }) => key === "actions").header;
const actionsTab = TABS.find(({ key }) => key === "actions");
const actionsDividerMetrics = { x: 10, y: 7, width: 75, height: 2 };
const actionsDividerHandles = dividerHandles({
  header: actionsHeader,
  metrics: actionsDividerMetrics,
});

function geometry(columns) {
  return columns.map(({ key, props }) => [key, props]);
}

test("column descriptors have stable unique keys and the planned adjustable inventory", () => {
  assert.deepEqual(TABS.map(({ key }) => key), Object.keys(EXPECTED_COLUMN_GEOMETRY));

  for (const tab of TABS) {
    for (const columns of [tab.header, tab.compactHeader]) {
      const keys = columns.map(({ key }) => key);
      assert.ok(keys.every((key) => /^[a-z][a-z0-9]*$/.test(key)), `${tab.key}: invalid key`);
      assert.equal(new Set(keys).size, keys.length, `${tab.key}: duplicate column key`);
    }

    assert.deepEqual(
      tab.header
        .filter(({ adjustable }) => adjustable)
        .map(({ key, minWidth }) => [key, minWidth]),
      Object.entries(EXPECTED_ADJUSTABLE_COLUMNS[tab.key]),
      `${tab.key}: adjustable full columns or minima drifted`,
    );
    assert.ok(
      tab.compactHeader.every(({ adjustable }) => !adjustable),
      `${tab.key}: compact columns must remain locked`,
    );
  }
});

test("width selection exposes the exact adjustable inventory for every tab", () => {
  for (const tab of TABS) {
    assert.deepEqual(
      adjustableWidthKeys(tab),
      Object.keys(EXPECTED_ADJUSTABLE_COLUMNS[tab.key]),
      `${tab.key}: width-mode inventory drifted`,
    );
  }
});

test("width selection starts at the first adjustable key and remembers a valid key per tab", () => {
  const remembered = {
    actions: "time",
    issues: "label",
    prs: "updated",
    security: "age",
  };

  for (const tab of TABS) {
    const first = Object.keys(EXPECTED_ADJUSTABLE_COLUMNS[tab.key])[0];
    assert.equal(selectWidthKey(tab), first, `${tab.key}: first adjustable key`);
    assert.equal(
      selectWidthKey(tab, remembered[tab.key]),
      remembered[tab.key],
      `${tab.key}: remembered selection`,
    );
    assert.equal(
      selectWidthKey(tab, "status"),
      first,
      `${tab.key}: locked remembered key must fall back`,
    );
    assert.equal(
      selectWidthKey(tab, "missing"),
      first,
      `${tab.key}: missing remembered key must fall back`,
    );
  }

  assert.equal(selectWidthKey({ key: "compact", header: actionsTab.compactHeader }), null);
});

test("Tab and Shift+Tab width selection wrap only over adjustable keys", () => {
  for (const tab of TABS) {
    const keys = Object.keys(EXPECTED_ADJUSTABLE_COLUMNS[tab.key]);
    assert.equal(cycleWidthKey(tab, keys.at(-1), 1), keys[0], `${tab.key}: forward wrap`);
    assert.equal(cycleWidthKey(tab, keys[0], -1), keys.at(-1), `${tab.key}: reverse wrap`);
    for (let index = 0; index < keys.length; index += 1) {
      assert.equal(
        cycleWidthKey(tab, keys[index], 1),
        keys[(index + 1) % keys.length],
        `${tab.key}: forward from ${keys[index]}`,
      );
      assert.equal(
        cycleWidthKey(tab, keys[index], -1),
        keys[(index - 1 + keys.length) % keys.length],
        `${tab.key}: reverse from ${keys[index]}`,
      );
    }
  }

  const compactTab = { key: "compact", header: actionsTab.compactHeader };
  assert.equal(cycleWidthKey(compactTab, null, 1), null);
  assert.equal(cycleWidthKey(compactTab, null, -1), null);
});

test("empty overrides preserve the established full and compact geometry", () => {
  for (const tab of TABS) {
    const resolved = resolveHeader(tab.header, {});
    assert.deepEqual(geometry(resolved), EXPECTED_COLUMN_GEOMETRY[tab.key].full);
    assert.deepEqual(geometry(tab.compactHeader), EXPECTED_COLUMN_GEOMETRY[tab.key].compact);
    resolved.forEach((column, index) => {
      assert.strictEqual(column, tab.header[index], `${tab.key}.${column.key} was copied needlessly`);
    });
  }
});

test("resolving an override replaces only its adjustable descriptor", () => {
  const base = actionsHeader;
  const overrides = { branch: 18 };
  const resolved = resolveHeader(base, overrides);
  const branchIndex = base.findIndex(({ key }) => key === "branch");

  assert.deepEqual(columnProps(resolved, "branch"), { width: 18 });
  assert.notStrictEqual(resolved[branchIndex], base[branchIndex]);
  assert.notStrictEqual(resolved[branchIndex].props, base[branchIndex].props);
  resolved.forEach((column, index) => {
    if (index !== branchIndex) assert.strictEqual(column, base[index]);
  });
  assert.deepEqual(overrides, { branch: 18 });
});

test("locked and invalid overrides cannot escape the width contract", () => {
  const base = actionsHeader;

  for (const overrides of [
    { status: 20 },
    { title: 20 },
    { missing: 20 },
    { branch: 12.5 },
    { branch: Number.NaN },
    { branch: Number.POSITIVE_INFINITY },
  ]) {
    const resolved = resolveHeader(base, overrides);
    assert.deepEqual(geometry(resolved), EXPECTED_COLUMN_GEOMETRY.actions.full);
    resolved.forEach((column, index) => assert.strictEqual(column, base[index]));
  }

  for (const tab of TABS) {
    for (const [key, minWidth] of Object.entries(EXPECTED_ADJUSTABLE_COLUMNS[tab.key])) {
      assert.equal(columnProps(resolveHeader(tab.header, { [key]: 1 }), key).width, minWidth);
    }
  }
});

test("width helpers do not mutate descriptors, props, arrays, or overrides", () => {
  const base = actionsHeader;
  const baseBefore = structuredClone(base);
  const overrides = Object.freeze({ workflow: 12, branch: 18 });
  const overridesBefore = structuredClone(overrides);
  const preferred = resolveHeader(base, overrides);
  const preferredBefore = structuredClone(preferred);

  fitHeaderToFrame(preferred, base, 59);
  adjustWidth({ header: preferred, key: "branch", delta: 3, frameCols: 70 });

  assert.deepEqual(base, baseBefore);
  assert.deepEqual(preferred, preferredBefore);
  assert.deepEqual(overrides, overridesBefore);
});

const ROW_FIXTURES = {
  actions: {
    item: {
      status: "completed",
      conclusion: "success",
      startedAt: "2026-08-10T10:00:00Z",
      updatedAt: "2026-08-10T10:01:00Z",
      displayTitle: "Ship widths",
      number: 101,
      workflowName: "CI",
      headBranch: "develop",
    },
    spin: null,
  },
  issues: {
    item: {
      number: 102,
      title: "Resizable columns",
      author: "octocat",
      label: "enhancement",
      updatedAt: "2026-08-10T10:01:00Z",
    },
  },
  prs: {
    item: {
      number: 103,
      title: "Use descriptor widths",
      author: "octocat",
      headRefName: "feature/widths",
      reviewDecision: "APPROVED",
      updatedAt: "2026-08-10T10:01:00Z",
      isDraft: false,
    },
  },
  security: {
    item: {
      severity: "high",
      detail: "ink",
      kind: "dependabot",
      title: "Update dependency",
      createdAt: "2026-08-10T10:01:00Z",
    },
  },
};

test("every full and compact row consumes the selected descriptor geometry", () => {
  for (const tab of TABS) {
    for (const [layout, baseColumns] of [
      ["full", tab.header],
      ["compact", tab.compactHeader],
    ]) {
      const columns = baseColumns.map((column, index) => ({
        ...column,
        props: { width: 31 + index },
      }));
      const rendered = tab.Row.type({
        ...ROW_FIXTURES[tab.key],
        now: new Date("2026-08-10T10:02:00Z"),
        compact: layout === "compact",
        cursor: false,
        columns,
      });
      const children = Array.isArray(rendered.props.children)
        ? rendered.props.children
        : [rendered.props.children];

      assert.deepEqual(
        children.map(({ props }) => props.width),
        columns.map(({ props }) => props.width),
        `${tab.key}.${layout}: row geometry did not come from the selected descriptors`,
      );
      assert.ok(
        children.every(({ props }) => props.grow === undefined),
        `${tab.key}.${layout}: a private grow literal escaped the descriptor model`,
      );
    }
  }
});

test("resolved fixed widths remain the single source for the minimum-width guard", () => {
  const base = actionsHeader;
  const wider = resolveHeader(base, { branch: 18 });

  assert.equal(minimumWidthFor(base), 56);
  assert.equal(minimumWidthFor(wider), minimumWidthFor(base) + 4);
});

test("width adjustment clamps to the semantic minimum and current frame budget", () => {
  const base = actionsHeader;
  const atMinimum = adjustWidth({ header: base, key: "branch", delta: -100, frameCols: 80 });
  const atMaximum = adjustWidth({ header: base, key: "branch", delta: 100, frameCols: 60 });

  assert.equal(columnProps(atMinimum, "branch").width, 6);
  assert.equal(columnProps(atMaximum, "branch").width, 18);
  assert.equal(minimumWidthFor(atMaximum), 60, "the four-cell grow budget must remain intact");
  assert.strictEqual(
    adjustWidth({ header: atMinimum, key: "branch", delta: -1, frameCols: 80 }),
    atMinimum,
  );
  assert.strictEqual(
    adjustWidth({ header: atMaximum, key: "branch", delta: 1, frameCols: 60 }),
    atMaximum,
  );
  assert.strictEqual(adjustWidth({ header: base, key: "branch", delta: 0, frameCols: 80 }), base);
  assert.strictEqual(adjustWidth({ header: base, key: "title", delta: 1, frameCols: 80 }), base);
});

test("one-cell and five-cell width updates use the shared clamp and normalize deviations", () => {
  for (const delta of [1, 5, -1, -5]) {
    const effectiveHeader = actionsTab.header;
    const adjusted = adjustWidth({
      header: effectiveHeader,
      key: "workflow",
      delta,
      frameCols: 79,
    });
    const nextWidth = columnProps(adjusted, "workflow").width;
    const updated = updateWidthPreference({
      overrides: {},
      tab: actionsTab,
      key: "workflow",
      nextWidth,
      effectiveHeader,
      frameCols: 79,
    });

    assert.deepEqual(
      updated,
      nextWidth === columnProps(actionsTab.header, "workflow").width
        ? {}
        : { actions: { workflow: nextWidth } },
      `delta ${delta}`,
    );
  }

  const clampedHigh = updateWidthPreference({
    overrides: {},
    tab: actionsTab,
    key: "workflow",
    nextWidth: 100,
    effectiveHeader: actionsTab.header,
    frameCols: 60,
  });
  assert.deepEqual(clampedHigh, { actions: { workflow: 14 } });

  const clampedLow = updateWidthPreference({
    overrides: {},
    tab: actionsTab,
    key: "workflow",
    nextWidth: -100,
    effectiveHeader: actionsTab.header,
    frameCols: 79,
  });
  assert.deepEqual(clampedLow, { actions: { workflow: 5 } });
});

test("width preference updates delete defaults and preserve unrelated deviations", () => {
  const issues = Object.freeze({ author: 9 });
  const overrides = Object.freeze({
    actions: Object.freeze({ workflow: 15, branch: 18 }),
    issues,
  });
  const effectiveHeader = resolveHeader(actionsTab.header, overrides.actions);

  const updated = updateWidthPreference({
    overrides,
    tab: actionsTab,
    key: "workflow",
    nextWidth: 10,
    effectiveHeader,
    frameCols: 79,
  });

  assert.deepEqual(updated, {
    actions: { branch: 18 },
    issues: { author: 9 },
  });
  assert.strictEqual(updated.issues, issues, "an untouched tab must retain nested identity");
  assert.deepEqual(overrides, {
    actions: { workflow: 15, branch: 18 },
    issues: { author: 9 },
  });

  const lastDeviation = updateWidthPreference({
    overrides: { actions: { workflow: 15 }, issues },
    tab: actionsTab,
    key: "workflow",
    nextWidth: 10,
    effectiveHeader: resolveHeader(actionsTab.header, { workflow: 15 }),
    frameCols: 79,
  });
  assert.deepEqual(lastDeviation, { issues: { author: 9 } });
  assert.strictEqual(lastDeviation.issues, issues);
});

test("selected and tab resets remove only their intended deviations", () => {
  const issues = Object.freeze({ author: 9 });
  const overrides = Object.freeze({
    actions: Object.freeze({ workflow: 15, branch: 18 }),
    issues,
  });

  const selectedReset = resetWidthPreference(overrides, "actions", "workflow");
  assert.deepEqual(selectedReset, {
    actions: { branch: 18 },
    issues: { author: 9 },
  });
  assert.strictEqual(selectedReset.issues, issues);

  const lastSelectedReset = resetWidthPreference(selectedReset, "actions", "branch");
  assert.deepEqual(lastSelectedReset, { issues: { author: 9 } });
  assert.strictEqual(lastSelectedReset.issues, issues);

  const tabReset = resetTabWidthPreferences(overrides, "actions");
  assert.deepEqual(tabReset, { issues: { author: 9 } });
  assert.strictEqual(tabReset.issues, issues);
  assert.deepEqual(overrides, {
    actions: { workflow: 15, branch: 18 },
    issues: { author: 9 },
  });
});

test("locked, compact, missing, unsafe, and clamped width operations preserve identity", () => {
  const overrides = Object.freeze({ actions: Object.freeze({ workflow: 5 }) });
  const atMinimum = resolveHeader(actionsTab.header, overrides.actions);

  for (const operation of [
    () =>
      updateWidthPreference({
        overrides,
        tab: actionsTab,
        key: "status",
        nextWidth: 20,
        effectiveHeader: atMinimum,
        frameCols: 79,
      }),
    () =>
      updateWidthPreference({
        overrides,
        tab: actionsTab,
        key: "missing",
        nextWidth: 20,
        effectiveHeader: atMinimum,
        frameCols: 79,
      }),
    () =>
      updateWidthPreference({
        overrides,
        tab: actionsTab,
        key: "workflow",
        nextWidth: 4,
        effectiveHeader: atMinimum,
        frameCols: 79,
      }),
    () =>
      updateWidthPreference({
        overrides,
        tab: actionsTab,
        key: "workflow",
        nextWidth: 5.5,
        effectiveHeader: atMinimum,
        frameCols: 79,
      }),
    () =>
      updateWidthPreference({
        overrides,
        tab: actionsTab,
        key: "workflow",
        nextWidth: 20,
        effectiveHeader: actionsTab.compactHeader,
        frameCols: 44,
      }),
    () => resetWidthPreference(overrides, "actions", "status"),
    () => resetWidthPreference(overrides, "actions", "missing"),
    () => resetWidthPreference(overrides, "issues", "author"),
    () => resetTabWidthPreferences(overrides, "issues"),
    () => resetTabWidthPreferences(overrides, "missing"),
  ]) {
    assert.strictEqual(operation(), overrides);
  }
});

test("fitting preserves preferred identity, shrinks above defaults in order, or returns null", () => {
  const defaults = actionsHeader;
  const preferred = resolveHeader(defaults, { workflow: 12, branch: 18 });

  assert.strictEqual(fitHeaderToFrame(preferred, defaults, 62), preferred);

  const fitted = fitHeaderToFrame(preferred, defaults, 59);
  assert.equal(minimumWidthFor(fitted), 59);
  assert.equal(columnProps(fitted, "workflow").width, 10);
  assert.equal(columnProps(fitted, "branch").width, 17);
  assert.deepEqual(
    geometry(fitHeaderToFrame(preferred, defaults, 56)),
    EXPECTED_COLUMN_GEOMETRY.actions.full,
  );
  assert.equal(fitHeaderToFrame(preferred, defaults, 55), null);
});

test("fitting never widens a preference below its default", () => {
  const defaults = actionsHeader;
  const preferred = resolveHeader(defaults, { workflow: 20, branch: 8 });
  const fitted = fitHeaderToFrame(preferred, defaults, 58);

  assert.equal(minimumWidthFor(fitted), 58);
  assert.equal(columnProps(fitted, "workflow").width, 18);
  assert.equal(columnProps(fitted, "branch").width, 8);
});

test("width-mode status variants stay bounded and use ASCII control glyphs", () => {
  for (const cols of [79, 60, 44, 32, 20, 8, 1, 0]) {
    const status = widthStatusText({ label: "WORKFLOW", width: 11, cols });
    assert.ok([...status].length <= Math.max(0, cols), `${cols}: ${JSON.stringify(status)}`);
    assert.match(status, /^[\x20-\x7e]*$/, `${cols}: status must be ASCII-only`);
    assert.ok(!/[←→↑↓]/.test(status), `${cols}: ambiguous-width arrow escaped`);
  }

  for (const cols of [79, 60, 44]) {
    const status = widthStatusText({ label: "WORKFLOW", width: 11, cols });
    assert.match(status, /WORKFLOW/);
    assert.match(status, /11/);
    assert.match(status, /<-/);
    assert.match(status, /->/);
    assert.match(status, /\br\b/);
    assert.match(status, /Esc/);
  }
});

test("width-mode status surfaces a bounded nonfatal save warning", () => {
  for (const cols of [79, 60, 44, 20, 8, 1, 0]) {
    const status = widthStatusText({
      label: "PACKAGE / FILE",
      width: 16,
      cols,
      saveError: new Error("read-only filesystem"),
    });
    assert.ok([...status].length <= Math.max(0, cols), `${cols}: ${JSON.stringify(status)}`);
    assert.match(status, /^[\x20-\x7e]*$/, `${cols}: warning must be ASCII-only`);
    if (cols >= "Widths not saved".length) assert.match(status, /Widths not saved/);
  }
});

const EXPECTED_HEADER_GUTTER_OWNERS = {
  actions: [null, "workflow", "branch", "time", "updated", null],
  issues: [null, "author", "label", "updated", null],
  prs: [null, "author", "branch", "review", "updated", null],
  security: [null, null, "package", "age", null],
};

test("header gutters belong to the adjustable edge facing the grow reservoir", () => {
  for (const tab of TABS) {
    assert.deepEqual(
      tab.header.map((_, index) => headerGutterKey(tab.header, index)),
      EXPECTED_HEADER_GUTTER_OWNERS[tab.key],
      tab.key,
    );
    assert.deepEqual(
      tab.compactHeader.map((_, index) => headerGutterKey(tab.compactHeader, index)),
      tab.compactHeader.map(() => null),
      `${tab.key}: compact gutters must stay locked`,
    );
  }
});

test("HeaderCells draws grips inside the existing one-cell gutters without changing geometry", () => {
  for (const tab of TABS) {
    const selectedWidthKey = adjustableWidthKeys(tab)[0];
    const rendered = HeaderCells({ cells: tab.header, selectedWidthKey });
    const children = Array.isArray(rendered.props.children)
      ? rendered.props.children
      : [rendered.props.children];

    assert.equal(children.length, tab.header.length * 2, `${tab.key}: content/gutter pairs`);
    let expectedFixedWidth = 0;
    let renderedFixedWidth = 0;
    for (let index = 0; index < tab.header.length; index += 1) {
      const descriptor = tab.header[index];
      const content = children[index * 2];
      const gutter = children[index * 2 + 1];
      const owner = headerGutterKey(tab.header, index);
      const gutterText = gutter.props.children;

      assert.deepEqual(
        { width: content.props.width, grow: content.props.grow },
        { width: descriptor.props.width, grow: descriptor.props.grow },
        `${tab.key}.${descriptor.key}: content geometry`,
      );
      assert.equal([...gutterText].length, 1, `${tab.key}.${descriptor.key}: gutter width`);
      assert.equal(gutterText, owner === null ? " " : "│", `${tab.key}.${descriptor.key}: grip`);
      assert.equal(
        Boolean(gutter.props.bold),
        owner === selectedWidthKey,
        `${tab.key}.${descriptor.key}: selected grip styling`,
      );

      expectedFixedWidth += (descriptor.props.width ?? 0) + 1;
      renderedFixedWidth += (content.props.width ?? 0) + [...gutterText].length;
    }
    assert.equal(renderedFixedWidth, expectedFixedWidth, `${tab.key}: fixed geometry changed`);

    const compactRendered = HeaderCells({
      cells: tab.compactHeader,
      selectedWidthKey,
    });
    const compactChildren = Array.isArray(compactRendered.props.children)
      ? compactRendered.props.children
      : [compactRendered.props.children];
    assert.equal(compactChildren.length, tab.compactHeader.length * 2);
    assert.ok(
      compactChildren
        .filter((_, index) => index % 2 === 1)
        .every((gutter) => gutter.props.children === " "),
      `${tab.key}: compact header unexpectedly rendered a grip`,
    );
  }
});

test("SGR mouse parsing accepts only unmodified left-button press, drag, and release reports", () => {
  assert.deepEqual(parseSgrMouse("[<0;1;1M"), { x: 0, y: 0, action: "press" });
  assert.deepEqual(parseSgrMouse("[<32;41;7M"), { x: 40, y: 6, action: "drag" });
  assert.deepEqual(parseSgrMouse("[<0;41;7m"), { x: 40, y: 6, action: "release" });

  for (const input of [
    "",
    "mouse",
    `${ESC}[<0;1;1M`,
    "[<0;0;1M",
    "[<0;1;0M",
    "[<0;-1;1M",
    "[<0;1;-1M",
    "[<0;1;1",
    "[<0;1;1X",
    "[<0;1.5;1M",
    "[<0;1;1.5M",
    "[<1;1;1M",
    "[<2;1;1M",
    "[<4;1;1M",
    "[<8;1;1M",
    "[<16;1;1M",
    "[<33;1;1M",
    "[<36;1;1M",
    "[<64;1;1M",
    "[<65;1;1M",
    "[<9007199254740992;1;1M",
    "[<0;9007199254740992;1M",
    "[<0;1;9007199254740992M",
  ]) {
    assert.equal(parseSgrMouse(input), null, input);
  }
});

test("divider handles follow live header geometry and each adjustable gutter's ownership", () => {
  assert.deepEqual(
    actionsDividerHandles,
    [
      { key: "workflow", x: 41, yStart: 7, yEnd: 9, width: 10, direction: -1 },
      { key: "branch", x: 52, yStart: 7, yEnd: 9, width: 14, direction: -1 },
      { key: "time", x: 67, yStart: 7, yEnd: 9, width: 7, direction: -1 },
      { key: "updated", x: 75, yStart: 7, yEnd: 9, width: 8, direction: -1 },
    ],
  );

  const securityHeader = TABS.find(({ key }) => key === "security").header;
  assert.deepEqual(
    dividerHandles({
      header: securityHeader,
      metrics: { x: 5, y: 11, width: 60, height: 2 },
    }),
    [
      { key: "package", x: 30, yStart: 11, yEnd: 13, width: 16, direction: 1 },
      { key: "age", x: 55, yStart: 11, yEnd: 13, width: 8, direction: -1 },
    ],
  );

  assert.deepEqual(
    dividerHandles({
      header: actionsTab.compactHeader,
      metrics: { x: 0, y: 0, width: 45, height: 2 },
    }),
    [],
  );
  for (const metrics of [null, {}, { x: 0, y: 0, width: 0, height: 2 }]) {
    assert.deepEqual(dividerHandles({ header: actionsHeader, metrics }), []);
  }
});

test("divider hit-testing is bounded, tolerant, and deterministically chooses the nearest handle", () => {
  const workflow = actionsDividerHandles[0];

  for (const x of [workflow.x - 1, workflow.x, workflow.x + 1]) {
    assert.equal(hitDivider(actionsDividerHandles, { x, y: 7 }), workflow);
    assert.equal(hitDivider(actionsDividerHandles, { x, y: 8 }), workflow);
  }
  assert.equal(hitDivider(actionsDividerHandles, { x: workflow.x - 2, y: 7 }), null);
  assert.equal(hitDivider(actionsDividerHandles, { x: workflow.x + 2, y: 7 }), null);
  assert.equal(hitDivider(actionsDividerHandles, { x: workflow.x, y: 6 }), null);
  assert.equal(hitDivider(actionsDividerHandles, { x: workflow.x, y: 9 }), null);
  assert.equal(hitDivider(actionsDividerHandles, { x: workflow.x + 2, y: 7 }, 2), workflow);

  const tied = [
    { key: "right", x: 12, yStart: 2, yEnd: 4, width: 5, direction: -1 },
    { key: "left", x: 10, yStart: 2, yEnd: 4, width: 5, direction: -1 },
  ];
  assert.equal(hitDivider(tied, { x: 11, y: 2 }).key, "left");
  assert.equal(hitDivider([], { x: 0, y: 0 }), null);
  assert.equal(hitDivider(actionsDividerHandles, null), null);
});

test("a divider press snapshots the drag origin and rejects unsupported starts", () => {
  assert.deepEqual(
    beginDividerDrag({
      event: { x: 41, y: 7, action: "press" },
      handles: actionsDividerHandles,
      tabKey: "actions",
    }),
    {
      tabKey: "actions",
      key: "workflow",
      startX: 41,
      startWidth: 10,
      direction: -1,
    },
  );
  assert.deepEqual(
    beginDividerDrag({
      event: { x: 43, y: 7, action: "press" },
      handles: actionsDividerHandles,
      tabKey: "actions",
      tolerance: 2,
    }),
    {
      tabKey: "actions",
      key: "workflow",
      startX: 43,
      startWidth: 10,
      direction: -1,
    },
  );

  for (const event of [
    null,
    { x: 41, y: 7, action: "drag" },
    { x: 41, y: 7, action: "release" },
    { x: 0, y: 0, action: "press" },
  ]) {
    assert.equal(
      beginDividerDrag({ event, handles: actionsDividerHandles, tabKey: "actions" }),
      null,
    );
  }
});

test("drag widths derive from the press snapshot and the divider growth direction", () => {
  const afterGrow = {
    tabKey: "actions",
    key: "workflow",
    startX: 41,
    startWidth: 10,
    direction: -1,
  };
  assert.deepEqual(
    draggedWidth({
      drag: afterGrow,
      event: { x: 44, y: 7, action: "drag" },
      tabKey: "actions",
      fullHeaderVisible: true,
    }),
    { key: "workflow", nextWidth: 7 },
  );
  assert.deepEqual(
    draggedWidth({
      drag: afterGrow,
      event: { x: 38, y: 7, action: "drag" },
      tabKey: "actions",
      fullHeaderVisible: true,
    }),
    { key: "workflow", nextWidth: 13 },
  );
  assert.deepEqual(
    draggedWidth({
      drag: afterGrow,
      event: { x: 43, y: 7, action: "drag" },
      tabKey: "actions",
      fullHeaderVisible: true,
    }),
    { key: "workflow", nextWidth: 8 },
    "repeated reports must remain relative to the original press snapshot",
  );

  const beforeGrow = {
    tabKey: "security",
    key: "package",
    startX: 30,
    startWidth: 16,
    direction: 1,
  };
  assert.deepEqual(
    draggedWidth({
      drag: beforeGrow,
      event: { x: 33, y: 11, action: "drag" },
      tabKey: "security",
      fullHeaderVisible: true,
    }),
    { key: "package", nextWidth: 19 },
  );

  for (const input of [
    { drag: null, event: { x: 44, y: 7, action: "drag" }, tabKey: "actions", fullHeaderVisible: true },
    { drag: afterGrow, event: null, tabKey: "actions", fullHeaderVisible: true },
    { drag: afterGrow, event: { x: 44, y: 7, action: "press" }, tabKey: "actions", fullHeaderVisible: true },
    { drag: afterGrow, event: { x: 44, y: 7, action: "release" }, tabKey: "actions", fullHeaderVisible: true },
    { drag: afterGrow, event: { x: 44, y: 7, action: "drag" }, tabKey: "issues", fullHeaderVisible: true },
    { drag: afterGrow, event: { x: 44, y: 7, action: "drag" }, tabKey: "actions", fullHeaderVisible: false },
    { drag: afterGrow, event: { x: 44, y: 7, action: "drag" }, tabKey: "actions", fullHeaderVisible: true, layoutValid: false },
  ]) {
    assert.equal(draggedWidth(input), null);
  }
});

test("terminal mouse lifecycle transitions are idempotent and restore disables reporting first", () => {
  const writes = [];
  const terminal = createTerminalLifecycle((chunk) => writes.push(chunk));

  assert.equal(terminal.isMouseReportingEnabled(), false);
  assert.equal(terminal.disableMouseReporting(), false);
  assert.equal(writes.join(""), "");

  assert.equal(terminal.enableMouseReporting(), true);
  assert.equal(terminal.enableMouseReporting(), false);
  assert.equal(terminal.isMouseReportingEnabled(), true);
  assert.equal(writes.join(""), `${ESC}[?1002h${ESC}[?1006h`);

  assert.equal(terminal.disableMouseReporting(), true);
  assert.equal(terminal.disableMouseReporting(), false);
  assert.equal(terminal.isMouseReportingEnabled(), false);
  assert.equal(
    writes.join(""),
    `${ESC}[?1002h${ESC}[?1006h${ESC}[?1002l${ESC}[?1006l`,
  );

  assert.equal(terminal.enableMouseReporting(), true);
  assert.equal(terminal.restoreScreen(), true);
  assert.equal(terminal.restoreScreen(), false);
  assert.equal(terminal.enableMouseReporting(), false);
  assert.equal(terminal.isMouseReportingEnabled(), false);
  assert.equal(
    writes.join(""),
    `${ESC}[?1002h${ESC}[?1006h${ESC}[?1002l${ESC}[?1006l` +
      `${ESC}[?1002h${ESC}[?1006h${ESC}[?1002l${ESC}[?1006l${ESC}[?25h${ESC}[?1049l`,
  );
});

test("width preference paths prefer an absolute XDG root on every supported platform", () => {
  const root = join("/tmp", "gh-glance-xdg");
  const expected = join(root, "gh-glance", "preferences.json");

  for (const platform of ["darwin", "linux"]) {
    assert.equal(
      widthPreferencesPath({
        env: { XDG_CONFIG_HOME: root },
        platform,
        home: join("/home", "ignored"),
      }),
      expected,
    );
  }
});

test("width preference paths use platform fallbacks for empty or relative XDG roots", () => {
  const macHome = join("/Users", "octocat");
  const linuxHome = join("/home", "octocat");

  for (const xdg of [undefined, "", "relative/config"]) {
    const env = xdg === undefined ? {} : { XDG_CONFIG_HOME: xdg };
    assert.equal(
      widthPreferencesPath({ env, platform: "darwin", home: macHome }),
      join(macHome, "Library", "Application Support", "gh-glance", "preferences.json"),
    );
    assert.equal(
      widthPreferencesPath({ env, platform: "linux", home: linuxHome }),
      join(linuxHome, ".config", "gh-glance", "preferences.json"),
    );
  }
});

test("width preference parsing accepts only known versioned adjustable widths", () => {
  const parsed = parseWidthPreferences(`{
    "version": ${WIDTH_PREFERENCES_VERSION},
    "tabs": {
      "security": {"package": 20, "age": 5, "severity": 30, "constructor": 30},
      "actions": {"workflow": 5, "branch": 18, "time": 4, "status": 30, "__proto__": 30},
      "issues": {"author": 6, "label": 6, "updated": 9007199254740992},
      "prs": {"review": 7, "branch": 6.5},
      "unknown": {"branch": 99},
      "__proto__": {"branch": 99}
    }
  }`);

  assert.deepEqual(parsed, {
    actions: { workflow: 5, branch: 18 },
    issues: { author: 6, label: 6 },
    prs: { review: 7 },
    security: { package: 20 },
  });
  assert.equal(Object.hasOwn(parsed, "__proto__"), false);
  assert.equal(Object.hasOwn(parsed.actions, "__proto__"), false);
});

test("width preference parsing treats malformed, unknown, and wrong-shaped documents as empty", () => {
  for (const raw of [
    "not json",
    "null",
    "[]",
    "{}",
    '{"version":2,"tabs":{"actions":{"branch":18}}}',
    '{"version":1,"tabs":null}',
    '{"version":1,"tabs":[]}',
    '{"version":1,"tabs":{"actions":null}}',
    '{"version":1,"tabs":{"actions":[]}}',
    '{"version":1,"tabs":{"actions":{"branch":"18"}}}',
  ]) {
    assert.deepEqual(parseWidthPreferences(raw), {}, raw);
  }
});

test("width preference serialization stores only ordered deviations and a trailing newline", () => {
  const overrides = Object.freeze({
    security: Object.freeze({ package: 16, age: 9 }),
    unknown: Object.freeze({ branch: 99 }),
    issues: Object.freeze({ author: 5, updated: 8, label: 6 }),
    actions: Object.freeze({
      workflow: 10,
      updated: 9,
      branch: 18,
      time: Number.NaN,
      title: 30,
    }),
  });

  assert.equal(
    serializeWidthPreferences(overrides),
    `{
  "version": 1,
  "tabs": {
    "actions": {
      "branch": 18,
      "updated": 9
    },
    "issues": {
      "label": 6
    },
    "security": {
      "age": 9
    }
  }
}
`,
  );
});

test("width preference parse and serialization round-trip stably without mutation", () => {
  const overrides = Object.freeze({
    actions: Object.freeze({ workflow: 7, branch: 18 }),
    issues: Object.freeze({ author: 9 }),
  });
  const before = structuredClone(overrides);

  const serialized = serializeWidthPreferences(overrides);
  const parsed = parseWidthPreferences(serialized);

  assert.deepEqual(parsed, before);
  assert.equal(serializeWidthPreferences(parsed), serialized);
  assert.deepEqual(overrides, before);
});

test("width preference writer coalesces trailing schedules to the latest state", async () => {
  const writes = [];
  const completed = deferred();
  const writer = createWidthPreferenceWriter({
    delay: 5,
    write: (value) => {
      writes.push(value);
      return { ok: true };
    },
    onResult: completed.resolve,
  });
  const first = { actions: { branch: 15 } };
  const latest = { actions: { branch: 18 } };

  writer.schedule(first);
  writer.schedule(latest);
  assert.deepEqual(await within(completed.promise), { ok: true });
  assert.deepEqual(writes, [latest]);

  await writer.dispose();
  assert.deepEqual(writes, [latest], "dispose must not repeat an already-clean write");
});

test("width preference writer flushes latest state once and dispose flushes dirty state", async () => {
  const writes = [];
  const results = [];
  const writer = createWidthPreferenceWriter({
    delay: 60_000,
    write: (value) => {
      writes.push(value);
      return { ok: true };
    },
    onResult: (result) => results.push(result),
  });
  const first = { actions: { workflow: 11 } };
  const latest = { actions: { workflow: 12 } };

  writer.schedule(first);
  writer.schedule(latest);
  await writer.flush();
  await writer.flush();
  assert.deepEqual(writes, [latest]);
  assert.deepEqual(results, [{ ok: true }]);

  const disposeWriter = createWidthPreferenceWriter({
    delay: 60_000,
    write: (value) => {
      writes.push(value);
      return { ok: true };
    },
    onResult: (result) => results.push(result),
  });
  const onDispose = { security: { package: 20 } };
  disposeWriter.schedule(onDispose);
  await disposeWriter.dispose();
  assert.deepEqual(writes, [latest, onDispose]);
  assert.deepEqual(results, [{ ok: true }, { ok: true }]);
});

test("width preference writer converts synchronous throws and rejections into result state", async () => {
  for (const [label, write] of [
    [
      "throw",
      () => {
        throw new Error("disk threw");
      },
    ],
    ["rejection", async () => Promise.reject(new Error("disk rejected"))],
  ]) {
    const results = [];
    const writer = createWidthPreferenceWriter({
      delay: 60_000,
      write,
      onResult: (result) => results.push(result),
    });
    writer.schedule({ actions: { branch: 18 } });

    await writer.flush();

    assert.equal(results.length, 1, label);
    assert.equal(results[0].ok, false, label);
    assert.ok(results[0].error instanceof Error, label);
    await writer.dispose();
  }
});

test("a failed width preference flush remains pending for a later retry", async () => {
  const value = { actions: { branch: 18 } };
  const writes = [];
  const results = [];
  const failure = new Error("temporary write failure");
  const writer = createWidthPreferenceWriter({
    delay: 60_000,
    write: (received) => {
      writes.push(received);
      return writes.length === 1 ? { ok: false, error: failure } : { ok: true };
    },
    onResult: (result) => results.push(result),
  });

  writer.schedule(value);
  assert.deepEqual(await writer.flush(), { ok: false, error: failure });
  assert.deepEqual(await writer.flush(), { ok: true });

  assert.deepEqual(writes, [value, value]);
  assert.deepEqual(results, [{ ok: false, error: failure }, { ok: true }]);
  await writer.dispose();
  assert.deepEqual(writes, [value, value], "a successful retry must leave the writer clean");
});

test("dispose retries the latest state after an earlier write failure", async () => {
  const initial = { actions: { branch: 18 } };
  const latest = { actions: { branch: 20 } };
  const writes = [];
  const results = [];
  const failure = new Error("first write failed");
  const writer = createWidthPreferenceWriter({
    delay: 60_000,
    write: (value) => {
      writes.push(value);
      return writes.length === 1 ? { ok: false, error: failure } : { ok: true };
    },
    onResult: (result) => results.push(result),
  });

  writer.schedule(initial);
  await writer.flush();
  writer.schedule(latest);
  await writer.dispose();

  assert.deepEqual(writes, [initial, latest]);
  assert.deepEqual(results, [{ ok: false, error: failure }, { ok: true }]);
});

test("overlapping asynchronous width preference writes are serialized in schedule order", async () => {
  const first = deferred();
  const second = deferred();
  const initial = { actions: { branch: 18 } };
  const latest = { actions: { branch: 20 } };
  const writes = [];
  const results = [];
  const writer = createWidthPreferenceWriter({
    delay: 60_000,
    write: (value) => {
      writes.push(value);
      return writes.length === 1 ? first.promise : second.promise;
    },
    onResult: (result) => results.push(result),
  });

  writer.schedule(initial);
  const firstFlush = writer.flush();
  writer.schedule(latest);
  const overlappingFlush = writer.flush();

  assert.deepEqual(writes, [initial], "the second write must wait for the first to settle");
  assert.deepEqual(results, []);

  first.resolve({ ok: true, id: "initial" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(writes, [initial, latest]);
  assert.deepEqual(results, [], "a superseded completion must not report stale result state");

  second.resolve({ ok: true, id: "latest" });
  await within(Promise.all([firstFlush, overlappingFlush]));
  assert.deepEqual(results, [{ ok: true, id: "latest" }]);
  await writer.dispose();
});

test("concurrent width preference flushes share one in-flight write", async () => {
  const pending = deferred();
  const value = { issues: { author: 9 } };
  const writes = [];
  const results = [];
  const writer = createWidthPreferenceWriter({
    delay: 60_000,
    write: (received) => {
      writes.push(received);
      return pending.promise;
    },
    onResult: (result) => results.push(result),
  });

  writer.schedule(value);
  const flushes = [writer.flush(), writer.flush(), writer.flush()];
  assert.deepEqual(writes, [value]);

  pending.resolve({ ok: true });
  const flushResults = await within(Promise.all(flushes));

  assert.deepEqual(writes, [value]);
  assert.deepEqual(results, [{ ok: true }]);
  assert.deepEqual(flushResults, [{ ok: true }, { ok: true }, { ok: true }]);
  await writer.dispose();
});

test("importing the app selects React's production build", async () => {
  // Guards a fix that already cost one fatal OOM. React's development build
  // records a PerformanceMeasure on every render and never releases them, which
  // killed a long-running dashboard after roughly 90 minutes; the fix is the
  // `process.env.NODE_ENV ??= "production"` on index.mjs's first line.
  //
  // It rests on two invariants nothing else checks. Line 23 must stay first, and
  // react/ink must stay *dynamic* imports -- ES import declarations are hoisted
  // and evaluated before any module-body statement, so a single innocuous
  // `import { Box } from "ink"` at the top would load React before line 23 runs
  // and silently select the development build. Asserting NODE_ENV is not enough,
  // because line 23 sets it either way by the time the import settles; the build
  // that actually loaded is the thing worth asserting.
  //
  // The discriminator is the size of React's client internals object: 4 keys in
  // production, 12 in development (react 19.2.8). If a React upgrade changes the
  // production shape this fails loudly here rather than silently in a user's
  // terminal three hours in, which is the right place for that surprise.
  // Imported dynamically, and deliberately not at the top of this file: a static
  // `import React from "react"` is hoisted above the index.mjs import and would
  // load react first, making this test fail for its own reason rather than the
  // app's. Which is a fair demonstration of how easy the real regression is.
  const React = (await import("react")).default;
  const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  assert.ok(internals, "React client internals missing -- check the discriminator, not the app");
  assert.equal(
    Object.keys(internals).length,
    4,
    "React loaded its development build: NODE_ENV was read after react, " +
      "or a static react/ink import was added above index.mjs's NODE_ENV default",
  );
});

test("safe() strips bidi overrides without disturbing legitimate text", () => {
  // A row must never display something other than its data. The C0 strip already
  // closed the CR/LF/ESC versions of that; U+202A-U+202E and U+2066-U+2069 are
  // the same attack by another route, and ink measures them as zero columns, so
  // they cost no width and survived truncation untouched.
  assert.equal(safe("harmless‮gnp.exe"), "harmlessgnp.exe");
  assert.equal(safe("a⁦b⁩c"), "abc");
  // Deleted, not replaced with a space: they measure zero, so substituting a
  // space would ADD a visible column and shift every cell to its right.
  assert.equal(Array.from(safe("ab‮cd")).length, 4);
  // The things that must survive -- a sanitizer that ate these would be a worse
  // bug than the one it fixes: real RTL, LRM, emoji, ZWJ sequences, CJK.
  assert.equal(safe("مرحبا bug"), "مرحبا bug");
  assert.equal(safe("a‎b"), "a‎b");
  assert.equal(safe("ship \u{1F680}"), "ship \u{1F680}");
  assert.equal(safe("\u{1F468}‍\u{1F469}‍\u{1F467}"), "\u{1F468}‍\u{1F469}‍\u{1F467}");
  assert.equal(safe("修复错误"), "修复错误");
});

test("safe() sanitizes values that are not strings", () => {
  // It used to return early for anything non-string, skipping both the control
  // strip and the clamp -- so the guarantee was really being provided by
  // GitHub's schema rather than by this function.
  assert.equal(safe(["x[2Jy"]), "x [2Jy");
  assert.equal(safe(null), "");
  assert.equal(safe(undefined), "");
  assert.equal(safe(5), "5");
});

test("REPO_PATTERN rejects dot segments but keeps real repository names", () => {
  // `owner/..` reached apiPath() and produced `repos/owner/../dependabot/alerts`;
  // gh forwards the dot segment unnormalized and GitHub resolves it server-side
  // to a different endpoint entirely.
  for (const bad of ["owner/..", "owner/.", "owner/...", "owner/x.git"]) {
    assert.ok(!REPO_PATTERN.test(bad), `${bad} must be rejected`);
  }
  // Dots are legal inside names -- .github is a real and widely used repository,
  // and over-tightening here would be a worse bug than the one being fixed.
  for (const good of ["cli/cli", "owner/.github", "owner/docs.example.com", "o/a.b.c"]) {
    assert.ok(REPO_PATTERN.test(good), `${good} must be accepted`);
  }
});

test("every verdict with a remedy also has a backoff ladder, and vice versa", () => {
  // The two tables are read together on every failure: one picks what the user
  // is told, the other picks how hard we keep asking. A verdict in one and not
  // the other means a tab that either explains itself and then hammers, or backs
  // off in silence. "other" is in neither, deliberately -- an unclassified
  // failure shows its real message and retries on the next tick.
  assert.deepEqual(Object.keys(VERDICT_REMEDY).sort(), Object.keys(FAILURE_LADDER).sort());
  assert.ok(!("other" in VERDICT_REMEDY));
  assert.ok(!("ok" in FAILURE_LADDER));
  // Short and flat: a rate limit clears on GitHub's own schedule, so the
  // hour-long unavailable ladder would leave the pane blank long after the cause
  // was gone.
  assert.equal(RATE_LIMIT_RETRY_MS.length, 1);
  assert.ok(RATE_LIMIT_RETRY_MS[0] <= BACKOFF_STEPS_MS[0]);
});

test("the per-fetch cost tables cover every tab and nothing else", () => {
  assert.deepEqual(Object.keys(REST_PER_FETCH).sort(), [...TAB_KEYS].sort());
  assert.deepEqual(Object.keys(GRAPHQL_PER_FETCH).sort(), [...TAB_KEYS].sort());
});

test("an actions fetch costs two REST calls", () => {
  // Measured 2026-08-10: gh run list issues /actions/runs and
  // /actions/workflows. Pinned because the adaptive throttle budgets against it.
  assert.equal(REST_PER_FETCH.actions, 2);
});

test("issues and prs cost no REST and two GraphQL, because --search routes them", () => {
  for (const key of ["issues", "prs"]) {
    assert.equal(REST_PER_FETCH[key], 0, key);
    assert.equal(GRAPHQL_PER_FETCH[key], 2, key);
  }
});

test("security costs one bounded request per newest and priority lane", () => {
  assert.equal(REST_PER_FETCH.security, 6);
  assert.ok(REST_PER_FETCH.security > ALERT_SOURCES.length);
});

test("projected hourly cost, per active tab, at the default refresh", () => {
  // runtime.refreshMs is REFRESH_MS on an imported module (the argv block is
  // gated on IS_MAIN), so these are the default-refresh figures.
  assert.deepEqual(projectedHourlyCost("actions"), { rest: 1800, graphql: 240 });
  assert.deepEqual(projectedHourlyCost("issues"), { rest: 480, graphql: 1560 });
  assert.deepEqual(projectedHourlyCost("prs"), { rest: 480, graphql: 1560 });
  assert.deepEqual(projectedHourlyCost("security"), { rest: 4440, graphql: 240 });
});

const POLICY_NOW = 1_000_000;
const policyBudget = (overrides = {}) => ({
  limit: 5000,
  remaining: 5000,
  used: 0,
  resetMs: POLICY_NOW + 3_600_000,
  observedAt: POLICY_NOW,
  ...overrides,
});
const policyLease = (
  seed,
  expiresAt = POLICY_NOW + GOVERNOR_LEASE_TTL_MS,
  registeredAt = POLICY_NOW,
) => ({
  expiresAt,
  phaseSeed: { seed, registeredAt },
});

test("the governor timing and reserve constants pin the policy contract", () => {
  assert.equal(BUDGET_RESERVE_FRACTION, 1 - BUDGET_SAFETY);
  assert.equal(BUDGET_SNAPSHOT_TTL_MS, 65_000);
  assert.equal(GOVERNOR_HEARTBEAT_MS, 20_000);
  assert.equal(GOVERNOR_LEASE_TTL_MS, 90_000);
  assert.equal(GOVERNOR_PROBE_LEASE_MS, 70_000);
  assert.equal(GOVERNOR_ACTIVE_PROBE_LEASE_MS, 35_000);
  assert.equal(BUDGET_RESET_GRACE_MS, 2_000);
  assert.equal(GOVERNOR_PHASE_WINDOW_MS, 5_000);
  assert.equal(BUDGET_PROBE_MS, 60_000);
  assert.equal(resourceReserve(5000), 1000);
});

test("budget normalization rejects malformed values", () => {
  const valid = policyBudget();
  assert.deepEqual(normalizeBudgetResource(valid), valid);
  for (const bad of [
    null,
    { ...valid, limit: -1 },
    { ...valid, remaining: 5001 },
    { ...valid, used: 5001 },
    { ...valid, resetMs: Number.NaN },
    { ...valid, observedAt: Number.POSITIVE_INFINITY },
  ]) {
    assert.equal(normalizeBudgetResource(bad), null);
  }
});

test("missing, malformed, future, stale, and reset budgets never grant", () => {
  const rows = [
    [null, "budget-unknown"],
    [{ ...policyBudget(), remaining: Number.NaN }, "budget-unknown"],
    [policyBudget({ observedAt: POLICY_NOW + 1 }), "budget-future"],
    [policyBudget({ observedAt: POLICY_NOW - BUDGET_SNAPSHOT_TTL_MS - 1 }), "budget-stale"],
    [policyBudget({ resetMs: POLICY_NOW }), "budget-reset"],
  ];
  for (const [budget, reason] of rows) {
    assert.deepEqual(
      resourceDecision({ budget, resource: "core", cost: 1, nowMs: POLICY_NOW }),
      { mode: "probe", reason },
    );
  }
});

test("the hard reserve denies exhausted and reserve-crossing requests", () => {
  assert.equal(availableForGrant({
    budget: policyBudget({ remaining: 1000, used: 4000 }),
    nowMs: POLICY_NOW,
  }).spendable, 0);
  for (const remaining of [1000, 999, 0]) {
    assert.equal(resourceDecision({
      budget: policyBudget({ remaining, used: 5000 - remaining }),
      resource: "core",
      cost: 1,
      nowMs: POLICY_NOW,
    }).mode, "paused");
  }
  assert.equal(resourceDecision({
    budget: policyBudget({ remaining: 1005, used: 3995 }),
    resource: "core",
    cost: 6,
    nowMs: POLICY_NOW,
  }).mode, "paused");
});

test("invalid precomputed reservation totals fail closed", () => {
  const budget = policyBudget();
  const expected = {
    mode: "paused",
    reason: "reservations-invalid",
    resetMs: budget.resetMs,
    epoch: budgetEpoch(budget),
  };
  for (const chargedCost of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.deepEqual(availableForGrant({
      budget: { ...budget, resource: "core" },
      nowMs: POLICY_NOW,
      chargedCost,
    }), expected);
    assert.deepEqual(resourceDecision({
      budget,
      resource: "core",
      cost: 1,
      nowMs: POLICY_NOW,
      chargedCost,
    }), expected);
  }
});

test("safe pacing is not clamped at one minute", () => {
  for (const intervalMs of [59_000, 60_000, 61_000, 600_000]) {
    const spendable = (2 * 3_600_000) / intervalMs;
    const decision = resourceDecision({
      budget: policyBudget({ remaining: 1000 + spendable }),
      resource: "core",
      cost: 2,
      nowMs: POLICY_NOW,
    });
    assert.equal(decision.mode, "open");
    assertClose(2 / decision.callsPerMs, intervalMs, 1e-6);
  }
});

test("a known shared rate block pauses until its reset", () => {
  const decision = resourceDecision({
    budget: policyBudget({ blockUntil: POLICY_NOW + 30_000, blockReason: "rate-limit" }),
    resource: "core",
    cost: 1,
    nowMs: POLICY_NOW,
  });
  assert.equal(decision.mode, "paused");
  assert.equal(decision.reason, "rate-limit");
  assert.equal(decision.resetMs, POLICY_NOW + 3_600_000);
});

test("a suffixed rollback epoch survives normalization into grants", () => {
  const epoch = `5000:${POLICY_NOW + 3_600_000}:${POLICY_NOW}`;
  const budget = policyBudget({ epoch });
  assert.equal(availableForGrant({ budget, nowMs: POLICY_NOW }).epoch, epoch);
  const scheduled = scheduleIntents({
    intents: [{
      id: "rollback-intent",
      leaseId: "rollback-lease",
      tab: "actions",
      priority: "active",
      costs: { core: 2, graphql: 0 },
      requestedAt: POLICY_NOW,
      expiresAt: POLICY_NOW + 10_000,
    }],
    leases: { "rollback-lease": policyLease("rollback-lease") },
    budgets: { core: budget },
    lanes: { core: { nextAt: POLICY_NOW } },
    nowMs: POLICY_NOW,
  });
  assert.equal(scheduled.grants.length, 1);
  assert.equal(scheduled.grants[0].epochs.core, epoch);
});

test("tab and auxiliary operation costs have one explicit registry", () => {
  for (const tab of TAB_KEYS) {
    assert.deepEqual(tabRequestCost(tab), {
      core: REST_PER_FETCH[tab],
      graphql: GRAPHQL_PER_FETCH[tab],
    });
    assert.deepEqual(operationCost(`tab:${tab}`), tabRequestCost(tab));
  }
  assert.equal(tabRequestCost("unknown"), null);
  assert.equal(operationCost("__proto__"), null);
  assert.deepEqual(operationCost("tab:security"), { core: 6, graphql: 0 });
  assert.deepEqual(operationCost("failure-context:repository"), { core: 0, graphql: 1 });
  assert.deepEqual(operationCost("open:actions"), { core: 2, graphql: 0 });
  assert.deepEqual(operationCost("open:issues"), { core: 0, graphql: 2 });
  assert.deepEqual(operationCost("open:prs"), { core: 0, graphql: 2 });
  assert.deepEqual(operationCost("doctor:security-endpoint"), { core: 1, graphql: 0 });
  for (const free of ["rate-limit", "version", "auth-status", "local-git", "failure-context:auth"]) {
    assert.deepEqual(operationCost(free), { core: 0, graphql: 0 });
  }
  assert.equal(operationCost("undeclared"), null);
});

test("every production runGh call site declares a registry operation", () => {
  const source = readFileSync(new URL("../index.mjs", import.meta.url), "utf8");
  const lines = source.split("\n");
  const calls = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.includes("runGh(") && !line.includes("function runGh"));
  assert.ok(calls.length > 0);
  for (const { index } of calls) {
    const declaration = lines.slice(index, index + 5).join("\n");
    assert.match(declaration, /operation(?::|\s*})/);
    const literal = /operation:\s*"([^"]+)"/.exec(declaration)?.[1];
    if (literal) assert.notEqual(operationCost(literal), null, literal);
    if (declaration.includes("`open:${tabKey}`")) {
      for (const tab of ["actions", "issues", "prs"]) {
        assert.notEqual(operationCost(`open:${tab}`), null, `open:${tab}`);
      }
    }
  }
  for (const delegated of [
    "version",
    "auth-status",
    "doctor:repository",
    "doctor:actions",
    "doctor:issues",
    "doctor:prs",
    "doctor:security-endpoint",
  ]) assert.notEqual(operationCost(delegated), null, delegated);
  assert.ok(Object.isFrozen(OPERATION_COSTS));
});

test("manual priority wins but never bypasses the reserve", () => {
  assert.equal(REQUEST_PRIORITIES.manual, REQUEST_PRIORITIES.diagnostic);
  assert.ok(REQUEST_PRIORITIES.manual < REQUEST_PRIORITIES["tab-switch"]);
  assert.ok(REQUEST_PRIORITIES["tab-switch"] < REQUEST_PRIORITIES.active);
  assert.ok(REQUEST_PRIORITIES.active < REQUEST_PRIORITIES.background);

  const leases = {
    a: policyLease("a"),
    b: policyLease("b"),
  };
  const scheduled = scheduleIntents({
    intents: [
      { id: "background", leaseId: "a", priority: "background", costs: { core: 2, graphql: 0 }, expiresAt: POLICY_NOW + 1000 },
      { id: "manual", leaseId: "b", priority: "manual", costs: { core: 2, graphql: 0 }, expiresAt: POLICY_NOW + 1000 },
    ],
    leases,
    budgets: { core: policyBudget() },
    nowMs: POLICY_NOW,
  });
  assert.deepEqual(scheduled.grants.map(({ intentId }) => intentId), ["manual", "background"]);

  const denied = scheduleIntents({
    intents: [{ id: "manual", leaseId: "a", priority: "manual", costs: { core: 2, graphql: 0 }, expiresAt: POLICY_NOW + 1000 }],
    leases,
    budgets: { core: policyBudget({ remaining: 1001 }) },
    nowMs: POLICY_NOW,
  });
  assert.equal(denied.grants.length, 0);
  assert.equal(denied.denied[0].mode, "paused");
});

test("tab intents derive registry costs and reject conflicting overrides", () => {
  const result = scheduleIntents({
    intents: [
      {
        id: "security-conflict",
        leaseId: "lease",
        tab: "security",
        costs: { core: 1, graphql: 0 },
        priority: "active",
        expiresAt: POLICY_NOW + 10_000,
      },
      {
        id: "security-derived",
        leaseId: "lease",
        tab: "security",
        priority: "active",
        expiresAt: POLICY_NOW + 10_000,
      },
      {
        id: "security-extra",
        leaseId: "lease",
        tab: "security",
        costs: { core: 6, graphql: 0, search: 0 },
        priority: "active",
        expiresAt: POLICY_NOW + 10_000,
      },
    ],
    leases: { lease: policyLease("security", POLICY_NOW + 10_000) },
    budgets: { core: policyBudget() },
    nowMs: POLICY_NOW,
  });
  assert.deepEqual(result.prunedIntentIds, ["security-conflict", "security-extra"]);
  assert.equal(result.grants.length, 1);
  assert.deepEqual(result.grants[0].costs, { core: 6, graphql: 0 });
});

test("equal-priority leases rotate fairly and deterministically", () => {
  const leases = Object.fromEntries(
    ["a", "b", "c"].map((id) => [id, policyLease(id, POLICY_NOW + 1000)]),
  );
  const result = scheduleIntents({
    intents: ["a", "b", "c"].map((leaseId) => ({
      id: leaseId,
      leaseId,
      priority: "active",
      costs: { core: 1, graphql: 0 },
      requestedAt: POLICY_NOW,
      expiresAt: POLICY_NOW + 1000,
    })),
    leases,
    budgets: { core: policyBudget() },
    cursors: { core: "a" },
    nowMs: POLICY_NOW,
  });
  assert.deepEqual(result.grants.map(({ leaseId }) => leaseId), ["b", "c", "a"]);
  assert.equal(result.cursors.core, "a");
});

test("active intents consume constrained capacity before background intents", () => {
  const leases = {
    active: policyLease("active", POLICY_NOW + 10_000),
    background: policyLease("background", POLICY_NOW + 10_000),
  };
  const result = scheduleIntents({
    intents: [
      { id: "background", leaseId: "background", priority: "background", costs: { core: 2, graphql: 0 }, expiresAt: POLICY_NOW + 1000 },
      { id: "active", leaseId: "active", priority: "active", costs: { core: 2, graphql: 0 }, expiresAt: POLICY_NOW + 1000 },
    ],
    leases,
    budgets: { core: policyBudget({ remaining: 1002 }) },
    nowMs: POLICY_NOW,
  });
  assert.deepEqual(result.grants.map(({ intentId }) => intentId), ["active"]);
  assert.equal(result.denied[0].intentId, "background");
});

test("mixed-resource queues honor each resource cursor", () => {
  const leases = Object.fromEntries(["a", "b", "c"].map((id) => [
    id,
    policyLease(id, POLICY_NOW + 10_000),
  ]));
  const result = scheduleIntents({
    intents: [
      { id: "1-core", leaseId: "b", priority: "active", costs: { core: 1, graphql: 0 }, expiresAt: POLICY_NOW + 1000 },
      { id: "2-graphql", leaseId: "a", priority: "active", costs: { core: 0, graphql: 1 }, expiresAt: POLICY_NOW + 1000 },
      { id: "3-both", leaseId: "c", priority: "active", costs: { core: 1, graphql: 1 }, expiresAt: POLICY_NOW + 1000 },
    ],
    leases,
    budgets: { core: policyBudget(), graphql: policyBudget() },
    cursors: { core: "a", graphql: "c" },
    nowMs: POLICY_NOW,
  });
  assert.deepEqual(result.grants.map(({ intentId }) => intentId), [
    "1-core",
    "2-graphql",
    "3-both",
  ]);
  assert.deepEqual(result.cursors, { core: "c", graphql: "c" });
});

test("invalid expiry and unknown priority prune unstarted intents", () => {
  const leases = {
    good: policyLease("good", POLICY_NOW + 10_000),
    invalid: policyLease("invalid", Number.NaN),
    unphased: { expiresAt: POLICY_NOW + 10_000 },
  };
  const result = scheduleIntents({
    intents: [
      { id: "missing-expiry", leaseId: "good", priority: "active", costs: { core: 1, graphql: 0 } },
      { id: "invalid-expiry", leaseId: "good", priority: "active", costs: { core: 1, graphql: 0 }, expiresAt: Number.NaN },
      { id: "unknown-priority", leaseId: "good", priority: "urgent", costs: { core: 1, graphql: 0 }, expiresAt: POLICY_NOW + 1000 },
      { id: "unknown-tab", leaseId: "good", priority: "active", tab: "unknown", expiresAt: POLICY_NOW + 1000 },
      { id: "missing-cost", leaseId: "good", priority: "active", costs: { core: 1 }, expiresAt: POLICY_NOW + 1000 },
      { id: "extra-cost", leaseId: "good", priority: "active", costs: { core: 1, graphql: 0, search: 0 }, expiresAt: POLICY_NOW + 1000 },
      { id: "invalid-cost", leaseId: "good", priority: "active", costs: { core: Number.NaN, graphql: 0 }, expiresAt: POLICY_NOW + 1000 },
      { id: "negative-cost", leaseId: "good", priority: "active", costs: { core: -1, graphql: 0 }, expiresAt: POLICY_NOW + 1000 },
      { id: "invalid-lease", leaseId: "invalid", priority: "active", costs: { core: 1, graphql: 0 }, expiresAt: POLICY_NOW + 1000 },
      { id: "missing-phase", leaseId: "unphased", priority: "active", costs: { core: 1, graphql: 0 }, expiresAt: POLICY_NOW + 1000 },
    ],
    leases,
    budgets: { core: policyBudget() },
    nowMs: POLICY_NOW,
  });
  assert.deepEqual(result.prunedIntentIds, [
    "missing-expiry",
    "invalid-expiry",
    "unknown-priority",
    "unknown-tab",
    "missing-cost",
    "extra-cost",
    "invalid-cost",
    "negative-cost",
    "invalid-lease",
    "missing-phase",
  ]);
  assert.equal(result.grants.length, 0);
});

test("started reservations stay charged while only definitely dead leases release unstarted work", () => {
  const deadLeases = { dead: { expiresAt: POLICY_NOW - 1 } };
  const base = {
    budget: policyBudget({ remaining: 1007 }),
    resource: "core",
    cost: 6,
    leases: deadLeases,
    nowMs: POLICY_NOW,
  };
  assert.equal(resourceDecision({
    ...base,
    reservations: [{ leaseId: "dead", status: "started", costs: { core: 2 } }],
  }).mode, "paused");
  assert.equal(resourceDecision({
    ...base,
    reservations: [{ leaseId: "dead", status: "scheduled", costs: { core: 2 } }],
  }).mode, "open");
  assert.equal(resourceDecision({
    ...base,
    leases: {},
    reservations: [{ leaseId: "missing", status: "scheduled", costs: { core: 2 } }],
  }).mode, "open");
  for (const expiresAt of [Number.NaN, Number.POSITIVE_INFINITY, "corrupt"]) {
    assert.equal(resourceDecision({
      ...base,
      leases: { corrupt: { expiresAt } },
      reservations: [{ leaseId: "corrupt", status: "scheduled", costs: { core: 2 } }],
    }).mode, "paused");
  }
});

test("valid precomputed reservation totals equal reservation reduction", () => {
  const budget = policyBudget({ remaining: 1020 });
  const leases = { live: policyLease("live", POLICY_NOW + 60_000) };
  const reservations = [
    { leaseId: "live", status: "scheduled", costs: { core: 2 } },
    { leaseId: "missing", status: "started", costs: { core: 3 } },
  ];
  const request = {
    budget,
    resource: "core",
    cost: 6,
    nowMs: POLICY_NOW,
  };
  assert.deepEqual(
    resourceDecision({ ...request, chargedCost: 5 }),
    resourceDecision({ ...request, reservations, leases }),
  );
});

test("budget reset changes the epoch and deterministic lease phase", () => {
  const first = policyBudget();
  let phaseSeed = "stable-seed";
  while (governorPhaseOffset(phaseSeed, budgetEpoch(first)) < 2) phaseSeed += "x";
  const offset = governorPhaseOffset(phaseSeed, budgetEpoch(first));
  const intent = {
    id: "phase",
    leaseId: "lease-a",
    priority: "active",
    costs: { core: 1, graphql: 0 },
    expiresAt: POLICY_NOW + 7_200_000,
  };
  const leases = { "lease-a": policyLease(phaseSeed, POLICY_NOW + 7_200_000) };
  const firstSchedule = scheduleIntents({
    intents: [intent],
    leases,
    budgets: { core: first },
    nowMs: POLICY_NOW,
  });
  const repeatedSchedule = scheduleIntents({
    intents: [intent],
    leases,
    budgets: { core: first },
    nowMs: POLICY_NOW + Math.floor(offset / 2),
  });
  assert.equal(firstSchedule.grants[0].notBefore, POLICY_NOW + offset);
  assert.equal(repeatedSchedule.grants[0].notBefore, firstSchedule.grants[0].notBefore);

  const nextAnchor = first.resetMs;
  const second = policyBudget({
    resetMs: nextAnchor + 3_600_000,
    observedAt: nextAnchor,
  });
  assert.notEqual(budgetEpoch(first), budgetEpoch(second));
  const resetSchedule = scheduleIntents({
    intents: [intent],
    leases,
    budgets: { core: second },
    nowMs: nextAnchor,
  });
  assert.equal(
    resetSchedule.grants[0].notBefore,
    nextAnchor + governorPhaseOffset(phaseSeed, budgetEpoch(second)),
  );
  assert.notEqual(resetSchedule.grants[0].notBefore, firstSchedule.grants[0].notBefore);
});

test("panes registered mid-window get distinct stable startup phases", () => {
  const registeredAt = POLICY_NOW + 600_000;
  const budget = policyBudget({ observedAt: registeredAt });
  let firstSeed = "pane-a";
  while (governorPhaseOffset(firstSeed, budgetEpoch(budget)) < 2) firstSeed += "x";
  let secondSeed = "pane-b";
  while (
    governorPhaseOffset(firstSeed, budgetEpoch(budget)) ===
    governorPhaseOffset(secondSeed, budgetEpoch(budget))
  ) secondSeed += "x";

  const phaseFor = (seed, nowMs) => scheduleIntents({
    intents: [{
      id: seed,
      leaseId: seed,
      tab: "actions",
      priority: "active",
      expiresAt: budget.resetMs,
    }],
    leases: { [seed]: policyLease(seed, budget.resetMs, registeredAt) },
    budgets: { core: budget },
    nowMs,
  }).grants[0].notBefore;

  const first = phaseFor(firstSeed, registeredAt);
  const second = phaseFor(secondSeed, registeredAt);
  assert.equal(first, registeredAt + governorPhaseOffset(firstSeed, budgetEpoch(budget)));
  assert.equal(second, registeredAt + governorPhaseOffset(secondSeed, budgetEpoch(budget)));
  assert.notEqual(first, second);
  assert.equal(phaseFor(firstSeed, registeredAt + 1), first);
});

test("pacing becomes no earlier as pressure increases", () => {
  const duration = ({ budget = policyBudget(), cost = 2, factor = 1 } = {}) => {
    const decision = resourceDecision({
      budget,
      resource: "core",
      cost,
      lastExternalFactor: factor,
      nowMs: POLICY_NOW,
    });
    assert.equal(decision.mode, "open");
    return cost / decision.callsPerMs;
  };
  const baseline = duration();
  assert.ok(duration({ budget: policyBudget({ remaining: 3000 }) }) >= baseline);
  assert.ok(duration({ budget: policyBudget({ resetMs: POLICY_NOW + 7_200_000 }) }) >= baseline);
  assert.ok(duration({ cost: 6 }) >= baseline);
  assert.ok(duration({ factor: 4 }) >= baseline);
});

test("small external-spend samples retain the prior factor", () => {
  assert.equal(nextExternalFactor({
    lastExternalFactor: 7,
    globalUsedDelta: 500,
    sharedCompletedDelta: MIN_SAMPLE_CALLS - 1,
  }), 7);
  assert.equal(nextExternalFactor({
    lastExternalFactor: 7,
    globalUsedDelta: 60,
    sharedCompletedDelta: 10,
  }), 6);
  assert.equal(nextExternalFactor({ lastExternalFactor: Number.NaN }), null);
  assert.equal(nextExternalFactor({ globalUsedDelta: Number.NaN }), null);
});

test("scheduler keeps a 500-intent lock mutation bounded", () => {
  const leases = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [
    `lease-${index}`,
    policyLease(`phase-${index}`),
  ]));
  const intents = Array.from({ length: 500 }, (_, index) => ({
    id: `benchmark-${index}`,
    leaseId: `lease-${index % 20}`,
    priority: "active",
    costs: { core: 1, graphql: 0 },
    requestedAt: POLICY_NOW,
    expiresAt: POLICY_NOW + GOVERNOR_LEASE_TTL_MS,
  }));
  const startedAt = performance.now();
  const result = scheduleIntents({
    intents,
    leases,
    budgets: { core: policyBudget() },
    nowMs: POLICY_NOW,
  });
  const elapsedMs = performance.now() - startedAt;
  assert.equal(result.grants.length, intents.length);
  assert.ok(elapsedMs < 2000, `500-intent schedule took ${elapsedMs.toFixed(1)}ms`);
});

test("repeated realistic demand fills but never crosses each fresh-window lane", () => {
  for (const count of [1, 3, 7, 12, 20]) {
    let nowMs = POLICY_NOW;
    const resetMs = POLICY_NOW + 3_600_000;
    const budgets = {
      core: policyBudget({ resetMs }),
      graphql: policyBudget({ resetMs }),
    };
    const leases = Object.fromEntries(Array.from({ length: count }, (_, index) => [
      `lease-${index}`,
      policyLease(`phase-${index}`, resetMs + GOVERNOR_LEASE_TTL_MS),
    ]));
    const totals = { core: 0, graphql: 0 };
    const progressed = new Set();
    let lanes = {};
    let reachedBoundary = false;

    for (let batch = 0; batch < 200 && nowMs < resetMs; batch += 1) {
      const cycles = Math.max(1, Math.ceil(12 / count));
      const tabs = ["actions", "security", "issues", "prs", "issues", "prs"];
      const intents = [];
      for (const [leaseIndex, leaseId] of Object.keys(leases).entries()) {
        for (let cycle = 0; cycle < cycles; cycle += 1) {
          for (const [tabIndex, tab] of tabs.entries()) {
            intents.push({
              id: `${count}:${batch}:${leaseId}:${cycle}:${tabIndex}:${tab}`,
              leaseId,
              tab,
              priority: cycle === 0 && tabIndex === leaseIndex % tabs.length
                ? "active"
                : "background",
              requestedAt: nowMs,
              expiresAt: resetMs + GOVERNOR_LEASE_TTL_MS,
            });
          }
        }
      }

      const result = scheduleIntents({ intents, leases, budgets, lanes, nowMs });
      lanes = result.lanes;
      for (const resource of ["core", "graphql"]) {
        const granted = result.grants.reduce(
          (total, grant) => total + grant.costs[resource],
          0,
        );
        totals[resource] += granted;
        assert.ok(totals[resource] <= 4000, `${count} leases crossed ${resource} reserve`);
        budgets[resource].remaining -= granted;
        budgets[resource].used += granted;
      }
      for (const grant of result.grants) progressed.add(grant.leaseId);
      reachedBoundary ||=
        Object.values(lanes).some(({ nextAt }) => nextAt >= resetMs) ||
        result.denied.some(({ mode, reason }) => mode === "waiting" && reason === "reset");
      if (result.grants.length === 0) break;
      nowMs = Math.ceil(Math.max(nowMs + 1, ...result.grants.map(({ notBefore }) => notBefore)));
      for (const budget of Object.values(budgets)) budget.observedAt = nowMs;
    }

    assert.ok(totals.core >= 3900, `${count} leases exercised only ${totals.core} core calls`);
    assert.ok(totals.graphql >= 3900, `${count} leases exercised only ${totals.graphql} GraphQL calls`);
    assert.equal(reachedBoundary, true, `${count} leases never reached a lane boundary`);
    assert.deepEqual([...progressed].sort(), Object.keys(leases).sort());
  }
});

test("a lane at reset waits without reserving the old epoch", () => {
  const resetMs = POLICY_NOW + 1000;
  const result = scheduleIntents({
    intents: [{ id: "late", leaseId: "a", priority: "active", costs: { core: 2, graphql: 0 }, expiresAt: resetMs + 1000 }],
    leases: { a: policyLease("a", resetMs + 1000) },
    budgets: { core: policyBudget({ resetMs }) },
    lanes: { core: { nextAt: resetMs } },
    nowMs: POLICY_NOW,
  });
  assert.equal(result.grants.length, 0);
  assert.equal(result.denied[0].mode, "waiting");
  assert.equal(result.denied[0].retryAt, resetMs + BUDGET_RESET_GRACE_MS);
});

test("deterministic closed-loop governor simulation preserves both reserves", () => {
  let nowMs = POLICY_NOW;
  let resetMs = nowMs + 3_600_000;
  let budgets = {
    core: policyBudget({ resetMs }),
    graphql: policyBudget({ resetMs }),
  };
  let lanes = {};
  let leases = {};
  const received = new Set();
  const mixes = ["actions", "issues", "prs", "security"];
  let crossedReset = false;

  for (let step = 0; step < 75; step += 1) {
    if (step === 0) leases["lease-0"] = policyLease("phase-0", nowMs + GOVERNOR_LEASE_TTL_MS);
    if (step === 5) {
      for (let index = 1; index < 7; index += 1) {
        leases[`lease-${index}`] = policyLease(`phase-${index}`, nowMs + GOVERNOR_LEASE_TTL_MS);
      }
    }
    if (step === 10) {
      for (let index = 7; index < 12; index += 1) {
        leases[`lease-${index}`] = policyLease(`phase-${index}`, nowMs + GOVERNOR_LEASE_TTL_MS);
      }
    }
    if (step === 20) {
      delete leases["lease-1"];
      delete leases["lease-3"];
      delete leases["lease-5"];
      budgets.core.remaining -= 300;
      budgets.core.used += 300;
      budgets.graphql.remaining -= 200;
      budgets.graphql.used += 200;
    }
    if (nowMs >= resetMs) {
      crossedReset = true;
      resetMs += 3_600_000;
      budgets = {
        core: policyBudget({ resetMs, observedAt: nowMs }),
        graphql: policyBudget({ resetMs, observedAt: nowMs }),
      };
    }

    for (const lease of Object.values(leases)) lease.expiresAt = nowMs + GOVERNOR_LEASE_TTL_MS;
    const active = Object.keys(leases).map((leaseId, index) => ({
      id: `active-${step}-${leaseId}`,
      leaseId,
      tab: mixes[index % mixes.length],
      priority: "active",
      requestedAt: nowMs,
      expiresAt: nowMs + GOVERNOR_HEARTBEAT_MS,
    }));
    const background = Object.keys(leases).slice(0, 3).map((leaseId, index) => ({
      id: `background-${step}-${leaseId}`,
      leaseId,
      tab: mixes[(index + 1) % mixes.length],
      priority: "background",
      requestedAt: nowMs,
      expiresAt: nowMs + GOVERNOR_HEARTBEAT_MS,
    }));
    const result = scheduleIntents({
      intents: [...background, ...active],
      leases,
      budgets,
      lanes,
      nowMs,
    });
    lanes = result.lanes;

    for (const resource of ["core", "graphql"]) {
      const granted = result.grants.reduce((total, grant) => total + grant.costs[resource], 0);
      assert.ok(budgets[resource].remaining - granted >= resourceReserve(budgets[resource].limit));
      budgets[resource].remaining -= granted;
      budgets[resource].used += granted;
      budgets[resource].observedAt = nowMs;
    }
    for (const grant of result.grants) {
      if (grant.intentId.startsWith("active-")) received.add(grant.leaseId);
    }
    nowMs += 60_000;
  }

  assert.equal(crossedReset, true);
  for (const leaseId of Object.keys(leases)) assert.ok(received.has(leaseId), leaseId);
});

// The control law. These assertions are the specification -- the function is
// pure, so the rubric can be stated exactly rather than observed through a
// timer. Expected intervals are derived, not guessed: with
// restPerTick("actions") = 2 + 6/12 = 2.5 and a fresh window (5000 remaining,
// resetting in an hour), affordable = 5000/3600 * 0.8 = 1.111 calls/sec.
function assertClose(actual, expected, tolerance) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${actual} within ${tolerance} of ${expected}`,
  );
}

const FRESH = { remaining: 5000, limit: 5000, resetMs: 3_600_000 };
// `budget` is merged onto FRESH *after* the general spread: a row that overrides
// only `remaining` must keep the fresh window's resetMs, or secondsToReset goes
// NaN and the case silently stops testing what it names.
const at = (over) => ({
  nowMs: 0,
  restPerTick: 2.5,
  floorMs: 5000,
  ...over,
  budget: { ...FRESH, ...over?.budget },
});
const sample = (sharedCompleted, globalUsedDelta) => ({
  sharedCompletedDelta: sharedCompleted,
  globalUsedDelta,
});

test("a single instance stays at the configured floor", () => {
  // required = 2.25 / 1.111 = 2.03s, below the 5s floor. This is the property
  // that keeps adaptation from being a regression for ordinary single-pane use.
  assert.equal(adaptiveRefreshMs(at({ sample: sample(100, 100) })), 5000);
});

test("three panes widen to about 7 seconds", () => {
  assertClose(adaptiveRefreshMs(at({ sample: sample(100, 300) })), 6750, 200);
});

test("seven panes widen to about 16 seconds", () => {
  assertClose(adaptiveRefreshMs(at({ sample: sample(100, 700) })), 15_750, 500);
});

test("ten panes widen to about 23 seconds", () => {
  assertClose(adaptiveRefreshMs(at({ sample: sample(100, 1000) })), 22_500, 500);
});

test("the aggregate of N adapted panes lands near the safety target", () => {
  // The property that matters, asserted directly rather than inferred from the
  // intervals: N panes each polling at the computed interval spend at most
  // BUDGET_SAFETY of the hourly limit, leaving the rest for the user's own gh.
  for (const n of [1, 3, 7, 10, 20]) {
    const ms = adaptiveRefreshMs(at({ sample: sample(100, 100 * n) }));
    const aggregate = n * (3_600_000 / ms) * 2.5;
    assert.ok(aggregate <= 5000 * BUDGET_SAFETY + 1, `n=${n} completed ${aggregate}`);
  }
});

// Phase 3 removes this unsafe legacy adapter assertion with its runtime caller.
test("legacy adapter: exhausted budget goes straight to the cap [remove in Phase 3]", () => {
  assert.equal(
    adaptiveRefreshMs(at({ budget: { remaining: 0 }, sample: sample(100, 700) })),
    MAX_ADAPTIVE_REFRESH_MS,
  );
});

// Phase 3 removes the unsafe one-minute clamp after governor admission is live.
test("legacy adapter: widening is capped [remove in Phase 3]", () => {
  assert.equal(
    adaptiveRefreshMs(at({ budget: { remaining: 10 }, sample: sample(100, 9000) })),
    MAX_ADAPTIVE_REFRESH_MS,
  );
});

test("too small a sample declines to infer an external factor", () => {
  // Floor, not a wild extrapolation: one call against a global delta of one
  // reads as "we are the only consumer" whether or not that is true. Floor
  // specifically because there is no earlier measurement to hold -- see below.
  assert.equal(adaptiveRefreshMs(at({ sample: sample(MIN_SAMPLE_CALLS - 1, 5000) })), 5000);
});

test("an unmeasurable window holds the widened interval, not the floor", () => {
  // The same rubric row as "seven panes", reached with a window too small to
  // re-measure. Dropping to the floor here is the flap: a pane wide enough to
  // need throttling is, by construction, too quiet to keep proving it.
  assertClose(
    adaptiveRefreshMs(at({ sample: sample(2, 700), lastExternalFactor: 7 })),
    15_750,
    500,
  );
});

test("nextExternalFactor holds the last measurement when the window cannot be measured", () => {
  const factor = (value, lastExternalFactor = 1) => nextExternalFactor({
    lastExternalFactor,
    globalUsedDelta: value?.globalUsedDelta ?? 0,
    sharedCompletedDelta: value?.sharedCompletedDelta ?? 0,
  });
  assert.equal(factor(sample(100, 700)), 7);
  assert.equal(factor(sample(2, 700), 7), 7);
  assert.equal(factor(null, 7), 7);
  // Never below 1, from either source: fewer than one consumer is not a thing,
  // and an external factor under 1 would compute an interval tighter than the floor.
  assert.equal(factor(sample(100, 50)), 1);
  assert.equal(factor(null, 0.2), null);
});

test("an unmeasurable probe window stays open instead of restarting", () => {
  const first = nextExternalSampleWindow(null, { used: 100 }, 0);
  assert.equal(first.sample, null, "the first probe has no window to measure over");
  assert.deepEqual(first.next, { used: 100, sharedCompleted: 0 });

  // Two completed shared calls, below MIN_SAMPLE_CALLS: the baseline must not advance,
  // or the next window starts equally short and the pane can never re-measure.
  const small = nextExternalSampleWindow(first.next, { used: 140 }, 2);
  assert.equal(externalSampleIsUsable(small.sample), false);
  assert.deepEqual(small.next, first.next);

  // One probe later the accumulated window is measurable -- and both halves of
  // the ratio span the whole stretch, not just the last minute of it.
  const grown = nextExternalSampleWindow(small.next, { used: 200 }, 6);
  assert.deepEqual(grown.sample, { globalUsedDelta: 100, sharedCompletedDelta: 6 });
  assert.deepEqual(grown.next, { used: 200, sharedCompleted: 6 });
});

test("a rate-limit window reset restarts the probe window", () => {
  // `used` falling means the hour rolled over. The span before the reset cannot
  // be compared against the counter after it, so this cycle infers nothing
  // rather than reporting a negative delta.
  const { sample: s, next } = nextExternalSampleWindow(
    { used: 4000, sharedCompleted: 900 },
    { used: 12 },
    950,
  );
  assert.equal(s, null);
  assert.deepEqual(next, { used: 12, sharedCompleted: 950 });
});

test("a throttled pane does not flap back to the floor between measurable windows", () => {
  // The closed-loop property the rubric above cannot see, because every row
  // there is handed its sample. Twenty panes widen to ~40s, at which point one
  // probe window holds ~3 of this pane's calls -- under MIN_SAMPLE_CALLS. If the
  // loop re-measured from scratch it would read "no other consumers", snap to
  // the floor, spend enough to measure again, and re-throttle: a two-minute flap
  // at exactly the instance count the widening exists for.
  //
  // The budget is held healthy on purpose. That is the trap: once the panes have
  // throttled, nothing about `remaining` says they must stay throttled, and the
  // inferred external factor is the only thing holding them there.
  const PANES = 20;
  let applied = 5000;
  let sharedCompleted = 0;
  let used = 0;
  let externalSampleWindow = null;
  let externalFactor = 1;
  const settled = [];

  for (let probe = 0; probe < 12; probe++) {
    const mine = (60_000 / applied) * 2.5; // one probe window at the current interval
    sharedCompleted += mine;
    used += mine * PANES;
    const budget = { ...FRESH, used };

    const step = nextExternalSampleWindow(externalSampleWindow, budget, sharedCompleted);
    externalSampleWindow = step.next;
    externalFactor = nextExternalFactor({
      lastExternalFactor: externalFactor,
      globalUsedDelta: step.sample?.globalUsedDelta ?? 0,
      sharedCompletedDelta: step.sample?.sharedCompletedDelta ?? 0,
    });
    const target = adaptiveRefreshMs(at({
      budget,
      sample: step.sample,
      lastExternalFactor: externalFactor,
    }));
    if (adaptiveChangeWorthApplying(applied, target)) applied = target;

    if (probe >= 2) settled.push(applied);
  }

  assert.ok(Math.min(...settled) > 5000, `returned to the floor: ${settled.join(", ")}`);
  assertClose(applied, 45_000, 2000);
});

// Phase 3 removes this unsafe fail-open fallback with the legacy adapter.
test("legacy adapter: missing budget returns the floor [remove in Phase 3]", () => {
  for (const budget of [null, undefined, { remaining: NaN }]) {
    assert.equal(adaptiveRefreshMs({ ...at(), budget, sample: sample(100, 700) }), 5000);
  }
});

test("the configured floor is never tightened, even above the cap", () => {
  const ms = adaptiveRefreshMs({ ...at({ sample: sample(100, 100) }), floorMs: 120_000 });
  assert.equal(ms, 120_000);
});

test("hysteresis suppresses small moves and admits large ones", () => {
  assert.equal(adaptiveChangeWorthApplying(10_000, 11_000), false); // +10%
  assert.equal(adaptiveChangeWorthApplying(10_000, 9_500), false); // -5%
  assert.equal(adaptiveChangeWorthApplying(10_000, 13_000), true); // +30%
  assert.equal(adaptiveChangeWorthApplying(10_000, 7_000), true); // -30%
  assert.equal(adaptiveChangeWorthApplying(0, 5_000), true); // first apply
});

test("restPerTick amortises the background tabs", () => {
  // Close rather than exact: the function accumulates one division per
  // background tab, so 0 + 2/12 + 3/12 is not bit-identical to 5/12.
  assertClose(restPerTick("actions"), 2 + 6 / BACKGROUND_EVERY, 1e-12);
  assertClose(restPerTick("security"), 6 + 2 / BACKGROUND_EVERY, 1e-12);
  assertClose(restPerTick("issues"), (2 + 6) / BACKGROUND_EVERY, 1e-12);
});

test("every tab's fetcher has a spend to report from the cost table", () => {
  // Guards the drift this design is built to prevent: the meter bills from the
  // same table the projection reads, so a tab with no entry would silently bill
  // nothing and make the inferred external factor wrong. The richer attribution
  // assertions live in the pty layer, because the fetchers need a `gh` to run.
  for (const key of TAB_KEYS) assert.equal(typeof REST_PER_FETCH[key], "number");
});

test("restPerTick and projectedHourlyCost agree", () => {
  // Two derivations of the same quantity; if they drift, one of them is wrong.
  for (const key of TAB_KEYS) {
    const perHour = restPerTick(key) * (3_600_000 / REFRESH_MS);
    assertClose(perHour, projectedHourlyCost(key).rest, 1);
  }
});

test("the status bar hints are a subset of the documented key table", () => {
  // KEY_TABLE feeds both --help and the `?` overlay; KEY_HINTS is the short
  // subset shown on the status bar. Nothing else enforces that they agree.
  // Matched on the action, not the glyph: the bar renders "Move: ↑↓" where the
  // table says "Up / Down, j / k", and those are two representations of one
  // binding rather than a drift. What must not happen is the bar advertising an
  // action the table never explains.
  const documented = KEY_TABLE.map(([, desc]) => desc.toLowerCase()).join(" | ");
  for (const hint of KEY_HINTS) {
    assert.ok(
      documented.includes(hint.label.toLowerCase()),
      `status bar advertises "${hint.label}" but the key table documents no such action`,
    );
  }
  assert.deepEqual(KEY_HINTS, [
    { label: "Move", keys: "↑↓" },
    { label: "Open", keys: "Ent" },
    { label: "Refresh", keys: "r" },
    { label: "Width", keys: "w" },
    { label: "Quit", keys: "q" },
  ]);
  assert.ok(
    KEY_TABLE.some(([keys]) => keys === "?"),
    "the overlay's own key must be listed in the table it renders",
  );
});

test("the missing-remote prompt exposes only explicit setup and exit actions", () => {
  assert.deepEqual(REMOTE_SETUP_HINTS, [
    { label: "Create remote", keys: "Ent" },
    { label: "Quit", keys: "q" },
  ]);
  assert.ok(REMOTE_SETUP_LINES.some((line) => line.includes("gh repo create")));
  assert.ok(REMOTE_SETUP_LINES.some((line) => line.includes("Push an existing local repository")));
  assert.ok(REMOTE_SETUP_LINES.every((line) => !line.includes("--source")));
  assert.ok(REMOTE_SETUP_LINES.some((line) => line.includes("gh-glance --repo owner/name")));
  assert.ok(REMOTE_SETUP_LINES.every((line) => !line.includes("--public")));
  assert.ok(REMOTE_SETUP_LINES.every((line) => !line.includes("--private")));
  assert.ok(REMOTE_SETUP_NONINTERACTIVE_LINES.every((line) => !line.includes("Enter")));
  assert.ok(REMOTE_SETUP_NONINTERACTIVE_LINES.some((line) => line.includes("Ctrl+C")));
});

test("setup signal forwarding terminates a delayed child", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  const exited = once(child, "exit");
  assert.equal(forwardSignalToChild(child, "SIGTERM"), true);
  const [code, signal] = await exited;
  assert.equal(code, null);
  assert.equal(signal, "SIGTERM");
  assert.equal(forwardSignalToChild(child, "SIGTERM"), false);
});

test("setup signal forwarding escalates when a child ignores SIGTERM", async () => {
  const child = spawn(
    process.execPath,
    ["-e", 'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000)'],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  await once(child.stdout, "data");
  const exited = once(child, "exit");
  assert.equal(forwardSignalToChild(child, "SIGTERM"), true);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, null);
  assert.equal(forwardSignalToChild(child, "SIGKILL"), true);
  const [code, signal] = await exited;
  assert.equal(code, null);
  assert.equal(signal, "SIGKILL");
});
