#!/usr/bin/env node
// gh-glance -- a live-refreshing GitHub dashboard sized for a narrow terminal
// pane: Actions, Issues, Pull Requests, and Security (Dependabot/
// code-scanning/secret-scanning alerts). All data comes from `gh` (issue/pr/
// run list + `gh api` for security alerts) -- no direct GitHub API calls of
// our own. Renders with ink so redraws are diffed in place, no full-screen
// clear/flash on refresh.

// React's development build instruments every render with performance.measure()
// calls for its DevTools timeline. In a browser those entries are dropped once
// the timeline buffer fills; in Node the user-timing buffer is never trimmed,
// so each render leaves a PerformanceMeasure behind permanently. A dashboard
// that redraws for hours accumulates them until the heap is gone -- measured at
// ~14 entries/s, which is a fatal "JavaScript heap out of memory" after a few
// hours of uptime. Selecting React's production build turns the instrumentation
// off at the source (verified: 0 entries, flat heap).
//
// react and ink pick their build by reading NODE_ENV at import time, so the flag
// has to be set before either is loaded. This assignment must stay the first
// statement in the file. NODE_ENV is only defaulted, not overwritten, so
// `NODE_ENV=development gh-glance` still gets React's warnings -- see
// disarmDevBuildLeak() for how that path is kept survivable rather than fatal.
process.env.NODE_ENV ??= "production";

import { execFile } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Running as the CLI vs. being imported by a test. Everything with a side
// effect -- argv handling, the TTY guard, the preflight, entering the alternate
// screen, render() -- hangs off this, so `import("./index.mjs")` is inert and
// the pure helpers below are unit-testable. Compared through realpath because
// `npm link` puts a symlink on PATH, so argv[1] and this module's own URL are
// different strings for the same file.
function detectMainModule() {
  try {
    const self = realpathSync(fileURLToPath(import.meta.url));
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === self;
  } catch {
    return false;
  }
}
const IS_MAIN = detectMainModule();

const REFRESH_MS = 5000;

// `gh run list` costs roughly linearly in --limit (measured: ~1.2s at 20 runs,
// ~3.0s at 100, ~4.9s at 150), so asking for a fixed 150 to render ~35 visible
// rows was paying several seconds per refresh for rows nobody sees. Actions is
// a scrolling log whose count is arbitrary anyway, so it fetches only what the
// pane can show -- one extra row tells us whether to render the count as "n+".
const MIN_RUN_LIMIT = 20;

// Ceiling on the pane-height-derived run limit. Without it a very tall terminal
// asks for enough runs that the fetch outlasts REFRESH_MS, at which point ticks
// are permanently absorbed by the in-flight guard and the effective refresh rate
// silently becomes whatever `gh` can sustain.
const MAX_RUN_LIMIT = 60;

// Issues and PRs are sets rather than logs: the count *is* the signal, so these
// stay generous. They are also far cheaper, being bounded by what's open.
const LIST_LIMIT = 150;

// Alert endpoints are filtered server-side to open items and capped at one
// page. The previous --paginate walked the repo's entire alert history --
// mostly closed alerts -- and then discarded them client-side.
const ALERT_PER_PAGE = 100;
const ALERT_QUERY = `?state=open&per_page=${ALERT_PER_PAGE}`;

// Inactive tabs only feed the tab-bar counts, so they refresh every Nth tick
// rather than every tick. Raised from 4 to 12 (a 60s cycle at the default
// refresh) because the measured steady-state cost was 1,980-2,520 REST calls
// per hour against a 5,000/hr limit -- 40-50% of the user's entire budget for a
// single pane. Only the tab you are looking at needs REFRESH_MS latency; the
// other three exist to keep counts honest, which tolerates a minute.
const BACKGROUND_EVERY = 12;

// A stalled `gh` used to wedge a tab permanently: the promise never settled, so
// the in-flight guard was never cleared and that tab stopped fetching for the
// life of the process while the spinner kept insisting it was working. The
// timeout has to clear the slowest *legitimate* fetch by a wide margin -- the
// MIN_RUN_LIMIT note above measures ~4.9s at 150 runs -- so it sits far above
// REFRESH_MS rather than near it. SIGKILL because `gh` mid-TLS-handshake can
// ignore SIGTERM.
const GH_TIMEOUT_MS = 30_000;

// Node's execFile defaults to a 1 MiB stdout buffer. A repo with ~100 open
// Dependabot alerts returns ~800 KB of advisory JSON (measured 7.3 KB/advisory)
// and was within reach of the cliff -- where the rejection was swallowed into a
// note and the tab rendered "Security (0)", i.e. the repos with the most to
// report looked the cleanest. Paired with the --jq projection below, which cuts
// the payload ~48x, this is headroom rather than an allocation.
const GH_MAX_BUFFER = 16 * 1024 * 1024;

// Endpoints that answer "this feature is not enabled here" do so with a 403/404
// on every single refresh. Re-asking forever costs a process spawn and a
// rate-limit unit each time (measured up to 11,520 wasted calls per 8h session),
// so a negative result backs off -- but never permanently, because Advanced
// Security can be switched on mid-session and a latched "not enabled" would be
// a lie about a security surface.
const BACKOFF_STEPS_MS = [60_000, 300_000, 1_800_000, 3_600_000];

// Past this, the active tab's data is old enough to say so. Deliberately
// coarse: `now` only advances on minute boundaries when nothing is in progress,
// so a minute-granular staleness label costs zero extra redraws, whereas a
// live "updated Ns ago" would make every frame differ and undo the
// byte-identical-idle-frame property the rest of this file works to keep.
const STALE_AFTER_MS = 30_000;

// Mutable because the fetchers below are defined before argv is parsed, and the
// argv block is what fills this in. Everything here has a working default, so
// the zero-argument invocation the README documents behaves exactly as before.
const runtime = {
  repo: null, // null means "let gh infer it from the git remote", as today
  refreshMs: REFRESH_MS,
  verbose: false,
  initialTabIndex: 0,
};

// The four tab keys, needed by --tab validation which runs long before the TABS
// table itself is built.
const TAB_KEYS = ["actions", "issues", "prs", "security"];

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_MS = 100;

// Motion opt-out. This pane is designed to sit in peripheral vision for hours,
// which is exactly where repetitive motion is most costly for users with
// vestibular sensitivity -- and a 20-minute workflow run means 20 minutes of
// 10fps animation with no way to stop it.
const ANIMATE = !process.env.GH_GLANCE_NO_ANIMATION;

// ---------- Untrusted input ----------

// Everything `gh` returns is chosen by strangers: on a public repo anyone can
// open an issue or a fork PR and pick the title, and a commit subject (which is
// what `displayTitle` is for push runs) has no byte restrictions at all.
//
// ink strips CSI sequences but -- verified against ink 7.1.1 -- deliberately
// preserves OSC sequences, SGR, and bare C0 controls so callers can pass
// chalk-styled strings through. So OSC 8 hyperlinks survive (an attacker-chosen
// clickable URL with no visual tell), CR survives (rewinds the cursor and
// overwrites the row above, which can forge or blank a neighbouring row --
// including making a critical alert read as clean), BEL survives (rings once
// per redraw, every 5s), and LF survives (one hostile title inflates to N lines
// and evicts other rows out of a height-clamped frame entirely).
//
// So sanitize here, at the data boundary, inside the parse() closures -- never
// on the composed output stream, which would strip ink's own SGR codes, the
// box-drawing in PanelEdge, and the alternate-screen escapes, i.e. the whole UI.
//
// Strip C0, DEL and C1 only. Emoji (including ZWJ sequences and variation
// selectors), CJK and other wide characters, combining marks and RTL text must
// survive untouched -- ink's width arithmetic depends on measuring them
// correctly, and the app's own Nerd Font glyphs live in the private use area, so
// anything shaped like "strip non-ASCII" would erase every status icon on
// screen. Control runs collapse to a single space rather than being deleted, so
// "a\nb" reads as "a b" rather than "ab".
// eslint-disable-next-line no-control-regex -- matching control characters is the entire purpose
const CONTROL_CHARS = /[ --]+/g;

// Titles are rendered at whatever length GitHub returns, and ink memoizes
// wrapped text in a module-level cache it never evicts -- so unbounded remote
// strings are unbounded retention in a process meant to run for hours. Clamp
// far above any realistic column width so ink's own ellipsis stays what the user
// actually sees, and clamp by codepoint: slicing mid-surrogate produces a string
// whose measured width disagrees with what the terminal draws, which
// desynchronizes every column to its right.
const MAX_FIELD_LENGTH = 300;

function safe(value) {
  if (typeof value !== "string") return value == null ? "" : String(value);
  const cleaned = value.replace(CONTROL_CHARS, " ").trim();
  const points = Array.from(cleaned);
  return points.length > MAX_FIELD_LENGTH ? points.slice(0, MAX_FIELD_LENGTH).join("") : cleaned;
}

// ---------- Formatting ----------

// The `ms < 0` guard does not catch NaN (every NaN comparison is false), and
// every caller builds a Date from an unvalidated API field -- so a null, absent
// or Go-zero timestamp used to render "NaNd ago" or "InfinityhNaNm" straight
// into the table. A dash reads as absent data and fits the fixed 7- and
// 8-column cells; dropping the row instead would make the count disagree with
// the body, which is worse.
const NO_VALUE = "-";

