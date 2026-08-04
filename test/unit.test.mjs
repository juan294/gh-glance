// Node's built-in test runner -- no framework, no config, no build step, which
// is the only way to add tests without contradicting the project's no-build
// stance (see CONTRIBUTING.md).
//
// Importing index.mjs is inert: everything with a side effect hangs off its
// main-module check, so this does not parse argv, enter the alternate screen,
// or start the dashboard.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  safe,
  shortErr,
  isUnavailable,
  isRateLimited,
  isAuthProblem,
  AUTH_RETRY_MS,
  BACKOFF_STEPS_MS,
  formatAge,
  formatDuration,
  usableSize,
  severityRank,
  pick,
  minimumWidthFor,
  runStatusIcon,
  RUN_STATUS_ICON,
  SEVERITY_STYLE,
  REVIEW_LABEL,
  MIN_TABLE_WIDTH,
  OCT_NERD,
  OCT_UNICODE,
  KEY_TABLE,
  KEY_HINTS,
  VERDICT_REMEDY,
  RATE_LIMIT_RETRY_MS,
  FAILURE_LADDER,
  REPO_PATTERN,
} from "../index.mjs";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const NUL = String.fromCharCode(0);
const DEL = String.fromCharCode(127);
const C1 = String.fromCharCode(155);

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
  assert.ok(
    KEY_TABLE.some(([keys]) => keys === "?"),
    "the overlay's own key must be listed in the table it renders",
  );
});