function formatDuration(ms) {
  if (!Number.isFinite(ms)) return NO_VALUE;
  if (ms < 0) ms = 0;
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h${m}m`;
  if (m > 0) return `${m}m${s}s`;
  return `${s}s`;
}

function formatAge(date, now) {
  const ms = now - date;
  if (!Number.isFinite(ms)) return NO_VALUE;
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// `shortErr` used to read err.shortMessage first -- an execa property that
// node:child_process never sets, so the branch was dead and every error fell
// through to err.message, which is the whole reconstructed command line
// (~150 characters of --json field names for the Actions fetch) followed by the
// part the user actually needs. Rendered against a layout that reserves exactly
// one row for it, that overflowed the frame and made ink full-clear and repaint
// every frame -- the flicker this file's header claims the design avoids.
//
// stderr carries the useful line, so prefer it. Keep the err.message fallback:
// a missing binary rejects with code ENOENT, an empty stderr and only
// "spawn gh ENOENT" as the message. Newlines are collapsed rather than kept,
// because ink honours an embedded \n inside a single <Text> and one row is all
// the layout has budgeted.
const MAX_ERR_LENGTH = 120;

function shortErr(err) {
  if (err?.killed && err?.signal) return `gh timed out after ${GH_TIMEOUT_MS / 1000}s`;
  const raw = (typeof err?.stderr === "string" && err.stderr.trim()) || err?.message || String(err);
  const withoutPreamble = String(raw).replace(/^Command failed:[^\n]*\n?/, "");
  const collapsed = withoutPreamble.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
  const text = collapsed || String(raw).trim() || "unknown error";
  return text.length > MAX_ERR_LENGTH ? `${text.slice(0, MAX_ERR_LENGTH - 1)}…` : text;
}

// `gh api` puts the HTTP status in stderr and exits 1, so err.code is the
// process exit code and says nothing about the cause. 403/404 is the honest
// "you can't see this here" -- everything else (auth expiry, rate limiting,
// DNS, a 502) is a real failure that used to be reported as a confident,
// plausible, and wrong claim that the feature was switched off.
function isUnavailable(err) {
  return /HTTP (403|404)/.test(String(err?.stderr ?? err?.message ?? ""));
}

function isRateLimited(err) {
  return /rate limit|secondary rate|API rate limit/i.test(String(err?.stderr ?? err?.message ?? ""));
}

// Some pty wrappers (and a terminal mid-resize) report a size of 0 or
// undefined. Taking that literally collapses the table to a single row (or
// draws a zero-width border), so fall back to sane defaults until real
// dimensions arrive.
const DEFAULT_ROWS = 30;
const DEFAULT_COLS = 80;
function usableSize(value, fallback) {
  return typeof value === "number" && value > 0 ? value : fallback;
}

// ---------- gh subprocess boundary ----------

// One seam for every `gh` call. Previously six call sites each passed nothing
// but argv, which meant six places to add a timeout, six to add a buffer size,
// six to neutralize the environment -- and it is why the three alert fetchers
// silently drifted into handling errors three different ways.
//
// The environment is *overridden*, never replaced: `gh` needs GH_TOKEN,
// GH_HOST (GitHub Enterprise), GH_CONFIG_DIR, HOME and the proxy variables to
// work at all, and GH_REPO is the one documented way to point this tool at
// another repository. GH_FORCE_TTY is the interesting one -- people export it
// in shell profiles to get rich `gh` output through pipes, and it makes
// `gh --json` emit ANSI-coloured pretty-printed JSON that JSON.parse rejects
// outright (verified), which broke all four tabs at once with an error pointing
// at JSON rather than at their environment.
const GH_ENV_OVERRIDES = {
  GH_FORCE_TTY: "",
  NO_COLOR: "1",
  CLICOLOR_FORCE: "0",
  GH_PAGER: "cat",
};

// Verbose output goes to stderr and never to stdout: stdout is ink's frame
// stream, and writing anything else into it corrupts the diff and the
// alternate-screen state. The argv block refuses --verbose while stderr is still
// a terminal, so these lines always land in a file rather than on top of the
// dashboard.
function logGh(args, startedAt, outcome) {
  if (!runtime.verbose) return;
  const ms = Date.now() - startedAt;
  process.stderr.write(
    `${new Date().toISOString()} gh ${args.join(" ")} -- ${outcome} in ${ms}ms\n`,
  );
}

async function runGh(args, { signal } = {}) {
  const startedAt = Date.now();
  try {
    const { stdout } = await execFileAsync("gh", args, {
      timeout: GH_TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: GH_MAX_BUFFER,
      env: { ...process.env, ...GH_ENV_OVERRIDES },
      signal,
    });
    logGh(args, startedAt, `ok ${stdout.length}B`);
    return stdout;
  } catch (err) {
    logGh(args, startedAt, `FAILED ${shortErr(err)}`);
    throw err;
  }
}

// `--repo` for the list subcommands. Empty when unset, so the argv vector stays
// byte-identical to what shipped before.
function repoArgs() {
  return runtime.repo ? ["--repo", runtime.repo] : [];
}

// `gh api` has no --repo; it resolves the {owner}/{repo} placeholder from the
// working directory. Substituting the validated value is what makes --repo work
// for the alert endpoints. REPO_PATTERN is why this is safe to interpolate into
// a request path.
function apiPath(path) {
  return runtime.repo ? path.replace("{owner}/{repo}", runtime.repo) : path;
}

// ---------- Data fetchers ----------

async function fetchActions(limit, signal) {
  const raw = await runGh(
    [
      "run",
      "list",
      ...repoArgs(),
      "--limit",
      String(limit),
      "--json",
      "databaseId,displayTitle,workflowName,number,headBranch,status,conclusion,startedAt,updatedAt",
    ],
    { signal },
  );
  return {
    raw,
    limit,
    parse: () =>
      JSON.parse(raw).map((r) => ({
        databaseId: r.databaseId,
        displayTitle: safe(r.displayTitle),
        workflowName: safe(r.workflowName),
        number: r.number,
        headBranch: safe(r.headBranch),
        status: r.status,
        conclusion: r.conclusion,
        startedAt: r.startedAt,
        updatedAt: r.updatedAt,
      })),
  };
}

// Both list endpoints return created-descending by default, while the row
// renders updatedAt under a column headed AGE -- so the visible column was
// non-monotonic (verified against cli/cli: a PR updated yesterday sat below one
// updated three days earlier) and, worse, truncating to pane height dropped the
// oldest-*created* rows. A PR opened six months ago and reviewed five minutes
// ago was invisible. Sorting server-side fixes the ordering and the truncation
// criterion together; verified that --search composes with --state open and
// returns the same result count.
const SORT_RECENT = ["--search", "sort:updated-desc"];

async function fetchIssues(signal) {
  const raw = await runGh(
    [
      "issue",
      "list",
      ...repoArgs(),
      "--state",
      "open",
      "--limit",
      String(LIST_LIMIT),
      ...SORT_RECENT,
      "--json",
      "number,title,author,labels,createdAt,updatedAt",
    ],
    { signal },
  );
  return {
    raw,
    limit: LIST_LIMIT,
    parse: () =>
      JSON.parse(raw).map((i) => ({
        number: i.number,
        title: safe(i.title),
        author: safe(i.author?.login ?? ""),
        label: safe(i.labels?.[0]?.name ?? ""),
        updatedAt: i.updatedAt,
      })),
  };
}

async function fetchPRs(signal) {
  const raw = await runGh(
    [
      "pr",
      "list",
      ...repoArgs(),
      "--state",
      "open",
      "--limit",
      String(LIST_LIMIT),
      ...SORT_RECENT,
      "--json",
      "number,title,author,headRefName,isDraft,reviewDecision,createdAt,updatedAt",
    ],
    { signal },
  );
  return {
    raw,
    limit: LIST_LIMIT,
    parse: () =>
      JSON.parse(raw).map((p) => ({
        number: p.number,
        title: safe(p.title),
        author: safe(p.author?.login ?? ""),
        headRefName: safe(p.headRefName),
        isDraft: p.isDraft,
        reviewDecision: p.reviewDecision,
        updatedAt: p.updatedAt,
      })),
  };
}

// The three alert endpoints were three near-identical 26-line blocks that had
// already drifted apart -- only the Dependabot one reported the real error,
// which is exactly the divergence a shared seam prevents. Severity and the
// unavailable-note stay per-endpoint parameters rather than becoming constants,
// because secret scanning deliberately hardcodes critical severity where the
// other two derive it from the payload.
//
// --jq projects the fields we keep server-side inside `gh`: the Dependabot
// response carries a full advisory object per alert (~7.3 KB measured), of which
// this app displays five scalars. Measured 729,866 bytes -> 15,261 for 100
// alerts. That shrinks the parse, the retained rawRef string, and the maxBuffer
// exposure in one move -- but note it runs client-side, so it does not reduce
// network bytes or the rate-limit cost. `state` is kept in the projection so the
// belt-and-braces open filter below still has something to test.
const ALERT_SOURCES = [
  {
    key: "dependabot",
    name: "Dependabot alerts",
    path: `repos/{owner}/{repo}/dependabot/alerts${ALERT_QUERY}`,
    jq: "[.[] | {number, state, created_at, severity: .security_advisory.severity, title: .security_advisory.summary, detail: .dependency.package.name}]",
    unavailable: "Dependabot alerts: unavailable (not enabled for this repository)",
    map: (a) => ({
      id: `dependabot-${a.number}`,
      kind: "Dependabot",
      severity: safe(a.severity ?? "unknown"),
      title: safe(a.title ?? "(no summary)"),
      detail: safe(a.detail ?? ""),
      createdAt: a.created_at,
    }),
  },
  {
    key: "codeScanning",
    name: "Code scanning",
    path: `repos/{owner}/{repo}/code-scanning/alerts${ALERT_QUERY}`,
    jq: "[.[] | {number, state, created_at, severity: (.rule.security_severity_level // .rule.severity), title: (.rule.description // .rule.name), detail: .most_recent_instance.location.path}]",
    unavailable: "Code scanning: not enabled (needs GitHub Advanced Security)",
    map: (a) => ({
      id: `codeql-${a.number}`,
      kind: "CodeQL",
      severity: safe(a.severity ?? "unknown"),
      title: safe(a.title ?? "(no description)"),
      detail: safe(a.detail ?? ""),
      createdAt: a.created_at,
    }),
  },
  {
    key: "secretScanning",
    name: "Secret scanning",
    path: `repos/{owner}/{repo}/secret-scanning/alerts${ALERT_QUERY}`,
    jq: "[.[] | {number, state, created_at, title: (.secret_type_display_name // .secret_type)}]",
    unavailable: "Secret scanning: not enabled for this repository",
    map: (a) => ({
      id: `secret-${a.number}`,
      kind: "Secret",
      // A leaked credential is always critical; there is no severity field to
      // derive one from, and this is what puts it in the red bucket below.
      severity: "critical",
      title: safe(a.title ?? "(unknown secret type)"),
      detail: "",
      createdAt: a.created_at,
    }),
  },
];

// Per-source backoff. Keyed by source so one unavailable endpoint cannot slow
// the other two, and capped rather than permanent so enabling Advanced Security
// mid-session is picked up within the hour.
const alertBackoff = new Map();

function backoffActive(key, now) {
  const state = alertBackoff.get(key);
  return Boolean(state) && now < state.until;
}

function recordFailure(key, now) {
  const previous = alertBackoff.get(key);
  const step = Math.min((previous?.step ?? -1) + 1, BACKOFF_STEPS_MS.length - 1);
  alertBackoff.set(key, { step, until: now + BACKOFF_STEPS_MS[step] });
}

function clearBackoff(key) {
  alertBackoff.delete(key);
}

async function fetchAlertSource(source, signal, now) {
  if (backoffActive(source.key, now)) {
    const note = alertBackoff.get(source.key).note;
    return { raw: `backoff:${note}`, parse: () => ({ alerts: [], note, truncated: false }) };
  }
  try {
    const raw = await runGh(["api", apiPath(source.path), "--jq", source.jq], { signal });
    clearBackoff(source.key);
    return {
      raw,
      parse: () => {
        const rows = JSON.parse(raw).filter((a) => a.state === "open");
        return {
          alerts: rows.map(source.map),
          note: null,
          truncated: rows.length >= ALERT_PER_PAGE,
        };
      },
    };
  } catch (err) {
    // A 403/404 means the feature genuinely is not available here and is worth
    // backing off. Anything else -- expired token, rate limit, network -- is
    // transient and must surface as itself rather than as a confident and wrong
    // claim about the repo's configuration, and must not be latched.
    const unavailable = isUnavailable(err) && !isRateLimited(err);
    const note = unavailable ? source.unavailable : `${source.name}: ${shortErr(err)}`;
    if (unavailable) {
      recordFailure(source.key, now);
      alertBackoff.get(source.key).note = note;
    }
    return { raw: `unavailable:${note}`, parse: () => ({ alerts: [], note, truncated: false }) };
  }
}

// Colour alone said which alerts mattered, but the list was ordered by the
// accident of which endpoint answered first: all Dependabot by age, then all
// CodeQL, then all secret-scanning -- which put leaked credentials last, below
// the fold, on a pane that shows ~25 rows. Rank explicitly, with createdAt as a
// total tiebreaker so an unchanged payload cannot reshuffle unrelated rows and
// defeat the redraw suppression.
const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, moderate: 2, low: 3, unknown: 4 };

function severityRank(severity) {
  return Object.hasOwn(SEVERITY_RANK, severity) ? SEVERITY_RANK[severity] : SEVERITY_RANK.unknown;
}

async function fetchSecurity(signal) {
  const now = Date.now();
  const parts = await Promise.all(ALERT_SOURCES.map((s) => fetchAlertSource(s, signal, now)));
  return {
    // Joined with a NUL so a change in any one of the three shows up as a
    // change in the combined payload, without risk of two different splits
    // colliding on the same string.
    raw: parts.map((p) => p.raw).join("\0"),
    limit: ALERT_PER_PAGE,
    parse: () => {
      const parsed = parts.map((p) => p.parse());
      const alerts = parsed.flatMap((p) => p.alerts);
      alerts.sort((a, b) => {
        const bySeverity = severityRank(a.severity) - severityRank(b.severity);
        if (bySeverity !== 0) return bySeverity;
        return String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? ""));
      });
      return {
        alerts,
        notes: parsed.map((p) => p.note).filter(Boolean),
        truncated: parsed.some((p) => p.truncated),
      };
    },
  };
}

// ---------- Selection ----------

// The cursor tracks the ITEM, never the row index. Rows arrive newest-first and
// a new run pushes everything down every few seconds, so an index-based cursor
// would drift under the reader continuously. Keyed the same way the render loop
// keys its rows.
function itemKey(item) {
  return item?.id ?? item?.databaseId ?? item?.number ?? null;
}

// `gh <kind> view --web` for the tabs that have a per-item command. The Security
// tab is absent on purpose: alerts have no `gh` view subcommand, so there is
// nothing honest to open.
const OPENABLE = { actions: "run", issues: "issue", prs: "pr" };

// Output is captured rather than inherited. `gh ... --web` prints "Opening ...
// in your browser" to stdout, and stdout is ink's frame stream -- letting that
// through would corrupt the diff and the alternate screen.
async function openInBrowser(tabKey, item, signal) {
  const kind = pick(OPENABLE, tabKey, null);
  const number = item?.number ?? item?.databaseId;
  if (!kind || number == null) return;
  await runGh([kind, "view", ...repoArgs(), String(number), "--web"], { signal });
}

// ---------- Startup preflight ----------

// Three failures are guaranteed on a fresh machine or a terminal that happens
// to be somewhere else: no `gh`, and not inside a repository. Each used to fail
// four times over -- once per tab -- as a multi-line subprocess dump rendered
// *inside the alternate screen*, which the exit handler then wiped, so the
// diagnosis was unreadable and then gone.
//
// Only locally-determinable, non-transient conditions belong here. Auth and
// network failures deliberately do not: `gh auth status` makes a network call,
// and exiting on it would make the tool unusable offline where today it simply
// recovers when the network returns. Those keep flowing through the in-pane
// error path, which is now worth reading.
async function preflight() {
  try {
    await execFileAsync("gh", ["--version"], { timeout: GH_TIMEOUT_MS });
  } catch (err) {
    if (err?.code === "ENOENT") {
      return "gh-glance: the gh CLI is not installed.\nInstall it from https://cli.github.com, then run `gh auth login`.";
    }
    return `gh-glance: could not run gh: ${shortErr(err)}`;
  }
  // Only meaningful when the repository is being inferred from the working
  // directory. With --repo or GH_REPO the cwd is irrelevant, and refusing to
  // start outside a checkout would defeat the flag's whole purpose -- watching a
  // repository you have not cloned.
  if (runtime.repo || process.env.GH_REPO) return null;
  try {
    await execFileAsync("git", ["rev-parse", "--git-dir"], { timeout: GH_TIMEOUT_MS });
  } catch {
    return (
      "gh-glance: not inside a git repository.\n" +
      "Run it from a cloned GitHub repository, or pass --repo owner/name."
    );
  }
  return null;
}

// ---------- Command line ----------

// The repository name is the only user-supplied value that reaches a subprocess
// argument *and* gets interpolated into a `gh api` path. execFile with an array
// means there is no shell to inject into, but an unvalidated value in the API
// path would be a request-forgery primitive against arbitrary endpoints -- so it
// is validated once, here at the boundary, against exactly what GitHub allows in
// an owner or repository name.
const REPO_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/;

// Below roughly two seconds a fetch cannot finish before the next tick, so the
// in-flight guard absorbs every other one and the effective rate is whatever
// `gh` can sustain -- the requested interval silently stops being real. Clamping
// with a stated minimum is honest where silently accepting it would not be.
const MIN_REFRESH_SECONDS = 2;
const MAX_REFRESH_SECONDS = 3600;

// The argv surface was a strict allowlist that exited 2 on anything unknown.
// That is a feature, not an accident -- a typo fails loudly instead of being
// ignored -- so widening it keeps the same shape: every flag is named here, and
// anything else still exits 2.
function parseArgs(argv) {
  const opts = { help: false, showVersion: false, repo: null, refresh: null, tab: null, verbose: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const takeValue = (name) => {
      const inline = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : null;
      if (inline !== null) return inline;
      i += 1;
      if (i >= argv.length) throw new Error(`${name} needs a value`);
      return argv[i];
    };

    if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg === "--version" || arg === "-v") opts.showVersion = true;
    else if (arg === "--verbose") opts.verbose = true;
    else if (arg === "--repo" || arg === "-R" || arg.startsWith("--repo=")) {
      opts.repo = takeValue("--repo");
    } else if (arg === "--refresh" || arg.startsWith("--refresh=")) {
      opts.refresh = takeValue("--refresh");
    } else if (arg === "--tab" || arg.startsWith("--tab=")) {
      opts.tab = takeValue("--tab");
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

// Returns { repo, refreshMs, tabKey, verbose } or throws with a message that
// says what to do about it.
function validateArgs(opts, tabKeys) {
  if (opts.repo !== null && !REPO_PATTERN.test(opts.repo)) {
    throw new Error(`--repo must look like owner/name, got: ${opts.repo}`);
  }

  let refreshMs = null;
  if (opts.refresh !== null) {
    const seconds = Number(opts.refresh);
    if (!Number.isFinite(seconds) || !Number.isInteger(seconds)) {
      throw new Error(`--refresh must be a whole number of seconds, got: ${opts.refresh}`);
    }
    if (seconds < MIN_REFRESH_SECONDS || seconds > MAX_REFRESH_SECONDS) {
      throw new Error(
        `--refresh must be between ${MIN_REFRESH_SECONDS} and ${MAX_REFRESH_SECONDS} seconds, got: ${seconds}`,
      );
    }
    refreshMs = seconds * 1000;
  }

  if (opts.tab !== null && !tabKeys.includes(opts.tab)) {
    throw new Error(`--tab must be one of ${tabKeys.join(", ")}, got: ${opts.tab}`);
  }

  return {
    help: opts.help,
    showVersion: opts.showVersion,
    repo: opts.repo,
    refreshMs,
    tabKey: opts.tab,
    verbose: opts.verbose,
  };
}

// ---------- Entry point ----------

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

const HELP = `gh-glance ${version} -- a live-refreshing GitHub dashboard for a narrow terminal pane.

Usage:
  gh-glance                     Run the dashboard in the current repository
  gh-glance --repo owner/name   Watch a specific repository instead
  gh-glance --refresh 15        Poll the active tab every 15 seconds
  gh-glance --tab security      Start on a specific tab
  gh-glance --verbose 2>log     Log every gh call to a file (see below)
  gh-glance --help              Show this help
  gh-glance --version           Show the version

Options:
  -R, --repo <owner/name>  Repository to watch. Without it the repo is inferred
                           from the git remote, the same way \`gh\` does it.
  --refresh <seconds>      Active-tab poll interval (${MIN_REFRESH_SECONDS}-${MAX_REFRESH_SECONDS},
                           default ${REFRESH_MS / 1000}). Background tabs stay at
                           ${BACKGROUND_EVERY}x this.
  --tab <name>             Tab to start on: ${TAB_KEYS.join(", ")}.
  --verbose                Write one line per gh invocation to stderr. stderr
                           must be redirected -- writing it to the terminal
                           would draw over the dashboard, so this refuses to
                           start otherwise.

Run it from inside a locally cloned GitHub repository; the repo is inferred
from the git remote, the same way \`gh\` does it. Requires the \`gh\` CLI
(2.20 or newer), authenticated via \`gh auth login\`.

The active tab refreshes every ${REFRESH_MS / 1000}s; the other three refresh every
${(REFRESH_MS * BACKGROUND_EVERY) / 1000}s to keep their counts honest without spending the API rate limit.

Status icons are GitHub Octicons and need a Nerd Font. Without one, set
GH_GLANCE_ICONS=unicode for plain-unicode equivalents.

Keys:
  1 2 3 4            Actions / Issues / Pull requests / Security
  Left / Right       Previous / next tab
  Tab / Shift+Tab    Next / previous tab
  r                  Refresh the current tab now
  q / Esc / Ctrl+C   Quit

Environment:
  GH_REPO=owner/name        Watch a specific repository (--repo takes precedence)
  GH_GLANCE_ICONS=unicode   Plain-unicode status icons (no Nerd Font needed)
  GH_GLANCE_NO_ANIMATION=1  Freeze the spinner (no motion)
  NO_COLOR=1                Disable colour (status stays readable)
`;

// argv and the TTY guard run *before* react and ink are imported. Loading ink
// costs a measured 137ms and 46MB of RSS, which is a poor trade for printing a
// version string -- and `--version`/`--help` are exactly the paths shell
// completions, npx and the CI smoke job hit. The NODE_ENV assignment at the top
// of the file stays where it is; only the imports moved down.
//
// Precedence is preserved: an unknown argument is reported before the non-TTY
// refusal, because a typo is the more actionable of the two.
if (IS_MAIN) {
  let opts;
  try {
    opts = validateArgs(parseArgs(process.argv.slice(2)), TAB_KEYS);
  } catch (err) {
    // Exit 2 for every argv problem, unchanged from when the only possible
    // problem was an unrecognised flag. CI asserts this code.
    console.error(`gh-glance: ${err.message}\nRun \`gh-glance --help\` for usage.`);
    process.exit(2);
  }

  // Checked after parsing rather than before, so `gh-glance --repo` with no
  // value reports the missing value rather than silently printing help.
  if (opts.help) {
    console.log(HELP);
    process.exit(0);
  }
  if (opts.showVersion) {
    console.log(version);
    process.exit(0);
  }

  // Verbose output must never reach stdout -- that is ink's frame stream, and
  // anything else in it corrupts the diff and the alternate-screen state. stderr
  // is safe only once it is redirected somewhere; while it is still the
  // terminal, these lines would be painted straight over the dashboard. Refusing
  // is better than quietly producing a corrupted screen.
  if (opts.verbose && process.stderr.isTTY) {
    console.error(
      "gh-glance: --verbose writes a log to stderr, which would draw over the dashboard.\n" +
        "Redirect it to a file, e.g. `gh-glance --verbose 2>gh-glance.log`.",
    );
    process.exit(2);
  }

  runtime.repo = opts.repo;
  runtime.verbose = opts.verbose;
  if (opts.refreshMs !== null) runtime.refreshMs = opts.refreshMs;
  if (opts.tabKey !== null) runtime.initialTabIndex = TAB_KEYS.indexOf(opts.tabKey);

  // This is a full-screen live dashboard, not a reporting command -- piping it
  // somewhere would emit an endless stream of redraw frames, so fail fast with
  // an explanation instead. Exit code 1 is asserted by CI.
  if (!process.stdout.isTTY) {
    console.error(
      "gh-glance: stdout is not a terminal. This is an interactive dashboard and can't be piped or redirected.",
    );
    process.exit(1);
  }

  const problem = await preflight();
  if (problem) {
    console.error(problem);
    process.exit(3);
  }
}

const ReactModule = await import("react");
const { render, Box, Text, useStdout, useInput, useStdin, useApp } = await import("ink");

const React = ReactModule.default;
const { useState, useEffect, useRef } = ReactModule;
const e = React.createElement;

// The NODE_ENV escape hatch above is genuinely useful -- React's warnings are
// worth having -- but the development build is what caused the fatal heap
// growth in the first place, and anyone with NODE_ENV=development exported from
// a shell profile or a dev container would silently get it back. Node never
// trims the user-timing buffer on its own, so clearing it periodically bounds
// the growth at a few seconds' worth of entries while leaving every warning
// intact. Scoped to the non-production branch: it discards any other consumer's
// marks, and there are none here today.
function disarmDevBuildLeak() {
  if (process.env.NODE_ENV === "production") return;
  console.error(
    "gh-glance: NODE_ENV is not 'production', so React's development build is loaded.\n" +
      "  Expect higher memory use. Unset NODE_ENV for the production build.",
  );
  setInterval(() => {
    performance.clearMeasures();
    performance.clearMarks();
  }, 10_000).unref();
}

// ---------- Octicons (via the Nerd Font glyph set -- private-use-area
// codepoints from ryanoasis/nerd-fonts glyphnames.json). Same icon shapes
// github.com uses, not emoji. ----------
const OCT_NERD = {
  checkCircleFill: "",
  xCircleFill: "",
  skipFill: "",
  dotFill: "",
  alertFill: "",
  issueOpened: "",
  pullRequest: "",
  pullRequestDraft: "",
  shield: "",
};

// Without a Nerd Font every one of those renders as a blank box, which meant
// status was carried by the colour of a blank box -- and by nothing at all for
// a colour-blind user or anyone running NO_COLOR. The README's remedy was to
// edit the glyph table in the installed source, which stops working the moment
// this ships as a package. Keys are identical to the table above by
// construction; a missing key renders an empty cell, which is the exact symptom
// this exists to fix. Every substitute is deliberately width-1 ASCII: the
// prettier candidates are East-Asian-Ambiguous and render two cells wide in
// some terminals, which shifts every column to their right.
const OCT_UNICODE = {
  checkCircleFill: "+",
  xCircleFill: "x",
  skipFill: "-",
  dotFill: "o",
  alertFill: "!",
  issueOpened: "i",
  pullRequest: "p",
  pullRequestDraft: "d",
  shield: "s",
};

const OCT = process.env.GH_GLANCE_ICONS === "unicode" ? OCT_UNICODE : OCT_NERD;

// ---------- Shared layout primitives ----------

// ANSI 8 ("gray", i.e. bright-black) sits close to the background on most dark
// themes -- legible in a screenshot, not at a glance. Secondary text uses
// dimColor instead of an absolute colour, so de-emphasis is computed against
// whatever foreground the user actually has: the previous ANSI 7 was tuned for
// a dark terminal and became unreadable on a light one, while on a dark theme
// it matched the default foreground closely enough that the intended hierarchy
// never appeared at all. "gray" is kept for the frame and separators, where
// receding is the whole point.
const BORDER_COLOR = "gray";
const TITLE_COLOR = "cyanBright";
const IDENTIFIER = "blue";
const REF = "magenta";

// Status colours, named by what they mean rather than what they look like. The
// meaning was previously carried only by repetition -- 28 inline literals across
// six values -- so a reader had to infer that redBright meant "failed" here and
// "critical" there.
//
// INERT and BORDER_COLOR are the same value on purpose and must stay separate
// names: one is chrome that should recede, the other is content that is
// genuinely de-emphasised. Merging them means the next person who retunes the
// frame colour silently restyles every skipped run.
const OK = "greenBright";
const BAD = "redBright";
const ATTENTION = "yellowBright";
const INERT = "gray";
const ERROR_TEXT = "red";

// `label` becomes the cell's text under INK_SCREEN_READER, where the icon
// column is otherwise a private-use codepoint that announces as nothing --
// leaving every row with no status at all. It is derived from the same lookup
// that picks the glyph, so the two cannot drift apart.
function Column({ width, grow, children, bold, color, dim, wrap, label }) {
  return e(
    Box,
    { width, flexGrow: grow ? 1 : 0, flexShrink: grow ? 1 : 0, marginRight: 1 },
    e(
      Text,
      { bold, color, dimColor: dim, wrap: wrap ?? "truncate-end", "aria-label": label },
      children,
    ),
  );
}

function HeaderCells({ cells }) {
  return e(
    Box,
    {
      flexDirection: "row",
      borderStyle: "single",
      borderTop: false,
      borderLeft: false,
      borderRight: false,
      borderColor: BORDER_COLOR,
    },
    ...cells.map((c, i) => e(Column, { key: i, ...c.props, bold: true, dim: true }, c.label)),
  );
}

// ---------- Panel frame ----------

// Ink can draw a border but not label one, so the horizontal edges are plain
// text and the box between them contributes only its verticals. Drawing them
// ourselves is what lets the tab name sit in the top edge and the row count in
// the bottom, the way lazygit labels its panels.
function PanelEdge({ width, top, label, labelColor }) {
  const [open, close] = top ? ["╭", "╮"] : ["╰", "╯"];
  const text = label ? ` ${label} ` : "";
  // The title hugs the left corner and the count the right, so each edge
  // spends a single dash on the side its label isn't on.
  const fill = width - 3 - text.length;
  // Too narrow to seat the label without wrapping the line: keep the frame,
  // drop the text.
  if (fill < 0) {
    return e(Text, { color: BORDER_COLOR, "aria-hidden": true }, open + "─".repeat(Math.max(0, width - 2)) + close);
  }
  return e(
    Text,
    { color: BORDER_COLOR, "aria-hidden": true },
    open,
    top ? "─" : "─".repeat(fill),
    e(Text, { color: labelColor, bold: true }, text),
    top ? "─".repeat(fill) : "─",
    close,
  );
}

// ---------- Error containment ----------

// Every field on screen is defined by GitHub and will keep changing shape. With
// the rows mapped straight into the tree, one unexpected value took the whole
// dashboard down -- and because the process sits in the alternate screen, the
// stack trace was wiped by the restore on the way out, so the tool simply
// vanished. A per-row boundary turns that into one visibly broken row.
class RowBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  // Reset when the underlying record changes, or a single bad row would keep
  // its slot blank long after the record that caused it is gone.
  static getDerivedStateFromProps(props, state) {
    return state.failed && props.resetKey !== state.key
      ? { failed: false, key: props.resetKey }
      : { ...state, key: props.resetKey };
  }

  render() {
    if (this.state.failed) {
      return e(Text, { color: BAD }, "! this row could not be rendered");
    }
    return this.props.children;
  }
}

// ---------- Actions tab ----------

// Four conclusions used to collapse into one grey glyph and timed_out was
// pixel-identical to a plain failure. Splitting them uses only codepoints
// already verified present in the glyph table above -- introducing new
// private-use codepoints risks rendering as a blank box, which is precisely the
// failure the unicode fallback exists to fix. Residual aliasing under NO_COLOR
// (timed_out vs action_required; skipped vs queued) is resolved by
// GH_GLANCE_ICONS=unicode, where every state has its own ASCII character.
const RUN_STATUS_ICON = {
  success: { icon: OCT.checkCircleFill, color: OK, label: "success" },
  failure: { icon: OCT.xCircleFill, color: BAD, label: "failed" },
  startup_failure: { icon: OCT.xCircleFill, color: BAD, label: "startup failure" },
  timed_out: { icon: OCT.alertFill, color: BAD, label: "timed out" },
  action_required: { icon: OCT.alertFill, color: ATTENTION, label: "action required" },
  cancelled: { icon: OCT.skipFill, color: INERT, label: "cancelled" },
  skipped: { icon: OCT.dotFill, color: INERT, label: "skipped" },
  neutral: { icon: OCT.dotFill, color: INERT, label: "neutral" },
  stale: { icon: OCT.dotFill, color: INERT, label: "stale" },
};
const RUN_UNKNOWN_ICON = { icon: "?", color: INERT, label: "unknown" };

// github.com draws a run that is actually executing as an amber circle with a
// turning segment, and one that is merely queued as the same amber standing
// still -- the motion, not the colour, is what separates them. With animation
// disabled there is no motion to distinguish them, so the running state falls
// back to the alert glyph rather than silently reading as queued.
const RUN_PENDING_ICON = { icon: OCT.dotFill, color: ATTENTION, label: "queued" };
const RUN_RUNNING_STATIC = { icon: OCT.alertFill, color: ATTENTION, label: "running" };

// Remote strings index these tables, and a plain object literal answers
// inherited keys -- `SEVERITY_COLOR["constructor"]` returned a function, which
// reaches ink's colour prop and throws, killing the render. `??` cannot catch
// that, because an inherited value is not nullish. Code-scanning severity comes
// from uploaded SARIF, so it is genuinely attacker-influenced.
function pick(table, key, fallback) {
  return typeof key === "string" && Object.hasOwn(table, key) ? table[key] : fallback;
}

function runStatusIcon(run, spin) {
  if (run.status === "in_progress") {
    return spin
      ? { icon: spin, color: ATTENTION, label: "running" }
      : RUN_RUNNING_STATIC;
  }
  if (run.status !== "completed") return RUN_PENDING_ICON;
  return pick(RUN_STATUS_ICON, run.conclusion, RUN_UNKNOWN_ICON);
}

const ACTIONS_HEADER = [
  { label: "", props: { width: 3 } },
  { label: "TITLE", props: { grow: true } },
  { label: "WORKFLOW", props: { width: 10 } },
  { label: "BRANCH", props: { width: 14 } },
  { label: "TIME", props: { width: 7 } },
  { label: "UPDATED", props: { width: 8 } },
];

// Dropped in order of least value first: BRANCH and WORKFLOW are inferable
// from the title far more often than the status icon or the age are.
const ACTIONS_HEADER_COMPACT = [
  { label: "", props: { width: 3 } },
  { label: "TITLE", props: { grow: true } },
  { label: "UPDATED", props: { width: 8 } },
];

function ActionsRow({ item, now, spin, compact, cursor }) {
  const { icon, color, label } = runStatusIcon(item, spin);
  const started = new Date(item.startedAt);
  const finished = item.status === "completed" ? new Date(item.updatedAt) : now;
  if (compact) {
    return e(
      Box,
      { flexDirection: "row" },
      e(Column, { width: 3, color, label }, `${cursor ? ">" : " "}${icon}`),
      e(Column, { grow: true }, item.displayTitle),
      e(Column, { width: 8, dim: true }, formatAge(new Date(item.updatedAt), now)),
    );
  }
  return e(
    Box,
    { flexDirection: "row" },
    e(Column, { width: 3, color, label }, `${cursor ? ">" : " "}${icon}`),
    e(Column, { grow: true }, item.displayTitle),
    // The run number is the actionable half and used to be the first thing
    // truncation ate, since it sat at the tail of a 10-column cell.
    e(Column, { width: 10, color: IDENTIFIER }, `#${item.number} ${item.workflowName}`),
    e(Column, { width: 14, color: REF, wrap: "truncate-middle" }, item.headBranch),
    e(Column, { width: 7 }, formatDuration(finished - started)),
    e(Column, { width: 8, dim: true }, formatAge(new Date(item.updatedAt), now)),
  );
}

// ---------- Issues tab ----------

const ISSUES_HEADER = [
  { label: "", props: { width: 3 } },
  { label: "TITLE", props: { grow: true } },
  { label: "AUTHOR", props: { width: 12 } },
  { label: "LABEL", props: { width: 14 } },
  { label: "UPDATED", props: { width: 8 } },
];

const ISSUES_HEADER_COMPACT = [
  { label: "", props: { width: 3 } },
  { label: "TITLE", props: { grow: true } },
  { label: "UPDATED", props: { width: 8 } },
];

function IssueRow({ item, now, compact, cursor }) {
  const cells = [
    e(Column, { key: "i", width: 3, color: OK, label: "open issue" }, `${cursor ? ">" : " "}${OCT.issueOpened}`),
    e(Column, { key: "t", grow: true }, `#${item.number} ${item.title}`),
  ];
  if (!compact) {
    cells.push(e(Column, { key: "a", width: 12, color: IDENTIFIER }, item.author));
    cells.push(e(Column, { key: "l", width: 14, color: REF }, item.label));
  }
  cells.push(
    e(Column, { key: "u", width: 8, dim: true }, formatAge(new Date(item.updatedAt), now)),
  );
  return e(Box, { flexDirection: "row" }, ...cells);
}

// ---------- Pull requests tab ----------

const PRS_HEADER = [
  { label: "", props: { width: 3 } },
  { label: "TITLE", props: { grow: true } },
  { label: "AUTHOR", props: { width: 12 } },
  { label: "BRANCH", props: { width: 14 } },
  { label: "REVIEW", props: { width: 10 } },
  { label: "UPDATED", props: { width: 8 } },
];

const PRS_HEADER_COMPACT = [
  { label: "", props: { width: 3 } },
  { label: "TITLE", props: { grow: true } },
  { label: "REVIEW", props: { width: 10 } },
];

const REVIEW_LABEL = {
  APPROVED: { label: "approved", color: OK },
  CHANGES_REQUESTED: { label: "changes", color: BAD },
  REVIEW_REQUIRED: { label: "pending", color: ATTENTION },
};
const REVIEW_NONE = { label: "", color: INERT };

function PRRow({ item, now, compact, cursor }) {
  const prIcon = item.isDraft
    ? { icon: OCT.pullRequestDraft, color: INERT, label: "draft pull request" }
    : { icon: OCT.pullRequest, color: OK, label: "open pull request" };
  const review = pick(REVIEW_LABEL, item.reviewDecision, REVIEW_NONE);
  const cells = [
    e(Column, { key: "i", width: 3, color: prIcon.color, label: prIcon.label }, `${cursor ? ">" : " "}${prIcon.icon}`),
    e(Column, { key: "t", grow: true }, `#${item.number} ${item.title}`),
  ];
  if (!compact) {
    cells.push(e(Column, { key: "a", width: 12, color: IDENTIFIER }, item.author));
    cells.push(
      e(Column, { key: "b", width: 14, color: REF, wrap: "truncate-middle" }, item.headRefName),
    );
  }
  cells.push(e(Column, { key: "r", width: 10, color: review.color }, review.label));
  if (!compact) {
    cells.push(
      e(Column, { key: "u", width: 8, dim: true }, formatAge(new Date(item.updatedAt), now)),
    );
  }
  return e(Box, { flexDirection: "row" }, ...cells);
}

// ---------- Security tab ----------

// Severity used to be carried by the shield glyph's colour alone, which made a
// critical alert and a high one pixel-identical (both redBright) and erased the
// distinction entirely under NO_COLOR or for a colour-blind reader. A 4-wide
// text column states it outright; the width comes out of PACKAGE / FILE, whose
// contents were already being truncated.
const SECURITY_HEADER = [
  { label: "", props: { width: 3 } },
  { label: "SEV", props: { width: 4 } },
  { label: "PACKAGE / FILE", props: { width: 16 } },
  { label: "SUMMARY", props: { grow: true } },
  { label: "AGE", props: { width: 8 } },
];

// SEV is the last thing to drop on this tab: it is the whole point of the pane
// and the only non-colour severity channel.
const SECURITY_HEADER_COMPACT = [
  { label: "", props: { width: 3 } },
  { label: "SEV", props: { width: 4 } },
  { label: "SUMMARY", props: { grow: true } },
];

const SEVERITY_STYLE = {
  critical: { color: BAD, short: "crit" },
  high: { color: BAD, short: "high" },
  medium: { color: ATTENTION, short: "med" },
  moderate: { color: ATTENTION, short: "med" },
  low: { color: INERT, short: "low" },
  unknown: { color: INERT, short: "?" },
};
const SEVERITY_UNKNOWN = SEVERITY_STYLE.unknown;

function SecurityRow({ item, now, compact, cursor }) {
  const sev = pick(SEVERITY_STYLE, item.severity, SEVERITY_UNKNOWN);
  const cells = [
    e(Column, { key: "i", width: 3, color: sev.color, label: `${sev.short} severity` }, `${cursor ? ">" : " "}${OCT.shield}`),
    e(Column, { key: "s", width: 4, color: sev.color }, sev.short),
  ];
  if (!compact) {
    cells.push(e(Column, { key: "p", width: 16, color: IDENTIFIER }, item.detail || item.kind));
  }
  cells.push(e(Column, { key: "t", grow: true }, item.title));
  if (!compact) {
    cells.push(
      e(Column, { key: "a", width: 8, dim: true }, formatAge(new Date(item.createdAt), now)),
    );
  }
  return e(Box, { flexDirection: "row" }, ...cells);
}

// ---------- Tabs ----------

const TABS = [
  {
    key: "actions",
    fetch: ({ signal, runLimit }) => fetchActions(runLimit, signal),
    label: "Actions",
    short: "Actions",
    header: ACTIONS_HEADER,
    compactHeader: ACTIONS_HEADER_COMPACT,
    Row: ActionsRow,
    countLabel: "runs",
  },
  {
    key: "issues",
    fetch: ({ signal }) => fetchIssues(signal),
    label: "Issues",
    short: "Issues",
    header: ISSUES_HEADER,
    compactHeader: ISSUES_HEADER_COMPACT,
    Row: IssueRow,
    countLabel: "open issues",
  },
  {
    key: "prs",
    fetch: ({ signal }) => fetchPRs(signal),
    label: "Pull requests",
    short: "PRs",
    header: PRS_HEADER,
    compactHeader: PRS_HEADER_COMPACT,
    Row: PRRow,
    countLabel: "open PRs",
  },
  {
    key: "security",
    fetch: ({ signal }) => fetchSecurity(signal),
    label: "Security",
    short: "Security",
    header: SECURITY_HEADER,
    compactHeader: SECURITY_HEADER_COMPACT,
    Row: SecurityRow,
    countLabel: "alerts",
  },
];

// The narrowest width each tab's table can render without its fixed columns
// overflowing the frame. Derived from the header descriptors rather than
// hard-coded, so adding or resizing a column cannot silently invalidate it.
// Below this the fixed columns (which deliberately do not shrink, so that
// BRANCH and TIME stay readable at ordinary widths) push past the terminal edge,
// the rows hard-wrap, and ink switches to clearing and repainting the whole
// screen every frame.
function minimumWidthFor(header) {
  const fixed = header.reduce((sum, cell) => sum + (cell.props.width ?? 0) + 1, 0);
  // + 2 border verticals, + 2 paddingX, + at least 4 columns for TITLE.
  return fixed + 8;
}
// Below this the full column set cannot render without its fixed columns
// overflowing the frame -- rows hard-wrap and ink switches to clearing and
// repainting the whole screen every frame. Worse, in the band just above the
// hard failure the frame still looked correct while the TITLE column silently
// rendered empty (measured: completely blank at 52 columns). So switch to the
// compact column set rather than letting either happen.
const MIN_TABLE_WIDTH = Math.max(...TABS.map((t) => minimumWidthFor(t.header)));
// The compact set needs roughly a third as much, so the frame, tab bar and
// status line survive at any width a terminal is realistically set to.
const MIN_COMPACT_WIDTH = Math.max(...TABS.map((t) => minimumWidthFor(t.compactHeader)));

// The tab bar is laid out independently of the table and wraps at its own
// width. Full labels need ~77 columns; short labels ~57. Hysteresis on the
// breakpoint so a pane parked exactly on it does not flip labels on every
// resize event and defeat the unchanged-frame optimization.
const TAB_LABEL_FULL_WIDTH = 78;
const TAB_LABEL_HYSTERESIS = 4;

function TabBar({ activeIndex, counts, firstLoad, failed, spin, useShort }) {
  return e(
    Box,
    { flexDirection: "row" },
    ...TABS.map((tab, i) => {
      const active = i === activeIndex;
      const count = counts[tab.key];
      // A tab that has never resolved shows the spinner where its count will
      // go, so the first load reads as "working" rather than "empty".
      const suffix = count == null ? (firstLoad[tab.key] ? ` ${spin}` : "") : ` (${count})`;
      const name = useShort ? tab.short : tab.label;
      // Bold and inverse are both stripped at chalk level 0 (NO_COLOR, or a
      // dumb terminal), which left no indication at all of which tab was
      // selected. Brackets survive; the padding they replace keeps the width
      // identical, so the bar does not shift between the two modes.
      const label = active ? `[${i + 1}:${name}${suffix}]` : ` ${i + 1}:${name}${suffix} `;
      return e(
        Box,
        { key: tab.key, marginRight: 2 },
        e(
          Text,
          {
            bold: active,
            inverse: active,
            // A tab whose fetches are failing kept rendering its last good
            // count at full confidence, and the error banner is only visible on
            // the tab you have selected -- so a background tab could fail for an
            // hour with nothing on screen to say so.
            color: failed[tab.key] ? "redBright" : undefined,
            dimColor: !active && !failed[tab.key],
            wrap: "truncate-end",
          },
          label,
        ),
      );
    }),
  );
}

// ---------- Status bar ----------

// Every glyph here is width-1 ASCII, deliberately. The arrows, the return
// symbol and the box-drawing separator are all East-Asian-Ambiguous: ink
// measures them as two columns in its width model, and a status bar built from
// them overflowed an 80-column terminal by six columns once selection added a
// hint. Same trap the unicode icon table already documents -- prefer strictly
// narrow ASCII over pretty-but-ambiguous.
//
// Tab switching is not listed: the tab bar already renders "1:Actions", so the
// digits document themselves, and the arrow keys are in --help. The hints that
// survive are the ones nothing else on screen reveals.
const KEY_HINTS = [
  { label: "Move", keys: "jk" },
  { label: "Open", keys: "Ent" },
  { label: "Refresh", keys: "r" },
  { label: "Quit", keys: "q" },
];

// Reserved so the hints don't shift sideways every time a refresh starts and
// finishes. Wide enough for the spinner, a space and "Fetching".
const FETCHING_WIDTH = 12;
// Likewise for the staleness slot, which is empty most of the time.
const STALE_WIDTH = 10;

// Two tones rather than one flat gray: the keys you press are the part worth
// finding at a glance, so they get the accent colour and the words describing
// them stay dim. The accent is the panel-title cyan rather than the amber used
// for in-progress status, so amber means exactly one thing across the product.
function StatusBar({ fetching, spin, stale, interactive }) {
  // Without raw mode none of the key handlers run, so advertising them would be
  // telling the user something untrue about what the app can do. Ctrl+C still
  // works there, because the tty delivers a real SIGINT.
  const hints = interactive
    ? KEY_HINTS
    : [{ label: "Quit", keys: "^C" }];
  return e(
    Box,
    { flexDirection: "row" },
    e(
      Box,
      { width: FETCHING_WIDTH, flexShrink: 0 },
      // Pinned to the resting frame when idle: the counter also drives the run
      // icons, so borrowing it here would set this turning while a workflow
      // executes -- saying "fetching" at a moment when nothing is being
      // fetched.
      e(
        Text,
        { color: fetching ? TITLE_COLOR : undefined, dimColor: !fetching },
        `${fetching && spin ? spin : SPINNER[0]} Fetching`,
      ),
    ),
    e(
      Box,
      { width: STALE_WIDTH, flexShrink: 0 },
      stale ? e(Text, { color: ATTENTION }, stale) : null,
    ),
    ...hints
      .flatMap((hint, i) => [
        i > 0 && e(Text, { key: `sep${i}`, color: BORDER_COLOR }, " | "),
        e(
          Text,
          { key: hint.label, wrap: "truncate-end" },
          e(Text, { dimColor: true }, `${hint.label}: `),
          e(Text, { color: TITLE_COLOR, bold: true }, hint.keys),
        ),
      ])
      .filter(Boolean),
  );
}

// ---------- Layout ----------

// Terminal size, and the label breakpoint that depends on it.
//
// The usableSize guard is applied on every read path, not just the first: pty
// wrappers and a terminal mid-resize report 0 or undefined, and taking either
// literally collapses the table. ink's own useWindowSize does not apply that
// fallback, which is why this stays hand-rolled.
function useTerminalSize(stdout) {
  const [size, setSize] = useState(() => ({
    rows: usableSize(stdout?.rows, DEFAULT_ROWS),
    cols: usableSize(stdout?.columns, DEFAULT_COLS),
    useShortLabels: usableSize(stdout?.columns, DEFAULT_COLS) < TAB_LABEL_FULL_WIDTH,
  }));

  useEffect(() => {
    if (!stdout) return;
    function onResize() {
      const cols = usableSize(stdout.columns, DEFAULT_COLS);
      const rows = usableSize(stdout.rows, DEFAULT_ROWS);
      setSize((previous) => {
        // Hysteresis on the label breakpoint: switch to short labels below it,
        // back to full only once comfortably above, so a pane dragged along the
        // boundary does not emit a different frame on every resize event.
        const useShortLabels = previous.useShortLabels
          ? cols < TAB_LABEL_FULL_WIDTH + TAB_LABEL_HYSTERESIS
          : cols < TAB_LABEL_FULL_WIDTH;
        // Same object when nothing moved, so a resize event that changes
        // nothing cannot cost a redraw.
        return previous.rows === rows &&
          previous.cols === cols &&
          previous.useShortLabels === useShortLabels
          ? previous
          : { rows, cols, useShortLabels };
      });
    }
    stdout.on("resize", onResize);
    return () => stdout.off("resize", onResize);
  }, [stdout]);

  return size;
}

// ---------- App ----------

function App() {
  const { stdout } = useStdout();
  const { isRawModeSupported } = useStdin();
  const { exit } = useApp();
  const [activeIndex, setActiveIndex] = useState(runtime.initialTabIndex);
  // `null` means "never resolved" -- distinct from `[]`, which means "resolved
  // and genuinely empty". The tab bar and the body render those differently.
  const [data, setData] = useState({ actions: null, issues: null, prs: null, security: null });
  const [meta, setMeta] = useState({
    actions: null,
    issues: null,
    prs: null,
    security: null,
  });
  const [securityNotes, setSecurityNotes] = useState([]);
  const [errors, setErrors] = useState({ actions: null, issues: null, prs: null, security: null });
  const [loading, setLoading] = useState({ actions: true, issues: true, prs: true, security: true });
  const [now, setNow] = useState(new Date());
  const { rows, cols, useShortLabels } = useTerminalSize(stdout);
  const [frame, setFrame] = useState(0);
  // Per tab, so switching away and back keeps your place. Keyed by item, and
  // both are plain state: they change only on a keypress, so an idle repo still
  // renders byte-identical frames and ink still writes nothing.
  const [selected, setSelected] = useState({});
  const [offset, setOffset] = useState({});

  const tab = TABS[activeIndex];
  const extraLines = (errors[tab.key] ? 1 : 0) + (tab.key === "security" ? securityNotes.length : 0);
  // Reserve lines for: the panel's top and bottom edges (2), the column header
  // and its separator (2), the tab bar (1) and the status line (1), plus a
  // 1-line safety margin. Slack is absorbed by the spacer in the tree below.
  const bodyRows = Math.max(1, rows - 7 - extraLines);

  // Read at fetch time rather than being a hook dependency, so dragging the
  // pane wider doesn't cancel and restart in-flight requests -- the next tick
  // simply asks for the new size.
  const runLimitRef = useRef(0);
  runLimitRef.current = Math.min(Math.max(bodyRows + 1, MIN_RUN_LIMIT), MAX_RUN_LIMIT);

  // Read inside the polling closure, which is created once on mount and must
  // not be torn down and rebuilt every time you press a tab key.
  const activeIndexRef = useRef(activeIndex);
  activeIndexRef.current = activeIndex;

  // An unfinished run's elapsed time is the only thing on screen that changes
  // faster than once a minute, so it decides how often `now` has to advance.
  const hasInProgressRef = useRef(false);
  hasInProgressRef.current = (data.actions ?? []).some((r) => r.status !== "completed");

  // Queued runs don't spin -- standing still is how they read as queued -- and
  // the icons only exist on the Actions tab, so a run turning behind another
  // tab would be ten redraws a second nobody can see.
  const hasRunningVisible =
    ANIMATE && tab.key === "actions" && (data.actions ?? []).some((r) => r.status === "in_progress");

  const inFlightRef = useRef({});
  const rawRef = useRef({});
  const cleanRef = useRef({});
  const fetchTabRef = useRef(null);
  const abortRef = useRef(null);

  const interactive = Boolean(isRawModeSupported);

  // useInput's handler is created before the render body computes the visible
  // slice, so the movement handlers read through a ref -- the same pattern the
  // poll loop uses for runLimitRef and activeIndexRef, and for the same reason:
  // the closure must see current values without being rebuilt on every change.
  const navRef = useRef({ items: [], key: null, bodyRows: 1, tabKey: "actions" });
  navRef.current = {
    items: data[tab.key] ?? [],
    key: selected[tab.key] ?? null,
    bodyRows,
    tabKey: tab.key,
  };
  const pageStep = Math.max(1, bodyRows - 1);

  const abortSelectionRef = useRef(null);

  function moveSelection(delta) {
    const { items, key: currentKey, bodyRows: rows_, tabKey } = navRef.current;
    if (items.length === 0) return;
    const current = currentKey == null ? -1 : items.findIndex((i) => itemKey(i) === currentKey);
    // From "nothing selected", down lands on the first row and up on the last,
    // which is what every list in this category does.
    const next =
      current === -1
        ? delta > 0
          ? 0
          : items.length - 1
        : Math.min(items.length - 1, Math.max(0, current + delta));
    setSelected((s) => ({ ...s, [tabKey]: itemKey(items[next]) }));
    // Keep the cursor on screen. Only the offset needed to reveal it changes,
    // so scrolling never jumps further than it has to.
    setOffset((o) => {
      const start = o[tabKey] ?? 0;
      const maxStart = Math.max(0, items.length - rows_);
      let nextStart = Math.min(start, maxStart);
      if (next < nextStart) nextStart = next;
      else if (next >= nextStart + rows_) nextStart = next - rows_ + 1;
      return nextStart === (o[tabKey] ?? 0) ? o : { ...o, [tabKey]: nextStart };
    });
  }

  function openSelected() {
    const { items, key: currentKey, tabKey } = navRef.current;
    const item = items.find((i) => itemKey(i) === currentKey);
    if (!item) return;
    const controller = new AbortController();
    abortSelectionRef.current = controller;
    // Fire and forget: a browser launch must not block the render loop, and a
    // failure surfaces through the tab's normal error line rather than as an
    // unhandled rejection.
    openInBrowser(tabKey, item, controller.signal).catch((err) => {
      setErrors((x) => ({ ...x, [tabKey]: shortErr(err) }));
    });
  }

  useInput(
    (input, key) => {
      if (input === "q" || key.escape) {
        exit();
      } else if (key.downArrow || input === "j") {
        moveSelection(1);
      } else if (key.upArrow || input === "k") {
        moveSelection(-1);
      } else if (key.pageDown) {
        moveSelection(pageStep);
      } else if (key.pageUp) {
        moveSelection(-pageStep);
      } else if (key.return) {
        openSelected();
      } else if (input === "r") {
        // Goes through the same per-tab in-flight guard as the poll loop, so
        // holding the key down cannot stack concurrent subprocesses.
        fetchTabRef.current?.(TABS[activeIndexRef.current].key);
      } else if (input >= "1" && input <= String(TABS.length)) {
        setActiveIndex(Number(input) - 1);
      } else if (key.tab && key.shift) {
        setActiveIndex((i) => (i - 1 + TABS.length) % TABS.length);
      } else if (key.tab || key.rightArrow) {
        setActiveIndex((i) => (i + 1) % TABS.length);
      } else if (key.leftArrow) {
        setActiveIndex((i) => (i - 1 + TABS.length) % TABS.length);
      }
    },
    // `isActive` has to be coerced: ink only skips raw mode when the flag is
    // strictly `false`, and Node reports `stdin.isTTY` as `undefined` -- not
    // `false` -- when stdin isn't a terminal. Passing the raw value through
    // would let ink call setRawMode() on a non-TTY stdin and throw on startup.
    { isActive: interactive },
  );

  // Deliberately mount-only. Every value this closure needs is read through a
  // ref (runLimitRef, activeIndexRef, hasInProgressRef) precisely so the
  // interval is created exactly once. Adding `activeIndex`, `bodyRows` or
  // `data` to the dependency array would tear down and rebuild the poll loop on
  // every tab keypress and every terminal resize, cancelling in-flight requests
  // -- the behaviour the per-tab guard and the fetch-time limit read were
  // written to prevent. Do not "fix" this by adding them.
  //
  // exhaustive-deps is satisfied as written -- every captured value is either a
  // ref or a setState function, both of which the rule treats as stable -- so
  // this needs no suppression, and if one ever becomes necessary that is the
  // signal that a real dependency crept in.
  useEffect(() => {
    let cancelled = false;
    let ticks = 0;
    const controller = new AbortController();
    abortRef.current = controller;

    // Each tab commits its own result the moment it lands instead of waiting on
    // a Promise.allSettled barrier. Actions is by far the slowest fetch, so
    // barrelling everything together meant the three fast tabs sat invisible
    // behind it and nothing at all appeared until the slowest call returned.
    function commit(key, run) {
      // Per-tab rather than one flag for the whole tick, so switching tabs can
      // refresh the tab you just landed on without waiting on an unrelated
      // background fetch -- and so a slow repo can't stack refreshes.
      if (inFlightRef.current[key]) return Promise.resolve();
      inFlightRef.current[key] = true;
      setLoading((l) => (l[key] ? l : { ...l, [key]: true }));
      return run()
        .then((result) => {
          if (cancelled) return;
          const { raw, parse, limit } = result;
          // Identical payload: skip the parse *and* the state update. Returning
          // the same state object makes React bail out of the re-render, so an
          // idle repo stops redrawing the pane entirely.
          //
          // The cache write used to happen *before* parse(), so a payload that
          // threw was still cached -- and on the next tick the error was cleared
          // at the top of this handler and the early return fired before parse()
          // could be retried, leaving the tab permanently showing "no runs" with
          // no error at all. Both now happen only after a successful parse.
          if (rawRef.current[key] === raw && cleanRef.current[key]) {
            setErrors((x) => (x[key] === null ? x : { ...x, [key]: null }));
            return;
          }
          const value = parse();
          rawRef.current[key] = raw;
          cleanRef.current[key] = true;
          setErrors((x) => (x[key] === null ? x : { ...x, [key]: null }));
          setData((d) => ({ ...d, [key]: value.alerts ?? value }));
          setMeta((m) => ({
            ...m,
            [key]: {
              at: Date.now(),
              // Compare against the limit this payload was actually fetched
              // with. Comparing against the live pane-height ref made the "n+"
              // marker lie for one cycle after every resize.
              truncated: value.truncated ?? (value.alerts ?? value).length >= limit,
            },
          }));
          if (value.notes) setSecurityNotes(value.notes);
        })
        .catch((err) => {
          if (cancelled || err?.name === "AbortError") return;
          cleanRef.current[key] = false;
          setErrors((x) => ({ ...x, [key]: shortErr(err) }));
        })
        .finally(() => {
          inFlightRef.current[key] = false;
          if (!cancelled) setLoading((l) => (l[key] ? { ...l, [key]: false } : l));
        });
    }

    function fetchTab(key) {
      const signal = controller.signal;
      const descriptor = TABS.find((t) => t.key === key);
      // Every tab carries its own fetcher on the registry, so adding a tab is a
      // TABS entry plus a fetcher rather than an entry plus an edit to a chain
      // in a different part of the file.
      return commit(key, () => descriptor.fetch({ signal, runLimit: runLimitRef.current }));
    }
    fetchTabRef.current = fetchTab;

    async function tick() {
      // Only the tab you're looking at needs to keep up with REFRESH_MS. The
      // other three exist to keep the tab-bar counts honest, which tolerates
      // being a minute behind -- so they refresh every BACKGROUND_EVERY ticks
      // instead, which is what keeps steady-state API usage off the rate limit.
      const active = TABS[activeIndexRef.current].key;
      const due = ticks % BACKGROUND_EVERY === 0 ? TABS.map((t) => t.key) : [active];
      ticks += 1;
      await Promise.allSettled(due.map(fetchTab));
      if (cancelled) return;
      // Advancing `now` is what forces a redraw, so only do it when it can
      // actually change what's on screen: durations of in-progress runs tick
      // every second, but every other age is minute-granular.
      setNow((prev) =>
        hasInProgressRef.current || Date.now() - prev.getTime() >= 60_000 ? new Date() : prev,
      );
    }

    tick();
    const id = setInterval(tick, runtime.refreshMs);
    return () => {
      cancelled = true;
      clearInterval(id);
      // `cancelled` stops state updates from a promise that already resolved;
      // the signal stops the subprocess itself, so quitting doesn't orphan up to
      // six `gh` children mid-request. They cover different windows and both are
      // needed.
      controller.abort();
    };
  }, []);

  // Background tabs can be up to BACKGROUND_EVERY ticks stale, so the tab you
  // switch to refreshes straight away rather than showing old data until its
  // slot next comes round. On mount this is a no-op: the initial tick already
  // has every tab in flight, and the per-tab guard rejects the duplicate.
  useEffect(() => {
    fetchTabRef.current?.(TABS[activeIndex].key);
  }, [activeIndex]);

  // Animate only when something on screen is genuinely moving. `loading` flips
  // true then false on *every* tick, including one that changed nothing, so
  // driving the spinner from it meant the 100ms interval restarted every 5
  // seconds forever -- roughly 44MB of terminal writes and 27 CPU-seconds per
  // idle hour, and the exact opposite of the redraw suppression above. The
  // first load genuinely is worth animating, because an empty pane with no
  // motion reads as broken; after that, only a run actually executing is.
  const firstLoad = Object.fromEntries(TABS.map((t) => [t.key, data[t.key] == null]));
  const anyFirstLoad = Object.values(firstLoad).some(Boolean);
  const showSpinner = ANIMATE && (anyFirstLoad || hasRunningVisible);
  useEffect(() => {
    if (!showSpinner) {
      // Park on a fixed frame rather than freezing wherever the animation
      // happened to stop: the resting glyph is then the same every time, so
      // consecutive idle frames stay byte-identical and Ink writes nothing.
      setFrame(0);
      return;
    }
    const id = setInterval(() => setFrame((f) => (f + 1) % SPINNER.length), SPINNER_MS);
    return () => clearInterval(id);
  }, [showSpinner]);

  const items = data[tab.key];
  const error = errors[tab.key];
  const spin = SPINNER[frame % SPINNER.length];

  const counts = Object.fromEntries(
    TABS.map((t) => {
      const list = data[t.key];
      if (list == null) return [t.key, null];
      // Every tab can be truncated, not just Actions: issues and PRs cap at
      // LIST_LIMIT and alerts at one page of 100. Reporting those as exact made
      // the count stop moving through a genuine change on any repo big enough
      // for this tool to matter.
      return [t.key, `${list.length}${meta[t.key]?.truncated ? "+" : ""}`];
    }),
  );
  const failed = Object.fromEntries(TABS.map((t) => [t.key, Boolean(errors[t.key])]));

  // Data can be arbitrarily old without anything on screen saying so: a failing
  // poll only surfaces on the tab you have selected, and after a laptop sleep
  // every pane is plausible and wrong. Threshold-gated and minute-granular on
  // purpose -- see STALE_AFTER_MS.
  const lastOk = meta[tab.key]?.at;
  const staleFor = lastOk == null ? null : now.getTime() - lastOk;
  const staleThreshold = Math.max(STALE_AFTER_MS, runtime.refreshMs * 6);
  const staleLabel =
    staleFor != null && staleFor > staleThreshold
      ? `stale ${formatDuration(Math.min(staleFor, 359_999_000))}`
      : null;

  const allItems = items ?? [];
  const tabOffsetRaw = offset[tab.key] ?? 0;
  // Re-clamped on every render rather than only on resize: the payload can
  // shrink under us between ticks, and a stale offset would render an empty
  // body while the count in the frame said otherwise.
  const maxOffset = Math.max(0, allItems.length - bodyRows);
  const tabOffset = Math.min(tabOffsetRaw, maxOffset);
  const visibleItems = allItems.slice(tabOffset, tabOffset + bodyRows);

  // Matched by key, never by position. If the selected item is gone -- closed,
  // merged, or aged out of the fetch window -- no row matches and nothing is
  // highlighted, which is the honest state; the next arrow key selects from the
  // top again. Resolving to a neighbouring index instead would silently move
  // the cursor onto an unrelated row.
  const selectedKey = selected[tab.key] ?? null;
  // Bottom-right of the frame, lazygit style: how much of the tab you can
  // currently see out of how much there is.
  const countLabel =
    items == null
      ? null
      : tabOffset > 0
        ? `${tabOffset + 1}-${tabOffset + visibleItems.length} of ${counts[tab.key]}`
        : `${visibleItems.length} of ${counts[tab.key]}`;

  // Fixed columns deliberately do not shrink, so BRANCH and TIME stay readable
  // at ordinary widths. Narrow panes drop columns instead, which keeps the
  // frame, the tab bar and the quit hint on screen -- the previous behaviour
  // pushed all three off the bottom.
  const compact = cols < MIN_TABLE_WIDTH;
  const header = compact ? tab.compactHeader : tab.header;

  return e(
    Box,
    { flexDirection: "column", width: "100%", height: rows },
    e(PanelEdge, { width: cols, top: true, label: tab.label, labelColor: TITLE_COLOR }),
    e(
      Box,
      {
        flexDirection: "column",
        flexGrow: 1,
        paddingX: 1,
        // Only the verticals: the labelled edges above and below are drawn as
        // text, and a border here too would double them up.
        borderStyle: "round",
        borderColor: BORDER_COLOR,
        borderTop: false,
        borderBottom: false,
      },
      // truncate-end is what makes the one-line reservation in `extraLines`
      // true by construction. Predicting the wrapped height instead would mean
      // duplicating ink's width model, and would still be wrong on resize.
      error && e(Text, { color: ERROR_TEXT, wrap: "truncate-end" }, error),
      tab.key === "security" &&
        securityNotes.map((note, i) =>
          e(Text, { key: i, dimColor: true, wrap: "truncate-end" }, note),
        ),
      e(HeaderCells, { cells: header }),
      ...visibleItems.map((item) => {
        const key = itemKey(item);
        return e(
          RowBoundary,
          { key, resetKey: key },
          e(tab.Row, {
            item,
            now,
            compact,
            cursor: key === selectedKey,
            spin: showSpinner ? spin : null,
          }),
        );
      }),
      // Distinguishes "still fetching" from "resolved and empty" in the body,
      // which is the difference between a dashboard that looks hung and one
      // that looks correct. Driven by "never resolved" rather than by the
      // loading flag, which toggles on every tick and made a settled-empty tab
      // swap its message every five seconds.
      visibleItems.length === 0 &&
        e(
          Text,
          { dimColor: true },
          firstLoad[tab.key]
            ? `${showSpinner ? spin : SPINNER[0]} loading ${tab.label.toLowerCase()}…`
            : tab.key === "security" && securityNotes.length === ALERT_SOURCES.length
              ? "no alert sources available"
              : `no ${tab.countLabel}`,
        ),
      // Pushes the panel's bottom edge down to the foot of the pane, so the
      // frame stays put instead of closing up under the column headers on a
      // tab that only has a handful of rows.
      e(Box, { flexGrow: 1 }),
    ),
    e(PanelEdge, { width: cols, top: false, label: countLabel, labelColor: BORDER_COLOR }),
    e(TabBar, {
      activeIndex,
      counts,
      firstLoad,
      failed,
      spin,
      useShort: useShortLabels,
    }),
    e(StatusBar, {
      fetching: Object.values(loading).some(Boolean),
      spin: showSpinner ? spin : null,
      stale: staleLabel,
      interactive,
    }),
  );
}

// ---------- Terminal lifecycle ----------

// Enter the alternate screen buffer, same as lazygit/htop/vim, so the shell
// prompt and the command that launched this script scroll out of view instead
// of sitting above the dashboard.
function enterAlternateScreen() {
  process.stdout.write("\x1b[?1049h\x1b[2J\x1b[H");
}

// Idempotent by construction: writing the exit sequence while already on the
// primary buffer is a no-op, which matters because this runs both from the
// crash handlers and from the `exit` listener. `?25h` is here because ink only
// restores cursor visibility through its own unmount path, which an explicit
// process.exit() skips.
let screenRestored = false;
function restoreScreen() {
  if (screenRestored) return;
  screenRestored = true;
  process.stdout.write("\x1b[?25h\x1b[?1049l");
}

// A crash used to be indistinguishable from a clean quit. Ink catches render
// errors and draws them -- into the alternate screen, which the exit handler
// then discarded -- and nothing ever set a non-zero exit code, so the dashboard
// simply vanished and any wrapper saw success. Restore the primary buffer
// *first*, then write, or the fix reproduces the problem it is fixing.
function installCrashHandlers() {
  const fail = (label) => (err) => {
    restoreScreen();
    console.error(`gh-glance: ${label}`);
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  };
  process.on("uncaughtException", fail("crashed"));
  process.on("unhandledRejection", fail("unhandled promise rejection"));
}

if (IS_MAIN) {
  disarmDevBuildLeak();
  installCrashHandlers();
  enterAlternateScreen();
  process.on("exit", restoreScreen);

  const app = render(e(App));

  // 128 + signal number, so a supervisor or `timeout` can tell an interrupted
  // run from a clean one. These fire on external `kill` and when raw mode is
  // unavailable; the ordinary Ctrl+C path goes through ink's own handler.
  //
  // Unmounting before restoring is load-bearing, not tidiness. signal-exit runs
  // our own `exit` listener ahead of ink's teardown, so simply exiting here let
  // restoreScreen hand the terminal back to the primary buffer *first* and ink
  // then repainted onto it -- and because the root Box is `height: rows` the
  // frame always exactly fills the viewport, so that repaint takes ink's
  // `isUnmounting && previousOutputHeight >= viewportRows` branch and is
  // preceded by \x1b[2J\x1b[3J. \x1b[3J erases the scrollback, so a `kill` threw
  // away the user's terminal history and left a dead dashboard behind it
  // (measured: 2,728 bytes on an 80x24 pane).
  //
  // Unmounting first puts that final repaint inside the alternate screen, where
  // restoreScreen discards it -- which is the ordering the q/Esc path already
  // gets for free through ink's own handleExit. ink's final layout and render
  // are synchronous, so the repaint has landed by the time we restore, and
  // exiting immediately afterwards keeps the prompt-exit guarantee: waiting for
  // the event loop to drain would let a hung `gh` turn Ctrl+C into an apparent
  // hang.
  const bySignal = (code) => () => {
    try {
      app.unmount();
    } catch {
      // Teardown is best effort. restoreScreen below, and the `exit` listener
      // above, both still run, so the terminal is handed back either way.
    }
    restoreScreen();
    process.exit(code);
  };
  process.on("SIGINT", bySignal(130));
  process.on("SIGTERM", bySignal(143));
  process.on("SIGHUP", bySignal(129));
}

// Exported for unit tests. The dashboard itself is still one file; these are
// the pure functions worth pinning, and nothing here is part of the public API.
export {
  parseArgs,
  validateArgs,
  REPO_PATTERN,
  MIN_REFRESH_SECONDS,
  MAX_REFRESH_SECONDS,
  TAB_KEYS,
  safe,
  shortErr,
  isUnavailable,
  isRateLimited,
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
  MIN_COMPACT_WIDTH,
  OCT_NERD,
  OCT_UNICODE,
};
