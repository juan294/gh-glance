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

import { execFile, spawn } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const requestIdentityStorage = new AsyncLocalStorage();

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

// The row cursor otherwise persists forever once you touch a movement key --
// useful while you're actually scanning a list, noise once you've moved on and
// left the pane running in a corner of the screen. 60s idle (measured from the
// last movement, not from tab switches or Enter) quietly drops it.
const SELECTION_IDLE_MS = 60_000;

// How long a first fetch has to still be unresolved before the loading line
// offers the Nerd Font escape hatch. The hint used to be unconditional, which
// put a line naming an environment variable in front of every user on every
// start to catch the minority whose terminal cannot draw the glyphs -- a dim
// "loading actions…" reads as "working", the same line with a remedy attached
// reads as a warning, and it was on screen for the whole first fetch every time.
//
// The threshold is set from the fetch that actually gates it, not from a round
// number: the hint hangs off the *visible* tab's loading line, and the tab you
// land on is Actions, whose `gh run list` is by far the slowest call here
// (measured against this repo: issues/PRs/alerts resolve 0.6-1.1s after the
// first frame, runs 1.4-3.0s). 1.5s would have fired on most ordinary starts --
// i.e. changed nothing. 3s sits past the slow end of that range, so a start that
// reaches it is genuinely stuck rather than merely fetching, which is exactly
// the moment the remedy is worth a line.
const ICON_HINT_AFTER_MS = 3000;

// `gh run list` costs roughly linearly in --limit (measured: ~1.2s at 20 runs,
// ~3.0s at 100, ~4.9s at 150), so asking for a fixed 150 to render ~35 visible
// rows was paying several seconds per refresh for rows nobody sees. Actions is
// a scrolling log whose count is arbitrary anyway, so it fetches only what the
// pane can show -- one extra row tells us whether to render the count as "n+".
// One stable request, not a pane-height-derived one. The limit used to track
// the terminal's height, which meant two panes of different sizes asked two
// different questions about the same repository: neither could reuse the
// other's validator, and a resize invalidated the ETag for nothing. 60 is the
// old ceiling -- above it a fetch outlasts REFRESH_MS and ticks are absorbed by
// the in-flight guard -- and it comfortably covers the tallest pane.
const ACTIONS_RUN_LIMIT = 60;

// The workflow catalog is now a fallback for runs whose own `name` is missing,
// so it is worth caching for long enough that it costs nothing on a normal
// session and short enough that a workflow renamed today shows up today.
const WORKFLOW_CATALOG_TTL_MS = 15 * 60_000;

// Issues and PRs are sets rather than logs: the count *is* the signal, so these
// stay generous. They are also far cheaper, being bounded by what's open.
const LIST_LIMIT = 150;

// Alert endpoints are filtered server-side to open items and every lane is
// capped at one page. The previous --paginate walked the repo's entire alert
// history -- mostly closed alerts -- and then discarded them client-side.
const ALERT_PER_PAGE = 100;
// Newest-first makes the base cut deterministic. When it fills, bounded
// critical/high lanes for the sources that support severity filtering recover
// priority rows beyond that cut; a full lane remains explicitly incomplete.
// Secret scanning has no severity filter and every row is critical, so its one
// newest lane is the honest bounded shape. All three endpoints accept the base
// parameters below.
const ALERT_QUERY = `?state=open&per_page=${ALERT_PER_PAGE}&sort=created&direction=desc`;

// Inactive tabs only feed the tab-bar counts. One rotating background tab is
// considered per wake, so each inactive tab is considered about every Nth floor
// instead of all three starting together. The shared governor can schedule
// either active or background demand later when that is the safe resource slot.
const BACKGROUND_EVERY = 12;

// The cadence table. A floor is a floor and never a ceiling: every entry below
// is the *earliest* normal check, so `--refresh 120` still means 120 seconds.
//
// Running or queued Actions are the one thing worth asking about faster than a
// quiet repository, and 5s is fast enough that a run's transition is visible
// while it still means something.
const POLL_ACTIVE_CI_MS = 5_000;
// Two successful unchanged observations, not one. A single 304 is not evidence
// that a repository is quiet, and slowing to the quiet cadence on it would
// delay the first real change by a whole interval for no reason.
const POLL_QUIET_AFTER = 2;
const POLL_QUIET_MS = Object.freeze({
  actions: 30_000,
  issues: 30_000,
  prs: 30_000,
  // Alerts are the slowest-moving surface here and the most expensive to read.
  security: 60_000,
});
// Inactive demand only feeds the tab-bar counts, so it is paced by whichever is
// slower: this app's own background interval, or BACKGROUND_EVERY floors.
const POLL_BACKGROUND_MS = Object.freeze({
  actions: 120_000,
  issues: 120_000,
  prs: 120_000,
  security: 300_000,
});
// What one fetch of each tab costs lives in REST_PER_FETCH / GRAPHQL_PER_FETCH,
// declared with ALERT_SOURCES below because the security figure derives from it.

// A stalled `gh` used to wedge a tab permanently: the promise never settled, so
// the in-flight guard was never cleared and that tab stopped fetching for the
// life of the process while the spinner kept insisting it was working. The
// timeout has to clear the slowest *legitimate* fetch by a wide margin -- the
// ACTIONS_RUN_LIMIT note above measures ~4.9s at 150 runs -- so it sits far above
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

// An auth failure is the opposite kind of thing: the user fixes it in seconds
// by re-authorizing in the browser, so a ladder measured in half-hours would
// leave the tab blank long after the cause was gone. A single short step keeps
// recovery bounded at ~30s while still bounding what a lapse that lasts all
// night costs -- two probes a minute per endpoint rather than one per tick.
const AUTH_RETRY_MS = [30_000];

// Past this, the active tab's data is old enough to say so. Deliberately
// coarse: `now` only advances on minute boundaries when nothing is in progress,
// so a minute-granular staleness label costs zero extra redraws, whereas a
// live "updated Ns ago" would make every frame differ and undo the
// byte-identical-idle-frame property the rest of this file works to keep.
const STALE_AFTER_MS = 30_000;

// A coordination hold must persist long enough to be meaningful before it
// takes the notice row. Short startup and lock-contention states recover on
// their own and should not present themselves as user-visible failures.
const COORDINATION_NOTICE_AFTER_MS = 2_000;

// Mutable because the fetchers below are defined before argv is parsed, and the
// argv block is what fills this in. Everything here has a working default, so
// the zero-argument invocation the README documents behaves exactly as before.
const runtime = {
  repo: null, // null means "let gh infer it from the git remote", as today
  // null unless the target was host-qualified. `gh` accepts [HOST/]OWNER/REPO;
  // when a host is present the list subcommands get it inside --repo and the
  // `gh api` calls get it as --hostname, because gh api has no --repo and would
  // otherwise silently query github.com while the other tabs read the tenant.
  host: null,
  repoExplicit: false,
  refreshMs: REFRESH_MS,
  background: "all",
  verbose: false,
  initialTabIndex: 0,
};
let runtimeRemoteUrls = [];

// The four tab keys, needed by --tab validation which runs long before the TABS
// table itself is built.
const TAB_KEYS = ["actions", "issues", "prs", "security"];

// The classic "dots" braille spinner lights only 1-2 of a cell's 8 dot
// positions per frame, and different frames light different corners --
// so next to the solid Nerd Font circle icons used for completed runs, it
// visibly jitters instead of holding a steady center. This set lights 6-7
// dots per frame, reading as a filled blob that matches the circle icons'
// visual weight while staying in the same width-1 braille block.
const SPINNER = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"];
// 200ms, not 100: the spinner is the single largest CPU term in the app, because
// every frame makes ink rebuild and diff the whole output string. Measured on a
// 40-row pane: 100ms costs 7.8% of a core and 9.8 MB/hr of terminal writes,
// 200ms costs 3.9% and 5.2 MB/hr, against a 0.33% idle floor. The motion is
// load-bearing -- it is the only thing separating an executing run from a queued
// one (see RUN_RUNNING_STATIC) -- so it may be slowed but never stopped. Eight
// frames at 200ms is a 1.6s cycle, still well inside one refresh.
const SPINNER_MS = 200;

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
// Strip C0, DEL, C1 -- and the explicit bidi overrides/isolates. Emoji (including ZWJ sequences and variation
// selectors), CJK and other wide characters, combining marks and RTL text must
// survive untouched -- ink's width arithmetic depends on measuring them
// correctly, and the app's own Nerd Font glyphs live in the private use area, so
// anything shaped like "strip non-ASCII" would erase every status icon on
// screen. Control runs collapse to a single space rather than being deleted, so
// "a\nb" reads as "a b" rather than "ab".
//
// U+202A-U+202E and U+2066-U+2069 (LRE/RLE/PDF/LRO/RLO and the isolates) are
// stripped in a *separate* pass because they must be deleted rather than
// collapsed to a space: ink measures them as zero columns, so replacing one with
// a space would add a visible column and shift every cell to its right -- the
// exact desync this file works to avoid. Without this, one RLO in an issue title
// makes the rest of that cell render reversed on any terminal with bidi
// reordering, so the row displays something other than its data. Deliberately
// NOT extended to U+200E/U+200F or to general category Cf: those are how
// legitimate mixed-direction Arabic and Hebrew titles render correctly, and
// preserving real RTL text is a stated property of this function.
// eslint-disable-next-line no-control-regex -- matching control characters is the entire purpose
const CONTROL_CHARS = /[ --]+/g;
const BIDI_OVERRIDES = /[‪-‮⁦-⁩]/g;

// Titles are rendered at whatever length GitHub returns, and ink memoizes
// wrapped text in a module-level cache it never evicts -- so unbounded remote
// strings are unbounded retention in a process meant to run for hours. Clamp
// far above any realistic column width so ink's own ellipsis stays what the user
// actually sees, and clamp by codepoint: slicing mid-surrogate produces a string
// whose measured width disagrees with what the terminal draws, which
// desynchronizes every column to its right.
const MAX_FIELD_LENGTH = 300;

function safe(value) {
  // Coerce first, sanitize always. Returning a non-string early skipped both the
  // control-character strip and the length clamp, so an array or an object with a
  // toString() came through untouched -- `safe(["[2Jx"])` returned the escape
  // verbatim. GitHub returns strings for every field this is called on today, so
  // the guarantee was being provided by the upstream schema rather than by the
  // function that claims to provide it.
  const value_ = typeof value === "string" ? value : value == null ? "" : String(value);
  const cleaned = value_.replace(BIDI_OVERRIDES, "").replace(CONTROL_CHARS, " ").trim();
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

// Where gh's diagnosis actually lives on a rejected execFile: stderr carries
// the HTTP line, and message is all a missing binary or a spawn failure leaves
// behind. One expression rather than one per predicate, so a fourth predicate
// cannot pick a fifth answer to the same question.
function errText(err) {
  return String(err?.stderr ?? err?.message ?? "");
}

// `gh api` puts the HTTP status in stderr and exits 1, so err.code is the
// process exit code and says nothing about the cause. 403/404 is the honest
// "you can't see this here" -- everything else (auth expiry, rate limiting,
// DNS, a 502) is a real failure that used to be reported as a confident,
// plausible, and wrong claim that the feature was switched off.
// The GraphQL variant is matched as two fixed substrings rather than one
// `.*`-joined regex: CodeQL (js/polynomial-redos) flags a wildcard spanning
// attacker-influenced text -- a repository name gh echoes back verbatim --
// as worst-case superlinear. Two `includes` calls are index-scan cheap
// regardless of what sits between the markers and carry no backtracking risk.
function isUnavailable(err) {
  const text = errText(err);
  const lower = text.toLowerCase();
  return (
    /HTTP (403|404)/.test(text) ||
    (lower.includes("could not resolve to a repository with the name") &&
      lower.includes("(repository)"))
  );
}

function isRateLimited(err) {
  return /rate limit|secondary rate|API rate limit/i.test(errText(err));
}

// On an enterprise or EMU tenant a 403 carries meanings it never carries on a
// personal account: an expired SAML session, a credential not authorized for
// the org, a token missing a scope. None of those are statements about the
// repository's configuration, and all of them are fixed by the user in seconds
// -- so they must surface as themselves rather than as "not enabled", and must
// not latch the hour-long backoff.
//
// Written broad on purpose. A message that fails to match degrades to the old
// behaviour, and `--doctor` reports the verbatim text plus the classification
// it received, so the pattern is tightened from evidence. A false positive
// merely retries every 30s instead of backing off, which is cheap and
// self-correcting. The asymmetry favours breadth.
// `access restriction` is what catches the OAuth App restrictions form, which
// says "you appear to have the correct authorization credentials" and so
// matches none of the negative markers -- it is an authorization failure phrased
// entirely in the positive. It stays clear of the genuine not-enabled messages,
// which talk about features rather than access.
const AUTH_MARKERS =
  /SAML|single[- ]sign[- ]on|\bSSO\b|must grant|not authoriz|unauthoriz|access restriction|Bad credentials|requires authentication|re-?authoriz|token .*scope|missing .*scope|insufficient|not logged into any GitHub hosts|To get started with GitHub CLI|run: gh auth login|none of the git remotes[\s\S]*known GitHub host/i;

function isAuthProblem(err) {
  return AUTH_MARKERS.test(errText(err));
}

// A local repository with no remote is an onboarding state, not an API or
// authentication failure. Both strings are emitted by current gh commands:
// list commands include the "failed to determine base repo" prefix, while
// `gh repo view` returns the shorter form.
function isMissingRemote(err) {
  return /(?:failed to determine base repo:\s*)?no git remotes found/i.test(errText(err));
}
// The shorter of the two, so a verdict recorded without a gh subprocess reads
// exactly like one gh produced and classifies the same way.
const NO_REMOTE_ERROR_TEXT = "no git remotes found";

const UNUSABLE_OUTPUT_CODE = "GH_GLANCE_UNUSABLE_OUTPUT";

// Only JSON parsed from a successful gh stdout stream goes through this seam.
// Marking the SyntaxError here distinguishes our own failed parse from a gh
// stderr message that happens to use the same words.
function parseJsonOutput(raw) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    if (error instanceof SyntaxError) error.code = UNUSABLE_OUTPUT_CODE;
    throw error;
  }
}

function isUnusableOutput(err) {
  return err?.code === UNUSABLE_OUTPUT_CODE;
}

// The one place the three predicates are turned into a verdict. Both consumers
// go through it -- the fetcher, to choose a note and a backoff ladder, and
// `--doctor`, to report what gh-glance concluded -- so the report cannot claim
// a classification the dashboard does not actually make. Deriving the order
// twice would let exactly that drift in the moment it mattered most: AUTH_MARKERS
// is deliberately broad and expected to grow, and the day it grows into a
// message the rate-limit pattern also matches is the day two copies disagree.
//
// The order is a priority, not a sequence of independent tests. Rate limiting
// arrives as a 403 and means the opposite of a permissions problem, so it
// outranks the auth markers; both outrank "unavailable", which is the reading
// of last resort for a 403/404 and the only one that makes a claim about the
// repository's configuration.
function classify(err) {
  if (err == null) return "ok";
  if (isMissingRemote(err)) return "no-remote";
  if (isRateLimited(err)) return "rate-limited";
  if (isAuthProblem(err)) return "auth-problem";
  if (isUnavailable(err)) return "unavailable";
  if (isUnusableOutput(err)) return "unusable-output";
  return "other";
}

// What to put on screen for a verdict, in the voice the preflight already uses:
// say what to do, not what the subprocess printed. The three tabs built on list
// commands used to render raw `gh` stderr, so the failures people actually hit --
// expired auth, a rate limit, a dropped network -- arrived as an untranslated
// fragment of somebody else's CLI with no statement of what to do about it,
// while the alert path one tab over had been classifying and translating all
// along.
//
// `other` is deliberately absent. It is the unclassified bucket, and the raw
// message is the most useful thing available for it -- inventing a remedy for a
// failure nobody recognised would be worse than showing what happened. That
// matters more than it looks: AUTH_MARKERS is deliberately broad, and a false
// positive that only picked a retry ladder was cheap, whereas one that also
// rewrites the on-screen text turns into a confidently wrong instruction.
const VERDICT_REMEDY = {
  "no-remote":
    "No GitHub remote found -- press Enter to create one, or use `gh-glance --repo owner/name`",
  "auth-problem":
    "GitHub login or authorization required -- run `gh auth status`, then `gh auth login` or `gh auth refresh`",
  "rate-limited": "GitHub rate limit reached -- backing off, this clears on its own",
  unavailable:
    "Repository not found or inaccessible to the active `gh` account -- check `gh auth status` and the repository target",
};

const NARROW_VERDICT_REMEDY = {
  "auth-problem": "Run: gh auth status (login required)",
  "rate-limited": "Wait: GitHub rate limit; retrying",
  unavailable: "Run: gh-glance --doctor (repo unavailable)",
  "no-remote": "Run: gh-glance --repo owner/name",
};

function toTabError(err) {
  return { kind: "fetch", verdict: classify(err), raw: shortErr(err) };
}

function textTabError(err) {
  return { kind: "text", text: shortErr(err) };
}

function failureTargetHost({ runtimeHost, ghHost, ghRepo, accounts } = {}) {
  let ghRepoHost = null;
  if (ghRepo) {
    try {
      ghRepoHost = parseRepoTarget(ghRepo).host;
    } catch {
      // GH_REPO is external process state, not validated argv. An invalid value
      // is not evidence about which host an unavailable repository targeted.
    }
  }

  const accountHosts = Array.isArray(accounts)
    ? accounts
        .map((account) => (typeof account?.host === "string" ? safe(account.host) : ""))
        .filter(Boolean)
    : [];
  const distinctHosts = new Map(accountHosts.map((host) => [host.toLowerCase(), host]));
  const soleAccountHost = distinctHosts.size === 1 ? distinctHosts.values().next().value : null;

  return runtimeHost || ghHost || ghRepoHost || soleAccountHost || null;
}

function unavailableRemedy(accounts, targetHost) {
  if (!Array.isArray(accounts) || !targetHost) return VERDICT_REMEDY.unavailable;
  const normalizedTarget = String(targetHost).toLowerCase();
  let matching = null;
  for (const account of accounts) {
    if (typeof account?.host !== "string" || typeof account?.login !== "string") continue;
    const host = safe(account.host);
    const login = safe(account.login);
    if (!host || !login || host.toLowerCase() !== normalizedTarget) continue;
    if (matching !== null) return VERDICT_REMEDY.unavailable;
    matching = { host, login };
  }
  if (matching === null) return VERDICT_REMEDY.unavailable;

  const { host, login } = matching;
  const candidate = `Repository not found or inaccessible to ${login}@${host} -- check the target or run \`gh auth switch\``;
  return candidate.length <= MAX_ERR_LENGTH ? candidate : VERDICT_REMEDY.unavailable;
}

function formatTabError(error, failureContext = null) {
  if (error == null) return null;
  if (error.kind === "text") return error.text;
  if (error.verdict === "other") return error.raw;
  if (error.verdict === "unavailable" && failureContext?.repo?.ok) {
    return "not available for this repository";
  }
  if (error.verdict === "unavailable") {
    return unavailableRemedy(failureContext?.accounts, failureContext?.targetHost);
  }
  return pick(VERDICT_REMEDY, error.verdict, null) ?? error.raw;
}

function formatTabErrorForWidth(error, failureContext = null, width = MAX_ERR_LENGTH) {
  const budget = Number.isSafeInteger(width) ? Math.max(0, width) : MAX_ERR_LENGTH;
  const full = formatTabError(error, failureContext) ?? "";
  const candidate =
    budget < 60 && error?.kind === "fetch"
      ? (pick(NARROW_VERDICT_REMEDY, error.verdict, null) ?? `Run: gh-glance --doctor (${full})`)
      : full;
  return candidate.length <= budget ? candidate : `${candidate.slice(0, Math.max(0, budget - 1))}…`;
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

// The single redaction boundary for everything this process prints outside the
// dashboard: the --verbose log, the crash handler's stack, and the --doctor
// report. Declared here, above all three, rather than beside runDoctor() -- it
// used to sit in the Diagnostics section and be reached backwards by hoisting.
//
// Token shapes and URL userinfo only. gh error messages quote the URL they
// failed on, so that is a real path for a credential to arrive in output a user
// is invited to paste into a bug report.
function redact(text) {
  return String(text)
    .replace(/gh[pousr]_[A-Za-z0-9]{16,}/g, "<redacted-token>")
    .replace(/github_pat_[A-Za-z0-9_]{16,}/g, "<redacted-token>")
    .replace(/\/\/[^/\s:@]+:[^/\s@]+@/g, "//<redacted>@");
}

// Verbose output goes to stderr and never to stdout: stdout is ink's frame
// stream, and writing anything else into it corrupts the diff and the
// alternate-screen state. The argv block refuses --verbose while stderr is still
// a terminal, so these lines always land in a file rather than on top of the
// dashboard.
//
// The outcome is redacted for the same reason --doctor redacts its report: on a
// failure it carries gh's own stderr, and gh error messages quote the URL they
// failed on -- which is a real path for a token or a proxy credential to arrive
// here. The README tells users to run `--verbose 2>gh-glance.log` and attach the
// result to a bug report, so this is one of the three artifacts that leave the
// machine, and it was the only one with no redaction boundary.
function logGh(args, startedAt, outcome) {
  if (!runtime.verbose) return;
  const ms = Date.now() - startedAt;
  process.stderr.write(
    `${new Date().toISOString()} gh ${args.join(" ")} -- ${redact(outcome)} in ${ms}ms\n`,
  );
}

// The poll loop's AbortController, published here so the crash handlers can
// reach it. A module-level handle rather than a ref because the crash path runs
// outside React entirely -- there is no component left to read a ref from. Kept
// in this section, above every consumer, so nothing has to reach downward for it.
let liveAbort = null;
let setupChild = null;
function registerLiveAbort(controller) {
  liveAbort = controller;
}
function abortLiveRequests() {
  runtimeIdentityCoordinator?.close();
  liveAbort?.abort();
  liveAbort = null;
}

function forwardSignalToChild(child, signal) {
  // child.killed means only that kill() was called successfully; it becomes
  // true before the process exits and therefore cannot gate SIGKILL escalation.
  if (!child || child.exitCode !== null || child.signalCode !== null) return false;
  return child.kill(signal);
}

function inspectAdmittedHttpStart(scope, operation, now = Date.now) {
  const costs = operationCost(operation);
  if (!costs) return { ok: false, reason: "undeclared" };
  if (RATE_RESOURCES.every((resource) => costs[resource] === 0)) return { ok: true };
  const readNow = typeof now === "function" ? now : () => now;
  const snapshot = inspectGovernor(scope, readNow());
  if (!snapshot.ok || snapshot.missing) return snapshot.ok ? { ok: false, reason: "corrupt" } : snapshot;
  const checkedAt = readNow();
  for (const resource of RATE_RESOURCES) {
    if (costs[resource] <= 0) continue;
    const budget = snapshot.value.budgets[resource];
    if (!budget) return { ok: false, reason: "budget-unknown", resource };
    if (budget.blockUntil > checkedAt) return { ok: false, reason: "blocked", resource, retryAt: budget.blockUntil };
    if (budget.resetMs <= checkedAt) return { ok: false, reason: "budget-reset", resource, retryAt: budget.resetMs + BUDGET_RESET_GRACE_MS };
  }
  return { ok: true };
}

// Re-checked either side of every wait a request can sit in, because admission,
// the transport permit and the subprocess boundary are each far enough apart
// that the account can change in between. One definition so the three checks
// cannot drift, and so a request costs one identity snapshot instead of three.
function assertBoundCredential(bound) {
  if (bound?.accessKey && bound.accessKey !== runtimeIdentityCoordinator?.current()?.accessKey) {
    throw new Error("Credential changed before request start");
  }
}

// GraphQL documents are supplied on stdin rather than as an argument, so a
// query never lands in argv where `ps` or an error string could carry it, and
// so its size is bounded by a pipe rather than by the platform argument limit.
// promisify(execFile) exposes the child, which is what lets stdin be written
// without giving up the timeout, kill signal, maxBuffer, abort and redaction
// contracts every other call depends on.
// The control plane cannot be gated on the capacity it exists to establish.
// Both observers are exempt from the data-admission recheck for that reason:
// a resource whose budget is unknown would otherwise refuse the one request
// that could learn it, and the tab would wait for a number nothing can fetch.
// They remain bounded elsewhere -- by the rolling attempt allowance, the shared
// transport permit and the secondary cooldown -- so this is an exemption from
// data admission, not from accounting.
const CONTROL_OPERATIONS = ["budget-core-observer", "graphql-observer"];

// An operation whose actual cost exceeded its declared bound is paused until its
// resource resets. Continuing to spend against a bound already known to be wrong
// is how a reserve gets crossed with every individual request looking admissible.
// Process-local on purpose: the bound is a property of this build's query text,
// so a differently-built pane's bound is not this one's to suspend.
const pausedOperations = new Map();

function pauseOperation(operation, untilMs) {
  if (!Number.isFinite(untilMs)) return;
  pausedOperations.set(operation, Math.max(pausedOperations.get(operation) ?? 0, untilMs));
}

function operationPausedUntil(operation, now = Date.now()) {
  const until = pausedOperations.get(operation);
  if (until === undefined) return null;
  if (until <= now) { pausedOperations.delete(operation); return null; }
  return until;
}

async function runGh(args, { signal, operation, input = null } = {}) {
  if (operationCost(operation) === null) {
    throw new Error(`undeclared gh operation: ${operation ?? "missing"}`);
  }
  const bound = requestIdentityStorage.getStore();
  assertBoundCredential(bound);
  const local = ["version", "local-git"].includes(operation);
  let control = null;
  const permit = runtimeIdentityCoordinator && !local
    ? await acquireIdentityHttpPermit(runtimeIdentityCoordinator, { signal }) : null;
  const startedAt = Date.now();
  let requestError = null;
  let requestStdout = null;
  try {
    assertBoundCredential(bound);
    if (runtimeIdentityCoordinator && operation === "budget-core-observer") {
      control = startIdentityControl(runtimeIdentityCoordinator);
      if (!control.ok) throw new Error(identityCoordinationMessage(control.reason));
    }
    // Admission can precede this per-call transport slot by many seconds.
    // A sibling request may publish a shared hold while this call is queued.
    // Keep the started envelope charged, but recheck resource validity at the
    // actual subprocess boundary without reserving the same work again.
    const pausedUntil = operationPausedUntil(operation);
    if (pausedUntil !== null) {
      throw new Error(`Operation paused after an unbounded cost (retry after ${new Date(pausedUntil).toISOString()})`);
    }
    if (bound && !local && !CONTROL_OPERATIONS.includes(operation)) {
      const ready = inspectAdmittedHttpStart(bound, operation);
      if (!ready.ok) throw new Error(`API budget paused (${ready.reason})`);
    }
    assertBoundCredential(bound);
    const pending = execFileAsync("gh", args, {
      timeout: GH_TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: GH_MAX_BUFFER,
      env: { ...process.env, ...GH_ENV_OVERRIDES },
      signal,
    });
    if (typeof input === "string") {
      // A child killed by the timeout or the abort signal closes stdin under
      // us; that EPIPE is the kill's consequence, not the failure worth
      // reporting, so let the awaited result below carry the real error.
      pending.child.stdin?.on("error", () => {});
      pending.child.stdin?.end(input);
    }
    const { stdout } = await pending;
    requestStdout = stdout;
    logGh(args, startedAt, `ok ${stdout.length}B`);
    return stdout;
  } catch (err) {
    requestError = err;
    logGh(args, startedAt, `FAILED ${shortErr(err)}`);
    throw err;
  } finally {
    if (permit) {
      const release = () => releaseIdentityHttpPermit(runtimeIdentityCoordinator, permit, requestError);
      const released = await retryIdentityCompletion(release, { timeoutMs: IDENTITY_RELEASE_WAIT_MS, shouldRetry: () => !runtimeIdentityCoordinator.isClosed() });
      if (!released.ok) runtimeIdentityCoordinator.deferCompletion(`permit:${permit.nonce}`, release);
    }
    if (control?.ok) {
      const settle = () => settleIdentityControl(runtimeIdentityCoordinator, control.value, requestStdout ?? requestError?.stdout);
      const settled = await retryIdentityCompletion(settle, { timeoutMs: IDENTITY_RELEASE_WAIT_MS, shouldRetry: () => !runtimeIdentityCoordinator.isClosed() });
      if (!settled.ok) runtimeIdentityCoordinator.deferCompletion(`control:${control.value.id}`, settle);
    }
  }
}

function parseGhApiResponse(stdout) {
  const text = typeof stdout === "string" ? stdout : String(stdout ?? "");
  const separator = /\r?\n\r?\n/.exec(text);
  const prefix = separator ? text.slice(0, separator.index) : text;
  const body = separator ? text.slice(separator.index + separator[0].length) : "";
  const lines = prefix.split(/\r?\n/);
  const statusMatch = /^HTTP\/\d(?:\.\d+)?\s+(\d{3})(?:\s|$)/i.exec(lines[0] ?? "");
  const headers = {};
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (name) headers[name] = line.slice(colon + 1).trim();
  }
  return {
    status: statusMatch ? Number(statusMatch[1]) : null,
    headers,
    body,
  };
}

function pickRateLimit(headers) {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return null;
  const integer = (name) => {
    const value = Number(headers[name]);
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  };
  const resource = typeof headers["x-ratelimit-resource"] === "string"
    ? headers["x-ratelimit-resource"].trim().toLowerCase()
    : "";
  const limit = integer("x-ratelimit-limit");
  const used = integer("x-ratelimit-used");
  const remaining = integer("x-ratelimit-remaining");
  const reset = integer("x-ratelimit-reset");
  if (!RATE_RESOURCES.includes(resource) || [limit, used, remaining, reset].includes(null)) return null;
  return { resource, limit, used, remaining, resetMs: reset * 1000 };
}

function responseHeaderObservation(rateLimit, cost, receivedAt = Date.now()) {
  return rateLimit ? {
    ...rateLimit,
    source: "response-header",
    receivedAt,
    cost,
  } : null;
}

function ghApiArgs(args, etag = null) {
  return [
    "api",
    "-i",
    ...args,
    ...(typeof etag === "string" && etag.length > 0 ? ["-H", `If-None-Match: ${etag}`] : []),
  ];
}

async function ghApi(args, { operation, signal, etag = null, run = runGh } = {}) {
  const argv = ghApiArgs(args, etag);
  try {
    const parsed = parseGhApiResponse(await run(argv, { operation, signal }));
    return {
      status: parsed.status,
      etag: parsed.headers.etag ?? null,
      rateLimit: pickRateLimit(parsed.headers),
      body: parsed.body,
    };
  } catch (error) {
    const parsed = parseGhApiResponse(error?.stdout);
    if (parsed.status === 304) {
      return {
        status: 304,
        etag: parsed.headers.etag ?? null,
        rateLimit: pickRateLimit(parsed.headers),
        body: "",
      };
    }
    if (parsed.status !== null) {
      error.apiResponse = parsed;
      const rateLimit = pickRateLimit(parsed.headers);
      const observation = responseHeaderObservation(rateLimit, 0);
      if (observation) error.budgetObservations = [observation];
    }
    throw error;
  }
}

// ---------- Explicit GraphQL ----------

// The version travels in the query key, so a changed document invalidates its
// cursors instead of paging a new shape with an old cursor.
const GRAPHQL_QUERY_VERSION = 2;
// GitHub prices a connection by the pages it could return, and the row's single
// label is a nested connection of its own. Two points is the conservative bound
// for one page; the observer selects nothing but the meter and costs one.
const GRAPHQL_PAGE_POINTS = 2;
const GRAPHQL_OBSERVER_POINTS = 1;
// 50 rows per page and no more than three pages preserves the existing
// LIST_LIMIT of 150 while making every page a separately admitted request.
const GRAPHQL_PAGE_SIZE = 50;
// Two hours: comfortably past any real primary window, and short enough that a
// nonsense timestamp cannot park the budget in a reset that never arrives.
const GRAPHQL_MAX_RESET_MS = 2 * 60 * 60 * 1000;

// Issues and pull requests are deliberately two documents, not one with two
// connections: a combined query cannot publish either tab until both halves
// are complete, which is exactly the completion barrier this phase removes.
// Both select only what a row renders, which is also what keeps the cost at
// its declared bound.
const ISSUE_PAGE_QUERY = `query($owner:String!,$name:String!,$first:Int!,$after:String){
  repository(owner:$owner,name:$name){
    id
    name
    nameWithOwner
    url
    issues(first:$first,after:$after,states:OPEN,orderBy:{field:UPDATED_AT,direction:DESC}){
      totalCount
      pageInfo{hasNextPage endCursor}
      nodes{id number title url updatedAt author{login} labels(first:1){nodes{name}}}
    }
  }
  rateLimit{cost limit used remaining resetAt}
}`;

const PULL_PAGE_QUERY = `query($owner:String!,$name:String!,$first:Int!,$after:String){
  repository(owner:$owner,name:$name){
    id
    name
    nameWithOwner
    url
    pullRequests(first:$first,after:$after,states:OPEN,orderBy:{field:UPDATED_AT,direction:DESC}){
      totalCount
      pageInfo{hasNextPage endCursor}
      nodes{id number title url updatedAt author{login} headRefName isDraft reviewDecision}
    }
  }
  rateLimit{cost limit used remaining resetAt}
}`;

// Selects the meter and nothing else. This is the only claimed GraphQL
// observer; a data page's counters constrain the same epoch but never open a
// new one.
const GRAPHQL_OBSERVER_QUERY = `query{rateLimit{cost limit used remaining resetAt}}`;

// Replaces `gh repo view --json`, whose GraphQL cost was real but undeclared.
const REPOSITORY_QUERY = `query($owner:String!,$name:String!){
  repository(owner:$owner,name:$name){
    id
    nameWithOwner
    url
    viewerPermission
  }
  rateLimit{cost limit used remaining resetAt}
}`;

const GRAPHQL_QUERIES = Object.freeze({
  repository: { query: REPOSITORY_QUERY, connection: null, points: GRAPHQL_OBSERVER_POINTS },
  issues: { query: ISSUE_PAGE_QUERY, connection: "issues", points: GRAPHQL_PAGE_POINTS },
  prs: { query: PULL_PAGE_QUERY, connection: "pullRequests", points: GRAPHQL_PAGE_POINTS },
  observer: { query: GRAPHQL_OBSERVER_QUERY, connection: null, points: GRAPHQL_OBSERVER_POINTS },
});

// `--input -` keeps the document and its variables on stdin as one typed JSON
// object, so variables stay typed rather than becoming the strings that
// `-f`/`-F` would produce, and nothing reaches argv.
function graphqlArgs(host = effectiveRuntimeHost()) {
  return ["api", "-i", "graphql", "--input", "-", ...apiHostArgs(host)];
}

function graphqlInput(kind, variables) {
  const declared = pick(GRAPHQL_QUERIES, kind, null);
  if (!declared) throw new Error(`undeclared graphql query: ${kind}`);
  if (variables === null) throw new Error(UNRESOLVED_REPOSITORY);
  return JSON.stringify({ query: declared.query, variables });
}

// `gh` resolves an omitted repository from the working directory. GraphQL has
// no such inference, so the slug must be resolved here or the document cannot
// be built at all -- and running without `--repo` is the documented default.
//
// Refusing is deliberate. A half-filled variable set is worse than no request:
// GitHub answers a missing `String!` with HTTP 200 and an errors array, which
// is indistinguishable from a denied query, so the tab would report a
// permission problem for what is really an unresolved target.
function graphqlRepositoryVariables(repository = effectiveRuntimeRepository()) {
  if (!repository) return null;
  const [owner, name] = repository.split("/");
  return { owner, name };
}

function graphqlPageVariables(after = null, repository = effectiveRuntimeRepository()) {
  const target = graphqlRepositoryVariables(repository);
  return target && { ...target, first: GRAPHQL_PAGE_SIZE, after };
}

// GitHub answers a rejected query with HTTP 200 and an `errors` array, and can
// answer a partly-resolvable one with both `data` and `errors`. Headers and
// envelope are therefore read separately: budget evidence stays usable even
// when the data is not, which is the only way a failed page can still be paid
// for honestly.
function parseGraphqlEnvelope(body) {
  let envelope;
  try { envelope = JSON.parse(body); } catch { return { ok: false, reason: "unparseable", errors: [], data: null, rateLimit: null }; }
  if (!isRecord(envelope)) return { ok: false, reason: "unparseable", errors: [], data: null, rateLimit: null };
  const errors = Array.isArray(envelope.errors) ? envelope.errors : [];
  const data = isRecord(envelope.data) ? envelope.data : null;
  const meter = isRecord(data?.rateLimit) ? data.rateLimit : null;
  const number = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
  // A primary window is an hour; anything beyond a generous ceiling is not a
  // reset this app can wait for, and accepting it would pin an epoch that
  // `budget.resetMs <= now` never clears.
  const parsedReset = typeof meter?.resetAt === "string" ? Date.parse(meter.resetAt) : Number.NaN;
  const resetMs = Number.isFinite(parsedReset) && parsedReset <= Date.now() + GRAPHQL_MAX_RESET_MS
    ? parsedReset
    : Number.NaN;
  const rateLimit = meter && [number(meter.limit), number(meter.used), number(meter.remaining)].every((value) => value !== null) && Number.isFinite(resetMs)
    ? { resource: "graphql", limit: meter.limit, used: meter.used, remaining: meter.remaining, resetMs, cost: number(meter.cost) }
    : null;
  return { ok: errors.length === 0 && data !== null, reason: errors.length > 0 ? "graphql-errors" : data === null ? "no-data" : null, errors, data, rateLimit };
}


function normalizeHost(value) {
  if (typeof value !== "string") return null;
  const host = value.trim().toLowerCase();
  return HOST_PATTERN.test(host) ? host : null;
}

function remoteHost(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    if (value.includes("://")) return normalizeHost(new URL(value).hostname);
  } catch {
    return null;
  }
  const scp = /^(?:[^@\s]+@)?([^:/\s]+):[^\s]+$/.exec(value);
  return scp ? normalizeHost(scp[1]) : null;
}

// One resolver governs both the rate-limit route and the account coordinator.
// Explicit --repo is intentionally authoritative: a qualified value names its
// host, while an unqualified value means github.com even when GH_HOST or
// GH_REPO is also present. This is the approved Phase 2 precedence deviation.
function resolveEffectiveHost({
  runtimeHost = null,
  runtimeRepo = null,
  repoExplicit = false,
  ghHost = null,
  ghRepo = null,
  remoteUrls = [],
} = {}) {
  if (repoExplicit && runtimeRepo) return normalizeHost(runtimeHost) ?? "github.com";
  const explicitRuntimeHost = normalizeHost(runtimeHost);
  if (explicitRuntimeHost) return explicitRuntimeHost;
  if (ghHost !== null && ghHost !== undefined) return normalizeHost(ghHost);
  if (ghRepo) {
    try {
      const target = parseRepoTarget(ghRepo);
      return normalizeHost(target.host) ?? "github.com";
    } catch {
      return null;
    }
  }
  const hosts = new Set(remoteUrls.map(remoteHost).filter(Boolean));
  return hosts.size === 1 ? [...hosts][0] : null;
}

const UNRESOLVED_REPOSITORY = "Repository could not be resolved; pass --repo owner/name";

// Whether there is a repository to talk about at all. A folder with no git
// remote, no --repo and no GH_REPO is the onboarding state the no-remote verdict
// renders -- but that verdict was only ever produced from a gh error, and with
// no remote there is no host to verify an identity against, so no gh command
// ran: the coordinator reported unknown-host and the dashboard sat on a generic
// "retrying" notice, waiting for a budget it could never resolve. Decided from
// the same inputs as the host so the two cannot disagree; an ambiguous set of
// remotes is still a coordination question, not this one.
function noRepositoryTarget({ runtimeRepo = null, ghRepo = null, remoteUrls = [] } = {}) {
  return !runtimeRepo && !ghRepo && remoteUrls.length === 0;
}

function runtimeHasNoRepositoryTarget(remoteUrls = runtimeRemoteUrls) {
  return noRepositoryTarget({ runtimeRepo: runtime.repo, ghRepo: process.env.GH_REPO, remoteUrls });
}

const NO_REPOSITORY_TARGET_REPORT =
  "no repository target: this folder has no git remote (run `gh repo create`, or pass --repo owner/name)";

// The owner/name half of the same question resolveEffectiveHost answers for the
// host, and in the same precedence: an explicit --repo, then GH_REPO, then an
// unambiguous git remote. Ambiguity resolves to null rather than to a guess.
function remoteSlug(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  let path;
  if (value.includes("://")) {
    try { path = new URL(value).pathname; } catch { return null; }
  } else {
    path = /^(?:[^@\s]+@)?[^:/\s]+:([^\s]+)$/.exec(value)?.[1] ?? null;
  }
  if (path === null) return null;
  // Trimmed by index rather than with /\/+$/. An end-anchored quantifier is
  // retried from every position, so a remote URL carrying a long run of slashes
  // costs quadratic time to reject (CodeQL js/polynomial-redos, high). Remote
  // URLs are library input: `git remote -v` reports whatever is configured.
  let start = 0;
  let end = path.length;
  while (start < end && path[start] === "/") start += 1;
  while (end > start && path[end - 1] === "/") end -= 1;
  const trimmed = path.slice(start, end);
  const slug = trimmed.endsWith(".git") ? trimmed.slice(0, -4) : trimmed;
  return REPO_PATTERN.test(slug) ? slug : null;
}

function resolveEffectiveRepository({ runtimeRepo = null, ghRepo = null, remoteUrls = [] } = {}) {
  if (runtimeRepo) return runtimeRepo;
  if (ghRepo) {
    try { return parseRepoTarget(ghRepo).slug; } catch { return null; }
  }
  const slugs = new Set(remoteUrls.map(remoteSlug).filter(Boolean));
  return slugs.size === 1 ? [...slugs][0] : null;
}

function effectiveRuntimeRepository(options = {}) {
  return resolveEffectiveRepository({
    runtimeRepo: runtime.repo,
    ghRepo: process.env.GH_REPO,
    remoteUrls: runtimeRemoteUrls,
    ...options,
  });
}

function effectiveRuntimeHost(options = {}) {
  return resolveEffectiveHost({
    runtimeHost: runtime.host,
    runtimeRepo: runtime.repo,
    repoExplicit: runtime.repoExplicit,
    ghHost: process.env.GH_HOST,
    ghRepo: process.env.GH_REPO,
    remoteUrls: runtimeRemoteUrls,
    ...options,
  });
}


// `gh api` has no --repo, so a host-qualified target has nowhere to put its
// host: GH_REPO=host/owner/repo supplies the owner and repo and *ignores* the
// host (verified against gh 2.97.0), which is the one combination where the
// list tabs and the alert endpoints disagree about which server they are
// talking to. --hostname is the flag gh api does have. Empty when no host was
// given, so the default argv vector is unchanged.
function apiHostArgs(host = effectiveRuntimeHost()) {
  host = normalizeHost(host);
  return host ? ["--hostname", host] : [];
}

// `gh api` has no --repo; it resolves the {owner}/{repo} placeholder from the
// working directory. Substituting the validated value is what makes --repo work
// for the alert endpoints. REPO_PATTERN is why this is safe to interpolate into
// a request path -- and note it is the bare slug that goes in, never the host,
// which travels as an argument rather than as path text.
function apiPath(path) {
  return runtime.repo ? path.replace("{owner}/{repo}", runtime.repo) : path;
}

// ---------- Data fetchers ----------

// The argv vector for each endpoint is built by a named function rather than
// inline, because `--doctor` reports these vectors and a second copy of them
// would be a report that drifts away from what the dashboard actually sends --
// which is the failure mode the whole diagnostics command exists to rule out.
// Parses the explicit repository query's envelope. The shape the rest of the
// failure context consumes is unchanged; only how it was obtained is.
function parseRepoContext(raw) {
  try {
    const envelope = JSON.parse(raw);
    const value = isRecord(envelope?.data?.repository) ? envelope.data.repository : envelope;
    if (
      value == null ||
      Array.isArray(value) ||
      typeof value !== "object" ||
      typeof value.nameWithOwner !== "string" ||
      typeof value.url !== "string" ||
      typeof value.viewerPermission !== "string"
    ) {
      return null;
    }
    return {
      ok: true,
      nameWithOwner: safe(value.nameWithOwner),
      url: safe(value.url),
      viewerPermission: safe(value.viewerPermission),
    };
  } catch {
    return null;
  }
}

function parseAuthContext(raw) {
  try {
    const value = JSON.parse(raw);
    if (!Array.isArray(value)) return null;
    return value
      .filter(
        (row) =>
          row != null &&
          !Array.isArray(row) &&
          typeof row === "object" &&
          typeof row.host === "string" &&
          typeof row.login === "string",
      )
      .map((row) => ({ host: safe(row.host), login: safe(row.login) }));
  } catch {
    return null;
  }
}

function failedContext(err) {
  return { ok: false, verdict: classify(err), raw: shortErr(err) };
}

function missingFailureContext() {
  return {
    repo: { ok: false, verdict: "other", raw: "Repository context unavailable" },
    accounts: null,
  };
}

function buildFailureContext(repoSettlement, authSettlement) {
  const parsedRepo =
    repoSettlement?.status === "fulfilled" ? parseRepoContext(repoSettlement.value) : null;
  const repo =
    parsedRepo ??
    (repoSettlement?.status === "rejected"
      ? failedContext(repoSettlement.reason)
      : missingFailureContext().repo);
  const accounts =
    authSettlement?.status === "fulfilled" ? parseAuthContext(authSettlement.value) : null;
  return { repo, accounts };
}

async function resolveFailureContext(signal, governor = null, { run = runGh } = {}) {
  const repoCall = governor
    ? runAdmittedOperation({
        ...governor,
        operation: "failure-context:repository",
        signal,
        run: (admittedSignal) => run(graphqlArgs(), {
          signal: admittedSignal,
          operation: "failure-context:repository",
          input: graphqlInput("repository", graphqlRepositoryVariables()),
        }).then((stdout) => parseGhApiResponse(stdout).body),
      }).then((result) => result.ok ? result.value : Promise.reject(result.error))
    : Promise.reject(new Error("API budget unavailable"));
  const identity = runtimeIdentityCoordinator?.current();
  const [repo, auth] = await Promise.allSettled([
    repoCall,
    identity ? Promise.resolve(JSON.stringify([{ host: identity.host, login: identity.login }])) : Promise.reject(new Error("Verified identity unavailable")),
  ]);
  return buildFailureContext(repo, auth);
}

function createFailureContextCoordinator({ resolve, commit, fallback }) {
  let epoch = 0;
  let value = null;
  let inFlight = null;

  function ensure(signal) {
    const captured = epoch;
    if (value !== null) return Promise.resolve(true);
    if (inFlight?.epoch === captured) return inFlight.promise;

    const promise = Promise.resolve()
      .then(() => resolve(signal))
      .then(
        (result) => {
          if (epoch !== captured) return false;
          commit(result);
          value = result;
          return true;
        },
        () => {
          if (epoch !== captured) return false;
          commit(fallback);
          value = fallback;
          return false;
        },
      )
      .finally(() => {
        if (inFlight?.epoch === captured) inFlight = null;
      });
    inFlight = { epoch: captured, promise };
    return promise;
  }

  function invalidate() {
    epoch += 1;
    value = null;
    commit(null);
  }

  return { ensure, invalidate };
}

function actionsRunsArgs() {
  return [
    apiPath(`repos/{owner}/{repo}/actions/runs?exclude_pull_requests=true&per_page=${ACTIONS_RUN_LIMIT}`),
    ...apiHostArgs(),
    "--jq",
    // html_url is projected because a run's page must come from the row itself.
    // Deriving it from the repository slug only works when --repo was given;
    // with an inferred repository the app never learns the slug, and the row is
    // the one place the answer is always present. It costs nothing extra: the
    // field is already in the response being parsed.
    //
    // `name` is the workflow's name as of the run. Selecting it here is what
    // turns the workflow catalog from an unconditional second request into a
    // fallback for the rows that lack one.
    "[.workflow_runs[] | {databaseId: .id, displayTitle: .display_title, workflowName: .name, number: .run_number, headBranch: .head_branch, status, conclusion, startedAt: .run_started_at, updatedAt: .updated_at, workflowId: .workflow_id, url: .html_url}]",
  ];
}

function actionsWorkflowsArgs() {
  return [
    apiPath("repos/{owner}/{repo}/actions/workflows?page=1&per_page=100"),
    ...apiHostArgs(),
    "--jq",
    "[.workflows[] | {id, name}]",
  ];
}

function parseActionsRuns(runsBody) {
  return parseJsonOutput(runsBody).map((run) => ({
    databaseId: run.databaseId,
    displayTitle: safe(run.displayTitle),
    workflowName: safe(run.workflowName ?? ""),
    number: run.number,
    headBranch: safe(run.headBranch),
    status: run.status,
    conclusion: run.conclusion,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    url: safe(run.url ?? ""),
    workflowId: run.workflowId,
  }));
}

function parseWorkflowCatalog(workflowsBody, at, previous = null) {
  // An attempt that produced no usable body still closes the TTL window, and
  // keeps whatever names were already known. Re-asking once per poll for a
  // catalog the server will not serve is the failure mode this replaces.
  if (typeof workflowsBody !== "string" || workflowsBody.length === 0) {
    return { at, names: previous?.names instanceof Map ? previous.names : new Map() };
  }
  return {
    at,
    names: new Map(parseJsonOutput(workflowsBody).map((workflow) => [workflow.id, safe(workflow.name)])),
  };
}

function catalogNames(catalog) {
  return catalog?.names instanceof Map ? catalog.names : new Map();
}

// The catalog is worth a request only when a run carries no name of its own and
// its workflow id is not already known. A server that answers with names -- the
// normal case -- never asks for it at all.
function workflowCatalogDemand({ runs = [], catalog = null, nowMs = Date.now() }) {
  const fresh = catalog && Number.isFinite(catalog.at) &&
    nowMs - catalog.at < WORKFLOW_CATALOG_TTL_MS;
  if (fresh) return false;
  const names = catalogNames(catalog);
  return runs.some((run) => !run.workflowName && !names.has(run.workflowId));
}

// A missing name renders empty rather than blocking the row. Everything else a
// run carries -- its status, conclusion and title -- is exactly as useful
// without the workflow's name, so an unreadable catalog must not cost CI status.
function resolveWorkflowNames(runs, catalog) {
  const names = catalogNames(catalog);
  return runs.map(({ workflowId, ...run }) => ({
    ...run,
    workflowName: run.workflowName || names.get(workflowId) || "",
  }));
}

function parseActionsBodies(runsBody, workflowsBody) {
  return resolveWorkflowNames(
    parseActionsRuns(runsBody),
    parseWorkflowCatalog(workflowsBody, 0),
  );
}

function entityKey(tab, path) {
  return `${tab}\0${path}`;
}

function cachedEntity(entities, tab, path) {
  const value = entities instanceof Map ? entities.get(entityKey(tab, path)) : null;
  return typeof value?.etag === "string" && typeof value?.body === "string" ? value : null;
}

async function fetchConditionalEntity({
  tab,
  args,
  operation,
  signal,
  force,
  entities,
  request = ghApi,
}) {
  const path = args[0];
  const cached = cachedEntity(entities, tab, path);
  const response = await request(args, {
    operation,
    signal,
    etag: force ? null : cached?.etag ?? null,
  });
  const observation = responseHeaderObservation(
    response.rateLimit,
    response.status === 200 ? 1 : 0,
  );
  if (response.status === 304) {
    // An entity that is present but empty is not an answer either: it parses to
    // nothing, and the validator that named it is never refreshed, so the tab
    // asks the same unanswerable question at every poll forever.
    const recovery = conditionalRecoveryPlan({ status: 304, entity: cached?.body });
    // A validator naming an entity this pane no longer holds describes a
    // question with no possible answer: the server will keep saying "unchanged"
    // and there is nothing here for that to mean. Drop the validator now --
    // directly, not through the staged publication, which only runs on a usable
    // transition -- so the next admitted check is unconditional. One recovery,
    // and the tab reports unusable in the meantime rather than looping.
    if (recovery.recover && entities instanceof Map) entities.delete(entityKey(tab, path));
    return {
      path,
      status: 304,
      body: recovery.recover ? null : cached.body,
      staged: null,
      observations: observation ? [observation] : [],
      recovered: recovery.recover,
    };
  }
  return {
    path,
    status: response.status,
    body: response.body,
    staged: response.status === 200
      ? [entityKey(tab, path), typeof response.etag === "string"
          ? { etag: response.etag, body: response.body }
          : null]
      : null,
    observations: observation ? [observation] : [],
  };
}

function conditionalBatchResult(responses, previousRaw, joinedRaw = null) {
  const list = Array.isArray(responses) ? responses : [];
  let allNotModified = list.length > 0;
  let restSpent = 0;
  let stagedEntities = null;
  const observations = [];
  for (const response of list) {
    if (response?.status !== 304 || typeof response.body !== "string") allNotModified = false;
    if (response?.status === 200) restSpent += 1;
    if (Array.isArray(response?.observations)) observations.push(...response.observations);
    if (!response?.staged) continue;
    stagedEntities ??= new Map();
    stagedEntities.set(...response.staged);
  }
  return {
    raw: allNotModified
      ? previousRaw
      : joinedRaw ?? list.map((response) => response?.body ?? "").join("\0"),
    allNotModified,
    restSpent,
    stagedEntities,
    observations,
  };
}

function publishStagedEntities(entities, staged, transitionKind) {
  if (!(entities instanceof Map) || !(staged instanceof Map) ||
    !["changed", "unchanged"].includes(transitionKind)) return false;
  for (const [key, value] of staged) {
    if (value === null) entities.delete(key);
    else entities.set(key, value);
  }
  return true;
}

const ACTIONS_QUERY_VERSION = 2;

async function fetchActions(signal, {
  entities = new Map(),
  force = false,
  previousRaw = null,
  catalog = null,
  governor = null,
  // Seams, so the conditional catalog fallback can be exercised without a live
  // governor or a subprocess.
  request = ghApi,
  admit = runAdmittedOperation,
} = {}) {
  const runsResponse = await fetchConditionalEntity({
    tab: "actions",
    args: actionsRunsArgs(),
    operation: "tab:actions-runs",
    signal,
    force,
    entities,
    request,
  });
  if (typeof runsResponse.body !== "string") {
    // The broken validator has already been dropped above, so the next admitted
    // check is unconditional. This poll reports unusable, which keeps the
    // last-good rows and their freshness clock rather than blanking the tab.
    return {
      raw: null,
      limit: ACTIONS_RUN_LIMIT,
      restSpent: 0,
      graphqlSpent: GRAPHQL_PER_FETCH.actions,
      stagedEntities: null,
      observations: runsResponse.observations,
      catalog,
      parse: () => parseActionsRuns(runsResponse.body ?? ""),
    };
  }
  const responses = [runsResponse];
  const runs = parseActionsRuns(runsResponse.body);
  const startedAt = Date.now();
  let nextCatalog = catalog;
  if (governor && workflowCatalogDemand({ runs, catalog, nowMs: startedAt })) {
    // Separately admitted, like a later GraphQL page: the catalog is a fallback,
    // so a budget decision about it settles against its own reservation and can
    // never take the run list -- or the tab's own settlement -- down with it.
    const admitted = await admit({
      ...governor,
      operation: "catalog:actions-workflows",
      priority: "background",
      signal,
      waitMs: GOVERNOR_ADMISSION_WAIT_MS,
      run: (admittedSignal) => fetchConditionalEntity({
        tab: "actions",
        args: actionsWorkflowsArgs(),
        operation: "catalog:actions-workflows",
        signal: admittedSignal,
        force,
        entities,
        request,
      }),
    });
    if (admitted.ok && admitted.value) {
      responses.push(admitted.value);
      nextCatalog = parseWorkflowCatalog(admitted.value.body, startedAt, catalog);
    }
    // A refusal leaves the catalog exactly as it was. Closing the TTL on a
    // scheduling outcome would hide missing names for fifteen minutes over a
    // moment of budget pressure.
  }
  const rows = resolveWorkflowNames(runs, nextCatalog);
  // The payload identity is what is rendered, not the concatenated bodies. The
  // catalog is fetched on some polls and not others, and joining raw bodies
  // made that alternation look like a content change every time.
  const raw = JSON.stringify({ v: ACTIONS_QUERY_VERSION, rows });
  const batch = conditionalBatchResult(responses, previousRaw, raw);
  return {
    raw: batch.raw,
    limit: ACTIONS_RUN_LIMIT,
    // The tab settles for its own request. The catalog settled against the
    // reservation it opened for itself.
    restSpent: runsResponse.status === 200 ? 1 : 0,
    graphqlSpent: GRAPHQL_PER_FETCH.actions,
    stagedEntities: batch.stagedEntities,
    observations: batch.observations,
    catalog: nextCatalog,
    parse: () => rows,
  };
}

// Ordering is part of the query now (`orderBy: UPDATED_AT DESC`) rather than a
// `--search sort:` flag. The AGE column renders updatedAt, so a created-order
// list made that column non-monotonic and, worse, truncating to pane height
// dropped the oldest-*created* rows -- a PR opened six months ago and reviewed
// five minutes ago was invisible. The old fix routed `gh issue list` through
// GraphQL implicitly and at an unobservable cost; asking for the order directly
// keeps the behaviour and makes the price visible.

// One page of an explicit connection. Headers and envelope are settled
// separately so a rejected query still pays honestly: GitHub answers those with
// HTTP 200 and an `errors` array, and its counters are trustworthy even when
// its data is not.
async function fetchGraphqlPage(kind, { signal, after = null, run = runGh, operation, host = effectiveRuntimeHost(), variables = null } = {}) {
  const declared = pick(GRAPHQL_QUERIES, kind, null);
  if (!declared) throw new Error(`undeclared graphql query: ${kind}`);
  let stdout;
  let failure = null;
  try {
    stdout = await run(graphqlArgs(host), { signal, operation, input: graphqlInput(kind, variables ?? graphqlPageVariables(after)) });
  } catch (error) {
    failure = error;
    // A failed call can still carry a complete response body: `gh` exits
    // non-zero on 4xx/5xx but has already written the headers and envelope,
    // and that is where trustworthy budget evidence lives.
    stdout = typeof error?.stdout === "string" ? error.stdout : "";
  }
  const parsed = parseGhApiResponse(stdout);
  const envelope = parseGraphqlEnvelope(parsed.body);
  // Prefer the envelope's meter: it carries this query's actual `cost`, which
  // the headers do not. Headers remain the fallback when the body is unusable.
  const meter = envelope.rateLimit ?? pickRateLimit(parsed.headers);
  // Absent evidence never refunds. An unobserved page keeps its conservative
  // reservation rather than being treated as free.
  const observedCost = Number.isSafeInteger(envelope.rateLimit?.cost)
    ? envelope.rateLimit.cost
    : declared.points;
  const observation = meter && meter.resource === "graphql"
    ? responseHeaderObservation(meter, observedCost)
    : null;
  return {
    kind,
    status: parsed.status,
    ok: failure === null && parsed.status === 200 && envelope.ok,
    reason: failure ? "transport" : parsed.status !== 200 ? "http" : envelope.reason,
    failure,
    data: envelope.data,
    // Recorded in full even when it exceeds the declared bound: an overrun is
    // evidence to reconcile, not a bookkeeping error to discard.
    observedCost,
    overrun: observedCost > declared.points,
    observations: observation ? [observation] : [],
  };
}

function graphqlConnection(page, connection) {
  const repository = isRecord(page.data?.repository) ? page.data.repository : null;
  const value = isRecord(repository?.[connection]) ? repository[connection] : null;
  return value && Array.isArray(value.nodes) ? value : null;
}

const ISSUE_ROW = (node) => ({
  number: node.number,
  title: safe(node.title),
  author: safe(node.author?.login ?? ""),
  label: safe(node.labels?.nodes?.[0]?.name ?? ""),
  updatedAt: node.updatedAt,
  url: safe(node.url ?? ""),
});

const PR_ROW = (node) => ({
  number: node.number,
  title: safe(node.title),
  author: safe(node.author?.login ?? ""),
  headRefName: safe(node.headRefName),
  isDraft: node.isDraft,
  reviewDecision: node.reviewDecision,
  updatedAt: node.updatedAt,
  url: safe(node.url ?? ""),
});

// How close to the end of the loaded rows the cursor must come before another
// page is worth acquiring. Ten rows is roughly half a pane, so the next page
// arrives before the user reaches the bottom without being fetched for a list
// nobody scrolled.
const PAGE_DEMAND_THRESHOLD = 10;

// A traversal's identity is the identity of its first page. A cursor is only
// meaningful against the ordering that produced it, so when the first page
// changes underneath an in-flight later page, that page describes a list that
// no longer exists.
function pageGeneration(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => String(itemKey(row)))
    .join("\u0000");
}

function paginationDemand({
  selectedIndex,
  loadedRows,
  hasNextPage,
  cap = LIST_LIMIT,
  threshold = PAGE_DEMAND_THRESHOLD,
}) {
  if (hasNextPage !== true) return false;
  if (loadedRows >= cap) return false;
  return Number.isSafeInteger(selectedIndex) && selectedIndex >= loadedRows - threshold;
}

// Demand is a page count, not an event, which is what makes it coalesce:
// holding `j` near the end asks for one more page however many times it fires.
function demandedPageCount(previous, {
  selectedIndex,
  loadedRows,
  hasNextPage,
  cap = LIST_LIMIT,
  pageSize = GRAPHQL_PAGE_SIZE,
}) {
  const current = Number.isSafeInteger(previous) && previous > 0 ? previous : 1;
  const max = Math.max(1, Math.ceil(cap / pageSize));
  if (!paginationDemand({ selectedIndex, loadedRows, hasNextPage, cap })) {
    return Math.min(current, max);
  }
  return Math.min(Math.max(current, Math.ceil(loadedRows / pageSize) + 1), max);
}

function mergeDemandedPages({ pages = [], cap = LIST_LIMIT, keyOf = itemKey }) {
  const list = (Array.isArray(pages) ? pages : []).filter(Boolean);
  const base = list[0] ?? null;
  const rows = [];
  const seen = new Set();
  let accepted = 0;
  let hasNextPage = false;
  let capped = false;
  for (const value of list) {
    if (value.generation !== base.generation) break;
    accepted += 1;
    hasNextPage = value.pageInfo?.hasNextPage === true;
    for (const row of value.rows ?? []) {
      const key = keyOf(row);
      // A node can legitimately appear on two pages when the list shifted
      // between them. Publishing it twice is a rendering bug, not extra data.
      if (key != null) {
        if (seen.has(key)) continue;
        seen.add(key);
      }
      if (rows.length >= cap) { capped = true; break; }
      rows.push(row);
    }
    if (capped) break;
  }
  return {
    rows,
    pages: accepted,
    // A capped or short merge is not a complete list, and must never render as
    // one: "50 of 999" and "50 open issues" are different claims.
    hasNextPage: hasNextPage || capped,
    incomplete: hasNextPage || capped || accepted < list.length,
    generation: base?.generation ?? null,
  };
}

// Acquires exactly the pages demand asks for, one explicitly admitted page at a
// time. The first page is covered by the tab's own reservation; each later page
// reserves its own envelope, so a denial there is an ordinary scheduling
// outcome rather than a hidden overspend. Rows already collected survive that
// denial and the result is marked incomplete rather than published as complete.
async function fetchGraphqlList(kind, mapRow, {
  signal,
  governor = null,
  previousRaw = null,
  // How many pages the viewport has actually asked for. One, until a cursor
  // comes within PAGE_DEMAND_THRESHOLD rows of the end. The walk used to run to
  // LIST_LIMIT on the very first paint -- three requests for a pane showing
  // about twenty rows, on every tab, forever.
  pages = 1,
  // Seams, so the paging loop can be exercised without a live governor: the
  // settlement figure it produces was wrong for months of repositories with
  // more than one page, and nothing could see it.
  fetchPage = fetchGraphqlPage,
  admit = runAdmittedOperation,
} = {}) {
  const connection = GRAPHQL_QUERIES[kind].connection;
  const operation = `tab:${kind}`;
  const first = await fetchPage(kind, { signal, operation });
  if (!first.ok) {
    const error = first.failure ?? new Error(`GraphQL ${kind} page unavailable (${first.reason})`);
    error.budgetObservations = first.observations;
    throw error;
  }
  const observations = [...first.observations];
  // Only the first page. Pages past it opened their own reservation inside
  // runAdmittedOperation and settle against it, so adding them here charges the
  // same work twice -- and a settlement above its reservation is rejected as
  // corrupt, which silently leaks the tab's reservation and discards every
  // budget observation the fetch gathered.
  const envelopeSpent = first.observedCost;
  let spent = first.observedCost;
  let overrun = first.overrun;
  let current = graphqlConnection(first, connection);
  const totalCount = current?.totalCount ?? null;
  const generation = pageGeneration((current?.nodes ?? []).map(mapRow));
  const wanted = Math.min(
    Math.max(1, Number.isSafeInteger(pages) ? pages : 1),
    Math.max(1, Math.ceil(LIST_LIMIT / GRAPHQL_PAGE_SIZE)),
  );
  const acquired = [];
  const collect = (value) => acquired.push({
    generation,
    rows: (value?.nodes ?? []).map(mapRow),
    pageInfo: value?.pageInfo ?? null,
  });
  let truncatedWalk = false;
  if (current) collect(current); else truncatedWalk = true;
  while (acquired.length < wanted && current?.pageInfo?.hasNextPage) {
    const cursor = current.pageInfo.endCursor;
    if (typeof cursor !== "string" || cursor.length === 0) { truncatedWalk = true; break; }
    if (!governor) { truncatedWalk = true; break; }
    const admitted = await admit({
      ...governor,
      operation: `page:${kind}`,
      priority: "background",
      signal,
      waitMs: GOVERNOR_ADMISSION_WAIT_MS,
      run: (admittedSignal) => fetchPage(kind, { signal: admittedSignal, after: cursor, operation: `page:${kind}` }),
    });
    // A later page that is denied, fails, or returns errors leaves the rows
    // already gathered exactly as they are. Losing page one because page two
    // was refused would turn a budget decision into data loss.
    //
    // Note that runAdmittedOperation settles these at their *declared* cost, not
    // their observed one -- conservative, so never an under-charge. A later
    // page's real meter reaches the ledger through the observations forwarded to
    // the tab settlement rather than through its own reservation.
    // Evidence first, and unconditionally: a page that failed as data still
    // observed the meter, and dropping that is the one thing this phase says
    // it will not do.
    if (admitted.value?.observations) observations.push(...admitted.value.observations);
    if (admitted.value?.overrun) overrun = true;
    if (!admitted.ok || !admitted.value?.ok) { truncatedWalk = true; break; }
    spent += admitted.value.observedCost;
    current = graphqlConnection(admitted.value, connection);
    if (!current) { truncatedWalk = true; break; }
    collect(current);
  }
  if (overrun) {
    // Recorded at its real cost above; suspended here until the resource resets,
    // which is the soonest a corrected bound could be trusted again.
    const reset = observations.at(-1)?.resetMs;
    pauseOperation(operation, Number.isFinite(reset) ? reset + BUDGET_RESET_GRACE_MS : Date.now() + BUDGET_PROBE_MS);
  }
  const merged = mergeDemandedPages({ pages: acquired, cap: LIST_LIMIT });
  const incomplete = merged.incomplete || truncatedWalk;
  // Serialized rows are the payload identity the unchanged-frame suppression
  // and the cache both compare on, so it must cover exactly what is rendered --
  // including the markers that say the list is not all of it.
  const raw = JSON.stringify({
    v: GRAPHQL_QUERY_VERSION,
    totalCount,
    incomplete,
    hasNextPage: merged.hasNextPage,
    rows: merged.rows,
  });
  return {
    raw: raw === previousRaw ? previousRaw : raw,
    // An incomplete walk reports the rows it has as its own limit, so the
    // existing truncation indicator fires. "More rows exist than are shown" is
    // exactly what incomplete means, and publishing 50 of 150 rows as a
    // complete tab is indistinguishable from a repository with 50 open issues.
    limit: incomplete ? merged.rows.length : LIST_LIMIT,
    restSpent: 0,
    graphqlSpent: envelopeSpent,
    // What the whole walk cost, for reporting. Never the settlement figure.
    graphqlSpentTotal: spent,
    observations,
    incomplete,
    totalCount,
    hasNextPage: merged.hasNextPage,
    generation: merged.generation,
    loadedPages: merged.pages,
    parse: () => merged.rows,
  };
}

async function fetchIssues(signal, { governor = null, previousRaw = null, pages = 1 } = {}) {
  return fetchGraphqlList("issues", ISSUE_ROW, { signal, governor, previousRaw, pages });
}

async function fetchPRs(signal, { governor = null, previousRaw = null, pages = 1 } = {}) {
  return fetchGraphqlList("prs", PR_ROW, { signal, governor, previousRaw, pages });
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
    priorityQueries: ["severity=critical,high"],
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
    priorityQueries: ["severity=critical", "severity=high"],
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
    priorityQueries: [],
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

// What one fetch of each tab costs, per budget. The single source of truth:
// `projectedHourlyCost` derives the hourly figure from it and the spend meter
// bills against it, so a corrected number cannot reach one and miss the other.
//
// actions was 2 for as long as every fetch made both calls: measured
// 2026-08-10 with `GH_DEBUG=api`, `gh run list` issued GET /actions/runs *and*
// GET /actions/workflows. The catalog is now a conditional fallback with its
// own reservation, so the tab reserves for the one call it always makes.
//
// issues and prs are 0 REST because SORT_RECENT's --search routes both through
// GraphQL entirely (2 POSTs each, confirmed by the same measurement).
const SECURITY_REQUESTS_PER_FETCH = ALERT_SOURCES.reduce(
  (total, source) => total + 1 + source.priorityQueries.length,
  0,
);
// Actions is one request now: the workflow catalog became a conditional
// fallback that opens its own reservation, so the tab no longer reserves for
// a second call it usually does not make.
const REST_PER_FETCH = { actions: 1, issues: 0, prs: 0, security: SECURITY_REQUESTS_PER_FETCH };
const GRAPHQL_PER_FETCH = { actions: 0, issues: 2, prs: 2, security: 0 };

function tabRequestCost(tab) {
  if (!TAB_KEYS.includes(tab)) return null;
  return { core: REST_PER_FETCH[tab], graphql: GRAPHQL_PER_FETCH[tab] };
}

// Every gh subprocess has one declared operation, enforced at the subprocess
// boundary. The shared governor uses these costs for quota admission. Tab totals are
// derived from the fetch tables, while Security endpoint entries describe the
// individual calls covered by the tab's six-call upfront reservation.
const OPERATION_COSTS = Object.freeze({
  ...Object.fromEntries(TAB_KEYS.map((tab) => [`tab:${tab}`, tabRequestCost(tab)])),
  "tab:actions-runs": { core: 1, graphql: 0 },
  // Separately admitted, like a later list page: only fetched when a run has
  // no name of its own, and settled against its own reservation.
  "catalog:actions-workflows": { core: 1, graphql: 0 },
  "tab:security-endpoint": { core: 1, graphql: 0 },
  "failure-context:repository": { core: 0, graphql: GRAPHQL_OBSERVER_POINTS },
  // Each page past the first reserves its own envelope, so a denial there is a
  // scheduling outcome rather than an unadmitted overspend.
  "page:issues": { core: 0, graphql: GRAPHQL_PAGE_POINTS },
  "page:prs": { core: 0, graphql: GRAPHQL_PAGE_POINTS },
  // The one claimed GraphQL observer. Not free, and not describable as free:
  // it selects the meter and pays a point for it.
  "graphql-observer": { core: 0, graphql: GRAPHQL_OBSERVER_POINTS },
  "doctor:repository": { core: 0, graphql: 1 },
  "doctor:actions-runs": { core: 1, graphql: 0 },
  "doctor:actions-workflows": { core: 1, graphql: 0 },
  "doctor:issues": tabRequestCost("issues"),
  "doctor:prs": tabRequestCost("prs"),
  "doctor:security-endpoint": { core: 1, graphql: 0 },
  // The claimed observer is the one control-plane exception to normal data
  // admission, but its worst-case vector is still one core unit: the first 200
  // can spend it before an ETag makes later observations free.
  "budget-core-observer": { core: 1, graphql: 0 },
  "rate-limit": { core: 0, graphql: 0 },
  "version": { core: 0, graphql: 0 },
  "local-git": { core: 0, graphql: 0 },
});

function operationCost(operation) {
  return pick(OPERATION_COSTS, operation, null);
}

// Target this fraction of what the token can afford, not all of it. The margin
// is for the user's own `gh` and `git` commands.
const BUDGET_SAFETY = 0.8;
const BUDGET_RESERVE_FRACTION = 1 - BUDGET_SAFETY;
// How often to re-read the budget. `gh api rate_limit` does not count against
// the limit (verified, delta 0 -- see rateBudget) but it is still a subprocess,
// so once a minute rather than once a tick: the quantity it measures moves on
// the scale of minutes.
const BUDGET_PROBE_MS = 60_000;
const BUDGET_SNAPSHOT_TTL_MS = 65_000;
// GraphQL has no response-header owner. One unusable minute sample must not
// close admission, but two consecutive misses still do: 2 probes + 5s grace.
const GRAPHQL_BUDGET_SNAPSHOT_TTL_MS = 2 * BUDGET_PROBE_MS + 5_000;
const GOVERNOR_HEARTBEAT_MS = 20_000;
const GOVERNOR_LEASE_TTL_MS = 90_000;
const GOVERNOR_PROBE_LEASE_MS = 70_000;
const GOVERNOR_ACTIVE_PROBE_LEASE_MS = 35_000;
const BUDGET_RESET_GRACE_MS = 2_000;
const GOVERNOR_PHASE_WINDOW_MS = 5_000;
const BUDGET_WINDOW_MS = 3_600_000;

function budgetSnapshotTtl(resource) {
  return resource === "graphql" ? GRAPHQL_BUDGET_SNAPSHOT_TTL_MS : BUDGET_SNAPSHOT_TTL_MS;
}

function sharedLaneProvenance(value) {
  return value?.waitCause === "shared-lane" &&
    Number.isSafeInteger(value?.sharingCount) && value.sharingCount > 1
    ? { waitCause: "shared-lane", sharingCount: value.sharingCount }
    : {};
}

function sharedLaneEvidence(value) {
  const provenance = sharedLaneProvenance(value);
  const ownerLeaseIds = Array.isArray(value?.sharingOwnerLeaseIds)
    ? [...new Set(value.sharingOwnerLeaseIds.filter((leaseId) =>
        typeof leaseId === "string" && leaseId.length > 0))]
    : [];
  return provenance.waitCause && ownerLeaseIds.length > 0
    ? { ...provenance, sharingOwnerLeaseIds: ownerLeaseIds }
    : {};
}

// Below this many completed shared calls in a probe window, external-spend
// inference is noise. Under the threshold the loop retains the previous factor.
const MIN_SAMPLE_CALLS = 5;

const REQUEST_PRIORITIES = Object.freeze({
  manual: 0,
  diagnostic: 0,
  "tab-switch": 1,
  active: 2,
  background: 3,
});

function normalizeBudgetResource(raw, observedAt = raw?.observedAt) {
  if (!raw || typeof raw !== "object") return null;
  const normalized = {
    limit: raw.limit,
    remaining: raw.remaining,
    used: raw.used,
    resetMs: raw.resetMs,
    observedAt,
  };
  if (
    Object.values(normalized).some((value) => !Number.isFinite(value) || value < 0) ||
    normalized.remaining > normalized.limit ||
    normalized.used > normalized.limit
  ) {
    return null;
  }
  return normalized;
}

function budgetEpoch(resource) {
  const normalized = normalizeBudgetResource(resource);
  if (!normalized) return null;
  return typeof resource?.epoch === "string" && resource.epoch.length > 0
    ? resource.epoch
    : `${normalized.limit}:${normalized.resetMs}`;
}

function resourceReserve(limit) {
  return Number.isFinite(limit) && limit >= 0
    ? Math.ceil(limit * BUDGET_RESERVE_FRACTION)
    : null;
}

function leaseFor(leases, leaseId) {
  return leases instanceof Map ? leases.get(leaseId) : leases?.[leaseId];
}

function countLiveLeases(leases, nowMs) {
  let count = 0;
  const values = leases instanceof Map ? leases.values() : Object.values(leases);
  for (const lease of values) {
    if (Number.isFinite(lease?.expiresAt) && lease.expiresAt > nowMs) count += 1;
  }
  return count;
}

function currentSharedLaneProvenance(value, leases, nowMs) {
  const evidence = sharedLaneEvidence(value);
  if (!evidence.waitCause || countLiveLeases(leases, nowMs) !== evidence.sharingCount) return {};
  return evidence.sharingOwnerLeaseIds.every((leaseId) => leaseFor(leases, leaseId)?.expiresAt > nowMs)
    ? sharedLaneProvenance(evidence)
    : {};
}

function reservationCost(reservation, resource, leases, nowMs) {
  if (!reservation || ["cancelled", "reconciled"].includes(reservation.status)) return 0;
  if (reservation.status === "scheduled") {
    const lease = leaseFor(leases, reservation.leaseId);
    if (!lease || (Number.isFinite(lease.expiresAt) && lease.expiresAt <= nowMs)) return 0;
  }
  const chargedCosts = reservation.status === "completed" &&
      reservation.outcome === "measured-success" && reservation.actualCosts
    ? reservation.actualCosts
    : reservation.costs;
  const cost = chargedCosts?.[resource] ??
    (reservation.resource === resource ? reservation.cost : 0);
  const accounted = reservation.accountedCosts?.[resource] ?? 0;
  return Number.isFinite(cost) && cost > 0 ? Math.max(0, cost - accounted) : 0;
}

function availableForGrant({
  budget,
  resource = budget?.resource,
  reservations = [],
  leases = {},
  nowMs,
  chargedCost = null,
}) {
  const normalized = normalizeBudgetResource(budget);
  if (!normalized) return { mode: "probe", reason: "budget-unknown" };
  if (!RATE_RESOURCES.includes(resource)) return { mode: "probe", reason: "budget-resource" };
  if (normalized.observedAt > nowMs) return { mode: "probe", reason: "budget-future" };
  if (nowMs - normalized.observedAt > budgetSnapshotTtl(resource)) {
    return { mode: "probe", reason: "budget-stale" };
  }
  if (nowMs >= normalized.resetMs) return { mode: "probe", reason: "budget-reset" };

  const epoch = budgetEpoch(budget);
  if (Number.isFinite(budget.blockUntil) && budget.blockUntil > nowMs) {
    return {
      mode: "paused",
      reason: budget.blockReason ?? "rate-limit",
      resetMs: normalized.resetMs,
      epoch,
    };
  }

  if (chargedCost !== null && (!Number.isFinite(chargedCost) || chargedCost < 0)) {
    return {
      mode: "paused",
      reason: "reservations-invalid",
      resetMs: normalized.resetMs,
      epoch,
    };
  }

  const reserve = resourceReserve(normalized.limit);
  const charged = chargedCost ?? reservations.reduce(
    (total, reservation) => total + reservationCost(reservation, resource, leases, nowMs),
    0,
  );
  return {
    mode: "open",
    reserve,
    spendable: Math.max(0, normalized.remaining - reserve - charged),
    resetMs: normalized.resetMs,
    epoch,
  };
}

function nextExternalFactor({
  lastExternalFactor = 1,
  globalUsedDelta = 0,
  sharedCompletedDelta = 0,
}) {
  if (
    !Number.isFinite(lastExternalFactor) ||
    lastExternalFactor < 1 ||
    !Number.isFinite(globalUsedDelta) ||
    globalUsedDelta < 0 ||
    !Number.isFinite(sharedCompletedDelta) ||
    sharedCompletedDelta < 0
  ) {
    return null;
  }
  const sample = { globalUsedDelta, sharedCompletedDelta };
  if (!externalSampleIsUsable(sample)) return lastExternalFactor;
  const measured = sample.globalUsedDelta / sample.sharedCompletedDelta;
  return Number.isFinite(measured) ? Math.max(1, measured) : null;
}

function resourceDecision({
  budget,
  resource,
  reservations = [],
  leases = {},
  nowMs,
  cost = 0,
  lastExternalFactor = budget?.lastExternalFactor ?? 1,
  globalUsedDelta = 0,
  sharedCompletedDelta = 0,
  chargedCost = null,
}) {
  const capacity = availableForGrant({
    budget,
    resource,
    reservations,
    leases,
    nowMs,
    chargedCost,
  });
  if (capacity.mode !== "open") return capacity;

  const externalFactor = nextExternalFactor({
    lastExternalFactor,
    globalUsedDelta,
    sharedCompletedDelta,
  });
  if (externalFactor === null) {
    return {
      mode: "paused",
      reason: "external-factor-invalid",
      resetMs: capacity.resetMs,
      epoch: capacity.epoch,
    };
  }
  if (!Number.isFinite(cost) || cost < 0 || capacity.spendable < cost || capacity.spendable <= 0) {
    return {
      mode: "paused",
      reason: "reserve",
      resetMs: capacity.resetMs,
      epoch: capacity.epoch,
    };
  }
  const callsPerMs = capacity.spendable / (capacity.resetMs - nowMs) / externalFactor;
  if (!Number.isFinite(callsPerMs) || callsPerMs <= 0) {
    return {
      mode: "paused",
      reason: "pacing-invalid",
      resetMs: capacity.resetMs,
      epoch: capacity.epoch,
    };
  }
  return { ...capacity, callsPerMs, externalFactor };
}

function governorPhaseOffset(phaseSeed, epoch) {
  const text = `${phaseSeed}:${epoch}`;
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % (GOVERNOR_PHASE_WINDOW_MS + 1);
}

function governorEpochPhaseAt(phaseSeed, decision) {
  const epochAnchor = Math.max(phaseSeed.registeredAt, decision.resetMs - BUDGET_WINDOW_MS);
  return epochAnchor + governorPhaseOffset(phaseSeed.seed, decision.epoch);
}

function intentPriority(intent) {
  const priority = Number.isInteger(intent.priority)
    ? intent.priority
    : REQUEST_PRIORITIES[intent.priority];
  return Object.values(REQUEST_PRIORITIES).includes(priority) ? priority : null;
}

const RATE_RESOURCES = ["core", "graphql"];

function exactResourceCosts(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const keys = Object.keys(raw);
  if (
    keys.length !== RATE_RESOURCES.length ||
    RATE_RESOURCES.some(
      (resource) =>
        !Object.hasOwn(raw, resource) || !Number.isFinite(raw[resource]) || raw[resource] < 0,
    )
  ) {
    return null;
  }
  return { core: raw.core, graphql: raw.graphql };
}

function intentCosts(intent) {
  if (intent.tab === undefined) return exactResourceCosts(intent.costs);
  const expected = tabRequestCost(intent.tab);
  if (!expected) return null;
  const supplied = intent.costs === undefined ? expected : exactResourceCosts(intent.costs);
  if (!supplied || supplied.core !== expected.core || supplied.graphql !== expected.graphql) {
    return null;
  }
  return expected;
}

function normalizePhaseSeed(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const validSeed =
    typeof raw.seed === "string" ? raw.seed.length > 0 : Number.isFinite(raw.seed);
  return validSeed && Number.isFinite(raw.registeredAt) && raw.registeredAt >= 0
    ? { seed: raw.seed, registeredAt: raw.registeredAt }
    : null;
}

function createRoundRobinState(intents, cursors) {
  const state = {};
  for (const resource of RATE_RESOURCES) {
    const leaseIds = new Set(cursors[resource] ? [cursors[resource]] : []);
    for (const intent of intents) {
      if (intent.costs[resource] > 0) leaseIds.add(intent.leaseId);
    }
    const order = [...leaseIds].sort();
    const index = new Map(order.map((leaseId, position) => [leaseId, position]));
    const cursorIndex = index.get(cursors[resource]);
    state[resource] = {
      index,
      size: order.length,
      start: cursorIndex === undefined || order.length === 0
        ? 0
        : (cursorIndex + 1) % order.length,
    };
  }
  state.multiplier = intents.length * RATE_RESOURCES.length + 1;
  return state;
}

function fairnessScore(intent, state) {
  let maximum = 0;
  let total = 0;
  for (const resource of RATE_RESOURCES) {
    if (intent.costs[resource] <= 0) continue;
    const lane = state[resource];
    const position = lane.index.get(intent.leaseId);
    const distance = (position - lane.start + lane.size) % lane.size;
    maximum = Math.max(maximum, distance);
    total += distance;
  }
  return maximum * state.multiplier + total;
}

function nextRoundRobinIndex(intents, state) {
  let bestIndex = 0;
  let bestScore = fairnessScore(intents[0], state);
  for (let index = 1; index < intents.length; index += 1) {
    const score = fairnessScore(intents[index], state);
    const best = intents[bestIndex];
    const candidate = intents[index];
    if (
      score < bestScore ||
      (score === bestScore &&
        ((candidate.requestedAt ?? 0) < (best.requestedAt ?? 0) ||
          ((candidate.requestedAt ?? 0) === (best.requestedAt ?? 0) &&
            String(candidate.id).localeCompare(String(best.id)) < 0)))
    ) {
      bestIndex = index;
      bestScore = score;
    }
  }
  return bestIndex;
}

function advanceRoundRobinState(state, resource, leaseId) {
  const lane = state[resource];
  lane.start = (lane.index.get(leaseId) + 1) % lane.size;
}

function scheduleIntents({
  intents = [],
  leases = {},
  budgets = {},
  reservations = [],
  lanes = {},
  cursors = {},
  nowMs,
  maxGrants = Number.POSITIVE_INFINITY,
  manualStreak = 0,
}) {
  const valid = [];
  const prunedIntentIds = [];
  for (const intent of intents) {
    const lease = leaseFor(leases, intent.leaseId);
    const costs = intentCosts(intent);
    const priority = intentPriority(intent);
    const phaseSeed = normalizePhaseSeed(lease?.phaseSeed);
    const knownTab = intent.tab === undefined || TAB_KEYS.includes(intent.tab);
    if (
      !lease ||
      !Number.isFinite(lease.expiresAt) ||
      lease.expiresAt <= nowMs ||
      !Number.isFinite(intent.expiresAt) ||
      intent.expiresAt <= nowMs ||
      !phaseSeed ||
      !knownTab ||
      priority === null ||
      !costs
    ) {
      prunedIntentIds.push(intent.id);
    } else {
      valid.push({ ...intent, costs, phaseSeed, normalizedPriority: priority });
    }
  }

  const chargedTotals = Object.fromEntries(RATE_RESOURCES.map((resource) => [
    resource,
    reservations.reduce(
      (total, reservation) => total + reservationCost(reservation, resource, leases, nowMs),
      0,
    ),
  ]));
  const updatedLanes = structuredClone(lanes);
  const updatedCursors = { ...cursors };
  const grants = [];
  const denied = [];
  const liveLeaseCount = countLiveLeases(leases, nowMs);
  const priorities = [...new Set(valid.map((intent) => intent.normalizedPriority))].sort((a, b) => a - b);

  let streak = Number.isSafeInteger(manualStreak) && manualStreak > 0 ? manualStreak : 0;
  const grantedIds = new Set();
  // Priority still decides every other question. This says only that "higher
  // priority" cannot mean "always": once manual work has taken the last three
  // turns and an active owner is waiting, that owner takes this one. The turn
  // is a single grant, and it is subject to exactly the same budget, phase and
  // lane checks as any other -- fairness reorders work, it never admits work
  // that could not otherwise be paid for.
  const owedActiveTurn = streak >= MANUAL_GRANT_STREAK_LIMIT &&
    valid.some((intent) => intent.normalizedPriority === REQUEST_PRIORITIES.active);
  const passes = owedActiveTurn
    ? [{ priority: REQUEST_PRIORITIES.active, limit: 1, record: false },
      ...priorities.map((priority) => ({ priority, limit: Number.POSITIVE_INFINITY, record: true }))]
    : priorities.map((priority) => ({ priority, limit: Number.POSITIVE_INFINITY, record: true }));

  for (const pass of passes) {
    const priority = pass.priority;
    const pending = valid.filter((intent) =>
      intent.normalizedPriority === priority && !grantedIds.has(intent.id));
    const roundRobinState = createRoundRobinState(pending, updatedCursors);
    let grantedThisPass = 0;
    while (pending.length > 0) {
      if (grants.length >= maxGrants || grantedThisPass >= pass.limit) break;
      const intent = pending.splice(nextRoundRobinIndex(pending, roundRobinState), 1)[0];
      const resources = RATE_RESOURCES.filter((resource) => intent.costs[resource] > 0);
      const decisions = Object.fromEntries(resources.map((resource) => [
        resource,
        resourceDecision({
          budget: budgets[resource],
          resource,
          leases,
          nowMs,
          cost: intent.costs[resource],
          chargedCost: chargedTotals[resource],
        }),
      ]));
      const blocked = resources.find((resource) => decisions[resource].mode !== "open");
      if (blocked) {
        // Only the ordinary pass records a denial. The owed-turn pass looks at
        // the same intents again immediately afterwards, and recording here
        // would report every one of them twice.
        if (pass.record) denied.push({ intentId: intent.id, resource: blocked, ...decisions[blocked] });
        continue;
      }

      const phaseTimes = Object.fromEntries(resources.map((resource) => [
        resource,
        governorEpochPhaseAt(intent.phaseSeed, decisions[resource]),
      ]));
      const intrinsicAt = Math.max(nowMs, ...Object.values(phaseTimes));
      const notBefore = Math.max(
        intrinsicAt,
        ...resources.map((resource) => updatedLanes[resource]?.nextAt ?? nowMs),
      );
      const expiring = resources.find((resource) => notBefore >= decisions[resource].resetMs);
      if (expiring) {
        if (!pass.record) continue;
        denied.push({
          intentId: intent.id,
          resource: expiring,
          mode: "waiting",
          reason: "reset",
          retryAt: decisions[expiring].resetMs + BUDGET_RESET_GRACE_MS,
          resetMs: decisions[expiring].resetMs,
          epoch: decisions[expiring].epoch,
        });
        continue;
      }

      const reservation = {
        id: `reservation:${intent.id}`,
        intentId: intent.id,
        leaseId: intent.leaseId,
        costs: { ...intent.costs },
        notBefore,
        status: "scheduled",
        epochs: Object.fromEntries(resources.map((resource) => [resource, decisions[resource].epoch])),
      };
      const limitingLanes = resources.filter((resource) =>
        updatedLanes[resource]?.nextAt === notBefore);
      const sharingOwnerLeaseIds = [...new Set(limitingLanes.map((resource) =>
        updatedCursors[resource]))];
      const sharedLane = liveLeaseCount > 1 && notBefore > intrinsicAt &&
        sharingOwnerLeaseIds.length > 0 && sharingOwnerLeaseIds.every((owner) =>
          owner !== intent.leaseId && leaseFor(leases, owner)?.expiresAt > nowMs);
      if (sharedLane) {
        reservation.waitCause = "shared-lane";
        reservation.sharingCount = liveLeaseCount;
        reservation.sharingOwnerLeaseIds = sharingOwnerLeaseIds;
      }
      grants.push(reservation);
      grantedIds.add(intent.id);
      grantedThisPass += 1;
      // A manual grant extends the run; anything else ends it. The counter has
      // to persist, because the run this bounds is one manual intent per
      // planning pass rather than several within one.
      streak = priority === REQUEST_PRIORITIES.manual ? streak + 1 : 0;
      for (const resource of resources) {
        chargedTotals[resource] += intent.costs[resource];
        updatedLanes[resource] = {
          ...updatedLanes[resource],
          nextAt: notBefore + intent.costs[resource] / decisions[resource].callsPerMs,
        };
        updatedCursors[resource] = intent.leaseId;
        advanceRoundRobinState(roundRobinState, resource, intent.leaseId);
      }
    }
  }

  return {
    grants,
    lanes: updatedLanes,
    cursors: updatedCursors,
    denied,
    prunedIntentIds,
    manualStreak: streak,
  };
}

// ---------- Credential identities and restart-safe coordination ----------
const IDENTITY_VERSION = 1;
const IDENTITY_ATTEMPT_WINDOW_MS = 15 * 60_000;
const IDENTITY_ATTEMPT_LIMIT = 3;
const IDENTITY_HOST_ATTEMPT_LIMIT = 12;
const IDENTITY_MAX_ATTEMPTS = 4096;
const HTTP_START_GAP_MS = 250;
const HTTP_MAX_WAITERS = 128;
// A permit is reclaimable once it cannot still belong to a live request. The
// owner-death check alone cannot see a process that is stopped, or one whose
// release lost its lock, so a permit outliving the subprocess timeout it guards
// is stale by construction rather than by guess.
const HTTP_PERMIT_MAX_MS = GH_TIMEOUT_MS + 5_000;
// The longest a primary window can run. An attempt that never obtained reset
// evidence is still covered once a full window has demonstrably elapsed since it
// started, which is what keeps an unprovable charge from being retained forever.
const IDENTITY_UNCERTAIN_MAX_MS = 3_600_000 + BUDGET_RESET_GRACE_MS;
// Bound the in-band wait for the registry lock when a request is already
// finishing. The permit is what other panes queue behind, so a slow release must
// hand off to deferCompletion quickly instead of holding the whole machine.
const IDENTITY_RELEASE_WAIT_MS = 500;
// How long startup will wait for a warm local identity before painting. Long
// enough to win the ordinary case, short enough that a stuck credential helper
// costs a cache-cold first frame rather than a blank terminal.
const WARM_IDENTITY_WAIT_MS = 1_000;
// "busy" and "unwritable" say the registry could not be read or written *right
// now*. Every other reason is a statement about the identity itself. Three
// callers each drew this line differently -- retryIdentityCompletion retried
// both, refresh() treated them as proof the identity was gone, and permit
// acquisition threw on them -- so a 250 ms lock wait could be reported as an
// account change. One definition keeps them from drifting apart again.
const RETRYABLE_COORDINATION_REASONS = ["busy", "unwritable"];
// 60 s doubling per prior attempt in the window. The two callers deliberately
// count different prior sets -- bootstrap also has a per-host unknown-principal
// allowance and the transport start gap to respect, while a known-capacity
// observer is admitted normally and only the exceptional branch is throttled --
// but the delay they apply is one law and belongs in one place.
function attemptRetryDelayMs(priorAttempts) {
  return 60_000 * 2 ** priorAttempts;
}

function retryableCoordination(reason) {
  return RETRYABLE_COORDINATION_REASONS.includes(reason);
}

// A dead owner releases its permit immediately; a live owner keeps it only for
// as long as a request could still be running under it. Without the second
// test a stopped process, or one whose release never won the lock, holds the
// single machine-wide permit forever and every pane queues behind it.
function staleHttpPermit(permit, now, kill = process.kill.bind(process)) {
  if (pidIsDead(permit.pid, kill)) return true;
  return Number.isFinite(permit.startedAt) && now - permit.startedAt > HTTP_PERMIT_MAX_MS;
}
let runtimeIdentityCoordinator = null;

function privateIdentityDigest(...parts) {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function identityRegistryRoot(pathOptions = {}) {
  return join(dirname(widthPreferencesPath(pathOptions)), "coordination-v2");
}

function credentialEnvironmentNames(host) {
  return host === "github.com" || host.endsWith(".ghe.com")
    ? ["GH_TOKEN", "GITHUB_TOKEN"] : ["GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"];
}

// Deliberately not memoized, despite being called on the render and request
// paths. resolveEffectiveCredential brackets the `gh auth token` subprocess with
// a before/after comparison of this value to catch a credential swapped while
// resolution was in flight, so any cache whose window can cover that gap makes
// the process bind the wrong credential -- and a local token can resolve in
// under a millisecond. The cost is one statSync plus a digest of four numbers;
// reduce the number of callers instead of caching the answer.
function credentialConfigurationRevision(host, env = process.env) {
  const names = credentialEnvironmentNames(host);
  const selected = names.find((name) => env[name]);
  if (selected) return privateIdentityDigest(host, String(env[selected]));
  const directory = effectiveGhConfigDir({ env });
  let stamp = null;
  try {
    const value = statSync(join(directory, "hosts.yml"));
    stamp = [value.dev, value.ino, value.size, value.mtimeMs];
  } catch { /* missing local configuration is resolved honestly by gh */ }
  return privateIdentityDigest(host, directory, stamp);
}

async function resolveEffectiveCredential({ host, env = process.env, runLocalToken } = {}) {
  host = normalizeHost(host);
  if (!host) return { ok: false, reason: "unknown-host" };
  const names = credentialEnvironmentNames(host);
  const initialRevision = credentialConfigurationRevision(host, env);
  let token;
  try {
    const selected = names.find((name) => env[name]);
    if (selected) token = String(env[selected]);
    else {
      // This seam never passes through runGh/logGh and never exposes the child
      // error, stdout or stderr. Credentials exist only in this lexical scope.
      const result = await (runLocalToken ?? (async (args) => execFileAsync("gh", args, {
        env: { ...env, ...GH_ENV_OVERRIDES }, timeout: GH_TIMEOUT_MS,
        maxBuffer: 1024 * 1024, killSignal: "SIGKILL",
      })))(["auth", "token", "--hostname", host]);
      token = String(typeof result === "string" ? result : result.stdout ?? "").trim();
    }
    if (credentialConfigurationRevision(host, env) !== initialRevision) return { ok: false, reason: "credential-changed" };
    if (!token || /\s/.test(token)) return { ok: false, reason: "credential-unavailable" };
    const credentialKey = privateIdentityDigest("credential-v1", host, token);
    token = null;
    return { ok: true, value: { host, credentialKey, configurationRevision: initialRevision } };
  } catch {
    return { ok: false, reason: "credential-unavailable" };
  }
}

function emptyIdentityRegistry() {
  return { version: IDENTITY_VERSION, migration: { activated: false, holdUntil: 0 }, identities: {}, attempts: {}, hosts: {} };
}

function normalizeIdentityRegistry(raw) {
  if (!exactKeys(raw, ["version", "migration", "identities", "attempts", "hosts"]) || raw.version !== IDENTITY_VERSION ||
      !exactKeys(raw.migration, ["activated", "holdUntil"]) || typeof raw.migration.activated !== "boolean" ||
      !Number.isFinite(raw.migration.holdUntil) || raw.migration.holdUntil < 0 ||
      !isRecord(raw.identities) || !isRecord(raw.attempts) || !isRecord(raw.hosts) ||
      Object.keys(raw.attempts).length > IDENTITY_MAX_ATTEMPTS) return null;
  const digest = (value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
  const time = (value) => Number.isFinite(value) && value >= 0;
  for (const [key, identity] of Object.entries(raw.identities)) {
    if (!digest(key) || !exactKeys(identity, ["host", "kind", "id", "login", "quotaKey", "accessKey", "generation", "observedAt"]) ||
        !normalizeHost(identity.host) || identity.kind !== "user" || !Number.isSafeInteger(identity.id) || identity.id <= 0 ||
        typeof identity.login !== "string" || identity.login !== safe(identity.login) || !digest(identity.quotaKey) || !digest(identity.accessKey) ||
        !Number.isSafeInteger(identity.generation) || identity.generation < 1 || !time(identity.observedAt)) return null;
  }
  for (const [id, attempt] of Object.entries(raw.attempts)) {
    if (!validGovernorId(id) || !exactKeys(attempt, ["credentialKey", "host", "resource", "startedAt", "retryAt", "ownerPid", "nonce", "status", "quotaKey", "resetMs", "accounted", "imported", "exceptional"]) ||
        !digest(attempt.credentialKey) || !normalizeHost(attempt.host) || !RATE_RESOURCES.includes(attempt.resource) ||
        !time(attempt.startedAt) || !time(attempt.retryAt) || !Number.isSafeInteger(attempt.ownerPid) || attempt.ownerPid < 1 || !validGovernorId(attempt.nonce) ||
        !["started", "finished", "uncertain"].includes(attempt.status) || (attempt.quotaKey !== null && !digest(attempt.quotaKey)) ||
        (attempt.resetMs !== null && !time(attempt.resetMs)) || typeof attempt.accounted !== "boolean" || typeof attempt.imported !== "boolean" || typeof attempt.exceptional !== "boolean") return null;
  }
  for (const [host, transport] of Object.entries(raw.hosts)) {
    if (!isRecord(transport)) return null;
    const keys = ["lastStartedAt", "cooldownUntil", "permit"];
    if (Object.hasOwn(transport, "waiters")) keys.push("waiters");
    if (Object.hasOwn(transport, "throttle")) keys.push("throttle");
    if (!normalizeHost(host) || !exactKeys(transport, keys) ||
        !time(transport.lastStartedAt) || !time(transport.cooldownUntil)) return null;
    if (transport.permit !== null && (!exactKeys(transport.permit, ["pid", "nonce", "startedAt"]) ||
        !Number.isSafeInteger(transport.permit.pid) || transport.permit.pid < 1 || !validGovernorId(transport.permit.nonce) || !time(transport.permit.startedAt))) return null;
    if (!Object.hasOwn(transport, "throttle")) transport.throttle = emptyTransportThrottle();
    if (!isRecord(transport.throttle) || !exactKeys(transport.throttle, ["attempts", "lastAt", "paused"]) ||
        !Number.isSafeInteger(transport.throttle.attempts) || transport.throttle.attempts < 0 ||
        transport.throttle.attempts > THROTTLE_PAUSE_AFTER ||
        !time(transport.throttle.lastAt) || typeof transport.throttle.paused !== "boolean") return null;
    if (!Object.hasOwn(transport, "waiters")) transport.waiters = [];
    if (!Array.isArray(transport.waiters) || transport.waiters.length > HTTP_MAX_WAITERS ||
        new Set(transport.waiters.map((waiter) => waiter?.nonce)).size !== transport.waiters.length ||
        transport.waiters.some((waiter) => !exactKeys(waiter, ["pid", "nonce", "queuedAt", "deadline"]) ||
          !Number.isSafeInteger(waiter.pid) || waiter.pid < 1 || !validGovernorId(waiter.nonce) ||
          !time(waiter.queuedAt) || !time(waiter.deadline) || waiter.deadline <= waiter.queuedAt ||
          waiter.deadline - waiter.queuedAt > GH_TIMEOUT_MS)) return null;
  }
  return raw;
}

function withIdentityRegistry(root, operation, { now = Date.now(), kill = process.kill.bind(process) } = {}) {
  const path = join(root, "registry.json");
  const scope = { path, hash: "identity-registry", host: "github.com", identityProvider: null, kill };
  return withGovernorLock(scope, () => {
    // Read and parse are separated for the same reason readGovernorState
    // separates them: EACCES, EIO or EMFILE mean "try again", while unparseable
    // bytes mean "stop and preserve the evidence". Collapsing the two reported a
    // transient descriptor shortage as permanent corruption.
    let raw = null;
    try { raw = readFileSync(path, "utf8"); }
    catch (error) { if (error?.code !== "ENOENT") return { ok: false, reason: "unwritable" }; }
    let state;
    if (raw === null) state = emptyIdentityRegistry();
    else {
      try { state = normalizeIdentityRegistry(JSON.parse(raw)); }
      catch { return { ok: false, reason: "corrupt" }; }
    }
    if (!state) return { ok: false, reason: "corrupt" };
    // Captured before the prunes below so their deletions still count as a
    // change. Every governor operation -- including read-only inspection --
    // funnels through here, and each one used to serialize and rename the
    // registry while holding the one machine-wide lock.
    const before = JSON.stringify(state);
    for (const transport of Object.values(state.hosts)) {
      transport.waiters = transport.waiters.filter((waiter) => waiter.deadline > now && !pidIsDead(waiter.pid, kill));
    }
    for (const [id, attempt] of Object.entries(state.attempts)) {
      // Past its rolling window *and* past any backoff it still imposes. retryAt
      // is what carries known exhaustion (settlement pushes it out to reset plus
      // grace, beyond the window), so testing it is what lets an aged-out entry
      // be dropped without forgiving a hold that is still in force.
      if (attempt.startedAt + IDENTITY_ATTEMPT_WINDOW_MS > now || attempt.retryAt > now) continue;
      const identity = state.identities[attempt.credentialKey];
      // No identity for this credential means no quota scope, so there is no
      // ledger receipt the attempt could be holding and nothing to reconcile.
      // These are the failed bootstraps -- they never reach importIdentityDebts,
      // so they used to be immortal and wedged claimIdentityBootstrap at
      // IDENTITY_MAX_ATTEMPTS permanently, with deleting registry.json by hand
      // as the only way out.
      if (!identity) { delete state.attempts[id]; continue; }
      const scope = { ...createQuotaScope({ ...identity, credentialKey: attempt.credentialKey }, { root, now: () => now, kill }), rootLocked: true };
      const retired = withGovernorLock(scope, () => {
        const ledger = readIdentityQuotaState(state, scope, now);
        if (!ledger.ok || ledger.missing) return ledger.ok ? { ok: false, reason: "corrupt" } : ledger;
        const budget = ledger.value.budgets[attempt.resource];
        const resetCovered = attempt.resetMs !== null
          ? now >= attempt.resetMs && budget?.resetMs > attempt.resetMs
          // An attempt whose observer never returned core evidence has no reset
          // of its own to wait for. A window boundary proven to fall after it
          // started covers its charge just as well, and is the only thing that
          // stops the entry from being retained for the life of the install.
          : budget?.resetMs > attempt.startedAt + IDENTITY_UNCERTAIN_MAX_MS;
        if (!attempt.accounted && !resetCovered) return { ok: true, value: false };
        delete ledger.value.reservations[`reservation:${id}`];
        const write = writeGovernorState(scope.path, ledger.value);
        return write.ok ? { ok: true, value: true } : write;
      });
      if (!retired.ok) return retired;
      if (retired.value) delete state.attempts[id];
    }
    const result = operation(state, now);
    if (!normalizeIdentityRegistry(state)) return { ok: false, reason: "corrupt" };
    if (JSON.stringify(state) === before) return result;
    const written = writeGovernorState(path, state);
    return written.ok ? result : written;
  });
}

function inspectIdentityRegistry(root, options) {
  return withIdentityRegistry(root, (state) => ({ ok: true, value: structuredClone(state) }), options);
}

function inspectLegacyMigration(root, state, now) {
  let names;
  try { names = readdirSync(dirname(root)).filter((name) => /^rate-governor-v1-[0-9a-f]{64}\.json$/.test(name)); }
  catch (error) { return { ok: false, reason: error.code === "ENOENT" ? "unwritable" : "corrupt" }; }
  let holdUntil = state.migration.holdUntil;
  for (const name of names) {
    let raw;
    try { raw = JSON.parse(readFileSync(join(dirname(root), name), "utf8")); } catch { return { ok: false, reason: "legacy-corrupt" }; }
    // Evidence is never rewritten. Recognize only the pinned legacy schemas.
    // Every protocol an older pane could still be running, newest first. The set
    // grows as GOVERNOR_STATE_VERSION advances: a version bump makes an old
    // binary fail closed on its own gate, but this side must still recognise
    // that binary's file well enough to see it holds a live lease.
    const legacy = LEGACY_GOVERNOR_VERSIONS
      .map((version) => readLegacyGovernorState(raw, now, version))
      .find(Boolean) ?? migrateGovernorState(raw, now);
    if (legacy && raw.version === 1 && raw.budgets?.core) {
      const core = raw.budgets.core;
      const preserved = normalizeGovernorBudget({ ...core, source: "core-observer", factorBaseline: { epoch: core.epoch, used: core.used, observedAt: core.observedAt }, knownLocalUsed: 0 }, now, "core");
      if (!preserved) return { ok: false, reason: "legacy-corrupt" };
      // This is a migration hold view only, never published as new authority.
      legacy.budgets.core = preserved;
      legacy.epochs.core = preserved.epoch;
    }
    if (!legacy) return { ok: false, reason: "legacy-corrupt" };
    if (Object.values(legacy.leases).some((lease) => lease.expiresAt > now)) return { ok: false, reason: "restart-required" };
    for (const resource of RATE_RESOURCES) {
      const budget = legacy.budgets[resource];
      holdUntil = Math.max(holdUntil, budget?.blockUntil ?? 0);
      const uncertain = Object.values(legacy.reservations).filter((reservation) =>
        ["started", "completed"].includes(reservation.status) && reservationCost(reservation, resource, legacy.leases, now) > 0);
      if (uncertain.length > 0) {
        // The deadline may only be read from the migrated view for resources the
        // migration kept. A v1 file's budgets are dropped on purpose -- they came
        // from /rate_limit and are not spendable capacity -- but the reset they
        // record is still a fact about when that window ended, and using it as a
        // deadline is not the same as admitting work against it. Core already had
        // a reconstruction above; GraphQL never did, so a v1 file holding any
        // uncertain GraphQL charge asked a dropped budget for its reset, found
        // none, and reported legacy-unresolved -- which has no deadline and so
        // never cleared. The file it came from had a perfectly good reset in it
        // the whole time.
        //
        // A file can also simply never have recorded a budget for the resource:
        // a v2 ledger whose panes only ever observed GraphQL still charged core
        // per request, so its core reservations exist without a core budget to
        // ask. Each reservation records the epoch it was admitted against, and
        // that epoch's reset is when its window ended -- the same fact, kept in
        // the other place. Only a reservation with no budget *and* no epoch is
        // genuinely undated.
        const recorded = uncertain
          .map((reservation) => Number(String(reservation.epochs?.[resource] ?? "").split(":")[1]))
          .filter(Number.isFinite);
        const reset = Number.isFinite(budget?.resetMs)
          ? budget.resetMs
          : Number.isFinite(Number(raw?.budgets?.[resource]?.resetMs))
            ? Number(raw.budgets[resource].resetMs)
            : recorded.length > 0 ? Math.max(...recorded) : NaN;
        if (!Number.isFinite(reset)) return { ok: false, reason: "legacy-unresolved" };
        holdUntil = Math.max(holdUntil, reset + BUDGET_RESET_GRACE_MS);
      }
    }
  }
  state.migration.holdUntil = holdUntil;
  if (holdUntil > now) return { ok: false, reason: "migration-hold", retryAt: holdUntil };
  // Deliberately a record, not a gate. Re-listing the legacy directory on every
  // operation is what satisfies "detect reappearing legacy leases during
  // operation": an old binary started after migration must still be able to
  // pause new admission, and it cannot announce itself through a sentinel it
  // does not read. Short-circuiting on this flag would be faster and wrong.
  state.migration.activated = true;
  return { ok: true };
}

function claimIdentityBootstrap(root, { credentialKey, host, resource = "core", now = Date.now(), kill = process.kill.bind(process) } = {}) {
  return withIdentityRegistry(root, (state) => {
    const migration = inspectLegacyMigration(root, state, now);
    if (!migration.ok) return migration;
    const transport = state.hosts[host] ??= { lastStartedAt: 0, cooldownUntil: 0, permit: null };
    if (transport.permit && staleHttpPermit(transport.permit, now, kill)) transport.permit = null;
    if (transport.permit || transport.waiters?.length) return { ok: false, reason: "identity-busy", retryAt: now + 1000 };
    const attempts = Object.values(state.attempts);
    const recent = attempts.filter((attempt) => attempt.startedAt > now - IDENTITY_ATTEMPT_WINDOW_MS);
    const own = recent.filter((attempt) => attempt.credentialKey === credentialKey && attempt.resource === resource && attempt.exceptional);
    const unknown = recent.filter((attempt) => attempt.host === host && attempt.exceptional);
    const retryAt = Math.max(transport.cooldownUntil, transport.lastStartedAt + HTTP_START_GAP_MS,
      ...attempts.filter((attempt) => attempt.credentialKey === credentialKey && attempt.resource === resource).map((attempt) => attempt.retryAt),
      own.length >= IDENTITY_ATTEMPT_LIMIT ? Math.min(...own.map((attempt) => attempt.startedAt)) + IDENTITY_ATTEMPT_WINDOW_MS : 0,
      unknown.length >= IDENTITY_HOST_ATTEMPT_LIMIT ? Math.min(...unknown.map((attempt) => attempt.startedAt)) + IDENTITY_ATTEMPT_WINDOW_MS : 0);
    if (retryAt > now) return { ok: false, reason: "identity-backoff", retryAt };
    if (attempts.length >= IDENTITY_MAX_ATTEMPTS) return { ok: false, reason: "identity-capacity" };
    const id = governorId();
    const nonce = governorId();
    state.attempts[id] = { credentialKey, host, resource, startedAt: now, retryAt: now + attemptRetryDelayMs(own.length),
      ownerPid: process.pid, nonce, status: "started", quotaKey: null, resetMs: null, accounted: false, imported: false, exceptional: true };
    transport.permit = { pid: process.pid, nonce, startedAt: now };
    transport.lastStartedAt = now;
    return { ok: true, value: { id, nonce } };
  }, { now, kill });
}

function readIdentityQuotaState(registry, scope, now) {
  const loaded = readGovernorState(scope.path, now);
  const known = Object.values(registry.identities).some((identity) => identity.quotaKey === scope.quotaKey) ||
    Object.values(registry.attempts).some((attempt) => attempt.imported && attempt.quotaKey === scope.quotaKey);
  return loaded.ok && loaded.missing && known ? { ok: false, reason: "corrupt" } : loaded;
}

function importIdentityDebts(root, state, credentialKey, identity, now) {
  const scope = { ...createQuotaScope({ ...identity, credentialKey }, { root, now: () => now }), rootLocked: true };
  return withGovernorLock(scope, () => {
    const loaded = readIdentityQuotaState(state, scope, now);
    if (!loaded.ok) return loaded;
    const transferred = [];
    for (const [id, attempt] of Object.entries(state.attempts)) {
      if (attempt.credentialKey !== credentialKey || attempt.imported) continue;
      const reservationId = `reservation:${id}`;
      loaded.value.reservations[reservationId] ??= {
        leaseId: id, intentId: id, costs: { core: 0, graphql: 0, [attempt.resource]: 1 }, actualCosts: null,
        accountedCosts: { core: 0, graphql: 0, [attempt.resource]: attempt.accounted ? 1 : 0 },
        notBefore: attempt.startedAt, status: "started", epochs: { core: null, graphql: null },
        startedAt: attempt.startedAt, completedAt: null, outcome: null,
      };
      transferred.push(id);
    }
    // importIdentityDebts writes this ledger before the registry transaction
    // that records the mapping commits. A crash in between leaves a charged
    // receipt here whose attempt is gone from the registry, and nothing else
    // ever looks at it again -- it presents only as a permanently smaller
    // budget. Re-bootstrapping the same credential is exactly when it can be
    // recognised, and a full window since it started proves a reset covered it.
    for (const key of Object.keys(loaded.value.reservations)) {
      const attemptId = /^reservation:(.+)$/.exec(key)?.[1];
      if (!attemptId || state.attempts[attemptId]) continue;
      const reservation = loaded.value.reservations[key];
      if (reservation.startedAt + IDENTITY_UNCERTAIN_MAX_MS > now) continue;
      delete loaded.value.reservations[key];
    }
    const written = writeGovernorState(scope.path, loaded.value);
    if (!written.ok) return written;
    // Marked transferred only once the receipts are durable. withIdentityRegistry
    // persists the registry whatever this returns, so setting these before the
    // ledger write meant a failed write could leave the registry claiming a debt
    // had moved to a ledger that never received it -- and the `imported` guard
    // would then skip those attempts forever, dropping the conservative charge.
    for (const id of transferred) {
      state.attempts[id].quotaKey = identity.quotaKey;
      state.attempts[id].imported = true;
    }
    return written;
  });
}

function finishIdentityBootstrap(root, { credentialKey, id, nonce, response = null, now = Date.now(), isCurrent = () => true } = {}) {
  return withIdentityRegistry(root, (state) => {
    const attempt = state.attempts[id];
    if (!attempt || attempt.nonce !== nonce || attempt.credentialKey !== credentialKey) return { ok: false, reason: "stale" };
    const transport = state.hosts[attempt.host];
    if (transport.permit?.nonce === nonce) transport.permit = null;
    attempt.status = response ? "finished" : "uncertain";
    const parsed = response?.body;
    const evidence = response?.rateLimit;
    applyTransportCooldown(transport, { retryAfter: response?.retryAfter, status: response?.status, secondary: response?.secondary, at: now });
    if (evidence?.resource === "core" && normalizeBudgetResource(evidence, now)) {
      attempt.resetMs = evidence.resetMs;
      if (evidence.remaining === 0) attempt.retryAt = Math.max(attempt.retryAt, evidence.resetMs + BUDGET_RESET_GRACE_MS);
    }
    if (!isCurrent()) return { ok: false, reason: "stale" };
    if ((response?.status ?? 200) !== 200 || !isRecord(parsed) || !Number.isSafeInteger(parsed.id) || parsed.id <= 0 || typeof parsed.login !== "string" ||
        parsed.login.length === 0 || !evidence || evidence.resource !== "core" || !normalizeBudgetResource(evidence, now)) return { ok: false, reason: "identity-unavailable" };
    const generation = state.identities[credentialKey]?.generation ?? 1;
    const identity = { host: attempt.host, kind: "user", id: parsed.id, login: safe(parsed.login),
      quotaKey: privateIdentityDigest("quota-v2", attempt.host, "user", parsed.id),
      accessKey: privateIdentityDigest("access-v2", credentialKey, generation), generation, observedAt: now };
    attempt.accounted = true;
    for (const previous of Object.values(state.attempts)) {
      if (previous.credentialKey === credentialKey && previous.resource === "core") previous.resetMs ??= evidence.resetMs;
    }
    // Record the mapping only after the ledger contains every debt. A crash
    // between writes replays stable reservation IDs while the root lock prevents
    // observers from deleting receipts before the mapping transaction finishes.
    const imported = importIdentityDebts(root, state, credentialKey, identity, now);
    if (!imported.ok) return imported;
    // The admitted identity proof supplies core authority. Retain its validator
    // so later observers can confirm unchanged identity without primary spend.
    {
      const scope = { ...createQuotaScope({ ...identity, credentialKey }, { root, now: () => now }), rootLocked: true };
      const seeded = withGovernorLock(scope, () => {
        const ledger = readIdentityQuotaState(state, scope, now);
        if (!ledger.ok) return ledger;
        const observation = budgetFromObservation(evidence, ledger.value.budgets.core, now, { resource: "core", source: "core-observer", receivedAt: now, allowEpochChange: true });
        if (observation.status === "accepted") {
          ledger.value.budgets.core = observation.budget;
          ledger.value.epochs.core = observation.budget.epoch;
          ledger.value.observers.core = { etag: typeof response.etag === "string" ? response.etag : null, outcome: "healthy", at: now, nextAt: now + BUDGET_PROBE_MS };
        }
        return writeGovernorState(scope.path, ledger.value);
      });
      if (!seeded.ok) return seeded;
    }
    if (!isCurrent()) return { ok: false, reason: "stale" };
    state.identities[credentialKey] = identity;
    return { ok: true, value: { ...identity, credentialKey } };
  }, { now });
}

function createSettlementContext(scope, coordinator) {
  return { scope: { ...scope, identityProvider: null }, isCurrent: () => coordinator.current()?.accessKey === scope.accessKey };
}

function createQuotaScope(identity, { root = identityRegistryRoot(), now = Date.now, identityProvider = null, kill = process.kill.bind(process) } = {}) {
  return { hash: identity.quotaKey, quotaKey: identity.quotaKey, credentialKey: identity.credentialKey, accessKey: identity.accessKey,
    path: join(root, `quota-${identity.quotaKey}.json`), coordinationRoot: root, host: identity.host, authIdentity: identity.quotaKey,
    identityProvider, now, kill };
}

function createIdentityCoordinator({ host, pathOptions = {}, env = process.env, now = Date.now, kill = process.kill.bind(process), runLocalToken, requestIdentity } = {}) {
  const root = identityRegistryRoot(pathOptions);
  let current = null;
  let revision = null;
  let pending = null;
  let failure = null;
  let resolvedCredential = null;
  let closed = false;
  const bootstrapAbort = new AbortController();
  const completions = new Map();
  const deferCompletion = (key, operation) => completions.set(key, operation);
  const flushCompletions = async () => {
    for (const [key, operation] of completions) {
      const result = await retryIdentityCompletion(operation, { shouldRetry: () => !closed });
      if (!result.ok && ["busy", "unwritable"].includes(result.reason)) return result;
      // A malformed/denied proof is a completed durable attempt, not pending
      // storage work. Drop that callback so ordinary backoff can recover.
      completions.delete(key);
      if (!result.ok && result.reason === "corrupt") return result;
    }
    return { ok: true };
  };
  const resolveHost = () => normalizeHost(typeof host === "function" ? host() : host);
  const snapshot = () => {
    if (closed) return null;
    const selectedHost = resolveHost();
    if (current && (current.host !== selectedHost || credentialConfigurationRevision(selectedHost, env) !== revision)) current = null;
    return current;
  };
  const refresh = ({ allowBootstrap = true } = {}) => {
    if (closed) return Promise.resolve({ ok: false, reason: "closed" });
    if (pending) return pending;
    pending = (async () => {
      const completed = await flushCompletions();
      if (!completed.ok) { failure = completed; return completed; }
      const selectedHost = resolveHost();
      const wantedRevision = selectedHost ? credentialConfigurationRevision(selectedHost, env) : null;
      const resolved = resolvedCredential?.value?.configurationRevision === wantedRevision
        ? resolvedCredential : await resolveEffectiveCredential({ host: selectedHost, env, runLocalToken });
      if (resolved.ok) resolvedCredential = resolved;
      if (closed) return { ok: false, reason: "closed" };
      if (!resolved.ok) { current = null; failure = resolved; return resolved; }
      revision = resolved.value.configurationRevision;
      const { credentialKey } = resolved.value;
      const stored = withIdentityRegistry(root, (state) => {
        const migration = inspectLegacyMigration(root, state, now());
        if (!migration.ok) return migration;
        const identity = state.identities[credentialKey];
        return { ok: true, value: identity ? { ...identity, credentialKey } : null };
      }, { now: now(), kill });
      // A retryable lock failure says nothing about the identity, and nulling
      // `current` for one makes ensureScope retire the lease and blank every
      // tab -- discarding the ETags that make the next round cheap.
      if (!stored.ok) { if (!retryableCoordination(stored.reason)) current = null; failure = stored; return stored; }
      if (stored.value) { current = stored.value; failure = null; return { ok: true, value: current }; }
      if (!allowBootstrap) {
        failure = { ok: false, reason: "identity-unavailable" };
        return failure;
      }
      const claim = claimIdentityBootstrap(root, { credentialKey, host: selectedHost, now: now(), kill });
      if (!claim.ok) { if (!retryableCoordination(claim.reason)) current = null; failure = claim; return claim; }
      const proofRevision = resolved.value.configurationRevision;
      // Check after claim lock waits as well as inside deferred completion:
      // either wait can outlive the host/configuration that selected this token.
      const isCurrent = () => !closed && resolveHost() === selectedHost && credentialConfigurationRevision(selectedHost, env) === proofRevision;
      let response = null;
      try {
        if (isCurrent()) response = await (requestIdentity ?? (async (requestHost, { signal }) => {
          let stdout;
          try {
            ({ stdout } = await execFileAsync("gh", ["api", "-i", "user", "--hostname", requestHost], {
              env: { ...env, ...GH_ENV_OVERRIDES }, timeout: GH_TIMEOUT_MS, maxBuffer: GH_MAX_BUFFER, killSignal: "SIGKILL", signal,
            }));
          } catch (error) { stdout = error.stdout ?? ""; }
          const parsed = parseGhApiResponse(stdout);
          let body = null;
          try { body = JSON.parse(parsed.body); } catch { /* selected error evidence is still useful */ }
          return { status: parsed.status, body, rateLimit: pickRateLimit(parsed.headers), etag: parsed.headers.etag ?? null,
            retryAfter: parsed.headers["retry-after"] ?? null, secondary: SECONDARY_LIMIT_PATTERN.test(String(body?.message ?? "")) };
        }))(selectedHost, { signal: bootstrapAbort.signal });
      } catch { /* raw authentication errors never leave the credential seam */ }
      const finish = () => finishIdentityBootstrap(root, { credentialKey, ...claim.value, response, now: now(), isCurrent });
      const settled = await retryIdentityCompletion(finish, { shouldRetry: () => !closed });
      if (!settled.ok && ["busy", "unwritable"].includes(settled.reason)) deferCompletion(`bootstrap:${claim.value.id}`, finish);
      if (!isCurrent()) { current = null; return { ok: false, reason: "stale" }; }
      current = settled.ok ? settled.value : null;
      failure = settled.ok ? null : settled;
      return settled;
    })().finally(() => { pending = null; });
    return pending;
  };
  return { root, current: snapshot, refresh, deferCompletion, flushCompletions, inspect: () => failure, isClosed: () => closed, close: () => { closed = true; current = null; bootstrapAbort.abort(); } };
}

async function retryIdentityCompletion(operation, { timeoutMs = GH_TIMEOUT_MS, shouldRetry = () => true } = {}) {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const result = operation();
    if (result.ok || !retryableCoordination(result.reason) || !shouldRetry() || performance.now() >= deadline) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Shutdown retains the unresolved receipt; do not keep the CLI alive to
    // retry a lock owned by another live process. Account switches still retry.
    if (!shouldRetry()) return result;
  }
}

function startIdentityControl(coordinator, now = Date.now()) {
  const identity = coordinator.current();
  if (!identity) return { ok: false, reason: "identity-unavailable" };
  return withIdentityRegistry(coordinator.root, (registry) => {
    const scope = { ...createQuotaScope(identity, { root: coordinator.root, now: () => now }), rootLocked: true };
    return withGovernorLock(scope, () => {
      const loaded = readIdentityQuotaState(registry, scope, now);
      if (!loaded.ok) return loaded;
      const state = loaded.value;
      const budget = state.budgets.core;
      const exceptional = !budget || now >= budget.resetMs + BUDGET_RESET_GRACE_MS;
      if (budget && now >= budget.resetMs && !exceptional) return { ok: false, reason: "identity-backoff", retryAt: budget.resetMs + BUDGET_RESET_GRACE_MS };
      if (!exceptional) {
        const reserved = Object.values(state.reservations).reduce((sum, reservation) => sum + reservationCost(reservation, "core", state.leases, now), 0);
        if (budget.remaining - resourceReserve(budget.limit) - reserved < 1) return { ok: false, reason: "identity-backoff", retryAt: budget.resetMs + BUDGET_RESET_GRACE_MS };
      }
      const recent = Object.values(registry.attempts).filter((attempt) => attempt.credentialKey === identity.credentialKey && attempt.resource === "core" && attempt.exceptional && attempt.startedAt > now - IDENTITY_ATTEMPT_WINDOW_MS);
      const retryAt = Math.max(0, ...recent.map((attempt) => attempt.retryAt), recent.length >= IDENTITY_ATTEMPT_LIMIT ? Math.min(...recent.map((attempt) => attempt.startedAt)) + IDENTITY_ATTEMPT_WINDOW_MS : 0);
      if (exceptional && retryAt > now) return { ok: false, reason: "identity-backoff", retryAt };
      if (Object.keys(registry.attempts).length >= IDENTITY_MAX_ATTEMPTS || Object.keys(state.reservations).length >= GOVERNOR_MAX_RESERVATIONS) return { ok: false, reason: "identity-capacity" };
      const id = governorId();
      registry.attempts[id] = { credentialKey: identity.credentialKey, host: identity.host, resource: "core", startedAt: now,
        retryAt: exceptional ? now + attemptRetryDelayMs(recent.length) : now, ownerPid: process.pid, nonce: governorId(), status: "started",
        quotaKey: identity.quotaKey, resetMs: budget?.resetMs ?? null, accounted: false, imported: true, exceptional };
      state.reservations[`reservation:${id}`] = { leaseId: id, intentId: id, costs: { core: 1, graphql: 0 }, actualCosts: null,
        accountedCosts: { core: 0, graphql: 0 }, notBefore: now, status: "started", epochs: { core: budget?.epoch ?? null, graphql: null },
        startedAt: now, completedAt: null, outcome: null };
      const written = writeGovernorState(scope.path, state);
      return written.ok ? { ok: true, value: { id, identity } } : written;
    });
  }, { now });
}

function settleIdentityControl(coordinator, control, stdout, now = Date.now()) {
  return withIdentityRegistry(coordinator.root, (registry) => {
    const attempt = registry.attempts[control.id];
    if (!attempt) return { ok: false, reason: "stale" };
    const parsed = parseGhApiResponse(stdout ?? "");
    const evidence = pickRateLimit(parsed.headers);
    const proven = [200, 304].includes(parsed.status) && evidence?.resource === "core";
    attempt.status = proven ? "finished" : "uncertain";
    attempt.accounted = proven;
    if (evidence?.resource === "core") {
      attempt.resetMs = evidence.resetMs;
      if (evidence.remaining === 0) attempt.retryAt = Math.max(attempt.retryAt, evidence.resetMs + BUDGET_RESET_GRACE_MS);
    }
    const scope = { ...createQuotaScope(control.identity, { root: coordinator.root, now: () => now }), rootLocked: true };
    return withGovernorLock(scope, () => {
      const loaded = readIdentityQuotaState(registry, scope, now);
      if (!loaded.ok) return loaded;
      const reservation = loaded.value.reservations[`reservation:${control.id}`];
      if (!reservation) return { ok: false, reason: "stale" };
      if (proven) {
        const cost = parsed.status === 304 ? 0 : 1;
        reservation.status = "completed";
        reservation.completedAt = now;
        reservation.outcome = "measured-success";
        reservation.actualCosts = { core: cost, graphql: 0 };
        reservation.accountedCosts = { core: cost, graphql: 0 };
      }
      return writeGovernorState(scope.path, loaded.value);
    });
  }, { now });
}

async function acquireIdentityHttpPermit(coordinator, { signal, now = Date.now } = {}) {
  const flushed = await coordinator.flushCompletions?.();
  if (flushed && !flushed.ok) throw new Error(identityCoordinationMessage(flushed.reason));
  const identity = coordinator.current();
  if (!identity) throw new Error("Verified identity unavailable");
  const queuedAt = now();
  const deadline = queuedAt + GH_TIMEOUT_MS;
  const nonce = governorId();
  let acquired = false;
  try {
    for (;;) {
      if (signal?.aborted) throw new Error("Request cancelled");
      if (coordinator.current()?.accessKey !== identity.accessKey) throw new Error("Credential changed before request start");
      if (now() >= deadline) throw new Error(identityCoordinationMessage("transport-busy"));
      const result = withIdentityRegistry(coordinator.root, (state) => {
        const migration = inspectLegacyMigration(coordinator.root, state, now());
        if (!migration.ok) return migration;
        if (now() >= deadline) return { ok: false, reason: "transport-busy", retryAt: deadline };
        const transport = state.hosts[identity.host] ??= { lastStartedAt: 0, cooldownUntil: 0, permit: null, waiters: [], throttle: emptyTransportThrottle() };
        // Five consecutive throttles means the ladder has stopped being useful.
        // Waiting out the deadline is what produced the last one, so the pause
        // holds until a person retries or a primary reset opens a recovery.
        if (transport.throttle?.paused) {
          return { ok: false, reason: "throttle-paused", retryAt: transport.cooldownUntil };
        }
        if (transport.permit && staleHttpPermit(transport.permit, now())) transport.permit = null;
        // Admission can happen during the mandatory start gap. Persist call
        // order once so later polling cannot overtake an earlier caller.
        if (!transport.waiters.some((waiter) => waiter.nonce === nonce)) {
          if (transport.waiters.length >= HTTP_MAX_WAITERS) return { ok: false, reason: "identity-capacity" };
          transport.waiters.push({ pid: process.pid, nonce, queuedAt, deadline });
        }
        const retryAt = Math.max(transport.cooldownUntil, transport.lastStartedAt + HTTP_START_GAP_MS);
        if (transport.permit || transport.waiters[0].nonce !== nonce || retryAt > now()) {
          return { ok: false, reason: "transport-busy", retryAt: Math.max(retryAt, now() + 50) };
        }
        transport.waiters.shift();
        transport.permit = { pid: process.pid, nonce, startedAt: now() };
        transport.lastStartedAt = now();
        return { ok: true, value: { nonce, host: identity.host } };
      }, { now: now() });
      if (result.ok) { acquired = true; return result.value; }
      // A contended registry lock is the same class of wait as a held permit:
      // both mean "not yet", not "no identity". Only transport-busy carries a
      // retryAt, so give the rest the poll interval the loop already uses.
      const retryAt = result.retryAt ?? now() + 50;
      if ((result.reason !== "transport-busy" && !retryableCoordination(result.reason)) ||
          now() >= deadline || retryAt >= deadline) throw new Error(identityCoordinationMessage(result.reason));
      await new Promise((resolve) => setTimeout(resolve, Math.max(1, Math.min(50, retryAt - now()))));
    }
  } finally {
    if (!acquired) {
      const cleanup = () => withIdentityRegistry(coordinator.root, (state) => {
        const transport = state.hosts[identity.host];
        if (transport) transport.waiters = transport.waiters.filter((waiter) => waiter.nonce !== nonce);
        return { ok: true };
      }, { now: now() });
      const cleaned = cleanup();
      if (!cleaned.ok) coordinator.deferCompletion?.(`waiter:${nonce}`, cleanup);
    }
  }
}

// One cooldown law, two call sites: the bootstrap observer reads its evidence
// from a parsed response, the permit release from a failed subprocess's captured
// output. They had already drifted into two implementations with two different
// secondary-limit detectors -- which is how a tuning applied to one quietly
// stops applying to the other.
const SECONDARY_LIMIT_PATTERN = /secondary rate|abuse/i;

// The locally chosen delay climbs by consecutive throttle and stops climbing at
// fifteen minutes. The cap bounds only what this client invents for itself: a
// server that asks for two hours is given two hours, because it knows something
// we do not.
const THROTTLE_LADDER_MS = [60_000, 120_000, 240_000, 480_000, 900_000];
// After this many consecutive throttles the transport stops choosing new delays
// and waits for a person or a primary reset. Climbing forever keeps a wedged
// credential politely hammering a limit it has no way to satisfy.
const THROTTLE_PAUSE_AFTER = 5;

function throttleLadderMs(priorThrottles) {
  const step = Number.isSafeInteger(priorThrottles) && priorThrottles > 0 ? priorThrottles : 0;
  return THROTTLE_LADDER_MS[Math.min(step, THROTTLE_LADDER_MS.length - 1)];
}

// Reads throttle evidence without inventing any. The case this exists to get
// right is the permission-only 403: it carries the same status as an exhausted
// primary limit and is not a throttle at all, so treating it as one pauses a
// pane that was never limited -- it was just not allowed.
function classifyThrottle({ status = null, headers = null, graphqlErrors = null, stderr = "", body = null } = {}) {
  const header = (name) => {
    const value = headers?.[name];
    return typeof value === "string" ? value.trim() : null;
  };
  const integer = (name) => {
    const value = Number(header(name));
    return Number.isSafeInteger(value) ? value : null;
  };
  const secondary = SECONDARY_LIMIT_PATTERN.test([
    String(body?.message ?? ""),
    String(stderr ?? ""),
    ...(Array.isArray(graphqlErrors)
      ? graphqlErrors.map((error) => `${error?.type ?? ""} ${error?.message ?? ""}`)
      : []),
  ].join("\n"));
  const retryAfter = header("retry-after");
  const remaining = integer("x-ratelimit-remaining");
  const reset = integer("x-ratelimit-reset");
  const resource = header("x-ratelimit-resource")?.toLowerCase() ?? null;
  // The counter itself says there is nothing left. That holds its own resource
  // until its own reset, and says nothing about the other one.
  if (!secondary && remaining === 0 && reset !== null && RATE_RESOURCES.includes(resource) &&
      (status === 403 || status === 429)) {
    return { kind: "primary", resource, resetMs: reset * 1000 };
  }
  if (retryAfter !== null || secondary || status === 429) {
    return { kind: "secondary", retryAfter, secondary, status };
  }
  return { kind: "none" };
}

function transportCooldownDeadline({ retryAfter, status, secondary, at, attempts = 0 }) {
  const supplied = typeof retryAfter === "string" && /^\d+(?:\.\d+)?$/.test(retryAfter)
    ? at + Number(retryAfter) * 1000
    : Date.parse(retryAfter ?? "");
  // A deadline the server supplied is honoured exactly, however long. Only the
  // delay chosen here is laddered, and only it is capped.
  if (Number.isFinite(supplied)) return supplied;
  return status === 429 || secondary === true ? at + throttleLadderMs(attempts) : null;
}

function emptyTransportThrottle() {
  return { attempts: 0, lastAt: 0, paused: false };
}

function applyTransportCooldown(transport, evidence) {
  const throttle = transport.throttle ?? emptyTransportThrottle();
  const deadline = transportCooldownDeadline({ ...evidence, attempts: throttle.attempts });
  if (deadline === null) return null;
  // Merged by maximum, so a shorter concurrent error never shortens a hold
  // another response already established, and the hold survives a primary epoch
  // change: secondary limits are not accounted in the primary counter.
  transport.cooldownUntil = Math.max(transport.cooldownUntil, deadline);
  const attempts = Math.min(throttle.attempts + 1, THROTTLE_PAUSE_AFTER);
  transport.throttle = { attempts, lastAt: evidence.at, paused: attempts >= THROTTLE_PAUSE_AFTER };
  return transport.cooldownUntil;
}

// A request that came back carrying no throttle evidence is the only thing that
// proves the hold is over, so it is the only thing that resets the ladder.
// Merely waiting out a deadline does not: that is what produced the next
// throttle last time.
function clearTransportThrottle(transport) {
  if (transport && transport.throttle && transport.throttle.attempts > 0) {
    transport.throttle = emptyTransportThrottle();
  }
}

function releaseIdentityHttpPermit(coordinator, permit, error = null) {
  return withIdentityRegistry(coordinator.root, (state) => {
    const transport = state.hosts[permit.host];
    if (transport?.permit?.nonce === permit.nonce) transport.permit = null;
    if (transport && error) {
      const response = parseGhApiResponse(error.stdout ?? "");
      const verdict = classifyThrottle({
        status: response.status,
        headers: response.headers,
        stderr: error.stderr,
      });
      // A permission-only 403 reaches here too. It is a failure, but it is not a
      // throttle, and holding the shared transport for it would pause every
      // pane over one repository the user cannot read.
      if (verdict.kind === "secondary") {
        applyTransportCooldown(transport, {
          retryAfter: verdict.retryAfter,
          status: verdict.status,
          secondary: verdict.secondary,
          at: Date.now(),
        });
      }
    } else if (transport && !error) {
      clearTransportThrottle(transport);
    }
    return { ok: true };
  });
}

// The explicit retry a paused transport waits for. Clears the ladder and the
// deadline together: a person choosing to retry is choosing to spend the next
// request finding out, which is exactly the recovery election the pause defers.
function retryThrottledTransport(root, host, { now = Date.now } = {}) {
  return withIdentityRegistry(root, (state) => {
    const transport = state.hosts[host];
    if (!transport?.throttle?.paused) return { ok: true, value: { resumed: false } };
    transport.throttle = emptyTransportThrottle();
    transport.cooldownUntil = Math.min(transport.cooldownUntil, now());
    return { ok: true, value: { resumed: true } };
  }, { now: now() });
}

function identityCoordinationMessage(reason) {
  if (reason === "restart-required") return "Restart required: close older gh-glance panes";
  // These two were one message for a long time, and the difference between them
  // is the difference between waiting and being stuck. A migration hold has a
  // deadline and ends by itself. An unresolved legacy ledger has no deadline at
  // all -- it holds unsettled spend with no reset recorded to wait for -- so the
  // same wording had people waiting weeks for something that was never going to
  // arrive. Say which one it is.
  if (reason === "migration-hold") return "Upgrade waiting for legacy quota reset";
  if (reason === "legacy-unresolved") return "Upgrade blocked: older spend cannot be settled or waited out";
  if (["legacy-corrupt", "corrupt"].includes(reason)) return "Coordination state unavailable; evidence preserved";
  if (reason === "transport-busy") return "Shared HTTP request or cooldown in progress";
  if (reason === "throttle-paused") return "Paused after repeated rate limits; refresh to retry";
  if (retryableCoordination(reason)) return "Coordinating with your other panes";
  if (reason === "identity-capacity") return "Coordination state full; retrying after the current window";
  return "Verified identity unavailable; waiting to retry";
}

// ---------- Shared account governor ----------

// The scope version is deliberately stable. Stored protocol revisions must use
// the same file so an older process sees the new exact shape and fails closed
// instead of coordinating through a second file.
const GOVERNOR_SCOPE_VERSION = 1;
// 3: GraphQL budgets carry `graphql-observer` provenance. An older build does
// not know that source and would reject the budget -- and normalizeGovernorState
// turns one rejected budget into total loss, discarding every live pane's
// leases, intents and reservations. The version gate makes it fail closed on the
// file instead, which is the whole point of having one.
// 4: observer claims, readiness and outcomes are per resource, so the schema
// shape changed rather than a field's contents. Replaced atomically -- an older
// build must fail closed on the version gate rather than half-read it.
// 5: scheduling fairness is persisted, because the starvation it prevents
// happens *between* planning passes -- each manual refresh is its own pass, so
// a counter that lives only inside one cannot see a run of them.
const GOVERNOR_STATE_VERSION = 6;
// Readable-as-evidence, never written: the shapes a still-running older pane
// holds. Recognising that such a pane owns a live lease is what the restart
// boundary depends on.
const LEGACY_GOVERNOR_VERSIONS = [GOVERNOR_STATE_VERSION, 5, 4, 3, 2];
// The first version whose file is already in the per-resource observer shape.
// Anything below it is adapted before it can be read; see readLegacyGovernorState.
const GOVERNOR_OBSERVER_SPLIT_VERSION = 4;
// The first version carrying persisted scheduling fairness. A version 4 file is
// otherwise in the current shape and only wants the field defaulted.
const GOVERNOR_FAIRNESS_VERSION = 5;
// The first version whose intents are priced by this build's cost table. An
// intent must declare exactly what its tab costs, so a build that re-prices a
// tab cannot read a live older pane's pending intents -- and that pane's file is
// precisely the one carrying the leases and uncertain debts this build must see.
// Bumping the version is what turns "corrupt" back into "older, and adaptable".
const GOVERNOR_TAB_COST_VERSION = 6;
// Manual work outranks active work, which is right until it means "always". A
// user holding the refresh key issues one manual intent per planning pass, and
// without a bound the active owner behind them never gets a turn at all.
const MANUAL_GRANT_STREAK_LIMIT = 3;
const GOVERNOR_MAX_LEASES = 128;
const GOVERNOR_MAX_INTENTS = 512;
const GOVERNOR_MAX_RESERVATIONS = 512;
const GOVERNOR_LOCK_WAIT_MS = 250;
const GOVERNOR_PROBE_DRAIN_MS = 30_000;
const GOVERNOR_PUBLICATION_REINSPECT_MS = 1_000;
const GOVERNOR_PROBE_TRANSITION_MS = 5_000;
const GOVERNOR_MAX_FUTURE_MS = 24 * 60 * 60 * 1000;
const persistenceWaitCell = new Int32Array(new SharedArrayBuffer(4));
const GOVERNOR_OUTCOMES = new Set([
  "measured-success",
  "rejected",
  "timeout",
  "signal",
  "abort",
  "process-loss",
]);
const GOVERNOR_RESERVATION_STATUSES = new Set([
  "scheduled",
  "started",
  "completed",
  "cancelled",
]);
const GOVERNOR_PROBE_STATUSES = new Set(["idle", "waiting", "healthy", "failed"]);
const GOVERNOR_BLOCK_REASONS = new Set(["rate-limit", "secondary-rate-limit", "abuse-limit"]);
const GOVERNOR_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function governorId() {
  return randomUUID();
}

function validGovernorId(value) {
  return typeof value === "string" && GOVERNOR_ID_PATTERN.test(value);
}

function validGovernorEpoch(value) {
  return typeof value === "string" && /^[0-9:.]+$/.test(value);
}

function governorScopeHash(effectiveHost, authIdentity) {
  const host = normalizeHost(effectiveHost);
  if (!host || typeof authIdentity !== "string" || authIdentity.length === 0) return null;
  return createHash("sha256")
    .update(JSON.stringify({ version: GOVERNOR_SCOPE_VERSION, effectiveHost: host, authCacheIdentity: authIdentity }))
    .digest("hex");
}

function governorPath(scopeHash, options = {}) {
  return join(dirname(widthPreferencesPath(options)), `rate-governor-v1-${scopeHash}.json`);
}

function createGovernorScope({
  effectiveHost,
  authIdentity,
  identityProvider = null,
  now = Date.now,
  kill = process.kill.bind(process),
  ...pathOptions
} = {}) {
  const host = normalizeHost(effectiveHost);
  const resolvedAuthIdentity = authIdentity ?? authCacheIdentity(pathOptions);
  const hash = governorScopeHash(host, resolvedAuthIdentity);
  if (!hash) return { ok: false, reason: "unknown-host" };
  const currentIdentity = identityProvider ?? (authIdentity === undefined
    ? () => ({ effectiveHost: host, authIdentity: authCacheIdentity(pathOptions) })
    : null);
  return {
    ok: true,
    value: {
      hash,
      path: governorPath(hash, pathOptions),
      host,
      authIdentity: resolvedAuthIdentity,
      identityProvider: currentIdentity,
      now,
      kill,
    },
  };
}

function scopeNow(scope, nowMs) {
  return Number.isFinite(nowMs) ? nowMs : Number(scope?.now?.());
}

function governorEffectiveTime(scope, requestedAt) {
  const currentAt = scopeNow(scope);
  return Number.isFinite(currentAt) && currentAt >= 0
    ? Math.max(requestedAt, currentAt)
    : requestedAt;
}

function currentGovernorScope(scope) {
  if (!scope || typeof scope.path !== "string" || !scope.hash || !normalizeHost(scope.host)) {
    return { ok: false, reason: "unknown-host" };
  }
  if (typeof scope.identityProvider !== "function") return { ok: true, value: scope };
  let current;
  try {
    current = scope.identityProvider();
  } catch {
    return { ok: false, reason: "stale" };
  }
  const hash = scope.quotaKey ? current?.quotaKey : governorScopeHash(current?.effectiveHost, current?.authIdentity);
  if (scope.quotaKey && current?.accessKey !== scope.accessKey) return { ok: false, reason: "stale" };
  return hash === scope.hash ? { ok: true, value: scope } : { ok: false, reason: "stale" };
}

function emptyGovernorState() {
  return {
    version: GOVERNOR_STATE_VERSION,
    epochs: { core: null, graphql: null },
    budgets: {},
    fairness: { manualStreak: 0 },
    // Symmetric on purpose. Core observer state lived in `observers.core` while
    // the GraphQL one lived in a differently-shaped `probeOutcome`, and a single
    // `probeClaim` serialized both -- so a slow or failed observer for one
    // resource held up the other's readiness for no reason the resources
    // themselves impose.
    observers: Object.fromEntries(RATE_RESOURCES.map((resource) => [
      resource, { etag: null, outcome: "idle", at: 0, nextAt: 0 },
    ])),
    probeClaims: Object.fromEntries(RATE_RESOURCES.map((resource) => [resource, null])),
    leases: {},
    intents: {},
    reservations: {},
    manualProbe: null,
  };
}

function finiteTimestamp(value, nowMs, { nullable = false, future = GOVERNOR_MAX_FUTURE_MS } = {}) {
  if (nullable && value === null) return null;
  return Number.isFinite(value) && value >= 0 && value <= nowMs + future ? value : undefined;
}

function exactKeys(value, keys) {
  return isRecord(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function normalizeGovernorBudget(raw, nowMs, resource = null) {
  if (!exactKeys(raw, [
    "limit", "remaining", "used", "resetMs", "observedAt", "blockUntil",
    "blockReason", "laneNextAt", "roundRobinCursor", "lastExternalFactor", "epoch",
    "source", "factorBaseline", "knownLocalUsed",
  ])) return null;
  const normalized = normalizeBudgetResource(raw);
  if (
    !normalized ||
    normalized.observedAt > nowMs ||
    finiteTimestamp(normalized.resetMs, nowMs) === undefined ||
    finiteTimestamp(raw.blockUntil, nowMs, { nullable: true }) === undefined ||
    finiteTimestamp(raw.laneNextAt, nowMs) === undefined ||
    (raw.blockReason !== null && !GOVERNOR_BLOCK_REASONS.has(raw.blockReason)) ||
    (raw.roundRobinCursor !== null && !validGovernorId(raw.roundRobinCursor)) ||
    !Number.isFinite(raw.lastExternalFactor) || raw.lastExternalFactor < 1 ||
    !["response-header", "core-observer", "graphql-observer", "rate-limit-probe"].includes(raw.source) ||
    // "rate-limit-probe" is retained as readable legacy provenance only: ledgers
    // written before the claimed GraphQL observer existed still carry it. Nothing
    // writes it any more, and neither it nor the GraphQL observer may ever stand
    // as core authority.
    ["rate-limit-probe", "graphql-observer"].includes(raw.source) && resource === "core" ||
    !exactKeys(raw.factorBaseline, ["epoch", "used", "observedAt"]) ||
    !validGovernorEpoch(raw.factorBaseline.epoch) ||
    !Number.isSafeInteger(raw.factorBaseline.used) || raw.factorBaseline.used < 0 ||
    finiteTimestamp(raw.factorBaseline.observedAt, nowMs) === undefined ||
    raw.factorBaseline.observedAt > nowMs ||
    !Number.isSafeInteger(raw.knownLocalUsed) || raw.knownLocalUsed < 0 ||
    !validGovernorEpoch(raw.epoch)
  ) return null;
  return {
    ...normalized,
    blockUntil: raw.blockUntil,
    blockReason: raw.blockReason,
    laneNextAt: raw.laneNextAt,
    roundRobinCursor: raw.roundRobinCursor,
    lastExternalFactor: raw.lastExternalFactor,
    epoch: raw.epoch,
    source: raw.source,
    factorBaseline: { ...raw.factorBaseline },
    knownLocalUsed: raw.knownLocalUsed,
  };
}

function normalizeGovernorLease(raw, nowMs) {
  if (!exactKeys(raw, ["expiresAt", "floorMs", "activeTab", "phaseSeed", "demand"])) return null;
  const phaseSeed = normalizePhaseSeed(raw.phaseSeed);
  const demand = exactResourceCosts(raw.demand);
  if (
    finiteTimestamp(raw.expiresAt, nowMs) === undefined ||
    !Number.isFinite(raw.floorMs) || raw.floorMs < MIN_REFRESH_SECONDS * 1000 ||
    !TAB_KEYS.includes(raw.activeTab) ||
    !phaseSeed || !validGovernorId(phaseSeed.seed) || phaseSeed.registeredAt > nowMs ||
    !demand
  ) return null;
  return { expiresAt: raw.expiresAt, floorMs: raw.floorMs, activeTab: raw.activeTab, phaseSeed, demand };
}

function normalizeGovernorIntent(raw, nowMs) {
  if (!exactKeys(raw, ["leaseId", "tab", "priority", "costs", "requestedAt", "expiresAt"])) return null;
  const expectedCosts = TAB_KEYS.includes(raw.tab)
    ? tabRequestCost(raw.tab)
    : operationCost(raw.tab);
  const suppliedCosts = exactResourceCosts(raw.costs);
  const costs = expectedCosts && suppliedCosts &&
    RATE_RESOURCES.every((resource) => expectedCosts[resource] === suppliedCosts[resource])
    ? expectedCosts
    : null;
  if (
    !validGovernorId(raw.leaseId) ||
    typeof raw.tab !== "string" || intentPriority(raw) === null || !costs ||
    finiteTimestamp(raw.requestedAt, nowMs) === undefined || raw.requestedAt > nowMs ||
    finiteTimestamp(raw.expiresAt, nowMs) === undefined
  ) return null;
  return { ...raw, costs };
}

function normalizeGovernorReservation(raw, nowMs) {
  if (!exactKeys(raw, [
    "leaseId", "intentId", "costs", "actualCosts", "accountedCosts", "notBefore", "status", "epochs",
    "startedAt", "completedAt", "outcome",
  ])) return null;
  const costs = exactResourceCosts(raw.costs);
  const actualCosts = raw.actualCosts === null ? null : exactResourceCosts(raw.actualCosts);
  const accountedCosts = exactResourceCosts(raw.accountedCosts);
  const epochs = exactKeys(raw.epochs, RATE_RESOURCES) &&
    RATE_RESOURCES.every((resource) => raw.epochs[resource] === null || validGovernorEpoch(raw.epochs[resource]))
    ? { ...raw.epochs }
    : null;
  if (
    !validGovernorId(raw.leaseId) || !validGovernorId(raw.intentId) ||
    !costs || actualCosts === null && raw.actualCosts !== null || !accountedCosts || !epochs ||
    finiteTimestamp(raw.notBefore, nowMs) === undefined ||
    !GOVERNOR_RESERVATION_STATUSES.has(raw.status) ||
    finiteTimestamp(raw.startedAt, nowMs, { nullable: true }) === undefined ||
    finiteTimestamp(raw.completedAt, nowMs, { nullable: true }) === undefined ||
    (raw.startedAt !== null && raw.startedAt > nowMs) ||
    (raw.completedAt !== null && raw.completedAt > nowMs) ||
    (raw.outcome !== null && !GOVERNOR_OUTCOMES.has(raw.outcome))
  ) return null;
  if (actualCosts && RATE_RESOURCES.some((resource) => actualCosts[resource] > costs[resource])) return null;
  if (RATE_RESOURCES.some((resource) => accountedCosts[resource] > (actualCosts?.[resource] ?? costs[resource]))) return null;
  return { ...raw, costs, actualCosts, accountedCosts, epochs };
}

function normalizeResourceObserver(raw, nowMs) {
  if (!exactKeys(raw, ["etag", "outcome", "at", "nextAt"])) return null;
  if (
    raw.etag !== null && (typeof raw.etag !== "string" || raw.etag.length === 0) ||
    !GOVERNOR_PROBE_STATUSES.has(raw.outcome) ||
    finiteTimestamp(raw.at, nowMs) === undefined || raw.at > nowMs ||
    finiteTimestamp(raw.nextAt, nowMs) === undefined
  ) return null;
  return { ...raw };
}

function normalizeProbeClaim(raw, nowMs) {
  if (raw === null) return null;
  if (!exactKeys(raw, [
    "ownerLeaseId", "nonce", "leaseUntil", "nextAt", "claimAt", "startedReservationIds",
  ])) {
    return undefined;
  }
  if (
    !validGovernorId(raw.ownerLeaseId) || !validGovernorId(raw.nonce) ||
    finiteTimestamp(raw.leaseUntil, nowMs) === undefined ||
    finiteTimestamp(raw.nextAt, nowMs) === undefined ||
    finiteTimestamp(raw.claimAt, nowMs) === undefined || raw.claimAt > nowMs ||
    !Array.isArray(raw.startedReservationIds) || raw.startedReservationIds.length > GOVERNOR_MAX_RESERVATIONS ||
    raw.startedReservationIds.some((id) => !id.startsWith("reservation:") || !validGovernorId(id.slice(12)))
  ) return undefined;
  return { ...raw, startedReservationIds: [...new Set(raw.startedReservationIds)] };
}

function normalizeManualProbe(raw, nowMs) {
  if (raw === null) return null;
  if (!exactKeys(raw, ["requestedEpoch", "baselineObservedAt", "satisfiedAt"])) return undefined;
  if (
    !validGovernorEpoch(raw.requestedEpoch) ||
    finiteTimestamp(raw.baselineObservedAt, nowMs) === undefined || raw.baselineObservedAt > nowMs ||
    finiteTimestamp(raw.satisfiedAt, nowMs, { nullable: true }) === undefined ||
    (raw.satisfiedAt !== null && raw.satisfiedAt > nowMs)
  ) return undefined;
  return { ...raw };
}

// `acceptVersion` exists for one caller: the legacy inspector, which must be
// able to *read* a still-running older pane's file to see its live leases. It
// never publishes what it reads. Every other caller takes the default, so a
// version this build does not write is unreadable and fails closed.
function normalizeGovernorState(raw, nowMs, { prune = true, acceptVersion = GOVERNOR_STATE_VERSION } = {}) {
  if (!exactKeys(raw, [
    "version", "epochs", "budgets", "fairness", "observers", "probeClaims", "leases",
    "intents", "reservations", "manualProbe",
  ]) || raw.version !== acceptVersion) return null;
  if (!exactKeys(raw.fairness, ["manualStreak"]) ||
      !Number.isSafeInteger(raw.fairness.manualStreak) || raw.fairness.manualStreak < 0) return null;
  if (
    !exactKeys(raw.epochs, RATE_RESOURCES) ||
    RATE_RESOURCES.some((resource) => raw.epochs[resource] !== null && !validGovernorEpoch(raw.epochs[resource])) ||
    !isRecord(raw.budgets) || Object.keys(raw.budgets).some((resource) => !RATE_RESOURCES.includes(resource)) ||
    !exactKeys(raw.observers, RATE_RESOURCES) ||
    !exactKeys(raw.probeClaims, RATE_RESOURCES) ||
    !isRecord(raw.leases) || !isRecord(raw.intents) || !isRecord(raw.reservations)
  ) return null;

  const state = emptyGovernorState();
  state.epochs = { ...raw.epochs };
  state.fairness = { ...raw.fairness };
  for (const resource of RATE_RESOURCES) {
    const observer = normalizeResourceObserver(raw.observers[resource], nowMs);
    if (!observer) return null;
    state.observers[resource] = observer;
  }
  for (const resource of Object.keys(raw.budgets)) {
    const budget = normalizeGovernorBudget(raw.budgets[resource], nowMs, resource);
    if (!budget) return null;
    state.budgets[resource] = budget;
  }
  for (const [id, rawLease] of Object.entries(raw.leases)) {
    if (!validGovernorId(id)) return null;
    const lease = normalizeGovernorLease(rawLease, nowMs);
    if (!lease || lease.phaseSeed.seed !== id) return null;
    if (!prune || lease.expiresAt > nowMs) state.leases[id] = lease;
  }
  if (Object.keys(state.leases).length > GOVERNOR_MAX_LEASES) return null;
  for (const [id, rawIntent] of Object.entries(raw.intents)) {
    if (!validGovernorId(id)) return null;
    const intent = normalizeGovernorIntent(rawIntent, nowMs);
    if (!intent) return null;
    if (!prune || (intent.expiresAt > nowMs && state.leases[intent.leaseId])) state.intents[id] = intent;
  }
  if (Object.keys(state.intents).length > GOVERNOR_MAX_INTENTS) return null;
  for (const [id, rawReservation] of Object.entries(raw.reservations)) {
    if (!id.startsWith("reservation:") || !validGovernorId(id.slice(12))) return null;
    const reservation = normalizeGovernorReservation(rawReservation, nowMs);
    if (!reservation || id !== `reservation:${reservation.intentId}`) return null;
    if (
      !prune || reservation.status === "started" || reservation.status === "completed" ||
      (reservation.status === "scheduled" && state.leases[reservation.leaseId])
    ) state.reservations[id] = reservation;
  }
  if (Object.keys(state.reservations).length > GOVERNOR_MAX_RESERVATIONS) return null;
  for (const resource of RATE_RESOURCES) {
    const claim = normalizeProbeClaim(raw.probeClaims[resource], nowMs);
    if (claim === undefined) return null;
    state.probeClaims[resource] = claim?.leaseUntil > nowMs ? claim : null;
  }
  state.manualProbe = normalizeManualProbe(raw.manualProbe, nowMs);
  if (state.manualProbe === undefined) return null;
  return state;
}

// Reads a still-running older pane's file as evidence. A version number alone
// is not enough to identify a document: versions 2 and 3 share a *shape* that
// version 4 replaced, so accepting their version against the current key set
// would reject every real file they wrote. Read-only -- the result is never
// published and the file is never rewritten.
function readLegacyGovernorState(raw, nowMs, version) {
  if (!isRecord(raw) || raw.version !== version) return null;
  const options = { prune: false, acceptVersion: version };
  if (version >= GOVERNOR_TAB_COST_VERSION) return normalizeGovernorState(raw, nowMs, options);
  // A version 5 file is in the current shape and differs only in what it
  // believes a tab costs. Version 4 additionally wants the fairness field
  // defaulted; anything older needs its observer shape rewritten first.
  const shaped = version >= GOVERNOR_OBSERVER_SPLIT_VERSION
    ? { ...raw }
    : adaptPreSplitGovernorShape(raw);
  if (!shaped) return null;
  if (version < GOVERNOR_FAIRNESS_VERSION) shaped.fairness = { manualStreak: 0 };
  return normalizeGovernorState(dropSupersededTabCosts(shaped), nowMs, options);
}

// An intent priced by a build that costed its tab differently. It is a pending
// request and nothing more: an intent still in the file has not been granted,
// because scheduleGovernorState deletes each one as it creates its reservation.
// So dropping it releases nothing and forgives nothing -- the pane that
// registered it re-registers at the current price on its next wake. Re-pricing
// it here would be the one unsafe option, because the older pane will still make
// the number of calls its own build declares.
function dropSupersededTabCosts(raw) {
  if (!isRecord(raw.intents)) return raw;
  const intents = {};
  for (const [id, intent] of Object.entries(raw.intents)) {
    const expected = TAB_KEYS.includes(intent?.tab)
      ? tabRequestCost(intent.tab)
      : operationCost(intent?.tab);
    const declared = exactResourceCosts(intent?.costs);
    // Anything unrecognisable is left exactly as it is, so normalization still
    // rejects a genuinely corrupt document rather than having it quietly pruned.
    if (!expected || !declared ||
      RATE_RESOURCES.every((resource) => expected[resource] === declared[resource])) {
      intents[id] = intent;
    }
  }
  return { ...raw, intents };
}

// Versions 2 and 3 held one observer for core, a differently shaped
// `probeOutcome` standing in for GraphQL, and a single claim naming the
// resources it covered. Rewrite that into the current shape so the inspector
// above can see the leases, deadlines and uncertain work such a pane holds.
// The claim's own `resources` list says which resources it covered, so
// splitting it in two reads the file rather than guessing at it.
function adaptPreSplitGovernorShape(raw) {
  if (!exactKeys(raw, [
    "version", "epochs", "budgets", "observers", "probeClaim", "probeOutcome",
    "leases", "intents", "reservations", "manualProbe",
  ])) return null;
  if (!exactKeys(raw.observers, ["core"])) return null;
  if (!exactKeys(raw.probeOutcome, ["status", "at", "nextAt"])) return null;
  if (raw.probeClaim !== null && !isRecord(raw.probeClaim)) return null;
  const { resources, ...claim } = raw.probeClaim ?? {};
  const covered = Array.isArray(resources) ? resources : [];
  const adapted = structuredClone(raw);
  delete adapted.probeClaim;
  delete adapted.probeOutcome;
  adapted.observers = {
    core: raw.observers.core,
    graphql: {
      etag: null,
      outcome: raw.probeOutcome.status,
      at: raw.probeOutcome.at,
      nextAt: raw.probeOutcome.nextAt,
    },
  };
  adapted.probeClaims = Object.fromEntries(RATE_RESOURCES.map((resource) => [
    resource, raw.probeClaim && covered.includes(resource) ? structuredClone(claim) : null,
  ]));
  return adapted;
}

function serializeGovernorState(state) {
  return `${JSON.stringify(state)}\n`;
}

// Failing closed on a version this build does not write is right in one
// direction only. An *older* binary meeting a newer file must refuse it, because
// it cannot know what the new fields mean. A *newer* binary meeting an older
// file at its own canonical path has to migrate it: the read happens before any
// write, so refusing leaves the file in place and the pane never recovers. It is
// not a transient failure, it is a permanent one, and every later launch repeats
// it.
//
// That asymmetry was missed when the observer split moved the protocol from 3 to
// 5. Versions 1 and 2 escaped it only because the file moved path at the same
// time, so a new build simply found nothing and started clean; 3 onwards share a
// path with 5 and collided.
function migrateGovernorState(raw, nowMs) {
  if (!isRecord(raw) || !Number.isSafeInteger(raw.version) || raw.version < 1) return null;
  if (raw.version >= GOVERNOR_STATE_VERSION) return null;
  if (raw.version === 1) return migrateV1GovernorState(raw, nowMs);
  // Everything from 2 onwards is this build's shape or one adaptation away from
  // it, and what it holds is worth keeping: the uncertain reservations are debts
  // that must not be forgiven by an upgrade, and the budgets were written by the
  // same observers this build trusts.
  const shaped = raw.version >= GOVERNOR_OBSERVER_SPLIT_VERSION
    ? structuredClone(raw)
    : adaptPreSplitGovernorShape(raw);
  if (!shaped) return null;
  if (!isRecord(shaped.fairness)) shaped.fairness = { manualStreak: 0 };
  shaped.version = GOVERNOR_STATE_VERSION;
  return normalizeGovernorState(dropSupersededTabCosts(shaped), nowMs);
}

function migrateV1GovernorState(raw, nowMs) {
  if (!exactKeys(raw, [
    "version", "epochs", "budgets", "probeClaim", "probeOutcome", "leases",  // v1 shape
    "intents", "reservations", "manualProbe",
  ]) || raw.version !== 1 || !isRecord(raw.budgets) || !isRecord(raw.reservations)) return null;
  const migrated = structuredClone(raw);
  migrated.version = GOVERNOR_STATE_VERSION;
  migrated.observers = { core: { etag: null, outcome: "idle", at: 0, nextAt: 0 } };
  // The v1 core value came from /rate_limit, which is not authoritative. Do not
  // preserve it as bootstrap evidence. GraphQL remains valid.
  delete migrated.budgets.core;
  migrated.epochs.core = null;
  // The v1 GraphQL value came from /rate_limit, for the same reason the core
  // value did, and is dropped for the same reason: this phase makes that
  // endpoint explicitly non-authoritative, and "never a source of spendable
  // capacity" cannot have an exception for numbers that arrived before the rule.
  // Keeping it would let a migrated pane admit GraphQL work against it and let
  // it establish the epoch later headers refine. The claimed observer
  // re-establishes capacity on the next probe.
  delete migrated.budgets.graphql;
  migrated.epochs.graphql = null;
  for (const reservation of Object.values(migrated.reservations)) {
    reservation.accountedCosts = { core: 0, graphql: 0 };
  }
  // v1 carried one claim for both resources; the new shape has one per resource
  // and a migrated claim belongs to neither, so it is dropped rather than
  // guessed at. The next probe re-claims what is actually due.
  delete migrated.probeClaim;
  delete migrated.probeOutcome;
  migrated.observers = Object.fromEntries(RATE_RESOURCES.map((resource) => [
    resource, { etag: null, outcome: "idle", at: 0, nextAt: 0 },
  ]));
  migrated.probeClaims = Object.fromEntries(RATE_RESOURCES.map((resource) => [resource, null]));
  migrated.fairness = { manualStreak: 0 };
  return normalizeGovernorState(migrated, nowMs);
}

function readGovernorState(path, nowMs, { persistMigration = true } = {}) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    return error?.code === "ENOENT"
      ? { ok: true, value: emptyGovernorState(), missing: true }
      : { ok: false, reason: "unwritable" };
  }
  try {
    const parsed = JSON.parse(raw);
    const normalized = normalizeGovernorState(parsed, nowMs);
    if (normalized) return { ok: true, value: normalized };
    const migrated = migrateGovernorState(parsed, nowMs);
    if (!migrated) return { ok: false, reason: "corrupt" };
    if (!persistMigration) return { ok: true, value: migrated, migrated: true };
    // Read-only callers persist the exact migration while they still hold the
    // scope lock. Mutating callers use this same value for their final write.
    const written = writeGovernorState(path, migrated);
    return written.ok ? { ok: true, value: migrated, migrated: true } : written;
  } catch {
    return { ok: false, reason: "corrupt" };
  }
}

function writeGovernorState(path, state) {
  const parent = dirname(path);
  let tempPath = null;
  try {
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    chmodSync(parent, 0o700);
    tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tempPath, serializeGovernorState(state), { encoding: "utf8", mode: 0o600, flag: "wx" });
    chmodSync(tempPath, 0o600);
    renameSync(tempPath, path);
    chmodSync(path, 0o600);
    return { ok: true };
  } catch {
    if (tempPath !== null) {
      try { unlinkSync(tempPath); } catch { /* exact private temporary file only */ }
    }
    return { ok: false, reason: "unwritable" };
  }
}

function lockOwner(path) {
  try {
    const owner = JSON.parse(readFileSync(path, "utf8"));
    return exactKeys(owner, ["pid", "nonce"]) && Number.isSafeInteger(owner.pid) && owner.pid > 0 &&
      typeof owner.nonce === "string" && owner.nonce.length > 0 ? owner : null;
  } catch {
    return null;
  }
}

function pidIsDead(pid, kill = process.kill.bind(process)) {
  try {
    kill(pid, 0);
    return false;
  } catch (error) {
    if (error?.code === "ESRCH") return true;
    return false;
  }
}

function releaseGovernorLock(lockPath, nonce) {
  const owner = lockOwner(lockPath);
  if (!owner || owner.nonce !== nonce) return false;
  const releasePath = `${lockPath}.release-${nonce}`;
  try {
    renameSync(lockPath, releasePath);
    unlinkSync(releasePath);
    return true;
  } catch {
    return false;
  }
}

function governorRecoveryPaths(lockPath) {
  try {
    const prefix = `${basename(lockPath)}.recovery-`;
    return readdirSync(dirname(lockPath))
      .filter((name) => name.startsWith(prefix))
      .map((name) => join(dirname(lockPath), name));
  } catch {
    return [];
  }
}

function governorRecoveryActive(lockPath, kill) {
  let active = false;
  for (const recoveryPath of governorRecoveryPaths(lockPath)) {
    const owner = lockOwner(recoveryPath);
    if (!owner || !pidIsDead(owner.pid, kill)) {
      active = true;
      continue;
    }
    releaseGovernorLock(recoveryPath, owner.nonce);
  }
  return active || governorRecoveryPaths(lockPath).length > 0;
}

function sameLockOwner(left, right) {
  return Boolean(left) && Boolean(right) && left.pid === right.pid && left.nonce === right.nonce;
}

function observeGovernorArtifact(observer, kind, path) {
  try { observer?.(kind, path); } catch { /* test observation cannot affect locking */ }
}

function quarantineDeadGovernorLock(lockPath, expectedOwner, {
  pid = process.pid,
  kill = process.kill.bind(process),
  observeArtifact = null,
} = {}) {
  const recoveryNonce = randomUUID();
  const recoveryPath = `${lockPath}.recovery-${recoveryNonce}`;
  let descriptor;
  try {
    descriptor = openSync(recoveryPath, "wx", 0o600);
    try {
      writeFileSync(descriptor, JSON.stringify({ pid, nonce: recoveryNonce }), "utf8");
    } finally {
      closeSync(descriptor);
    }
    chmodSync(recoveryPath, 0o600);
    observeGovernorArtifact(observeArtifact, "recovery", recoveryPath);
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* descriptor was already closed */ }
    }
    return error?.code === "EEXIST" ? "busy" : "failed";
  }

  const quarantinePath = `${lockPath}.quarantine-${randomUUID()}`;
  try {
    // Unique recovery markers make every new owner recheck after acquisition.
    // A killed recovery process leaves a uniquely named marker that another
    // process can remove only after its PID is confirmed dead; the path can
    // never be reused by a successor.
    // Re-read both fields after taking that marker and again immediately before
    // rename, so an owner that changed since the initial ESRCH result is never
    // selected as the abandoned lock.
    const confirmed = lockOwner(lockPath);
    if (!sameLockOwner(confirmed, expectedOwner) || !pidIsDead(confirmed.pid, kill)) return "changed";
    const beforeRename = lockOwner(lockPath);
    if (!sameLockOwner(beforeRename, expectedOwner)) return "changed";
    renameSync(lockPath, quarantinePath);
    observeGovernorArtifact(observeArtifact, "quarantine", quarantinePath);
    const quarantined = lockOwner(quarantinePath);
    if (!sameLockOwner(quarantined, expectedOwner)) {
      // Acquisitions that raced the recovery marker cannot enter their critical
      // section. Restoring here preserves that successor rather than deleting
      // or leaving it under an abandoned quarantine name.
      renameSync(quarantinePath, lockPath);
      return "changed";
    }
    unlinkSync(quarantinePath);
    return "quarantined";
  } catch (error) {
    return error?.code === "ENOENT" ? "changed" : "failed";
  } finally {
    releaseGovernorLock(recoveryPath, recoveryNonce);
  }
}

function withGovernorLock(scope, operation, {
  pid = process.pid,
  nonce = randomUUID(),
  waitMs = GOVERNOR_LOCK_WAIT_MS,
  kill = scope?.kill ?? process.kill.bind(process),
  observeArtifact = null,
} = {}) {
  if (scope?.coordinationRoot && !scope.rootLocked) {
    return withIdentityRegistry(scope.coordinationRoot, (registry, at) => {
      const migration = inspectLegacyMigration(scope.coordinationRoot, registry, at);
      if (!migration.ok) return migration;
      if (registry.identities[scope.credentialKey]) {
        try { statSync(scope.path); } catch { return { ok: false, reason: "corrupt" }; }
      }
      return withGovernorLock({ ...scope, rootLocked: true }, operation, { pid, nonce, waitMs, kill, observeArtifact });
    }, { now: scopeNow(scope), kill });
  }
  const current = currentGovernorScope(scope);
  if (!current.ok) return current;
  const lockPath = `${scope.path}.lock`;
  const deadline = Date.now() + waitMs;
  try {
    mkdirSync(dirname(scope.path), { recursive: true, mode: 0o700 });
    chmodSync(dirname(scope.path), 0o700);
  } catch {
    return { ok: false, reason: "unwritable" };
  }
  const waitForLock = () => {
    if (Date.now() >= deadline) return false;
    Atomics.wait(persistenceWaitCell, 0, 0, 5);
    return true;
  };
  for (;;) {
    if (governorRecoveryActive(lockPath, kill)) {
      if (!waitForLock()) return { ok: false, reason: "busy" };
      continue;
    }
    try {
      const descriptor = openSync(lockPath, "wx", 0o600);
      try {
        writeFileSync(descriptor, JSON.stringify({ pid, nonce }), "utf8");
      } finally {
        closeSync(descriptor);
      }
      chmodSync(lockPath, 0o600);
      observeGovernorArtifact(observeArtifact, "canonical", lockPath);
      if (governorRecoveryActive(lockPath, kill)) {
        releaseGovernorLock(lockPath, nonce);
        if (!waitForLock()) return { ok: false, reason: "busy" };
        continue;
      }
      try {
        return operation();
      } finally {
        releaseGovernorLock(lockPath, nonce);
      }
    } catch (error) {
      if (error?.code !== "EEXIST") return { ok: false, reason: "unwritable" };
      const owner = lockOwner(lockPath);
      // The creator owns the canonical path as soon as open("wx") succeeds,
      // before its small JSON owner record is fully visible. Treat an unreadable
      // record as owned during the bounded wait; stealing it could overlap the
      // creator, while returning busy is always fail-closed.
      if (!owner) {
        if (!waitForLock()) return { ok: false, reason: "busy" };
        continue;
      }
      if (pidIsDead(owner.pid, kill)) {
        const recovery = quarantineDeadGovernorLock(lockPath, owner, { pid, kill, observeArtifact });
        if (recovery === "quarantined" || recovery === "changed") continue;
        if (!waitForLock()) return { ok: false, reason: "busy" };
        continue;
      }
      if (!waitForLock()) return { ok: false, reason: "busy" };
    }
  }
}

function mutateGovernor(scope, nowMs, mutate) {
  const requestedAt = scopeNow(scope, nowMs);
  if (!Number.isFinite(requestedAt) || requestedAt < 0) return { ok: false, reason: "corrupt" };
  return withGovernorLock(scope, () => {
    // Another process can persist a lease while this caller waits for the
    // lock. Re-read the clock after exclusivity is acquired so that valid work
    // committed during that wait does not look future-dated to normalization.
    // Explicit future times and injected fake clocks remain authoritative.
    const at = governorEffectiveTime(scope, requestedAt);
    // Scope can change while this process waits for the file lock. Admission
    // must bind to the host/account identity observed while exclusivity is
    // held, immediately before it reads and mutates the shared state.
    const current = currentGovernorScope(scope);
    if (!current.ok) return current;
    const loaded = readGovernorState(scope.path, at, { persistMigration: false });
    if (!loaded.ok) return loaded;
    const state = loaded.value;
    // A mutator can reject without writing. Keep an untouched migration so
    // that even that path upgrades the file once before releasing the lock.
    const migration = loaded.migrated ? structuredClone(state) : null;
    const returnAfterMigration = (result) => {
      if (migration === null) return result;
      const written = writeGovernorState(scope.path, migration);
      return written.ok ? result : written;
    };
    const value = mutate(state, at);
    if (value?.ok === false && value.write !== true) return returnAfterMigration(value);
    const normalized = normalizeGovernorState(state, at);
    if (!normalized) return returnAfterMigration({ ok: false, reason: "corrupt" });
    const written = writeGovernorState(scope.path, normalized);
    if (!written.ok) return written;
    return value?.ok === false ? { ok: false, reason: value.reason } : { ok: true, value: value?.value };
  });
}

// The largest single operation the governor will ever admit. Returned pacing is
// capped at one of these so an idle stretch cannot accumulate into a burst: at
// most one operation's worth of the lane is ever given back at a time.
const GOVERNOR_MAX_ATOMIC_COST = Math.max(...Object.values(OPERATION_COSTS)
  .flatMap((costs) => RATE_RESOURCES.map((resource) => costs?.[resource] ?? 0)));

// A grant paces the lane by what it *reserved*, which is a worst case. When the
// request costs less than that -- a 304 costs nothing -- or never happens at
// all, the difference is capacity paced away for nobody, and the next request
// waits out a slot no one used.
//
// The lane is never pulled earlier than the transport gap, which is what keeps
// this from becoming a burst. Recomputing the rate here can differ from the
// rate at grant time if capacity has since changed, so the returned credit is
// an estimate rather than an exact reversal; that is safe because admission
// still re-checks affordability against the reserve before anything starts.
// Pacing decides when work may go, never whether it may.
function returnPacingCredit(state, resource, unusedCost, nowMs) {
  const budget = state.budgets[resource];
  if (!budget || !(unusedCost > 0)) return;
  const decision = resourceDecision({ budget, resource, nowMs, cost: 0, chargedCost: 0 });
  const callsPerMs = decision?.callsPerMs;
  if (!Number.isFinite(callsPerMs) || callsPerMs <= 0) return;
  const credit = Math.min(unusedCost, GOVERNOR_MAX_ATOMIC_COST) / callsPerMs;
  budget.laneNextAt = Math.max(nowMs + HTTP_START_GAP_MS, budget.laneNextAt - credit);
}

function scheduleGovernorState(state, nowMs) {
  if (Object.keys(state.intents).length === 0) return { grants: [], denied: [] };
  let reservationCount = Object.keys(state.reservations).length;
  const lanes = Object.fromEntries(RATE_RESOURCES.flatMap((resource) =>
    state.budgets[resource] ? [[resource, { nextAt: state.budgets[resource].laneNextAt }]] : [],
  ));
  const cursors = Object.fromEntries(RATE_RESOURCES.flatMap((resource) =>
    state.budgets[resource]?.roundRobinCursor
      ? [[resource, state.budgets[resource].roundRobinCursor]]
      : [],
  ));
  const deferredBackground = state.observers.graphql.outcome === "failed"
    ? Object.entries(state.intents)
      .filter(([, intent]) => intentPriority(intent) === REQUEST_PRIORITIES.background)
      .map(([id]) => id)
    : [];
  const deferred = new Set(deferredBackground);
  const result = scheduleIntents({
    intents: Object.entries(state.intents)
      .filter(([id]) => !deferred.has(id))
      .map(([id, intent]) => ({
        id,
        ...intent,
        tab: TAB_KEYS.includes(intent.tab) ? intent.tab : undefined,
      })),
    leases: state.leases,
    budgets: state.budgets,
    reservations: Object.entries(state.reservations).map(([id, reservation]) => ({ id, ...reservation })),
    lanes,
    cursors,
    nowMs,
    maxGrants: GOVERNOR_MAX_RESERVATIONS - reservationCount,
    manualStreak: state.fairness.manualStreak,
  });
  state.fairness.manualStreak = result.manualStreak;
  result.denied.push(...deferredBackground.map((intentId) => ({
    intentId,
    mode: "paused",
    reason: "probe-failed",
  })));
  for (const id of result.prunedIntentIds) delete state.intents[id];
  for (const grant of result.grants) {
    if (reservationCount >= GOVERNOR_MAX_RESERVATIONS) break;
    state.reservations[grant.id] = {
      leaseId: grant.leaseId,
      intentId: grant.intentId,
      costs: grant.costs,
      actualCosts: null,
      accountedCosts: { core: 0, graphql: 0 },
      notBefore: grant.notBefore,
      status: "scheduled",
      epochs: { core: grant.epochs.core ?? null, graphql: grant.epochs.graphql ?? null },
      startedAt: null,
      completedAt: null,
      outcome: null,
    };
    reservationCount += 1;
    delete state.intents[grant.intentId];
  }
  for (const resource of RATE_RESOURCES) {
    if (!state.budgets[resource]) continue;
    state.budgets[resource].laneNextAt = result.lanes[resource]?.nextAt ?? state.budgets[resource].laneNextAt;
    state.budgets[resource].roundRobinCursor = result.cursors[resource] ?? state.budgets[resource].roundRobinCursor;
  }
  return result;
}

function registerLease(scope, lease) {
  return mutateGovernor(scope, lease?.phaseSeed?.registeredAt, (state, nowMs) => {
    if (!isRecord(lease) || !validGovernorId(lease.id) || lease.phaseSeed?.seed !== lease.id) {
      return { ok: false, reason: "corrupt" };
    }
    const normalized = normalizeGovernorLease({
      expiresAt: lease.expiresAt,
      floorMs: lease.floorMs,
      activeTab: lease.activeTab,
      phaseSeed: lease.phaseSeed,
      demand: lease.demand,
    }, nowMs);
    if (!normalized || normalized.expiresAt <= nowMs) return { ok: false, reason: "stale" };
    if (!state.leases[lease.id] && Object.keys(state.leases).length >= GOVERNOR_MAX_LEASES) {
      return { ok: false, reason: "busy" };
    }
    state.leases[lease.id] = normalized;
    return { value: { leaseId: lease.id, expiresAt: normalized.expiresAt } };
  });
}

function heartbeatLease(scope, leaseId, demand, nowMs, activeTab = null) {
  return mutateGovernor(scope, nowMs, (state, at) => {
    const lease = state.leases[leaseId];
    const costs = exactResourceCosts(demand);
    if (!lease || !costs || (activeTab !== null && !TAB_KEYS.includes(activeTab))) {
      return { ok: false, reason: "stale" };
    }
    lease.expiresAt = at + GOVERNOR_LEASE_TTL_MS;
    lease.demand = costs;
    if (activeTab !== null) lease.activeTab = activeTab;
    scheduleGovernorState(state, at);
    return { value: { leaseId, expiresAt: lease.expiresAt, activeTab: lease.activeTab } };
  });
}

function maintainControlLease(scope, leaseId, floorMs, activeTab, nowMs) {
  const demand = tabRequestCost(activeTab);
  if (!demand) return { ok: false, reason: "corrupt" };
  const renewed = heartbeatLease(scope, leaseId, demand, nowMs, activeTab);
  if (renewed.ok) return { ...renewed, value: { ...renewed.value, status: "renewed" } };
  const registered = registerLease(scope, {
    id: leaseId,
    expiresAt: nowMs + GOVERNOR_LEASE_TTL_MS,
    floorMs,
    activeTab,
    phaseSeed: { seed: leaseId, registeredAt: nowMs },
    demand,
  });
  return registered.ok
    ? { ...registered, value: { ...registered.value, status: "registered", activeTab } }
    : registered;
}

// Claims the observer for one resource. Independence is the point: a slow or
// failed GraphQL observer must not hold up core readiness, because nothing about
// the resources themselves couples them. What still couples them is the shared
// HTTP permit and any account-wide secondary hold, and those are enforced
// elsewhere -- not by making one claim stand for both.
function claimProbe(scope, leaseId, nowMs, resource) {
  if (!RATE_RESOURCES.includes(resource)) return { ok: false, reason: "corrupt" };
  return mutateGovernor(scope, nowMs, (state, at) => {
    if (!state.leases[leaseId]) return { ok: false, reason: "stale" };
    const held = state.probeClaims[resource];
    if (held && held.leaseUntil > at) {
      return { value: { status: "waiting", leaseUntil: held.leaseUntil } };
    }
    const resetAt = Number.isFinite(state.budgets[resource]?.resetMs)
      ? state.budgets[resource].resetMs + BUDGET_RESET_GRACE_MS
      : Number.POSITIVE_INFINITY;
    // A core reset starts a new shared accounting epoch, so the GraphQL counter
    // is also due then: external-spend baselines and the protected
    // one-publication reset contract have to advance together.
    const coreResetAt = Number.isFinite(state.budgets.core?.resetMs)
      ? state.budgets.core.resetMs + BUDGET_RESET_GRACE_MS
      : Number.POSITIVE_INFINITY;
    // ...but only until it has actually observed since that reset. Left
    // unqualified, every pane keeps qualifying for as long as core has not
    // published its new epoch, so a reset draws a stampede of GraphQL observers
    // instead of the one the shared epoch needs. The publication used to close
    // that window as a side effect of being read first; saying it here means it
    // does not depend on which resource a refresh happens to reach first.
    const dueAtCoreReset = resource === "graphql" &&
      state.observers.graphql.at < coreResetAt
      ? coreResetAt
      : Number.POSITIVE_INFINITY;
    const nextAt = Math.min(
      state.observers[resource].nextAt,
      resetAt,
      dueAtCoreReset,
    );
    if (nextAt > at) return { value: { status: "waiting", nextAt } };
    const nonce = randomUUID();
    const startedReservationIds = Object.entries(state.reservations)
      // An expired owner can no longer settle its request. Keep that uncertain
      // cost charged, but do not make every later probe wait for it to finish.
      // Only work charging this resource is drained -- an unrelated lane's
      // outstanding request says nothing about this counter.
      .filter(([, reservation]) => reservation.status === "started" &&
        state.leases[reservation.leaseId]?.expiresAt > at &&
        reservationCost(reservation, resource, state.leases, at) > 0)
      .map(([id]) => id);
    state.probeClaims[resource] = {
      ownerLeaseId: leaseId,
      nonce,
      leaseUntil: at + GOVERNOR_PROBE_LEASE_MS,
      nextAt: at,
      claimAt: at,
      startedReservationIds,
    };
    state.observers[resource].outcome = "waiting";
    state.observers[resource].at = at;
    state.observers[resource].nextAt = at + GOVERNOR_PROBE_LEASE_MS;
    return { value: {
      status: "claimed",
      nonce,
      resource,
      leaseUntil: state.probeClaims[resource].leaseUntil,
      startedReservationIds,
      coreEtag: state.observers[resource].etag,
    } };
  });
}

function renewProbeClaim(scope, leaseId, nonce, nowMs, resource) {
  return mutateGovernor(scope, nowMs, (state, at) => {
    const claim = state.probeClaims[resource];
    if (!claim || claim.ownerLeaseId !== leaseId || claim.nonce !== nonce || claim.leaseUntil <= at) {
      return { ok: false, reason: "stale" };
    }
    claim.leaseUntil = at + GOVERNOR_ACTIVE_PROBE_LEASE_MS;
    return { value: { nonce, leaseUntil: claim.leaseUntil } };
  });
}

function budgetFromObservation(raw, previous, nowMs, {
  resource,
  source,
  receivedAt = nowMs,
  clearProvenBlock = false,
  allowEpochChange = false,
} = {}) {
  let normalized = normalizeBudgetResource({ ...raw, observedAt: receivedAt });
  if (
    !normalized || normalized.resetMs <= nowMs || receivedAt > nowMs ||
    !RATE_RESOURCES.includes(resource) ||
    !["response-header", "core-observer", "graphql-observer", "rate-limit-probe"].includes(source) ||
    resource === "core" && ["rate-limit-probe", "graphql-observer"].includes(source)
  ) return { status: "invalid" };
  const epoch = `${normalized.limit}:${normalized.resetMs}`;
  // Endpoint responses can carry cached or endpoint-specific rate headers.
  // They may refine the counter inside the epoch established by its claimed
  // observer, but only that observer may move the resource into a new epoch.
  if (!allowEpochChange && (!previous || previous.epoch !== epoch)) {
    return { status: "ignored", epoch };
  }
  if (previous) {
    if (normalized.resetMs < previous.resetMs) return { status: "ignored" };
    if (budgetEpoch(previous) === epoch && normalized.used < previous.used) {
      if (!allowEpochChange) return { status: "ignored" };
      // The claimed observer can lag a newer endpoint response within the
      // same GitHub window. Refresh its timestamp without giving that stale
      // counter any capacity: retain the higher used and lower remaining
      // values until the observer catches up.
      normalized = {
        ...normalized,
        used: previous.used,
        remaining: Math.min(normalized.remaining, previous.remaining),
      };
    }
    if (
      normalized.resetMs === previous.resetMs && normalized.used === previous.used &&
      receivedAt <= previous.observedAt
    ) return { status: "ignored" };
  }
  const epochChanged = !previous || previous.epoch !== epoch;
  const preserveBlock = !clearProvenBlock || !epochChanged;
  const blockActive = preserveBlock && Number.isFinite(previous?.blockUntil) && previous.blockUntil > nowMs;
  const next = {
    ...normalized,
    blockUntil: blockActive ? previous.blockUntil : null,
    blockReason: blockActive ? previous.blockReason : null,
    laneNextAt: epochChanged ? nowMs : previous.laneNextAt,
    roundRobinCursor: previous?.roundRobinCursor ?? null,
    // A new epoch is a new accounting window, so what other clients did in the
    // last one is not evidence about this one. The baseline and the local
    // accumulation below are already reset here; carrying the factor across
    // kept throttling this window on a ratio measured in a window that is over.
    // Only a claimed observer can open an epoch, so this cannot be moved by a
    // stale or reordered response.
    lastExternalFactor: epochChanged ? 1 : (previous?.lastExternalFactor ?? 1),
    epoch,
    source,
    factorBaseline: epochChanged || !previous?.factorBaseline
      ? { epoch, used: normalized.used, observedAt: receivedAt }
      : { ...previous.factorBaseline },
    knownLocalUsed: epochChanged ? 0 : previous.knownLocalUsed,
  };
  return { status: "accepted", budget: next, epochChanged };
}

function publishProbe(scope, leaseId, nonce, budgets, nowMs, resource) {
  return mutateGovernor(scope, nowMs, (state, at) => {
    const claim = state.probeClaims[resource];
    if (!claim || claim.ownerLeaseId !== leaseId || claim.nonce !== nonce || claim.leaseUntil <= at) {
      return { ok: false, reason: "stale" };
    }
    const nextBudgets = { ...state.budgets };
    const nextEpochs = { ...state.epochs };
    // Captured before the publication overwrites it: the reset this epoch
    // change supersedes is the boundary the GraphQL observer is measured against.
    const supersededCoreResetMs = state.budgets.core?.resetMs;
    const changedResources = [];
    const resetResources = [];
    if (!budgets?.[resource]) return { ok: false, reason: "corrupt" };
    const observerCosts = {};
    {
      const supplied = budgets[resource];
      const raw = supplied.budget ?? supplied;
      // The owner source names what actually established the number. Calling a
      // GraphQL budget a "rate-limit-probe" was accurate when /rate_limit supplied
      // it and is a lie now that the claimed observer does.
      const source = supplied.source ?? (resource === "core" ? "core-observer" : "graphql-observer");
      const ownerSource = resource === "core" ? "core-observer" : "graphql-observer";
      if (source !== ownerSource) return { ok: false, reason: "corrupt" };
      const observed = budgetFromObservation(raw, state.budgets[resource], at, {
        resource,
        source,
        receivedAt: supplied.receivedAt ?? at,
        clearProvenBlock: true,
        allowEpochChange: true,
      });
      if (observed.status === "invalid") return { ok: false, reason: "corrupt" };
      if (observed.status !== "ignored") {
        // The observer's own cost is local spend. Left out, the external-factor
        // reconciliation below attributes it to other clients, and the governor
        // throttles the user's real work to make room for its own probing.
        observerCosts[resource] = Number.isSafeInteger(supplied.cost) && supplied.cost > 0 ? supplied.cost : 0;
        nextBudgets[resource] = observed.budget;
        if (resource === "core" && supplied.blocked === true) {
          nextBudgets[resource].blockUntil = observed.budget.resetMs;
          nextBudgets[resource].blockReason = "rate-limit";
        }
        nextEpochs[resource] = observed.budget.epoch;
        changedResources.push(resource);
        if (observed.epochChanged && state.epochs[resource] !== null) resetResources.push(resource);
      }
    }
    if (changedResources.length === 0) return { ok: false, reason: "corrupt" };
    const completedBeforeClaim = Object.entries(state.reservations)
      .filter(([, reservation]) =>
        reservation.status === "completed" && reservation.completedAt < claim.claimAt);
    for (const resource of changedResources) {
      const previous = state.budgets[resource];
      if (!previous || nextBudgets[resource].epoch !== previous.epoch) continue;
      const baseline = previous.factorBaseline;
      if (!baseline || baseline.epoch !== nextBudgets[resource].epoch || nextBudgets[resource].used < baseline.used) {
        continue;
      }
      const legacyCompletedDelta = completedBeforeClaim
        .reduce((total, [, reservation]) =>
          total + (reservation.completedAt > baseline.observedAt
            ? reservationCost(reservation, resource, state.leases, at)
            : 0), 0);
      const globalUsedDelta = nextBudgets[resource].used - baseline.used;
      const sharedCompletedDelta = previous.knownLocalUsed + legacyCompletedDelta + (observerCosts[resource] ?? 0);
      const factor = nextExternalFactor({
        lastExternalFactor: previous.lastExternalFactor,
        globalUsedDelta,
        sharedCompletedDelta,
      });
      if (factor === null) return { ok: false, reason: "corrupt" };
      nextBudgets[resource].lastExternalFactor = factor;
      // Closing the window costs the evidence in it, so only a window that
      // actually reconciled may close. Four local units observed twice are
      // eight, and eight are enough; discarding each four because neither
      // reached five on its own is what kept a factor of seven alive through
      // any amount of purely local spend.
      if (externalSampleIsUsable({ globalUsedDelta, sharedCompletedDelta })) {
        nextBudgets[resource].factorBaseline = {
          epoch: nextBudgets[resource].epoch,
          used: nextBudgets[resource].used,
          observedAt: nextBudgets[resource].observedAt,
        };
        nextBudgets[resource].knownLocalUsed = 0;
      }
      // Otherwise both are left exactly as the observation produced them, which
      // is the previous baseline and the previous local total. Rewriting them
      // here would count the same completed reservations twice: they are still
      // in the ledger precisely because the baseline did not advance past them.
    }
    for (const [id, reservation] of completedBeforeClaim) {
      const accountedByEveryResource = RATE_RESOURCES.every((resource) =>
        reservationCost(reservation, resource, state.leases, at) === 0 ||
        nextBudgets[resource]?.factorBaseline?.observedAt >= reservation.completedAt);
      if (accountedByEveryResource) delete state.reservations[id];
    }
    state.budgets = nextBudgets;
    state.epochs = nextEpochs;
    state.probeClaims[resource] = null;
    {
      const published = nextBudgets[resource];
      state.observers[resource] = {
        etag: typeof budgets[resource].etag === "string" ? budgets[resource].etag : state.observers[resource].etag,
        outcome: "healthy",
        at,
        // A resource observed as empty is due again at its own reset, not at the
        // ordinary cadence: probing an exhausted counter to be told it is still
        // exhausted spends against it for nothing.
        nextAt: published.remaining === 0
          ? published.resetMs + BUDGET_RESET_GRACE_MS
          : at + BUDGET_PROBE_MS,
      };
    }
    // A core reset opens a new shared accounting epoch, so the GraphQL counter
    // is due with it: external-spend baselines and the protected
    // one-publication reset contract have to advance together. A refresh that
    // reads GraphQL before core has already done this, because core's old reset
    // time still said GraphQL was due when that claim was evaluated. What
    // cannot see it is a pane whose GraphQL observer last ran before the reset
    // -- another pane published this epoch first, moving the reset out of
    // reach. Only that case still owes an observation, so only that case is
    // pulled forward; marking it unconditionally spends a second point to
    // re-read a counter this same cycle has just read. An exhausted GraphQL
    // counter waits for its own reset either way.
    if (resource === "core" && resetResources.includes("core")) {
      const graphql = nextBudgets.graphql;
      const heldToReset = graphql && graphql.remaining === 0 &&
        at < graphql.resetMs + BUDGET_RESET_GRACE_MS;
      const observedSinceReset = Number.isFinite(supersededCoreResetMs) &&
        state.observers.graphql.at >= supersededCoreResetMs;
      if (!heldToReset && !observedSinceReset) {
        state.observers.graphql.nextAt = Math.min(state.observers.graphql.nextAt || at, at);
      }
    }
    if (resetResources.length > 0) state.manualProbe = null;
    else if (state.manualProbe &&
      Object.values(nextEpochs).includes(state.manualProbe.requestedEpoch) &&
      RATE_RESOURCES.some((resource) => availableForGrant({
        budget: nextBudgets[resource],
        resource,
        nowMs: at,
      }).spendable === 0)) {
      state.manualProbe.satisfiedAt = at;
    }
    scheduleGovernorState(state, at);
    return { value: { epochs: nextEpochs, retiredThrough: claim.claimAt } };
  });
}

function failProbeClaim(scope, leaseId, nonce, nowMs, resource) {
  return mutateGovernor(scope, nowMs, (state, at) => {
    const claim = state.probeClaims[resource];
    if (!claim || claim.ownerLeaseId !== leaseId || claim.nonce !== nonce) {
      return { ok: false, reason: "stale" };
    }
    // Only this resource's readiness is affected. A failed GraphQL observer that
    // also marked core failed would erase authority core had legitimately
    // established, and stall a lane with nothing wrong with it.
    state.probeClaims[resource] = null;
    state.observers[resource] = {
      ...state.observers[resource],
      outcome: "failed",
      at,
      nextAt: at + BUDGET_PROBE_MS,
    };
    return { value: { retryAt: at + BUDGET_PROBE_MS } };
  });
}

function requestManualProbe(scope, leaseId, epoch, observedAt, nowMs) {
  return mutateGovernor(scope, nowMs, (state, at) => {
    if (!state.leases[leaseId] || typeof epoch !== "string" || !Number.isFinite(observedAt)) {
      return { ok: false, reason: "stale" };
    }
    if (state.manualProbe?.requestedEpoch === epoch && state.manualProbe.baselineObservedAt === observedAt) {
      return { value: { status: state.manualProbe.satisfiedAt === null ? "pending" : "satisfied", ...state.manualProbe } };
    }
    state.manualProbe = { requestedEpoch: epoch, baselineObservedAt: observedAt, satisfiedAt: null };
    if (state.epochs.core === epoch) {
      const core = state.budgets.core;
      const heldThroughReset = core?.blockUntil > at && core.blockUntil === core.resetMs;
      state.observers.core.nextAt = heldThroughReset
        ? Math.max(state.observers.core.nextAt, core.blockUntil + BUDGET_RESET_GRACE_MS)
        : Math.min(state.observers.core.nextAt || at, at);
    }
    if (state.epochs.graphql === epoch) {
      state.observers.graphql.nextAt = Math.min(state.observers.graphql.nextAt || at, at);
    }
    return { value: { status: "pending", ...state.manualProbe } };
  });
}

function registerIntent(scope, intent) {
  return mutateGovernor(scope, intent?.requestedAt, (state, nowMs) => {
    if (!isRecord(intent) || !validGovernorId(intent.id)) {
      return { ok: false, reason: "corrupt" };
    }
    const normalized = normalizeGovernorIntent({
      leaseId: intent.leaseId,
      tab: intent.tab,
      priority: intent.priority,
      costs: intent.costs ?? tabRequestCost(intent.tab),
      requestedAt: intent.requestedAt,
      expiresAt: intent.expiresAt,
    }, nowMs);
    if (!normalized) return { ok: false, reason: "corrupt" };
    if (normalized.expiresAt <= nowMs || !state.leases[normalized.leaseId]) {
      return { ok: false, reason: "stale" };
    }
    const duplicate = Object.entries(state.intents).find(([, pending]) =>
      pending.leaseId === normalized.leaseId && pending.tab === normalized.tab &&
      pending.priority === normalized.priority,
    );
    if (duplicate) return { value: { status: "pending", intentId: duplicate[0], coalesced: true } };
    const reservationId = `reservation:${intent.id}`;
    const existingReservation = state.reservations[reservationId];
    if (existingReservation) return { value: { status: existingReservation.status, reservationId } };
    if (!state.intents[intent.id] && Object.keys(state.intents).length >= GOVERNOR_MAX_INTENTS) {
      return { ok: false, reason: "busy" };
    }
    state.intents[intent.id] = normalized;
    const scheduled = scheduleGovernorState(state, nowMs);
    const reservation = state.reservations[reservationId];
    const grant = scheduled.grants.find((item) => item.id === reservationId);
    const denial = scheduled.denied.find((item) => item.intentId === intent.id);
    return { value: reservation
      ? {
          status: "scheduled",
          reservationId,
          ...reservation,
          ...sharedLaneEvidence(grant),
        }
      : {
          status: denial?.mode ?? "pending",
          intentId: intent.id,
          resource: denial?.resource ?? null,
          reason: denial?.reason ?? "budget-unknown",
          resetMs: denial?.resetMs ?? null,
          retryAt: denial?.retryAt ?? denial?.notBefore ?? null,
          notBefore: denial?.notBefore ?? null,
        } };
  });
}

function readIntentDecision(scope, intentId, nowMs, previousEvidence = null) {
  return mutateGovernor(scope, nowMs, (state, at) => {
    const scheduled = scheduleGovernorState(state, at);
    const reservationId = `reservation:${intentId}`;
    const reservation = state.reservations[reservationId];
    const grant = scheduled.grants.find((item) => item.id === reservationId);
    // UI provenance stays process-local. Reuse it only for this same pending
    // intent while its original owners and pane count remain valid.
    const retainedSharing = previousEvidence?.intentId === intentId &&
      reservation?.status === "scheduled" && reservation.notBefore > at &&
      currentSharedLaneProvenance(previousEvidence, state.leases, at).waitCause
      ? sharedLaneEvidence(previousEvidence) : {};
    if (reservation) return { value: {
      status: reservation.status,
      reservationId,
      ...reservation,
      ...retainedSharing,
      ...sharedLaneEvidence(grant),
    } };
    if (!state.intents[intentId]) return { ok: false, reason: "stale" };
    const denial = scheduled.denied.find((item) => item.intentId === intentId);
    return { value: {
      status: denial?.mode ?? "pending",
      resource: denial?.resource ?? null,
      reason: denial?.reason ?? "budget-unknown",
      resetMs: denial?.resetMs ?? null,
      retryAt: denial?.retryAt ?? denial?.notBefore ?? null,
      notBefore: denial?.notBefore ?? null,
    } };
  });
}

function cancelIntent(scope, intentId, nowMs) {
  return mutateGovernor(scope, nowMs, (state) => {
    if (!validGovernorId(intentId)) return { ok: false, reason: "corrupt" };
    if (state.intents[intentId]) {
      delete state.intents[intentId];
      return { value: { status: "cancelled", intentId } };
    }
    const reservationId = `reservation:${intentId}`;
    const reservation = state.reservations[reservationId];
    if (!reservation || reservation.status !== "scheduled") {
      return { ok: false, reason: "stale" };
    }
    delete state.reservations[reservationId];
    // The request never started, so the whole slot it was paced into is free.
    for (const resource of RATE_RESOURCES) {
      returnPacingCredit(state, resource, reservation.costs[resource], nowMs ?? Date.now());
    }
    return { value: { status: "cancelled", intentId, reservationId } };
  });
}

function startReservation(scope, reservationId, nowMs) {
  return mutateGovernor(scope, nowMs, (state, at) => {
    const reservation = state.reservations[reservationId];
    const lease = reservation && state.leases[reservation.leaseId];
    if (!reservation || reservation.status !== "scheduled" || !lease || lease.expiresAt <= at) {
      if (reservation?.status === "scheduled") reservation.status = "cancelled";
      return { ok: false, reason: "stale", write: Boolean(reservation) };
    }
    if (reservation.notBefore > at) return { value: { status: "waiting", notBefore: reservation.notBefore } };
    // Any live observer claim defers a start: the claim owns the shared HTTP
    // permit for its window, so starting here would contend for it.
    const liveClaim = RATE_RESOURCES
      .map((resource) => state.probeClaims[resource])
      .filter((claim) => claim && claim.leaseUntil > at)
      .sort((left, right) => right.leaseUntil - left.leaseUntil)[0];
    if (liveClaim) {
      return { value: { status: "waiting", reason: "probe", notBefore: liveClaim.leaseUntil } };
    }
    for (const resource of RATE_RESOURCES.filter((name) => reservation.costs[name] > 0)) {
      const budget = state.budgets[resource];
      if (
        !budget || at - budget.observedAt > budgetSnapshotTtl(resource) || at >= budget.resetMs ||
        state.epochs[resource] !== reservation.epochs[resource] ||
        (Number.isFinite(budget.blockUntil) && budget.blockUntil > at)
      ) {
        reservation.status = "cancelled";
        return { ok: false, reason: "stale", write: true };
      }
      const charged = Object.values(state.reservations).reduce(
        (total, item) => total + reservationCost(item, resource, state.leases, at),
        0,
      );
      if (budget.remaining - resourceReserve(budget.limit) - charged < 0) {
        reservation.status = "cancelled";
        return { ok: false, reason: "stale", write: true };
      }
    }
    reservation.status = "started";
    reservation.startedAt = at;
    return { value: { status: "started", reservationId } };
  });
}

function completeReservation(scope, reservationId, completion, nowMs) {
  return mutateGovernor(scope, nowMs, (state, at) => {
    const reservation = state.reservations[reservationId];
    if (!reservation || reservation.status !== "started" || !GOVERNOR_OUTCOMES.has(completion?.outcome)) {
      return { ok: false, reason: "stale" };
    }
    const measured = completion.outcome === "measured-success"
      ? exactResourceCosts(completion.actualCost)
      : reservation.costs;
    if (!measured || RATE_RESOURCES.some((resource) => measured[resource] > reservation.costs[resource])) {
      return { ok: false, reason: "corrupt" };
    }
    reservation.status = "completed";
    reservation.completedAt = at;
    reservation.outcome = completion.outcome;
    reservation.actualCosts = { ...measured };
    reservation.accountedCosts = { core: 0, graphql: 0 };
    // The same rule as the observing settlement path: this one narrows the
    // charge in exactly the same way, so it releases the pacing in exactly the
    // same way. Wiring it into only one of the two settlement paths left every
    // doctor probe and manual operation paying for capacity it did not use.
    if (completion.outcome === "measured-success") {
      for (const resource of RATE_RESOURCES) {
        returnPacingCredit(state, resource, reservation.costs[resource] - measured[resource], at);
      }
    }
    return { value: { status: "completed", actualCosts: reservation.actualCosts } };
  });
}

function settleReservationWithBudgetObservations(
  scope,
  leaseId,
  reservationId,
  completion,
  nowMs,
) {
  return mutateGovernor(scope, nowMs, (state, at) => {
    const reservation = state.reservations[reservationId];
    const lease = state.leases[leaseId];
    if (
      !lease || lease.expiresAt <= at || !reservation ||
      reservation.leaseId !== leaseId || reservation.status !== "started" ||
      !GOVERNOR_OUTCOMES.has(completion?.outcome)
    ) return { ok: false, reason: "stale" };
    const measured = completion.outcome === "measured-success"
      ? exactResourceCosts(completion.actualCosts ?? completion.actualCost)
      : reservation.costs;
    if (!measured || RATE_RESOURCES.some((resource) => measured[resource] > reservation.costs[resource])) {
      return { ok: false, reason: "corrupt" };
    }
    const observations = Array.isArray(completion.observations) ? completion.observations : [];
    if (observations.some((observation) =>
      !isRecord(observation) || observation.source !== "response-header" ||
      !Number.isFinite(observation.receivedAt) || observation.receivedAt > at)) {
      return { ok: false, reason: "corrupt" };
    }
    const acceptedCosts = { core: 0, graphql: 0 };
    const acceptedAfterBaseline = { core: 0, graphql: 0 };
    for (const resource of RATE_RESOURCES) {
      const candidates = observations
        .filter((observation) => observation.resource === resource)
        .sort((left, right) =>
          left.resetMs - right.resetMs || left.used - right.used || left.receivedAt - right.receivedAt);
      for (const observation of candidates) {
        const observed = budgetFromObservation(observation, state.budgets[resource], at, {
          resource,
          source: observation.source,
          receivedAt: observation.receivedAt,
          clearProvenBlock: false,
        });
        if (observed.status === "invalid") continue;
        const definiteCost = Number.isSafeInteger(observation.cost) && observation.cost >= 0
          ? observation.cost
          : 0;
        if (observed.status === "accepted") {
          state.budgets[resource] = observed.budget;
          state.epochs[resource] = observed.budget.epoch;
          acceptedCosts[resource] += definiteCost;
          if (observation.receivedAt > observed.budget.factorBaseline.observedAt) {
            acceptedAfterBaseline[resource] += definiteCost;
          }
        } else if (
          observation.source === "response-header" &&
          state.budgets[resource]?.epoch === `${observation.limit}:${observation.resetMs}` &&
          state.budgets[resource].used >= observation.used
        ) {
          // A newer same-window counter already includes this completed call.
          acceptedCosts[resource] += definiteCost;
          if (observation.receivedAt > state.budgets[resource].factorBaseline.observedAt) {
            acceptedAfterBaseline[resource] += definiteCost;
          }
        }
      }
    }
    reservation.status = "completed";
    reservation.completedAt = at;
    reservation.outcome = completion.outcome;
    reservation.actualCosts = { ...measured };
    reservation.accountedCosts = Object.fromEntries(RATE_RESOURCES.map((resource) => [
      resource,
      completion.outcome === "measured-success"
        ? Math.min(measured[resource], acceptedCosts[resource])
        : 0,
    ]));
    for (const resource of RATE_RESOURCES) {
      const budget = state.budgets[resource];
      if (!budget || completion.outcome !== "measured-success") continue;
      // accountedCosts removes the portion already present in an authoritative
      // counter from the reservation residual. knownLocalUsed contains only
      // that same portion when it arrived after the factor baseline. Their sum
      // is therefore exactly the measured local cost, never twice that cost.
      budget.knownLocalUsed += Math.min(
        reservation.accountedCosts[resource],
        acceptedAfterBaseline[resource],
      );
    }
    // Only a measured outcome knows what it spent. A timeout, abort or process
    // loss proves nothing, so its worst case stays charged and its pacing stays
    // spent -- refunding there would let a run of timeouts pace as though
    // nothing had been sent.
    if (completion.outcome === "measured-success") {
      for (const resource of RATE_RESOURCES) {
        returnPacingCredit(state, resource, reservation.costs[resource] - measured[resource], at);
      }
    }
    scheduleGovernorState(state, at);
    return { value: {
      status: "completed",
      actualCosts: reservation.actualCosts,
      accountedCosts: reservation.accountedCosts,
    } };
  });
}

function recordResourceBlock(scope, resource, resetMs, reason) {
  return mutateGovernor(scope, undefined, (state, nowMs) => {
    const budget = state.budgets[resource];
    if (!budget || !RATE_RESOURCES.includes(resource) || !Number.isFinite(resetMs) || resetMs <= nowMs ||
      !GOVERNOR_BLOCK_REASONS.has(reason)) return { ok: false, reason: "corrupt" };
    budget.blockUntil = resetMs;
    budget.blockReason = reason;
    if (resource === "core") {
      state.observers.core.nextAt = Math.min(
        state.observers.core.nextAt || resetMs + BUDGET_RESET_GRACE_MS,
        resetMs + BUDGET_RESET_GRACE_MS,
      );
    } else {
      state.observers.graphql.nextAt = Math.min(
        state.observers.graphql.nextAt || resetMs + BUDGET_RESET_GRACE_MS,
        resetMs + BUDGET_RESET_GRACE_MS,
      );
    }
    return { value: { resource, resetMs, reason } };
  });
}

function releaseLease(scope, leaseId) {
  return mutateGovernor(scope, undefined, (state) => {
    if (!state.leases[leaseId]) return { ok: false, reason: "stale" };
    delete state.leases[leaseId];
    for (const [id, intent] of Object.entries(state.intents)) {
      if (intent.leaseId === leaseId) delete state.intents[id];
    }
    for (const [id, reservation] of Object.entries(state.reservations)) {
      if (reservation.leaseId === leaseId && reservation.status === "scheduled") delete state.reservations[id];
    }
    return { value: { released: leaseId } };
  });
}

function inspectGovernor(scope, nowMs) {
  const requestedAt = scopeNow(scope, nowMs);
  if (!Number.isFinite(requestedAt) || requestedAt < 0) return { ok: false, reason: "corrupt" };
  return withGovernorLock(scope, () => {
    const at = governorEffectiveTime(scope, requestedAt);
    const loaded = readGovernorState(scope.path, at);
    return loaded;
  });
}

function governorHealth(result, nowMs = Date.now()) {
  if (!result?.ok) return { status: "unavailable", leases: 0, resources: {} };
  const state = result.value;
  let status = "healthy";
  if (RATE_RESOURCES.some((resource) => state.probeClaims[resource]?.leaseUntil > nowMs)) status = "waiting for probe";
  else if (RATE_RESOURCES.some((resource) => !state.budgets[resource] ||
    nowMs - state.budgets[resource].observedAt > budgetSnapshotTtl(resource))) status = "stale";
  else if (RATE_RESOURCES.some((resource) => state.budgets[resource].blockUntil > nowMs)) status = "blocked";
  return {
    status,
    leases: Object.keys(state.leases).length,
    resources: Object.fromEntries(RATE_RESOURCES.flatMap((resource) => {
      const budget = state.budgets[resource];
      return budget ? [[resource, {
        reserve: resourceReserve(budget.limit),
        remaining: budget.remaining,
        resetMs: budget.resetMs,
        source: budget.source,
      }]] : [];
    })),
  };
}

async function retryGovernorMutation(run, { now, wait, deadline, signal }) {
  let result = run();
  while (!result.ok && result.reason === "busy" && !signal?.aborted && now() < deadline) {
    await wait(Math.min(100, Math.max(1, deadline - now())));
    result = run();
  }
  return result;
}

// Each resource refreshes on its own claim. A slow or failing observer for one
// must not delay or invalidate the other's readiness -- nothing about the
// resources couples them. What still couples them is the shared HTTP permit and
// any account-wide secondary hold, and those are enforced where they belong.
// Core is refreshed last because its publication is what reopens data
// admission. Finishing the cycle's control work before that happens stops a
// pane that merely published the reset from getting a head start, over the
// shared permit, on higher-priority work waiting for the same lane. It is also
// the order readSharedBudgetSources reads its sources in, and the order the
// single claim this replaced already used, so the sequence of actual HTTP
// calls is unchanged.
const BUDGET_REFRESH_ORDER = ["graphql", "core"];

async function refreshSharedBudget(scope, leaseId, signal, options = {}) {
  const outcomes = [];
  for (const resource of BUDGET_REFRESH_ORDER) {
    outcomes.push([resource, await refreshResourceBudget(scope, leaseId, signal, resource, options)]);
  }
  const published = outcomes.filter(([, result]) => result.ok);
  if (published.length === 0) return outcomes[0][1];
  const inspect = options.inspect ?? inspectGovernor;
  const now = options.now ?? (() => scopeNow(scope));
  const snapshot = inspect(scope, now());
  return {
    ok: true,
    value: {
      status: "published",
      budgets: snapshot.ok ? snapshot.value.budgets : {},
      resources: published.map(([resource]) => resource),
    },
  };
}

async function refreshResourceBudget(scope, leaseId, signal, resource, {
  readBudgets = readSharedBudgetSources,
  now = () => scopeNow(scope),
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  inspect = inspectGovernor,
  renew = renewProbeClaim,
  publish = publishProbe,
  fail = failProbeClaim,
} = {}) {
  let claim = claimProbe(scope, leaseId, now(), resource);
  if (!claim.ok) return claim;
  if (claim.value.status !== "claimed") {
    const startedAt = now();
    const deadline = Math.min(
      claim.value.leaseUntil ?? claim.value.nextAt ?? startedAt,
      startedAt + GOVERNOR_PUBLICATION_REINSPECT_MS,
    );
    let inspections = 0;
    while (!signal?.aborted && now() < deadline && inspections < 10) {
      inspections += 1;
      const snapshot = inspect(scope, now());
      if (!snapshot.ok) return snapshot;
      // Only this resource's freshness matters here. Waiting on the other's
      // observer is what made one failing lane stall an unrelated healthy one.
      if (
        snapshot.value.budgets[resource] &&
        now() - snapshot.value.budgets[resource].observedAt <= budgetSnapshotTtl(resource) &&
        snapshot.value.observers[resource].outcome === "healthy"
      ) {
        return { ok: true, value: { status: "published", budgets: snapshot.value.budgets } };
      }
      if (now() >= deadline || inspections >= 10) break;
      await wait(Math.min(100, Math.max(1, deadline - now())));
    }
    claim = claimProbe(scope, leaseId, now(), resource);
    if (!claim.ok || claim.value.status !== "claimed") return claim;
  }
  const { nonce, startedReservationIds, coreEtag = null } = claim.value;
  const drainUntil = now() + GOVERNOR_PROBE_DRAIN_MS;
  while (startedReservationIds.length > 0 && now() < drainUntil) {
    const snapshot = inspect(scope, now());
    if (!snapshot.ok) {
      failProbeClaim(scope, leaseId, nonce, now(), resource);
      return snapshot;
    }
    const stillStarted = startedReservationIds.some((id) => snapshot.value.reservations[id]?.status === "started");
    if (!stillStarted) break;
    if (signal?.aborted) {
      failProbeClaim(scope, leaseId, nonce, now(), resource);
      return { ok: false, reason: "stale" };
    }
    await wait(Math.min(100, Math.max(1, drainUntil - now())));
  }
  const renewalStartedAt = now();
  const renewalDeadline = Math.min(
    claim.value.leaseUntil,
    renewalStartedAt + GOVERNOR_PROBE_TRANSITION_MS,
  );
  const renewed = await retryGovernorMutation(
    () => renew(scope, leaseId, nonce, now(), resource),
    { now, wait, deadline: renewalDeadline, signal },
  );
  if (!renewed.ok) {
    failProbeClaim(scope, leaseId, nonce, now(), resource);
    return renewed;
  }
  // Known exhaustion waits for its actual reset. The GraphQL observer costs a
  // point, so probing an already-empty budget to be told it is still empty digs
  // the hole deeper -- the /rate_limit read this replaced was free and could
  // afford to be unconditional.
  const beforeRead = inspect(scope, now());
  const exhausted = resource === "graphql" && beforeRead.ok &&
    beforeRead.value.budgets.graphql &&
    beforeRead.value.budgets.graphql.remaining <= 0 &&
    now() < beforeRead.value.budgets.graphql.resetMs + BUDGET_RESET_GRACE_MS;
  if (exhausted) {
    failProbeClaim(scope, leaseId, nonce, now(), resource);
    return { ok: false, reason: "budget-reset" };
  }
  let budgets;
  try {
    budgets = await requestIdentityStorage.run(scope, () => readBudgets(signal, scope.host, {
      resources: [resource],
      coreEtag,
      renewClaim: async () => {
        const startedAt = now();
        const extended = await retryGovernorMutation(
          () => renew(scope, leaseId, nonce, now(), resource),
          {
            now,
            wait,
            deadline: Math.min(renewed.value.leaseUntil, startedAt + GOVERNOR_PROBE_TRANSITION_MS),
            signal,
          },
        );
        if (extended.ok) renewed.value.leaseUntil = extended.value.leaseUntil;
        return extended.ok;
      },
    }));
  } catch {
    budgets = null;
  }
  if (!budgets) {
    const failureDeadline = Math.min(
      renewed.value.leaseUntil ?? Number.POSITIVE_INFINITY,
      now() + GOVERNOR_PROBE_TRANSITION_MS,
    );
    await retryGovernorMutation(
      () => fail(scope, leaseId, nonce, now(), resource),
      { now, wait, deadline: failureDeadline, signal },
    );
    return { ok: false, reason: "stale" };
  }
  const transitionDeadline = Math.min(
    renewed.value.leaseUntil ?? Number.POSITIVE_INFINITY,
    now() + GOVERNOR_PROBE_TRANSITION_MS,
  );
  const published = await retryGovernorMutation(
    () => publish(scope, leaseId, nonce, budgets, now(), resource),
    { now, wait, deadline: transitionDeadline, signal },
  );
  if (!published.ok) {
    await retryGovernorMutation(
      () => fail(scope, leaseId, nonce, now(), resource),
      { now, wait, deadline: transitionDeadline, signal },
    );
  }
  return published;
}

// Whether a probe window holds enough completed shared calls for the ratio below to
// mean anything. Named rather than inlined because the control law and the loop
// that feeds it must agree on the answer: the law uses it to decide whether to
// infer, and the loop uses it to decide whether the window may be closed.
function externalSampleIsUsable(sample) {
  return (
    Boolean(sample) &&
    sample.sharedCompletedDelta >= MIN_SAMPLE_CALLS &&
    sample.globalUsedDelta > 0
  );
}

function alertArgs(source, path = source.path) {
  return [apiPath(path), ...apiHostArgs(), "--jq", source.jq];
}

function alertRequestArgs(source) {
  if (!source || typeof source.path !== "string" || !Array.isArray(source.priorityQueries)) {
    return [];
  }
  return [
    alertArgs(source),
    ...source.priorityQueries.map((query) => alertArgs(source, `${source.path}&${query}`)),
  ];
}

function shouldFetchAlertPriorityLanes(openCount) {
  return openCount >= ALERT_PER_PAGE;
}

function mergeAlertRows(groups) {
  const seen = new Set();
  const merged = [];
  for (const rows of groups) {
    for (const row of Array.isArray(rows) ? rows : []) {
      const key = row?.number ?? row?.id;
      if (key == null || seen.has(key)) continue;
      seen.add(key);
      merged.push(row);
    }
  }
  return merged;
}

// Per-source backoff. Keyed by source so one unavailable endpoint cannot slow
// the other two, and capped rather than permanent so enabling Advanced Security
// mid-session is picked up within the hour.
const alertBackoff = new Map();

function backoffStorageKey(key) {
  const access = requestIdentityStorage.getStore()?.accessKey ?? runtimeIdentityCoordinator?.current()?.accessKey;
  return access ? `${access}\0${key}` : key;
}

function backoffActive(key, now) {
  const state = alertBackoff.get(backoffStorageKey(key));
  return Boolean(state) && now < state.until;
}

// Which local ladder each verdict takes. Shared rate limits are held by the
// account governor instead of a process-local retry timer.
const FAILURE_LADDER = {
  "no-remote": BACKOFF_STEPS_MS,
  unavailable: BACKOFF_STEPS_MS,
  "auth-problem": AUTH_RETRY_MS,
};

// The ladder is a parameter rather than a second near-identical function,
// which is the drift the ALERT_SOURCES comment below warns about: two copies of
// this would diverge the first time one of them was fixed.
function recordFailure(key, now, steps = BACKOFF_STEPS_MS) {
  const previous = alertBackoff.get(backoffStorageKey(key));
  const step = Math.min((previous?.step ?? -1) + 1, steps.length - 1);
  alertBackoff.set(backoffStorageKey(key), { step, until: now + steps[step] });
}

function clearBackoff(key) {
  alertBackoff.delete(backoffStorageKey(key));
}

function forcedBackoffKeys(key) {
  return [
    `tab:${key}`,
    ...(key === "security" ? ALERT_SOURCES.map((source) => source.key) : []),
  ];
}

function clearForcedBackoffAfterStart(key, force, status, clear = clearBackoff) {
  if (!force || status !== "started") return false;
  for (const backoffKey of forcedBackoffKeys(key)) clear(backoffKey);
  return true;
}

async function fetchAlertSource(source, signal, now, {
  entities,
  force = false,
  request = fetchConditionalEntity,
} = {}) {
  if (backoffActive(source.key, now)) {
    const { note, verdict } = alertBackoff.get(backoffStorageKey(source.key));
    // The verdict is replayed alongside the note. Replaying only the note left
    // the tab unable to tell "Dependabot is switched off here" from "we cannot
    // see Dependabot" for the whole length of a backoff window.
    // Nothing was spawned, so nothing was billed -- which is the whole reason
    // the meter is fed by the fetchers rather than by counting ticks.
    return {
      raw: `backoff:${note}`,
      completedCalls: 0,
      verdict,
      allNotModified: false,
      stagedEntities: new Map(),
      parse: () => ({ alerts: [], note, verdict, truncated: false }),
    };
  }
  let completedCalls = 0;
  const observations = [];
  try {
    const requests = alertRequestArgs(source);
    const payloads = [];
    const groups = [];
    const responses = [];
    for (const [index, args] of requests.entries()) {
      if (index > 0 && !shouldFetchAlertPriorityLanes(groups[0]?.length ?? 0)) break;
      let response = null;
      try {
        response = await request({
          tab: "security",
          args,
          operation: "tab:security-endpoint",
          signal,
          force,
          entities,
        });
        if (response.status === 200) completedCalls += 1;
        observations.push(...(response.observations ?? []));
        responses.push(response);
        payloads.push(response.body ?? "");
        groups.push(parseJsonOutput(response.body ?? "").filter((alert) => alert.state === "open"));
      } catch (error) {
        if (response === null) completedCalls += 1;
        observations.push(...(error.budgetObservations ?? []));
        throw error;
      }
    }
    const raw = payloads.join("\0");
    clearBackoff(source.key);
    const batch = conditionalBatchResult(responses, raw, raw);
    return {
      raw,
      completedCalls,
      verdict: "ok",
      allNotModified: batch.allNotModified,
      // Every other fetchAlertSource path returns a Map. An all-304 batch has
      // no staged writes, so conditionalBatchResult returns null; normalize it
      // here before fetchSecurity merges the independently fetched sources.
      stagedEntities: batch.stagedEntities ?? new Map(),
      observations,
      parse: () => {
        const rows = mergeAlertRows(groups);
        return {
          alerts: rows.map(source.map),
          note: null,
          verdict: "ok",
          truncated: groups.some((group) => group.length >= ALERT_PER_PAGE),
        };
      },
    };
  } catch (err) {
    // Only "unavailable" is a statement about the repository's configuration,
    // so it is the only verdict allowed to replace gh's message with the
    // source's fixed note. Everything else -- an expired SAML session, a rate
    // limit, a network drop -- surfaces as itself.
    const verdict = classify(err);
    if (verdict === "unusable-output") {
      return {
        raw: "unusable-output",
        completedCalls,
        verdict,
        allNotModified: false,
        stagedEntities: new Map(),
        observations,
        parse: () => ({
          alerts: [],
          note: null,
          verdict,
          truncated: false,
          unusable: true,
        }),
      };
    }
    const note = verdict === "unavailable" ? source.unavailable : `${source.name}: ${shortErr(err)}`;
    const steps = pick(FAILURE_LADDER, verdict, null);
    if (steps) {
      recordFailure(source.key, now, steps);
      Object.assign(alertBackoff.get(backoffStorageKey(source.key)), { note, verdict });
    }
    return {
      raw: `unavailable:${note}`,
      // A failed call still bills: the request reached GitHub and was counted
      // whether it returned data, `[]`, or a 403.
      completedCalls,
      verdict,
      allNotModified: false,
      stagedEntities: new Map(),
      observations,
      parse: () => ({ alerts: [], note, verdict, truncated: false }),
    };
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

async function fetchSecurity(signal, {
  entities = new Map(),
  force = false,
  previousRaw = null,
} = {}) {
  // Monotonic, not wall-clock. These deadlines measure *elapsed* time, and
  // Date.now() can jump: a laptop resume or an NTP correction stepping the clock
  // backwards would hold an alert source in backoff for up to an hour of apparent
  // time that never passed -- on a security surface, which is exactly what the
  // capped ladder exists to prevent. Staleness deliberately stays on Date.now()
  // for the mirror-image reason: a sleep gap is the thing it reports, and
  // performance.now() does not advance across suspend.
  const now = performance.now();
  const parts = await Promise.all(ALERT_SOURCES.map((source) =>
    fetchAlertSource(source, signal, now, { entities, force })));
  const allNotModified = parts.length > 0 && parts.every((part) => part.allNotModified);
  const stagedEntities = new Map(parts.flatMap((part) => [...part.stagedEntities]));
  return {
    // Joined with a NUL so a change in any one of the three shows up as a
    // change in the combined payload, without risk of two different splits
    // colliding on the same string.
    raw: allNotModified ? previousRaw : parts.map((p) => p.raw).join("\0"),
    limit: ALERT_PER_PAGE,
    // Summed from what each source reported rather than assumed to be
    // ALERT_SOURCES.length: a source held off by backoff spawned nothing and
    // must not be billed for it.
    restSpent: parts.reduce((total, part) => total + part.completedCalls, 0),
    graphqlSpent: 0,
    measuredSuccess: parts.every((part) => part.verdict === "ok"),
    rateLimited: parts.some((part) => part.verdict === "rate-limited"),
    stagedEntities,
    observations: parts.flatMap((part) => part.observations ?? []),
    parse: () => {
      if (parts.some((part) => part.verdict === "unusable-output")) return { unusable: true };
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
        unusable: parsed.some((p) => p.unusable),
        // "Blind" is not the same as "switched off", and the tab bar could not
        // tell them apart: fetchAlertSource never rejects, so a repo whose three
        // endpoints all 403'd on an expired SAML session rendered
        // `4:Security (0)` -- byte-identical to a genuinely clean repo, on the
        // one surface where a false all-clear is the worst possible answer.
        // `unavailable` is excluded deliberately: that verdict IS an answer about
        // the repository, and most repos have Advanced Security switched off, so
        // treating it as blindness would mark almost everyone permanently unsure.
        blind: parsed.some((p) => p.verdict != null && p.verdict !== "ok" && p.verdict !== "unavailable"),
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

function reconcileSelectionViewport({ items, key, offset = 0, rows = 1 }) {
  const list = Array.isArray(items) ? items : [];
  const rowCount = Math.max(1, Number.isSafeInteger(rows) ? rows : 1);
  const maxOffset = Math.max(0, list.length - rowCount);
  let nextOffset = Math.min(Math.max(0, Number.isSafeInteger(offset) ? offset : 0), maxOffset);
  if (key == null) return { key: null, offset: nextOffset };
  const index = list.findIndex((item) => itemKey(item) === key);
  if (index < 0) return { key: null, offset: nextOffset };
  if (index < nextOffset) nextOffset = index;
  else if (index >= nextOffset + rowCount) nextOffset = index - rowCount + 1;
  return { key, offset: nextOffset };
}

// The tabs with a per-item URL. Security is absent on purpose: an alert has no
// stable per-item page this app can construct honestly.
const OPENABLE = ["actions", "issues", "prs"];

// The platform's opener, by fixed argv and without a shell, so a URL is an
// argument and never a fragment of a command line.
// rundll32 rather than `cmd /c start ""`: cmd re-parses its /c string, so a URL
// handed to it is a fragment of a command line and its metacharacters are live.
// FileProtocolHandler takes the URL as one real argument, which is the whole
// point of using execFile without a shell.
const BROWSER_OPENERS = {
  darwin: ["open"],
  linux: ["xdg-open"],
  win32: ["rundll32", "url.dll,FileProtocolHandler"],
};

// Only https, and only the host this pane is actually talking to. A row is
// remote data; without this a crafted `url` could point the user's browser
// anywhere, or hand a `file:`/`javascript:` URL to the platform opener.
function admittedRowUrl(value, host) {
  if (typeof value !== "string" || value.length === 0) return null;
  let parsed;
  try { parsed = new URL(value); } catch { return null; }
  if (parsed.protocol !== "https:") return null;
  return parsed.host === host ? parsed.toString() : null;
}

// Actions rows come from REST and carry no URL, but a run's page is a pure
// function of the repository and its databaseId -- both already validated --
// so it is derived locally rather than fetched. Issues and PRs select `url` in
// their query, which is validated against the same host before use.
function rowBrowserUrl(tabKey, item, { host = effectiveRuntimeHost(), repo = effectiveRuntimeRepository() } = {}) {
  if (!OPENABLE.includes(tabKey) || !isRecord(item) || !host) return null;
  // The row's own URL first, for every tab. A run only falls back to a derived
  // URL when the payload predates the projection, and that fallback needs the
  // slug, which the app only has when --repo was given.
  const declared = admittedRowUrl(item.url, host);
  if (declared || tabKey !== "actions") return declared;
  const id = item.databaseId ?? item.number;
  if (!Number.isSafeInteger(id) || id <= 0 || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(repo ?? ""))) return null;
  return `https://${host}/${repo}/actions/runs/${id}`;
}

// Opening a page the row already names costs nothing and needs no admission:
// `gh <kind> view --web` spent a request to be told a URL that was already in
// hand. Output is still captured rather than inherited, because stdout is ink's
// frame stream and an opener's chatter would corrupt the alternate screen.
async function openInBrowser(tabKey, item, signal, _governor = null, { run = null, host, repo } = {}) {
  if (!OPENABLE.includes(tabKey)) return;
  const url = rowBrowserUrl(tabKey, item, {
    ...(host === undefined ? {} : { host }),
    ...(repo === undefined ? {} : { repo }),
  });
  // Returning quietly here is how a dead Enter key looks: the row has no usable
  // page, and the user is entitled to know that rather than press it again.
  if (!url) throw new Error("This row has no page to open yet; refresh and try again");
  const opener = pick(BROWSER_OPENERS, process.platform, null);
  if (!opener) throw new Error(`Opening a browser is not supported on ${process.platform}`);
  const [command, ...prefix] = opener;
  const launch = run ?? ((argv) => execFileAsync(argv[0], argv.slice(1), {
    timeout: GH_TIMEOUT_MS,
    killSignal: "SIGKILL",
    maxBuffer: GH_MAX_BUFFER,
    signal,
  }));
  await launch([command, ...prefix, url]);
}

function createOpenRequestRegistry() {
  const requests = new Map();
  return {
    start(key, run) {
      if (requests.has(key)) return null;
      const controller = new AbortController();
      requests.set(key, { controller, promise: null });
      let started;
      try {
        started = run({ signal: controller.signal });
      } catch (error) {
        started = Promise.reject(error);
      }
      const promise = Promise.resolve(started).finally(() => requests.delete(key));
      requests.set(key, { controller, promise });
      return promise;
    },
    abortAll() {
      for (const { controller } of requests.values()) controller.abort();
    },
    size: () => requests.size,
  };
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

// ---------- Diagnostics (--doctor) ----------

// This report is written to be pasted into a bug report or a chat window, which
// makes it a disclosure surface before it is anything else. So redaction is not
// a review note applied per call site -- it is applied once, at the single point
// where the report is assembled, the same way safe() is the one boundary for
// untrusted remote strings rather than six. redact() itself now lives up in the
// gh subprocess section, because the --verbose log and the crash handler need it
// too and nothing should reach backwards for it.

// Values that are the thing being diagnosed, so they are printed as-is.
const DOCTOR_ENV_PLAIN = [
  "GH_HOST",
  "GH_REPO",
  "GH_CONFIG_DIR",
  "NO_PROXY",
  "GH_GLANCE_ICONS",
  "GH_GLANCE_NO_ANIMATION",
  "GH_GLANCE_REFRESH",
  "NO_COLOR",
  "NODE_ENV",
];
const DOCTOR_ENV_PROXY = ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY"];
// Listed so they always get a line even when unset -- the absence of GH_TOKEN is
// itself a diagnosis. Their values are never printed; see envValue(), where
// presence-only is the default for everything outside DOCTOR_ENV_PLAIN.
const DOCTOR_ENV_SECRET = ["GH_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_TOKEN"];

const NOT_SET = "not set";

// Scheme and host only. A proxy URL is one of the few env values that routinely
// carries a credential inline, and the host is the entire diagnostic value.
function proxySummary(value) {
  for (const candidate of [value, `http://${value}`]) {
    try {
      const url = new URL(candidate);
      if (url.host) return `${url.protocol}//${url.host}`;
    } catch {
      // Not a URL in this form; try the next one, then give up.
    }
  }
  return "(set, unparseable)";
}

// Every gh/GITHUB variable that is actually set gets a line, so the report shows
// the environment as it is rather than as this list imagined it. Token-shaped
// names still take the presence-only path below.
function doctorEnvNames() {
  const named = [...DOCTOR_ENV_PLAIN, ...DOCTOR_ENV_PROXY, ...DOCTOR_ENV_SECRET];
  const known = new Set(named);
  const extra = Object.keys(process.env).filter(
    (name) => /^(GH|GITHUB)_/.test(name) && process.env[name] && !known.has(name),
  );
  return [...named, ...extra];
}

function summarizeDoctorEnv(name, value, { home = homedir() } = {}) {
  if (!value) return NOT_SET;
  if (name === "NO_PROXY") {
    const entries = String(value).split(",").map((entry) => entry.trim()).filter(Boolean).length;
    return `set (${entries} ${entries === 1 ? "entry" : "entries"})`;
  }
  if (name === "GH_CONFIG_DIR") {
    const text = String(value);
    const prefix = `${home}/`;
    return text === home ? "~" : text.startsWith(prefix) ? `~/${text.slice(prefix.length)}` : `…/${text.split(/[\\/]/).filter(Boolean).at(-1) ?? "gh"}`;
  }
  return String(value);
}

// Presence-only is the DEFAULT; printing a value is the opt-in, and the opt-in
// list is curated above. This was the other way round -- print unless the *name*
// ended in _TOKEN/_SECRET/_PASSWORD/_KEY -- which meant the discovery loop above
// harvested variables nobody had reviewed and printed them in full. Verified
// leaks under the old rule: GH_APP_PEM (a whole RSA private key), GITHUB_OAUTH,
// GITHUB_PAT, GH_COOKIE, GH_CREDENTIALS. redact() only catches GitHub *token*
// shapes, so anything else sailed through. This report is advertised as safe to
// paste into a bug report, so the failure mode has to be a less useful line, not
// a disclosed credential.
function envValue(name) {
  const value = process.env[name];
  if (!value) return NOT_SET;
  if (DOCTOR_ENV_PROXY.includes(name)) return proxySummary(value);
  if (DOCTOR_ENV_PLAIN.includes(name)) return summarizeDoctorEnv(name, value);
  return "set";
}

// gh writes some of this to stdout and some to stderr depending on version and
// on whether it succeeded, and a non-zero exit is itself worth reporting rather
// than throwing. Both streams, whatever happened.
async function captureGh(args, operation) {
  try {
    return (await runGh(args, { operation })).trim();
  } catch (err) {
    const both = `${err?.stdout ?? ""}${err?.stderr ?? ""}`.trim();
    return both || shortErr(err);
  }
}

const PROBE_STDERR_LIMIT = 400;

async function probe(name, args, operation, input = null) {
  const startedAt = Date.now();
  // A declared local prerequisite the run cannot satisfy is reported, not
  // attempted: starting a request whose document cannot be built would spend a
  // reservation to receive a GraphQL error that says nothing about the tenant.
  if (input === UNRESOLVED_REPOSITORY) {
    return { name, args, ms: 0, failed: true, stderr: UNRESOLVED_REPOSITORY, http: null, classified: "unavailable" };
  }
  try {
    const stdout = await runGh(args, { operation, input });
    return { name, args, ms: Date.now() - startedAt, bytes: stdout.length, classified: "ok" };
  } catch (err) {
    return {
      name,
      args,
      ms: Date.now() - startedAt,
      failed: true,
      // Bodies are never included, only sizes -- and a failing endpoint's stderr
      // is the one place the verbatim tenant message can be captured, which is
      // the reason this command exists.
      stderr: String(err?.stderr ?? "").trim().slice(0, PROBE_STDERR_LIMIT),
      http: /HTTP (\d{3})/.exec(errText(err))?.[1] ?? null,
      classified: classify(err),
    };
  }
}

const DOCTOR_LABEL_WIDTH = 18;
const PROBE_LABEL_WIDTH = 12;

// The underline is derived rather than typed, so renaming a heading cannot
// leave a rule that is the wrong length underneath it.
function section(title) {
  return [title, "-".repeat(title.length)];
}

// A label longer than its column (GH_GLANCE_NO_ANIMATION, GH_ENTERPRISE_TOKEN)
// would otherwise butt straight against its value with no separator at all,
// which is unreadable exactly where the report is being skim-read for a
// "set" / "not set".
function field(label, value, width = DOCTOR_LABEL_WIDTH) {
  return label.length < width ? `${label.padEnd(width)}${value}` : `${label}  ${value}`;
}

async function gitRemote() {
  try {
    const { stdout } = await execFileAsync("git", ["remote", "get-url", "origin"], {
      timeout: GH_TIMEOUT_MS,
    });
    return stdout.trim() || "(no origin remote)";
  } catch {
    return "not a git repository (or no origin remote)";
  }
}

async function gitRemoteUrls() {
  try {
    const { stdout } = await execFileAsync("git", ["remote"], { timeout: GH_TIMEOUT_MS });
    const names = stdout.split(/\r?\n/).map((name) => name.trim()).filter(Boolean);
    const settled = await Promise.allSettled(names.map(async (name) => {
      const result = await execFileAsync("git", ["remote", "get-url", "--all", name], {
        timeout: GH_TIMEOUT_MS,
      });
      return result.stdout.split(/\r?\n/).map((url) => url.trim()).filter(Boolean);
    }));
    return settled.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  } catch {
    return [];
  }
}

function targetSource() {
  if (runtime.repo) return "flag";
  if (process.env.GH_REPO) return "GH_REPO";
  return "git remote (or none, if this is not a checkout)";
}

// How much of the hourly API budget is left, and roughly how fast this
// configuration spends it. The steady-state cost is not small and was invisible:
// at the default 5s refresh with the Security tab open the safe projection is
// around 4,440 REST requests an hour -- about 89% of a personal token's 5,000 --
// because a full newest page activates bounded priority lanes. `--refresh 2`
// projects past the limit outright, so it exhausts inside the hour, every hour.
// The budget is shared with everything else the token does, so the first symptom
// is usually "GitHub is broken" somewhere else entirely.
//
// `gh api rate_limit` is documented as not counting against the limit, and it
// measures as free (verified: delta 0), so this is safe to run on a diagnostic
// path. GHES tenants can be configured with a different ceiling, which is
// exactly why this reports the server's own numbers rather than asserting 5,000.
// The claimed GraphQL observer, and the only source of spendable GraphQL
// capacity. `/rate_limit` used to supply this number for free, but a counter
// obtained for free is not authority: it is another endpoint's view of the
// meter, it can lag behind the spend it is meant to bound, and it can never
// report what a particular query actually cost. This query costs a point and
// says exactly what it cost, which is what makes it reconcilable.
async function readGraphqlObserver(signal, host = effectiveRuntimeHost(), {
  fetchPage = fetchGraphqlPage,
} = {}) {
  const page = await fetchPage("observer", { signal, operation: "graphql-observer", host, variables: {} });
  const observed = page.observations[0];
  if (!observed || observed.resource !== "graphql") return null;
  return {
    budget: { remaining: observed.remaining, limit: observed.limit, used: observed.used, resetMs: observed.resetMs },
    receivedAt: observed.receivedAt,
    cost: page.observedCost,
  };
}

// Report data only, and explicitly not authority: it is left available because
// a diagnostic that can contradict the observer is useful evidence, and pinned
// as non-authoritative so it can never be mistaken for spendable capacity.
async function readRateLimitResources(signal, host = effectiveRuntimeHost()) {
  const raw = await runGh(["api", "rate_limit", ...apiHostArgs(host)], {
    signal,
    operation: "rate-limit",
  });
  return JSON.parse(raw)?.resources;
}

async function rateBudget(preloadedResources = null) {
  try {
    // Host-routed like every other `gh api` call: a budget is per token *per
    // server*, so on a GHES tenant the github.com numbers are not merely stale,
    // they belong to a different limit entirely.
    const resources = normalizeRateBudgets(preloadedResources ?? await readRateLimitResources());
    // formatAge() is for timestamps in the past and returns "-" for a future one,
    // so the reset is rendered as a forward interval instead.
    const fmt = (r) => {
      if (!r) return "(absent)";
      const inMs = r.resetMs - Date.now();
      const resets = inMs > 0 ? `resets in ${formatDuration(inMs)}` : "reset due";
      return `${r.remaining}/${r.limit} left, ${resets}`;
    };
    return { core: fmt(resources?.core), graphql: fmt(resources?.graphql) };
  } catch (err) {
    return { core: `unavailable (${shortErr(err)})`, graphql: "unavailable" };
  }
}

// The same probe as rateBudget, but returning both resources as protocol data.
// rateBudget keeps its display shape for the --doctor path, where strings are
// the product.
//
// Safe to run on a timer for the same reason it is safe on the diagnostic path:
// `gh api rate_limit` is documented as not counting against the limit, and it
// measures as free (verified: delta 0).
function normalizeRateBudget(resource) {
  if (
    !resource ||
    !Number.isFinite(resource.remaining) ||
    !Number.isFinite(resource.limit) ||
    !Number.isFinite(resource.used) ||
    !Number.isFinite(resource.reset)
  ) {
    return null;
  }
  return {
    remaining: resource.remaining,
    limit: resource.limit,
    used: resource.used,
    resetMs: resource.reset * 1000,
  };
}

function normalizeRateBudgets(resources) {
  return Object.fromEntries(RATE_RESOURCES.map((resource) => [
    resource,
    normalizeRateBudget(resources?.[resource]),
  ]));
}

async function readCoreBudget(signal, host = effectiveRuntimeHost(), etag = null) {
  try {
    const response = await ghApi(["user", ...apiHostArgs(host)], {
      signal,
      operation: "budget-core-observer",
      etag,
    });
    if (response.rateLimit?.resource !== "core") return null;
    return {
      budget: response.rateLimit,
      etag: response.etag ?? etag,
      receivedAt: Date.now(),
    };
  } catch (error) {
    const status = error?.apiResponse?.status;
    const rateLimit = pickRateLimit(error?.apiResponse?.headers);
    if (![403, 429].includes(status) || rateLimit?.resource !== "core") return null;
    return {
      budget: rateLimit,
      etag: error.apiResponse.headers.etag ?? etag,
      receivedAt: Date.now(),
      blocked: true,
    };
  }
}

async function readSharedBudgetSources(signal, host = effectiveRuntimeHost(), {
  resources = RATE_RESOURCES,
  coreEtag = null,
  renewClaim = null,
  readGraphql = readGraphqlObserver,
  readCore = readCoreBudget,
} = {}) {
  const result = {};
  if (resources.includes("graphql")) {
    const observed = await readGraphql(signal, host).catch(() => null);
    if (!observed?.budget) return null;
    result.graphql = observed;
  }
  if (resources.includes("core")) {
    // Each gh command is independently bounded, but two sequential commands can
    // outlive one claim. Extend the same nonce between the two observers. The
    // GraphQL read is no longer the free one -- it costs a point of its own now
    // -- so this renewal separates two charged requests, not a free one from a
    // charged one.
    if (resources.includes("graphql") && typeof renewClaim === "function" && !await renewClaim()) return null;
    const core = await readCore(signal, host, coreEtag);
    if (core) result.core = core;
  }
  return Object.keys(result).length > 0 ? result : null;
}

// Conservative unpaced demand at this configuration's floor, derived from the
// same constants the scheduler uses rather than from a number written down once
// and left to rot. The governor can admit less demand; this projection explains
// pressure, not actual granted spend. The per-fetch prices come from
// REST_PER_FETCH and GRAPHQL_PER_FETCH, which also feed the operation registry.
function projectedHourlyCost(activeKey, {
  floorMs = runtime.refreshMs,
  background = runtime.background,
} = {}) {
  const perHour = (intervalMs) =>
    Number.isFinite(intervalMs) && intervalMs > 0 ? 3_600_000 / intervalMs : 0;
  const totals = { rest: { min: 0, max: 0 }, graphql: { min: 0, max: 0 } };
  for (const tab of TAB_KEYS) {
    const demand = tab === activeKey ? "active" : "inactive";
    // Fastest: nothing has been observed unchanged yet, and Actions has work in
    // flight. Slowest: the quiet cadence this tab settles into.
    const fastest = pollPolicyInterval({
      tab, floorMs, demand, unchangedCount: 0, inProgressCI: true, background,
    });
    const slowest = pollPolicyInterval({
      tab, floorMs, demand, unchangedCount: POLL_QUIET_AFTER, background,
    });
    totals.rest.min += REST_PER_FETCH[tab] * perHour(slowest);
    totals.rest.max += REST_PER_FETCH[tab] * perHour(fastest);
    totals.graphql.min += GRAPHQL_PER_FETCH[tab] * perHour(slowest);
    totals.graphql.max += GRAPHQL_PER_FETCH[tab] * perHour(fastest);
  }
  return {
    rest: { min: Math.round(totals.rest.min), max: Math.round(totals.rest.max) },
    graphql: { min: Math.round(totals.graphql.min), max: Math.round(totals.graphql.max) },
  };
}

function formatProjectedRange({ min, max }) {
  return min === max ? `~${max}` : `~${min}-${max}`;
}

function doctorProbePlan() {
  // GraphQL cannot infer a repository the way `gh` does, so a report run from a
  // directory with no unambiguous remote says so per probe instead of sending a
  // document with a missing variable and reporting the resulting error as if it
  // came from the server.
  const target = effectiveRuntimeRepository();
  const document = (kind, variables) => (variables ? graphqlInput(kind, variables) : UNRESOLVED_REPOSITORY);
  return [
    // Every probe is now an explicit request whose cost is declared. The old
    // Issues/PRs entries ran `gh issue list`/`gh pr list`, whose `--search`
    // routed through GraphQL at a price the report could not name.
    ["Repository access", graphqlArgs(), "doctor:repository", document("repository", graphqlRepositoryVariables(target)), "repository"],
    ["Actions runs", ghApiArgs(actionsRunsArgs()), "doctor:actions-runs"],
    ["Actions workflows", ghApiArgs(actionsWorkflowsArgs()), "doctor:actions-workflows"],
    ["Issues (first page)", graphqlArgs(), "doctor:issues", document("issues", graphqlPageVariables(null, target)), "issues"],
    ["Pull requests (first page)", graphqlArgs(), "doctor:prs", document("prs", graphqlPageVariables(null, target)), "prs"],
    ...ALERT_SOURCES.flatMap((source) =>
      alertRequestArgs(source).map((args, index) => [
        index === 0 ? source.name : `${source.name} (priority ${index})`,
        ghApiArgs(args),
        "doctor:security-endpoint",
      ]),
    ),
  ];
}

async function mapAllSettledBounded(items, limit, map) {
  const settled = Array(items.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      [settled[index]] = await Promise.allSettled([map(items[index], index)]);
    }
  };
  await Promise.allSettled(Array.from(
    { length: Math.min(Math.max(1, limit), items.length) },
    () => worker(),
  ));
  return settled;
}

function skippedDoctorProbe(name, args, admitted) {
  return {
    name,
    args,
    skipped: true,
    classified: "skipped",
    skipReason: admitted?.value?.resetMs
      ? `budget paused; reset ${new Date(admitted.value.resetMs).toISOString()}`
      : admitted?.value?.notBefore
        ? `next safe slot ${new Date(admitted.value.notBefore).toISOString()}`
        : "budget unavailable",
  };
}

async function runDoctor() {
  // A live backoff would make an alert probe silently skip and report nothing,
  // which is the opposite of what a diagnostic run is for.
  alertBackoff.clear();

  const probes = doctorProbePlan();

  // Free checks run first. The display rate_limit read is report data only;
  // admission re-reads its GraphQL source after owning the shared claim.
  const [ghVersion, remote, remoteUrls] = await Promise.all([
    captureGh(["--version"], "version"),
    gitRemote(),
    gitRemoteUrls(),
  ]);
  const effectiveHost = effectiveRuntimeHost({ remoteUrls });
  runtimeIdentityCoordinator = createIdentityCoordinator({ host: effectiveHost });
  const verified = await runtimeIdentityCoordinator.refresh();
  const verifiedIdentity = runtimeIdentityCoordinator.current();
  const authStatus = verifiedIdentity
    ? `${verifiedIdentity.host}: ${verifiedIdentity.login} (verified)`
    : runtimeHasNoRepositoryTarget(remoteUrls) ? NO_REPOSITORY_TARGET_REPORT : identityCoordinationMessage(verified.reason);
  const resources = verifiedIdentity ? await readRateLimitResources(undefined, effectiveHost).catch(() => null) : null;
  const budget = resources
    ? await rateBudget(resources)
    : { core: "unavailable", graphql: "unavailable" };
  const scopeResult = verifiedIdentity
    ? { ok: true, value: createQuotaScope(verifiedIdentity, { root: runtimeIdentityCoordinator.root, identityProvider: runtimeIdentityCoordinator.current }) }
    : verified;
  let governorResult = scopeResult;
  let results = [];
  if (scopeResult.ok) {
    const scope = scopeResult.value;
    const leaseId = governorId();
    const nowMs = Date.now();
    const registered = registerLease(scope, {
      id: leaseId,
      expiresAt: nowMs + GOVERNOR_LEASE_TTL_MS,
      floorMs: runtime.refreshMs,
      activeTab: "actions",
      phaseSeed: { seed: leaseId, registeredAt: nowMs },
      demand: { core: 6, graphql: 2 },
    });
    try {
      if (registered.ok) await refreshSharedBudget(scope, leaseId, undefined);
      const admissionAt = Date.now();
      const admittedProbes = probes.map(([name, args, operation, input = null, document = null], index) => {
        const admitted = registered.ok
          ? admitGovernorOperation(scope, leaseId, operation, "diagnostic", admissionAt)
          : registered;
        if (!admitted?.ok || admitted.value.status !== "started") {
          return { index, skipped: { ...skippedDoctorProbe(name, args, admitted), ...(document ? { document } : {}) } };
        }
        return { index, name, args, operation, input, document, reservationId: admitted.value.reservationId };
      });
      results = admittedProbes.map((item) => item.skipped ?? null);
      const runnable = admittedProbes.filter((item) => !item.skipped);
      const settled = await mapAllSettledBounded(runnable, 4, async (item) => {
        const result = await requestIdentityStorage.run(scope, () => probe(item.name, item.args, item.operation, item.input));
        if (item.document) result.document = item.document;
        completeReservation({ ...scope, identityProvider: null }, item.reservationId, result.failed
          ? { outcome: "rejected" }
          : { outcome: "measured-success", actualCost: operationCost(item.operation) }, Date.now());
        return result;
      });
      settled.forEach((outcome, index) => {
        const item = runnable[index];
        results[item.index] = outcome.status === "fulfilled"
          ? outcome.value
          : {
            name: item.name,
            args: item.args,
            failed: true,
            classified: "other",
            stderr: shortErr(outcome.reason),
          };
      });
    } finally {
      const cleanup = { ...scope, identityProvider: null };
      releaseLease(cleanup, leaseId);
      governorResult = inspectGovernor(cleanup, Date.now());
    }
  }
  const governor = governorHealth(governorResult, Date.now());

  const lines = [
    "gh-glance doctor",
    "================",
    field("gh-glance", version),
    field("node", `${process.version}  ${process.platform}/${process.arch}`),
    field("gh", ghVersion.split("\n")[0] || "NOT FOUND"),
    "",
    ...section("Authenticated hosts"),
    authStatus || "(no output)",
    "",
    ...section("Repository target"),
    field("source", targetSource()),
    field("host", effectiveHost ?? "(unresolved)"),
    field("slug", runtime.repo ?? "(inferred from the working directory)"),
    field("git remote", remote),
    "",
    // Labelled, because these two numbers come from `gh api rate_limit`, which
    // this version treats as a diagnostic and never as spendable capacity. The
    // "API governor" section below carries the numbers actually admitted
    // against, with their provenance. A reader who cannot tell the two apart
    // will believe the wrong one.
    ...section("API budget (rate_limit, non-authoritative)"),
    field("REST core", budget.core),
    field("GraphQL", budget.graphql),
    field(
      "projected demand",
      (() => {
        const active = TAB_KEYS[runtime.initialTabIndex] ?? TAB_KEYS[0];
        const { rest, graphql } = projectedHourlyCost(active);
        // A range, because the cadence now depends on what the repository is
        // doing. Labelled "projected" rather than "spends": the governor admits
        // less than this, and the API governor section below carries what was
        // actually charged.
        return `${formatProjectedRange(rest)} REST + ${formatProjectedRange(graphql)} GraphQL per hour ` +
          `(floor ${runtime.refreshMs / 1000}s, background ${runtime.background}, "${active}" active)`;
      })(),
    ),
    "",
    ...section("API governor"),
    field("status", governor.status),
    field("live leases", governor.leases),
    ...RATE_RESOURCES.map((resource) => {
      const detail = governor.resources[resource];
      return field(
        resource,
        detail
          ? `${detail.remaining} remaining, ${detail.reserve} reserved, reset ${new Date(detail.resetMs).toISOString()} (${detail.source})`
          : "unavailable",
      );
    }),
    "",
    ...section("Environment"),
    ...doctorEnvNames().map((name) => field(name, envValue(name))),
    "",
    ...section("Endpoint probes"),
  ];

  const probeLine = (label, value) => lines.push(`  ${field(label, value, PROBE_LABEL_WIDTH)}`);
  for (const result of results) {
    lines.push(`  ${result.name}`);
    probeLine("argv", `gh ${result.args.join(" ")}`);
    // Three GraphQL probes share one argv, and the document that distinguishes
    // them travels on stdin. A report that cannot say which query it sent is
    // exactly the drift this command exists to rule out.
    if (result.document) probeLine("document", result.document);
    probeLine(
      "outcome",
      result.skipped
        ? `SKIPPED (${result.skipReason})`
        : result.failed ? `FAILED in ${result.ms}ms` : `ok ${result.bytes}B in ${result.ms}ms`,
    );
    if (result.http) probeLine("http", result.http);
    probeLine("classified", result.classified);
    if (result.stderr) probeLine("stderr", result.stderr);
    lines.push("");
  }

  // The single redaction boundary. Everything above may have captured a token,
  // a proxy credential or a URL with userinfo; nothing above is responsible for
  // removing it.
  return redact(lines.join("\n"));
}

// ---------- Command line ----------

// The repository name is the only user-supplied value that reaches a subprocess
// argument *and* gets interpolated into a `gh api` path. execFile with an array
// means there is no shell to inject into, but an unvalidated value in the API
// path would be a request-forgery primitive against arbitrary endpoints -- so it
// is validated once, here at the boundary, against exactly what GitHub allows in
// an owner or repository name.
//
// The name half requires at least one character that is not a dot. Without that
// it accepted `owner/..`, which `apiPath()` spliced into
// `repos/owner/../dependabot/alerts` -- and gh forwards the dot segment
// unnormalized, so GitHub resolves it server-side to a *different endpoint*
// (verified: it lands on Get-a-repository). The value is operator-supplied, so
// this was never a cross-user vulnerability, but it broke the one invariant the
// comment above claims. A trailing `.git` is rejected for the same reason: it is
// not a name GitHub issues, so accepting it can only mean someone pasted a clone
// URL's tail. Names that merely *contain* or *start with* a dot stay valid --
// `owner/.github` and `owner/docs.example.com` are both real.
const REPO_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?\/(?=[A-Za-z0-9._-]*[A-Za-z0-9_-])(?!.*\.git$)[A-Za-z0-9._-]+$/;

// A dot is mandatory, and that is the safety property rather than a nicety.
// Without it "owner/name/extra" -- already in the hostile-input list -- would
// stop being a rejected typo and quietly become "the repo name/extra on the
// host named owner", i.e. a slip of the finger turning into a request to
// somewhere else entirely. With it, every value in that list stays rejected.
// Labels may not start or end with a hyphen and the string may not have an
// empty, leading or trailing label, which is what rules out "-bad.host",
// "host..com" and "host.com.".
const HOST_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

const repoMessage = (value) => `--repo must look like owner/name or host/owner/name, got: ${value}`;

// `gh` itself accepts [HOST/]OWNER/REPO for --repo and GH_REPO; this accepts
// the same shape and splits it into the two things that are used differently --
// the slug, which is interpolated into a `gh api` path, and the host, which
// never is. REPO_PATTERN keeps its exact meaning: it validates the owner/name
// half, here as before.
function parseRepoTarget(value) {
  const parts = String(value).split("/");
  let host = null;
  let slug;
  if (parts.length === 3 && HOST_PATTERN.test(parts[0])) {
    host = parts[0];
    slug = `${parts[1]}/${parts[2]}`;
  } else if (parts.length === 2) {
    slug = String(value);
  } else {
    throw new Error(repoMessage(value));
  }
  if (!REPO_PATTERN.test(slug)) throw new Error(repoMessage(value));
  return { host, slug };
}

// Below roughly two seconds a fetch cannot finish before the next tick, so the
// in-flight guard absorbs every other one and the effective rate is whatever
// `gh` can sustain -- the requested interval silently stops being real. Clamping
// with a stated minimum is honest where silently accepting it would not be.
const BACKGROUND_MODES = ["all", "off"];
const MIN_REFRESH_SECONDS = 2;
const MAX_REFRESH_SECONDS = 3600;

// The argv surface was a strict allowlist that exited 2 on anything unknown.
// That is a feature, not an accident -- a typo fails loudly instead of being
// ignored -- so widening it keeps the same shape: every flag is named here, and
// anything else still exits 2.
function parseArgs(argv) {
  const opts = {
    help: false,
    showVersion: false,
    doctor: false,
    repo: null,
    refresh: null,
    // Which surface supplied `refresh`, so validateArgs can name it in the
    // bounds messages. argv never sets it -- the entry block does, when it
    // falls back to GH_GLANCE_REFRESH -- but it is declared here so the shape
    // parseArgs returns stays stated in one place.
    refreshSource: null,
    tab: null,
    // Whether inactive tabs are polled at all. `off` never requests data for a
    // tab you are not looking at; its counts stay at whatever was last known,
    // visibly aged.
    background: null,
    verbose: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const takeValue = (name) => {
      const inline = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : null;
      if (inline !== null) return inline;
      i += 1;
      if (i >= argv.length) throw new Error(`${name} needs a value`);
      return argv[i];
    };

    // No `-v`. It used to mean --version, which is the conventional reading, but
    // this CLI also has --verbose -- so `gh-glance -v 2>log`, which is what you
    // type when you want the log, printed a version string and exited 0. That is
    // the one argv path that failed quietly in a surface built to fail loudly.
    // Unknown now, so it exits 2 and points at --help.
    if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg === "--version") opts.showVersion = true;
    else if (arg === "--verbose") opts.verbose = true;
    else if (arg === "--doctor") opts.doctor = true;
    else if (arg === "--repo" || arg === "-R" || arg.startsWith("--repo=")) {
      opts.repo = takeValue("--repo");
    } else if (arg === "--refresh" || arg.startsWith("--refresh=")) {
      opts.refresh = takeValue("--refresh");
    } else if (arg === "--tab" || arg.startsWith("--tab=")) {
      opts.tab = takeValue("--tab");
    } else if (arg === "--background" || arg.startsWith("--background=")) {
      opts.background = takeValue("--background");
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

// Returns { repo, refreshMs, tabKey, background, verbose } or throws with a message that
// says what to do about it.
function validateArgs(opts, tabKeys) {
  const { host, slug } = opts.repo !== null ? parseRepoTarget(opts.repo) : { host: null, slug: null };

  let refreshMs = null;
  if (opts.refresh !== null) {
    // Named so the message points at whichever surface supplied the value: the
    // interval can now come from GH_GLANCE_REFRESH as well as --refresh.
    const refreshLabel = opts.refreshSource ?? "--refresh";
    const seconds = Number(opts.refresh);
    if (!Number.isFinite(seconds) || !Number.isInteger(seconds)) {
      throw new Error(`${refreshLabel} must be a whole number of seconds, got: ${opts.refresh}`);
    }
    if (seconds < MIN_REFRESH_SECONDS || seconds > MAX_REFRESH_SECONDS) {
      throw new Error(
        `${refreshLabel} must be between ${MIN_REFRESH_SECONDS} and ${MAX_REFRESH_SECONDS} seconds, got: ${seconds}`,
      );
    }
    refreshMs = seconds * 1000;
  }

  if (opts.tab !== null && !tabKeys.includes(opts.tab)) {
    throw new Error(`--tab must be one of ${tabKeys.join(", ")}, got: ${opts.tab}`);
  }

  if (opts.background !== null && !BACKGROUND_MODES.includes(opts.background)) {
    throw new Error(`--background must be one of ${BACKGROUND_MODES.join(", ")}, got: ${opts.background}`);
  }

  return {
    help: opts.help,
    showVersion: opts.showVersion,
    doctor: opts.doctor,
    repo: slug,
    host,
    refreshMs,
    tabKey: opts.tab,
    background: opts.background,
    verbose: opts.verbose,
  };
}

// ---------- Entry point ----------

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

// The one key table. --help renders it, the `?` overlay renders it, and the
// status bar's KEY_HINTS is the deliberately short subset of it -- so a binding
// added in one place cannot go missing from the others, which is the same rule
// this file already applies to argv vectors and to classify().
const KEY_TABLE = [
  ["1 2 3 4", "Actions / Issues / Pull requests / Security"],
  ["Left / Right", "Previous / next tab"],
  ["Tab / Shift+Tab", "Next / previous tab"],
  ["Up / Down, j / k", "Move the cursor between rows"],
  ["PgUp / PgDn", "Move a page at a time"],
  ["Enter", "Open the selected item or accept a prompt"],
  ["r", "Refresh the current tab when a safe grant is available"],
  ["R", "Resynchronize the current tab, ignoring cached validators and backoff"],
  ["w", "Adjust table column widths"],
  ["?", "Show the keys (any key closes it)"],
  ["q / Esc / Ctrl+C", "Quit (Esc leaves width mode)"],
];
const KEY_COL = Math.max(...KEY_TABLE.map(([k]) => k.length)) + 3;
const keyTableLines = () => KEY_TABLE.map(([k, d]) => `${k.padEnd(KEY_COL)}${d}`);

// Which bindings survive a short pane, most important first. Named rather than
// indexed into KEY_TABLE: the order used to be a list of positions, so adding a
// key silently reassigned every entry after it -- which is exactly how `R`
// pushed Quit out of the four-row overlay.
const HELP_PRIORITY = [
  "q / Esc / Ctrl+C",
  "r",
  "Enter",
  "Up / Down, j / k",
  "1 2 3 4",
  "w",
  "?",
  "Left / Right",
  "Tab / Shift+Tab",
  "PgUp / PgDn",
  "R",
];

function helpLines(maxRows) {
  const rows = Math.max(1, Number.isSafeInteger(maxRows) ? maxRows : 1);
  const all = keyTableLines();
  const lineFor = (binding) => all[KEY_TABLE.findIndex(([key]) => key === binding)];
  if (all.length <= rows) return all;
  if (rows === 1) return [`… ${all.length} keys: gh-glance --help`];
  if (rows === 4) {
    return [
      lineFor("q / Esc / Ctrl+C"),
      lineFor("r"),
      "Ent/jk Open the selected/Move the cursor",
      `… ${all.length - 4} more: gh-glance --help`,
    ];
  }
  const priority = HELP_PRIORITY.slice(0, rows - 1).map(lineFor);
  return [...priority, `… ${all.length - priority.length} more: gh-glance --help`];
}

const HELP = `gh-glance ${version} -- a live-refreshing GitHub dashboard for a narrow terminal pane.

Usage:
  gh-glance                     Run the dashboard in the current repository
  gh-glance --repo owner/name   Watch a specific repository instead
  gh-glance --refresh 15        Set a 15-second active-tab poll floor
  gh-glance --tab security      Start on a specific tab
  gh-glance --background off    Poll only the tab you are looking at
  gh-glance --verbose 2>log     Log every gh call to a file (see below)
  gh-glance --doctor            Print a diagnostic report and exit
  gh-glance --help              Show this help
  gh-glance --version           Show the version

Options:
  -R, --repo [host/]owner/name
                           Repository to watch. Without it the repo is inferred
                           from the git remote, the same way \`gh\` does it. The
                           host form targets a GitHub Enterprise or EMU
                           data-residency tenant (e.g. tenant.ghe.com/acme/api)
                           and is unnecessary when running inside a clone of
                           that repository.
  --refresh <seconds>      Minimum active-tab poll interval (${MIN_REFRESH_SECONDS}-${MAX_REFRESH_SECONDS},
                           default ${REFRESH_MS / 1000}). A floor, never a ceiling:
                           a quiet tab slows to ${POLL_QUIET_MS.actions / 1000}s (${POLL_QUIET_MS.security / 1000}s for Security),
                           and running Actions are checked every ${POLL_ACTIVE_CI_MS / 1000}s.
                           Safe shared grants may run later.
  --tab <name>             Tab to start on: ${TAB_KEYS.join(", ")}.
  --background <mode>      ${BACKGROUND_MODES.join(" or ")} (default all). \`off\` never requests data
                           for a tab you are not looking at; its count stays at
                           the last known value and visibly ages.
  --verbose                Write one line per gh invocation to stderr. stderr
                           must be redirected -- writing it to the terminal
                           would draw over the dashboard, so this refuses to
                           start otherwise.
  --doctor                 Gather versions, authenticated hosts, the resolved
                           repo target, API governor health and one safely
                           admitted probe per endpoint, then exit.
                           Safe to redirect to a file and share -- tokens are
                           never printed, proxy credentials are stripped, and
                           no response bodies are included.

Run it from inside a locally cloned GitHub repository; the repo is inferred
from the git remote, the same way \`gh\` does it. Requires the \`gh\` CLI
(2.20 or newer), authenticated via \`gh auth login\`.

On a healthy single pane, the active tab is considered every ${REFRESH_MS / 1000}s while its
content is changing, then every ${POLL_QUIET_MS.actions / 1000}s once two checks in a row come back
unchanged; each background tab is considered about every ${Math.max(REFRESH_MS * BACKGROUND_EVERY, POLL_BACKGROUND_MS.actions) / 1000}s. Quota-consuming
calls still need a shared, resource-specific grant that preserves a hard reserve.
Scheduled checks and manual refresh do not bypass that safety check: neither
refresh key can spend past the reserve.

Row icons are GitHub Octicons and need a Nerd Font. Without one, set
GH_GLANCE_ICONS=unicode for Unicode status glyphs and text row substitutes, or
GH_GLANCE_ICONS=ascii for ASCII-only status and row icons.

Keys:
${keyTableLines()
  .map((line) => `  ${line}`)
  .join("\n")}

The cursor clears itself after 60s with no movement.

Environment:
  GH_REPO=[host/]owner/name Watch a specific repository (--repo takes precedence)
  GH_HOST=host              GitHub Enterprise or EMU host for every call and
                            its account governor. A qualified GH_REPO also
                            supplies the host; an unqualified one means github.com.
  GH_GLANCE_REFRESH=<seconds>
                            Minimum active-tab poll interval, ${MIN_REFRESH_SECONDS}-${MAX_REFRESH_SECONDS};
                            safe shared grants may run later
                            (--refresh takes precedence)
  GH_GLANCE_ICONS=unicode   Unicode status glyphs and text row substitutes
  GH_GLANCE_ICONS=ascii     ASCII-only status and row icons
  GH_GLANCE_NO_ANIMATION=1  Stop motion; semantic status words remain
  NO_COLOR=1                Disable colour (status stays readable)
  INK_SCREEN_READER=true    Linear, unthrottled rendering (unverified -- see README)
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
    const argvOpts = parseArgs(process.argv.slice(2));
    // The flag wins, which is the precedence GH_REPO already advertises -- but
    // not its mechanism: GH_REPO is read at each use site, because `gh` honours
    // it natively and a repo slug needs no validation. An interval does, so it
    // is resolved once, here, and substituted before validation -- an
    // out-of-range GH_GLANCE_REFRESH is then refused by the same two messages
    // an out-of-range --refresh gets, rather than by a second copy of the
    // bounds. It still reaches runtime through the one write site below rather
    // than being assigned beside it.
    if (argvOpts.refresh === null && process.env.GH_GLANCE_REFRESH) {
      argvOpts.refresh = process.env.GH_GLANCE_REFRESH;
      argvOpts.refreshSource = "GH_GLANCE_REFRESH";
    }
    opts = validateArgs(argvOpts, TAB_KEYS);
  } catch (err) {
    // Exit 2 for every argv problem, unchanged from when the only possible
    // problem was an unrecognised flag. CI asserts this code.
    console.error(`gh-glance: ${err.message}\nRun \`gh-glance --help\` for usage.`);
    process.exit(2);
  }

  // One place argv becomes runtime state. It used to be two -- the --doctor
  // branch set repo and host, the dashboard path set all five -- and they had
  // already drifted: `--doctor --verbose` was accepted and silently dropped, so
  // the one flag that shows what was actually sent to gh did nothing on the one
  // command built to explain what gh-glance is doing. Same for --refresh and
  // --tab. Applying everything up front cannot corrupt the doctor path, which
  // never renders with ink; the --verbose TTY refusal below stays *below* the
  // doctor branch on purpose, since that combination is useful and harmless.
  runtime.repo = opts.repo;
  runtime.host = opts.host;
  runtime.repoExplicit = opts.repo !== null;
  runtime.verbose = opts.verbose;
  if (opts.refreshMs !== null) runtime.refreshMs = opts.refreshMs;
  if (opts.tabKey !== null) runtime.initialTabIndex = TAB_KEYS.indexOf(opts.tabKey);
  if (opts.background !== null) runtime.background = opts.background;

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

  // A reporting command, like --help and --version: gather, print, exit. It sits
  // here on purpose -- ahead of the non-TTY refusal, because the whole point is
  // `gh-glance --doctor > report.txt`, and ahead of preflight(), because a
  // missing gh and a cwd outside a repository are exactly the conditions worth
  // reporting rather than exiting 3 over.
  if (opts.doctor) {
    console.log(await runDoctor());
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
  runtimeRemoteUrls = await gitRemoteUrls();
  runtimeIdentityCoordinator = createIdentityCoordinator({ host: () => effectiveRuntimeHost() });
  // Resolve warm identity/cache locally; cold proof belongs to the mounted UI
  // so quit/signal handling remains available while GitHub is slow.
  //
  // Bounded, because the warm path still spawns `gh auth token`: a prompting
  // credential helper, a keyring daemon that is not up yet in a fresh login
  // session, or a cold binary on a network filesystem would otherwise hold the
  // first frame for the full subprocess timeout with nothing on screen at all.
  // Past the bound the same refresh is picked up by the mounted UI, and
  // ensureScope corrects the cache target and hydrates from it.
  await Promise.race([
    runtimeIdentityCoordinator.refresh({ allowBootstrap: false }),
    new Promise((resolve) => { setTimeout(resolve, WARM_IDENTITY_WAIT_MS).unref(); }),
  ]);
}

const ReactModule = await import("react");
const { render, measureElement, Box, Text, useStdout, useInput, useStdin, useApp } = await import("ink");

const React = ReactModule.default;
const { useState, useEffect, useMemo, useRef, useCallback } = ReactModule;
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

// Whether the private-use glyphs are in play. There is no way to ask a terminal
// whether it can draw them -- the only honest probe is writing one and reading
// the cursor back, which hangs on terminals that never answer -- so instead the
// app says, once, where the escape hatch is. Without a Nerd Font every icon is a
// blank box, which reads as "this program is broken" rather than "install a
// font", and the remedy currently lives only in --help and the README: both of
// which require quitting the full-screen app you are trying to evaluate.
function normalizeIconProfile(value) {
  if (value === "unicode" || value === "ascii") return value;
  return "nerd";
}

const ICON_PROFILE = normalizeIconProfile(process.env.GH_GLANCE_ICONS);
const USING_NERD_ICONS = ICON_PROFILE === "nerd";
const OCT = USING_NERD_ICONS ? OCT_NERD : OCT_UNICODE;

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
function Column({ width, grow, children, bold, color, dim, wrap, label, marginRight = 1 }) {
  return e(
    Box,
    { width, flexGrow: grow ? 1 : 0, flexShrink: grow ? 1 : 0, marginRight },
    e(
      Text,
      { bold, color, dimColor: dim, wrap: wrap ?? "truncate-end", "aria-label": label },
      children,
    ),
  );
}

function selectionLabel(label, selected) {
  return selected ? `selected, ${label}` : label;
}

// Each descriptor still owns one gutter cell, but an adjustable column owns
// the edge that faces the flexible TITLE/SUMMARY reservoir. Fixed columns after
// the grow cell therefore use the preceding descriptor's trailing gutter;
// fixed columns before it use their own. Keeping this mapping pure lets the
// pointer phase share the exact same geometry as the visible grips.
function headerGutterKeyAt(cells, index, growIndex) {
  if (!Array.isArray(cells) || !Number.isSafeInteger(index) || index < 0 || index >= cells.length) {
    return null;
  }
  if (growIndex < 0) return null;
  if (index < growIndex) {
    return isAdjustableWidthColumn(cells[index]) ? cells[index].key : null;
  }
  return isAdjustableWidthColumn(cells[index + 1]) ? cells[index + 1].key : null;
}

function headerGutterKey(cells, index) {
  const growIndex = Array.isArray(cells)
    ? cells.findIndex((column) => column.props?.grow)
    : -1;
  return headerGutterKeyAt(cells, index, growIndex);
}

function HeaderCells({ cells, selectedWidthKey = null, headerRef = null }) {
  const growIndex = cells.findIndex((column) => column.props?.grow);
  return e(
    Box,
    {
      ref: headerRef,
      flexDirection: "row",
      borderStyle: "single",
      borderTop: false,
      borderLeft: false,
      borderRight: false,
      borderColor: BORDER_COLOR,
    },
    ...cells.flatMap((c, index) => {
      const gripKey = headerGutterKeyAt(cells, index, growIndex);
      const selected = gripKey !== null && gripKey === selectedWidthKey;
      return [
        e(
          Column,
          { key: `${c.key}:cell`, ...c.props, bold: true, dim: true, marginRight: 0 },
          c.label,
        ),
        e(
          Text,
          {
            key: `${c.key}:gutter`,
            color: selected ? TITLE_COLOR : BORDER_COLOR,
            bold: selected,
            dimColor: gripKey !== null && !selected,
            "aria-hidden": true,
          },
          gripKey === null ? " " : "│",
        ),
      ];
    }),
  );
}

const MemoHeaderCells = React.memo(HeaderCells);

function parseSgrMouse(input) {
  if (typeof input !== "string") return null;
  const match = /^\[<(\d+);(\d+);(\d+)([Mm])$/.exec(input);
  if (!match) return null;

  const code = Number(match[1]);
  const encodedX = Number(match[2]);
  const encodedY = Number(match[3]);
  if (
    !Number.isSafeInteger(code) ||
    !Number.isSafeInteger(encodedX) ||
    !Number.isSafeInteger(encodedY) ||
    encodedX < 1 ||
    encodedY < 1 ||
    (code !== 0 && code !== 32)
  ) {
    return null;
  }

  return {
    x: encodedX - 1,
    y: encodedY - 1,
    action: match[4] === "m" ? "release" : code === 32 ? "drag" : "press",
  };
}

function dividerHandles({ header, metrics }) {
  if (
    !Array.isArray(header) ||
    !metrics ||
    !Number.isSafeInteger(metrics.x) ||
    !Number.isSafeInteger(metrics.y) ||
    !Number.isSafeInteger(metrics.width) ||
    !Number.isSafeInteger(metrics.height) ||
    metrics.x < 0 ||
    metrics.y < 0 ||
    metrics.width < 1 ||
    metrics.height < 1
  ) {
    return [];
  }

  const growIndexes = header
    .map((column, index) => column.props?.grow ? index : -1)
    .filter((index) => index >= 0);
  if (growIndexes.length !== 1) return [];
  const growIndex = growIndexes[0];
  const fixedWidth = header.reduce((sum, column, index) => {
    if (index === growIndex) return sum;
    return Number.isSafeInteger(column.props?.width) && column.props.width >= 0
      ? sum + column.props.width
      : Number.NaN;
  }, 0);
  const growWidth = metrics.width - header.length - fixedWidth;
  const yEnd = metrics.y + metrics.height;
  if (!Number.isSafeInteger(growWidth) || growWidth < 0 || !Number.isSafeInteger(yEnd)) return [];

  const handles = [];
  let x = metrics.x;
  for (let index = 0; index < header.length; index += 1) {
    const contentWidth = index === growIndex ? growWidth : header[index].props.width;
    const gutterX = x + contentWidth;
    const key = headerGutterKeyAt(header, index, growIndex);
    if (key !== null) {
      const ownerIndex = index < growIndex ? index : index + 1;
      const owner = header[ownerIndex];
      if (!isAdjustableWidthColumn(owner) || owner.key !== key) return [];
      handles.push({
        key,
        x: gutterX,
        yStart: metrics.y,
        yEnd,
        width: owner.props.width,
        direction: ownerIndex < growIndex ? 1 : -1,
      });
    }
    x = gutterX + 1;
  }
  return handles;
}

function hitDivider(handles, point, tolerance = 1) {
  if (
    !Array.isArray(handles) ||
    !point ||
    !Number.isSafeInteger(point.x) ||
    !Number.isSafeInteger(point.y) ||
    !Number.isSafeInteger(tolerance) ||
    tolerance < 0
  ) {
    return null;
  }

  let nearest = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const handle of handles) {
    if (
      !Number.isSafeInteger(handle?.x) ||
      !Number.isSafeInteger(handle.yStart) ||
      !Number.isSafeInteger(handle.yEnd) ||
      point.y < handle.yStart ||
      point.y >= handle.yEnd
    ) {
      continue;
    }
    const distance = Math.abs(point.x - handle.x);
    if (
      distance <= tolerance &&
      (distance < nearestDistance ||
        (distance === nearestDistance && (nearest === null || handle.x < nearest.x)))
    ) {
      nearest = handle;
      nearestDistance = distance;
    }
  }
  return nearest;
}

function beginDividerDrag({ event, handles, tabKey, tolerance = 1 }) {
  if (event?.action !== "press" || typeof tabKey !== "string" || tabKey.length === 0) {
    return null;
  }
  const handle = hitDivider(handles, event, tolerance);
  if (!handle) return null;
  return {
    tabKey,
    key: handle.key,
    startX: event.x,
    startWidth: handle.width,
    direction: handle.direction,
  };
}

function draggedWidth({
  drag,
  event,
  tabKey,
  fullHeaderVisible,
  layoutValid = true,
}) {
  if (
    !drag ||
    event?.action !== "drag" ||
    drag.tabKey !== tabKey ||
    fullHeaderVisible !== true ||
    layoutValid !== true ||
    !Number.isSafeInteger(drag.startX) ||
    !Number.isSafeInteger(drag.startWidth) ||
    (drag.direction !== 1 && drag.direction !== -1) ||
    !Number.isSafeInteger(event.x)
  ) {
    return null;
  }
  const nextWidth = drag.startWidth + drag.direction * (event.x - drag.startX);
  return Number.isSafeInteger(nextWidth) ? { key: drag.key, nextWidth } : null;
}

function sameElementMetrics(left, right) {
  return (
    left != null &&
    right != null &&
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

function shouldEnableMouseReporting({ interactive, widthMode }) {
  return Boolean(interactive && widthMode);
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

// A plain rule under the tab bar, distinct from PanelEdge's corners so it
// reads as a separator rather than another frame. Without it the tab labels
// sat flush against the panel's top border -- readable, but dense enough that
// the two rows scanned as one.
function Divider({ width }) {
  return e(Text, { color: BORDER_COLOR, dimColor: true, "aria-hidden": true }, "─".repeat(Math.max(0, width)));
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
// inherited keys -- `SEVERITY_STYLE["constructor"]` returned a function, which
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
  { key: "status", label: "", props: { width: 3 }, adjustable: false },
  { key: "title", label: "TITLE", props: { grow: true }, adjustable: false },
  { key: "workflow", label: "WORKFLOW", props: { width: 10 }, adjustable: true, minWidth: 5 },
  { key: "branch", label: "BRANCH", props: { width: 14 }, adjustable: true, minWidth: 6 },
  { key: "time", label: "TIME", props: { width: 7 }, adjustable: true, minWidth: 5 },
  { key: "updated", label: "UPDATED", props: { width: 8 }, adjustable: true, minWidth: 6 },
];

// Dropped in order of least value first: BRANCH and WORKFLOW are inferable
// from the title far more often than the status icon or the age are.
const ACTIONS_HEADER_COMPACT = [
  { key: "status", label: "", props: { width: 3 } },
  { key: "title", label: "TITLE", props: { grow: true } },
  { key: "updated", label: "UPDATED", props: { width: 8 } },
];

function ActionsRow({ item, now, spin, compact, cursor, columns }) {
  const { icon, color, label } = runStatusIcon(item, spin);
  const started = new Date(item.startedAt);
  const finished = item.status === "completed" ? new Date(item.updatedAt) : now;
  if (compact) {
    return e(
      Box,
      { flexDirection: "row" },
      e(Column, { ...columnProps(columns, "status"), color, label: selectionLabel(label, cursor) }, `${cursor ? ">" : " "}${icon}`),
      e(Column, columnProps(columns, "title"), item.displayTitle),
      e(Column, { ...columnProps(columns, "updated"), dim: true }, formatAge(new Date(item.updatedAt), now)),
    );
  }
  return e(
    Box,
    { flexDirection: "row" },
    e(Column, { ...columnProps(columns, "status"), color, label: selectionLabel(label, cursor) }, `${cursor ? ">" : " "}${icon}`),
    e(Column, columnProps(columns, "title"), item.displayTitle),
    // The run number is the actionable half and used to be the first thing
    // truncation ate, since it sat at the tail of a 10-column cell.
    e(Column, { ...columnProps(columns, "workflow"), color: IDENTIFIER }, `#${item.number} ${item.workflowName}`),
    e(Column, { ...columnProps(columns, "branch"), color: REF, wrap: "truncate-middle" }, item.headBranch),
    e(Column, columnProps(columns, "time"), formatDuration(finished - started)),
    e(Column, { ...columnProps(columns, "updated"), dim: true }, formatAge(new Date(item.updatedAt), now)),
  );
}

// ---------- Issues tab ----------

const ISSUES_HEADER = [
  { key: "status", label: "", props: { width: 3 }, adjustable: false },
  { key: "title", label: "TITLE", props: { grow: true }, adjustable: false },
  { key: "author", label: "AUTHOR", props: { width: 12 }, adjustable: true, minWidth: 6 },
  { key: "label", label: "LABEL", props: { width: 14 }, adjustable: true, minWidth: 6 },
  { key: "updated", label: "UPDATED", props: { width: 8 }, adjustable: true, minWidth: 6 },
];

const ISSUES_HEADER_COMPACT = [
  { key: "status", label: "", props: { width: 3 } },
  { key: "title", label: "TITLE", props: { grow: true } },
  { key: "updated", label: "UPDATED", props: { width: 8 } },
];

function IssueRow({ item, now, compact, cursor, columns }) {
  const cells = [
    e(Column, { key: "status", ...columnProps(columns, "status"), color: OK, label: selectionLabel("open issue", cursor) }, `${cursor ? ">" : " "}${OCT.issueOpened}`),
    e(Column, { key: "title", ...columnProps(columns, "title") }, `#${item.number} ${item.title}`),
  ];
  if (!compact) {
    cells.push(e(Column, { key: "author", ...columnProps(columns, "author"), color: IDENTIFIER }, item.author));
    cells.push(e(Column, { key: "label", ...columnProps(columns, "label"), color: REF }, item.label));
  }
  cells.push(
    e(Column, { key: "updated", ...columnProps(columns, "updated"), dim: true }, formatAge(new Date(item.updatedAt), now)),
  );
  return e(Box, { flexDirection: "row" }, ...cells);
}

// ---------- Pull requests tab ----------

const PRS_HEADER = [
  { key: "status", label: "", props: { width: 3 }, adjustable: false },
  { key: "title", label: "TITLE", props: { grow: true }, adjustable: false },
  { key: "author", label: "AUTHOR", props: { width: 12 }, adjustable: true, minWidth: 6 },
  { key: "branch", label: "BRANCH", props: { width: 14 }, adjustable: true, minWidth: 6 },
  { key: "review", label: "REVIEW", props: { width: 10 }, adjustable: true, minWidth: 7 },
  { key: "updated", label: "UPDATED", props: { width: 8 }, adjustable: true, minWidth: 6 },
];

const PRS_HEADER_COMPACT = [
  { key: "status", label: "", props: { width: 3 } },
  { key: "title", label: "TITLE", props: { grow: true } },
  { key: "review", label: "REVIEW", props: { width: 10 } },
];

const REVIEW_LABEL = {
  APPROVED: { label: "approved", color: OK },
  CHANGES_REQUESTED: { label: "changes", color: BAD },
  REVIEW_REQUIRED: { label: "pending", color: ATTENTION },
};
const REVIEW_NONE = { label: "", color: INERT };

function PRRow({ item, now, compact, cursor, columns }) {
  const prIcon = item.isDraft
    ? { icon: OCT.pullRequestDraft, color: INERT, label: "draft pull request" }
    : { icon: OCT.pullRequest, color: OK, label: "open pull request" };
  const review = pick(REVIEW_LABEL, item.reviewDecision, REVIEW_NONE);
  const cells = [
    e(Column, { key: "status", ...columnProps(columns, "status"), color: prIcon.color, label: selectionLabel(prIcon.label, cursor) }, `${cursor ? ">" : " "}${prIcon.icon}`),
    e(Column, { key: "title", ...columnProps(columns, "title") }, `#${item.number} ${item.title}`),
  ];
  if (!compact) {
    cells.push(e(Column, { key: "author", ...columnProps(columns, "author"), color: IDENTIFIER }, item.author));
    cells.push(
      e(Column, { key: "branch", ...columnProps(columns, "branch"), color: REF, wrap: "truncate-middle" }, item.headRefName),
    );
  }
  cells.push(e(Column, { key: "review", ...columnProps(columns, "review"), color: review.color }, review.label));
  if (!compact) {
    cells.push(
      e(Column, { key: "updated", ...columnProps(columns, "updated"), dim: true }, formatAge(new Date(item.updatedAt), now)),
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
  { key: "status", label: "", props: { width: 3 }, adjustable: false },
  { key: "severity", label: "SEV", props: { width: 4 }, adjustable: false },
  { key: "package", label: "PACKAGE / FILE", props: { width: 16 }, adjustable: true, minWidth: 6 },
  { key: "summary", label: "SUMMARY", props: { grow: true }, adjustable: false },
  { key: "age", label: "AGE", props: { width: 8 }, adjustable: true, minWidth: 6 },
];

// SEV is the last thing to drop on this tab: it is the whole point of the pane
// and the only non-colour severity channel.
const SECURITY_HEADER_COMPACT = [
  { key: "status", label: "", props: { width: 3 } },
  { key: "severity", label: "SEV", props: { width: 4 } },
  { key: "summary", label: "SUMMARY", props: { grow: true } },
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

function SecurityRow({ item, now, compact, cursor, columns }) {
  const sev = pick(SEVERITY_STYLE, item.severity, SEVERITY_UNKNOWN);
  const cells = [
    e(Column, { key: "status", ...columnProps(columns, "status"), color: sev.color, label: selectionLabel(`${sev.short} severity`, cursor) }, `${cursor ? ">" : " "}${OCT.shield}`),
    e(Column, { key: "severity", ...columnProps(columns, "severity"), color: sev.color }, sev.short),
  ];
  if (!compact) {
    cells.push(e(Column, { key: "package", ...columnProps(columns, "package"), color: IDENTIFIER }, item.detail || item.kind));
  }
  cells.push(e(Column, { key: "summary", ...columnProps(columns, "summary") }, item.title));
  if (!compact) {
    cells.push(
      e(Column, { key: "age", ...columnProps(columns, "age"), dim: true }, formatAge(new Date(item.createdAt), now)),
    );
  }
  return e(Box, { flexDirection: "row" }, ...cells);
}

// ---------- Tabs ----------

// Memoised because their inputs are stable by construction. Two things must
// stay true for that to hold: `now` must keep being replaced rather than
// mutated, and the raw-payload bail-out must keep producing fresh item objects
// when data genuinely changes. In-place mutation of a parsed item would make a
// memoised row silently stop updating.
const MemoActionsRow = React.memo(ActionsRow);
const MemoIssueRow = React.memo(IssueRow);
const MemoPRRow = React.memo(PRRow);
const MemoSecurityRow = React.memo(SecurityRow);

const TABS = [
  {
    key: "actions",
    fetch: ({ signal, ...options }) => fetchActions(signal, options),
    label: "Actions",
    short: "Actions",
    header: ACTIONS_HEADER,
    compactHeader: ACTIONS_HEADER_COMPACT,
    Row: MemoActionsRow,
    countLabel: "runs",
  },
  {
    key: "issues",
    fetch: ({ signal, governor, previousRaw, pages }) =>
      fetchIssues(signal, { governor, previousRaw, pages }),
    label: "Issues",
    short: "Issues",
    header: ISSUES_HEADER,
    compactHeader: ISSUES_HEADER_COMPACT,
    Row: MemoIssueRow,
    countLabel: "open issues",
  },
  {
    key: "prs",
    fetch: ({ signal, governor, previousRaw, pages }) =>
      fetchPRs(signal, { governor, previousRaw, pages }),
    label: "Pull requests",
    short: "PRs",
    header: PRS_HEADER,
    compactHeader: PRS_HEADER_COMPACT,
    Row: MemoPRRow,
    countLabel: "open PRs",
  },
  {
    key: "security",
    fetch: ({ signal, ...options }) => fetchSecurity(signal, options),
    label: "Security",
    short: "Security",
    header: SECURITY_HEADER,
    compactHeader: SECURITY_HEADER_COMPACT,
    Row: MemoSecurityRow,
    countLabel: "alerts",
  },
];

function tabForKey(key) {
  return TABS.find((tab) => tab.key === key);
}

const EMPTY_WIDTH_OVERRIDES = Object.freeze({});

function columnProps(columns, key) {
  const column = columns.find((candidate) => candidate.key === key);
  if (!column) throw new Error(`Unknown column: ${key}`);
  return column.props;
}

function isAdjustableWidthColumn(column) {
  return (
    column?.adjustable &&
    Number.isSafeInteger(column.props.width) &&
    Number.isSafeInteger(column.minWidth)
  );
}

function adjustableWidthKeys(tab) {
  if (!tab || !Array.isArray(tab.header)) return [];
  return tab.header.filter(isAdjustableWidthColumn).map((column) => column.key);
}

function selectWidthKey(tab, rememberedKey = null) {
  const keys = adjustableWidthKeys(tab);
  return keys.includes(rememberedKey) ? rememberedKey : (keys[0] ?? null);
}

function cycleWidthKey(tab, selectedKey, direction) {
  if (!Number.isSafeInteger(direction) || direction === 0) return selectWidthKey(tab, selectedKey);
  const keys = adjustableWidthKeys(tab);
  if (keys.length === 0) return null;
  const current = keys.indexOf(selectedKey);
  if (current < 0) return direction > 0 ? keys[0] : keys[keys.length - 1];
  return keys[(current + Math.sign(direction) + keys.length) % keys.length];
}

function resolveHeader(base, overrides = EMPTY_WIDTH_OVERRIDES) {
  let changed = false;
  const resolved = base.map((column) => {
    if (
      !isAdjustableWidthColumn(column) ||
      overrides == null ||
      !Object.hasOwn(overrides, column.key) ||
      !Number.isSafeInteger(overrides[column.key])
    ) {
      return column;
    }

    const width = Math.max(column.minWidth, overrides[column.key]);
    if (width === column.props.width) return column;
    changed = true;
    return { ...column, props: { ...column.props, width } };
  });
  return changed ? resolved : base;
}

function fitHeaderToFrame(preferred, defaults, frameCols) {
  const preferredFloor = minimumWidthFor(preferred);
  if (preferredFloor <= frameCols) return preferred;
  if (minimumWidthFor(defaults) > frameCols) return null;

  let remaining = preferredFloor - frameCols;
  return preferred.map((column) => {
    if (remaining <= 0 || !Number.isSafeInteger(column.props.width)) return column;
    const defaultColumn = defaults.find((candidate) => candidate.key === column.key);
    const defaultWidth = defaultColumn?.props.width;
    if (!Number.isSafeInteger(defaultWidth) || column.props.width <= defaultWidth) return column;

    const shrinkBy = Math.min(remaining, column.props.width - defaultWidth);
    remaining -= shrinkBy;
    return { ...column, props: { ...column.props, width: column.props.width - shrinkBy } };
  });
}

function effectiveHeaderFor(tab, tabOverrides, frameCols) {
  return fitHeaderToFrame(
    resolveHeader(tab.header, tabOverrides),
    tab.header,
    frameCols,
  );
}

function adjustWidth({ header, key, delta, frameCols }) {
  if (!Number.isSafeInteger(delta) || delta === 0 || !Number.isSafeInteger(frameCols)) return header;
  const index = header.findIndex((column) => column.key === key);
  if (index < 0) return header;

  const column = header[index];
  if (!isAdjustableWidthColumn(column)) return header;

  const available = Math.max(0, frameCols - minimumWidthFor(header));
  const maximum = column.props.width + available;
  const width = Math.min(maximum, Math.max(column.minWidth, column.props.width + delta));
  if (width === column.props.width) return header;

  const adjusted = [...header];
  adjusted[index] = { ...column, props: { ...column.props, width } };
  return adjusted;
}

function removeWidthOverride(overrides, tabKey, key) {
  if (!isRecord(overrides)) return overrides;
  const tabOverrides = overrides[tabKey];
  if (!isRecord(tabOverrides) || !Object.hasOwn(tabOverrides, key)) return overrides;

  const nextTab = { ...tabOverrides };
  delete nextTab[key];
  if (Object.keys(nextTab).length > 0) return { ...overrides, [tabKey]: nextTab };

  const next = { ...overrides };
  delete next[tabKey];
  return next;
}

// One immutable preference reducer for keyboard deltas and the pointer phase's
// absolute drag snapshots. The optional geometry arguments are the live fitted
// header and frame budget; omitting them gives unit callers semantic-minimum
// clamping without inventing a terminal width.
function updateWidthPreference({
  overrides,
  tab,
  key,
  nextWidth,
  effectiveHeader,
  frameCols,
}) {
  if (!isRecord(overrides) || !tab || !Array.isArray(tab.header) || !Number.isSafeInteger(nextWidth)) {
    return overrides;
  }
  const defaultColumn = tab.header.find((column) => column.key === key);
  if (!isAdjustableWidthColumn(defaultColumn)) return overrides;

  const tabOverrides = isRecord(overrides[tab.key]) ? overrides[tab.key] : EMPTY_WIDTH_OVERRIDES;
  const currentHeader = Array.isArray(effectiveHeader)
    ? effectiveHeader
    : resolveHeader(tab.header, tabOverrides);
  const currentColumn = currentHeader.find((column) => column.key === key);
  if (!isAdjustableWidthColumn(currentColumn)) return overrides;

  const delta = nextWidth - currentColumn.props.width;
  const liveFrameCols = Number.isSafeInteger(frameCols)
    ? frameCols
    : minimumWidthFor(currentHeader) + Math.max(0, delta);
  const adjusted = adjustWidth({ header: currentHeader, key, delta, frameCols: liveFrameCols });
  if (adjusted === currentHeader) return overrides;
  const width = adjusted.find((column) => column.key === key).props.width;
  const hasOverride = Object.hasOwn(tabOverrides, key);

  if (width === defaultColumn.props.width) {
    return removeWidthOverride(overrides, tab.key, key);
  }

  if (hasOverride && tabOverrides[key] === width) return overrides;
  return { ...overrides, [tab.key]: { ...tabOverrides, [key]: width } };
}

function resetWidthPreference(overrides, tabKey, key) {
  if (!isRecord(overrides)) return overrides;
  const tab = tabForKey(tabKey);
  const column = tab?.header.find((candidate) => candidate.key === key);
  if (!isAdjustableWidthColumn(column)) return overrides;
  return removeWidthOverride(overrides, tabKey, key);
}

function resetTabWidthPreferences(overrides, tabKey) {
  if (!isRecord(overrides) || !Object.hasOwn(overrides, tabKey)) return overrides;
  if (!tabForKey(tabKey)) return overrides;
  const next = { ...overrides };
  delete next[tabKey];
  return next;
}

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

// ---------- Width preferences ----------

const WIDTH_PREFERENCES_VERSION = 1;
let widthPreferenceTempSequence = 0;

function widthPreferencesPath({
  env = process.env,
  platform = process.platform,
  home = homedir(),
} = {}) {
  const xdgRoot = env?.XDG_CONFIG_HOME;
  const root =
    typeof xdgRoot === "string" && xdgRoot.length > 0 && isAbsolute(xdgRoot)
      ? xdgRoot
      : platform === "darwin"
        ? join(home, "Library", "Application Support")
        : join(home, ".config");
  return join(root, "gh-glance", "preferences.json");
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const PERSISTENCE_LOCK_WAIT_MS = 250;
const PERSISTENCE_STALE_LOCK_MS = 5000;

function withPersistenceLock(path, operation) {
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + PERSISTENCE_LOCK_WAIT_MS;
  let descriptor = null;
  while (descriptor === null) {
    try {
      descriptor = openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if (error?.code !== "EEXIST") return { ok: false, error };
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > PERSISTENCE_STALE_LOCK_MS) {
          unlinkSync(lockPath);
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) return { ok: false, busy: true, error };
      Atomics.wait(persistenceWaitCell, 0, 0, 10);
    }
  }
  try {
    return operation();
  } finally {
    try {
      closeSync(descriptor);
    } finally {
      try {
        unlinkSync(lockPath);
      } catch {
        // The lock is advisory; failure to remove it is recovered as stale.
      }
    }
  }
}

function samePersistedValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mergeWidthPreferenceSnapshots(base, disk, next) {
  const merged = isRecord(disk) ? structuredClone(disk) : {};
  const base_ = isRecord(base) ? base : {};
  const next_ = isRecord(next) ? next : {};
  const tabKeys = new Set([...Object.keys(base_), ...Object.keys(next_)]);
  for (const tabKey of tabKeys) {
    const baseTab = isRecord(base_[tabKey]) ? base_[tabKey] : {};
    const nextTab = isRecord(next_[tabKey]) ? next_[tabKey] : {};
    const columnKeys = new Set([...Object.keys(baseTab), ...Object.keys(nextTab)]);
    for (const key of columnKeys) {
      if (samePersistedValue(baseTab[key], nextTab[key])) continue;
      if (!Object.hasOwn(nextTab, key)) {
        if (isRecord(merged[tabKey])) delete merged[tabKey][key];
      } else {
        merged[tabKey] = isRecord(merged[tabKey]) ? merged[tabKey] : {};
        merged[tabKey][key] = nextTab[key];
      }
    }
    if (isRecord(merged[tabKey]) && Object.keys(merged[tabKey]).length === 0) delete merged[tabKey];
  }
  return merged;
}

function mergeDashboardCacheSnapshots(base, disk, next) {
  const merged = isRecord(disk) ? structuredClone(disk) : {};
  const base_ = isRecord(base) ? base : {};
  const next_ = isRecord(next) ? next : {};
  for (const target of new Set([...Object.keys(base_), ...Object.keys(next_)])) {
    if (samePersistedValue(base_[target], next_[target])) continue;
    if (!Object.hasOwn(next_, target)) {
      delete merged[target];
      continue;
    }

    const baseEntry = isRecord(base_[target]) ? base_[target] : {};
    const diskEntry = isRecord(merged[target]) ? merged[target] : {};
    const nextEntry = isRecord(next_[target]) ? next_[target] : {};
    const mergedEntry = structuredClone(diskEntry);
    const baseTabs = isRecord(baseEntry.tabs) ? baseEntry.tabs : {};
    const nextTabs = isRecord(nextEntry.tabs) ? nextEntry.tabs : {};
    const mergedTabs = isRecord(mergedEntry.tabs) ? mergedEntry.tabs : {};
    for (const tabKey of new Set([...Object.keys(baseTabs), ...Object.keys(nextTabs)])) {
      if (samePersistedValue(baseTabs[tabKey], nextTabs[tabKey])) continue;
      if (Object.hasOwn(nextTabs, tabKey)) mergedTabs[tabKey] = nextTabs[tabKey];
      else delete mergedTabs[tabKey];
    }
    if (Object.keys(mergedTabs).length > 0) mergedEntry.tabs = mergedTabs;
    else delete mergedEntry.tabs;

    for (const field of ["securityNotes", "securityBlind", "updatedAt"]) {
      if (samePersistedValue(baseEntry[field], nextEntry[field])) continue;
      if (Object.hasOwn(nextEntry, field)) mergedEntry[field] = nextEntry[field];
      else delete mergedEntry[field];
    }
    merged[target] = mergedEntry;
  }
  return merged;
}

function adoptPersistedSnapshot(result, persistedRef, liveRef) {
  if (result?.ok !== true || !isRecord(result.persisted)) return false;
  persistedRef.current = result.persisted;
  liveRef.current = result.persisted;
  return true;
}

function normalizeWidthOverrides(overrides, tabs = TABS, { omitDefaults = false } = {}) {
  if (!isRecord(overrides)) return {};

  const normalized = {};
  for (const tab of tabs) {
    if (!Object.hasOwn(overrides, tab.key) || !isRecord(overrides[tab.key])) continue;

    const source = overrides[tab.key];
    const tabOverrides = {};
    for (const column of tab.header) {
      if (!isAdjustableWidthColumn(column) || !Object.hasOwn(source, column.key)) continue;
      const width = source[column.key];
      if (!Number.isSafeInteger(width) || width < column.minWidth) continue;
      if (omitDefaults && width === column.props.width) continue;
      tabOverrides[column.key] = width;
    }
    if (Object.keys(tabOverrides).length > 0) normalized[tab.key] = tabOverrides;
  }
  return normalized;
}

function decodeWidthPreferences(raw, tabs = TABS) {
  let document;
  try {
    document = JSON.parse(raw);
  } catch (error) {
    return { preferences: {}, error };
  }

  if (
    !isRecord(document) ||
    !Object.hasOwn(document, "version") ||
    document.version !== WIDTH_PREFERENCES_VERSION ||
    !Object.hasOwn(document, "tabs") ||
    !isRecord(document.tabs)
  ) {
    return { preferences: {}, error: new Error("Unsupported width preferences document") };
  }

  return { preferences: normalizeWidthOverrides(document.tabs, tabs), error: null };
}

function parseWidthPreferences(raw, tabs = TABS) {
  return decodeWidthPreferences(raw, tabs).preferences;
}

function serializeWidthPreferences(overrides, tabs = TABS) {
  const document = {
    version: WIDTH_PREFERENCES_VERSION,
    tabs: normalizeWidthOverrides(overrides, tabs, { omitDefaults: true }),
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

function loadWidthPreferences(path, tabs = TABS) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    return error?.code === "ENOENT"
      ? { preferences: {}, error: null }
      : { preferences: {}, error };
  }
  return decodeWidthPreferences(raw, tabs);
}

function saveWidthPreferences(path, overrides, tabs = TABS, { base = null } = {}) {
  try {
    const parent = dirname(path);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    return withPersistenceLock(path, () => {
      let tempPath = null;
      try {
        const disk = base === null ? {} : loadWidthPreferences(path, tabs).preferences;
        const merged = base === null
          ? overrides
          : mergeWidthPreferenceSnapshots(base, disk, overrides);
        const payload = serializeWidthPreferences(merged, tabs);
        widthPreferenceTempSequence += 1;
        tempPath = `${path}.${process.pid}.${Date.now()}.${widthPreferenceTempSequence}.tmp`;
        writeFileSync(tempPath, payload, {
          encoding: "utf8",
          mode: 0o600,
          flag: "wx",
        });
        renameSync(tempPath, path);
        return { ok: true, persisted: normalizeWidthOverrides(merged, tabs) };
      } catch (error) {
        if (tempPath !== null) {
          try {
            unlinkSync(tempPath);
          } catch {
            // Cleanup targets only this operation's exact temporary file.
          }
        }
        return { ok: false, error };
      }
    });
  } catch (error) {
    return { ok: false, error };
  }
}

function createCoalescedWriter({ write, delay = 200, onResult = () => {} }) {
  let latest;
  let generation = 0;
  let persistedGeneration = 0;
  let timer = null;
  let flushPromise = null;

  function report(result) {
    try {
      onResult(result);
    } catch {
      // Persistence reporting is advisory and must not reach Ink's render path.
    }
    return result;
  }

  function failed(error) {
    return { ok: false, error };
  }

  async function writeGeneration(value) {
    let pending;
    try {
      // Keep this call before the first await. The production writer is
      // synchronous, so an unmount flush completes the filesystem replacement
      // before React hands terminal teardown back to its caller.
      pending = write(value);
    } catch (error) {
      return failed(error);
    }

    try {
      const result = await pending;
      return result?.ok === false ? result : (result ?? { ok: true });
    } catch (error) {
      return failed(error);
    }
  }

  async function drain() {
    let result = { ok: true, written: false };
    while (persistedGeneration < generation) {
      const attemptedGeneration = generation;
      const value = latest;
      result = await writeGeneration(value);

      const isLatest = attemptedGeneration === generation;
      if (result.ok !== false) {
        persistedGeneration = Math.max(persistedGeneration, attemptedGeneration);
      }

      // The loop serializes a superseding write behind this completion, so its
      // result owns the warning state. A stale completion is deliberately not
      // reported, while async replacements can neither race on disk nor report
      // out of order.
      if (!isLatest) continue;
      report(result);
      // Leave the latest generation dirty after failure. A later flush/dispose
      // retries it; concurrent callers still share this completed attempt.
      if (result.ok === false) return result;
    }
    return result;
  }

  function flush() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (flushPromise !== null) return flushPromise;
    if (persistedGeneration >= generation) {
      return Promise.resolve({ ok: true, written: false });
    }

    const pending = drain().finally(() => {
      if (flushPromise === pending) flushPromise = null;
    });
    flushPromise = pending;
    return pending;
  }

  function schedule(value) {
    latest = value;
    generation += 1;
    if (timer === null) {
      timer = setTimeout(() => {
        timer = null;
        void flush();
      }, delay);
      timer.unref?.();
    } else {
      timer.refresh();
    }
  }

  return {
    schedule,
    flush,
    dispose: flush,
  };
}

const createWidthPreferenceWriter = createCoalescedWriter;

// ---------- Last-known-good dashboard cache ----------

// 3: cached rows carry their page URL, without which they cannot be opened.
const DASHBOARD_CACHE_VERSION = 3;
const MAX_DASHBOARD_CACHE_TARGETS = 5;
const MAX_DASHBOARD_CACHE_ROWS_PER_TAB = 60;
let dashboardCacheTempSequence = 0;

function dashboardCachePath(options = {}) {
  return join(dirname(widthPreferencesPath(options)), "dashboard-cache.json");
}

function effectiveGhConfigDir({ env = process.env, platform = process.platform, home = homedir() } = {}) {
  if (env?.GH_CONFIG_DIR) return String(env.GH_CONFIG_DIR);
  if (env?.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME)) return join(env.XDG_CONFIG_HOME, "gh");
  if (platform === "win32" && env?.APPDATA) return join(env.APPDATA, "GitHub CLI");
  return join(home, ".config", "gh");
}

function authCacheIdentity({
  env = process.env,
  platform = process.platform,
  home = homedir(),
  stat,
} = {}) {
  const configDir = effectiveGhConfigDir({ env, platform, home });
  let configStat = stat;
  if (configStat === undefined) {
    try {
      configStat = statSync(join(configDir, "hosts.yml"));
    } catch {
      configStat = null;
    }
  }
  const tokenDigests = Object.fromEntries(
    ["GH_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]
      .filter((name) => env?.[name])
      .map((name) => [
        name,
        createHash("sha256").update(String(env[name])).digest("hex"),
      ]),
  );
  const payload = {
    configDir,
    configStat: configStat
      ? {
          dev: Number(configStat.dev),
          ino: Number(configStat.ino),
          size: Number(configStat.size),
          mtimeMs: Math.trunc(Number(configStat.mtimeMs)),
        }
      : null,
    tokenDigests,
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 24);
}

// Explicit targets are stable across working directories. In inferred mode the
// directory is the only repository identity available without making another
// GitHub call -- exactly the call that cannot succeed when this cache is needed.
// JSON encoding avoids delimiter ambiguity in host, repo, and path strings.
function dashboardCacheTarget({
  repo = null,
  ghRepo = null,
  host = null,
  cwd = process.cwd(),
  account = authCacheIdentity(),
} = {}) {
  const target = repo || ghRepo;
  return target
    ? JSON.stringify({ kind: "repo", host: String(host ?? ""), repo: String(target), account })
    : JSON.stringify({ kind: "cwd", host: String(host ?? ""), cwd: String(cwd), account });
}

function cacheTimestamp(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function normalizeCachedItem(tabKey, item) {
  if (!isRecord(item)) return null;
  if (tabKey === "actions") {
    if (!Number.isSafeInteger(item.databaseId)) return null;
    return {
      databaseId: item.databaseId,
      displayTitle: safe(item.displayTitle),
      workflowName: safe(item.workflowName),
      number: Number.isSafeInteger(item.number) ? item.number : null,
      headBranch: safe(item.headBranch),
      status: safe(item.status),
      conclusion: item.conclusion == null ? null : safe(item.conclusion),
      startedAt: safe(item.startedAt),
      updatedAt: safe(item.updatedAt),
      // Retained because opening a row now reads its URL from the row. Dropping
      // it made Enter on a cache-hydrated row do nothing at all, with no error.
      url: safe(item.url ?? ""),
    };
  }
  if (tabKey === "issues") {
    if (!Number.isSafeInteger(item.number)) return null;
    return {
      number: item.number,
      title: safe(item.title),
      author: safe(item.author),
      label: safe(item.label),
      updatedAt: safe(item.updatedAt),
      url: safe(item.url ?? ""),
    };
  }
  if (tabKey === "prs") {
    if (!Number.isSafeInteger(item.number)) return null;
    return {
      number: item.number,
      title: safe(item.title),
      author: safe(item.author),
      headRefName: safe(item.headRefName),
      isDraft: Boolean(item.isDraft),
      reviewDecision: safe(item.reviewDecision),
      updatedAt: safe(item.updatedAt),
      url: safe(item.url ?? ""),
    };
  }
  if (tabKey === "security") {
    const id = safe(item.id);
    if (!id) return null;
    return {
      id,
      kind: safe(item.kind),
      severity: safe(item.severity),
      title: safe(item.title),
      detail: safe(item.detail),
      createdAt: safe(item.createdAt),
    };
  }
  return null;
}

function normalizeDashboardCacheEntry(entry) {
  if (!isRecord(entry) || !isRecord(entry.tabs)) return null;
  const tabs = {};
  for (const tabKey of TAB_KEYS) {
    const tab = entry.tabs[tabKey];
    if (!isRecord(tab) || !Array.isArray(tab.data)) continue;
    const lastOk = cacheTimestamp(tab.lastOk);
    if (
      lastOk === null ||
      !isRecord(tab.meta) ||
      cacheTimestamp(tab.meta.at) === null ||
      typeof tab.meta.truncated !== "boolean"
    ) {
      continue;
    }
    const normalizedData = tab.data.map((item) => normalizeCachedItem(tabKey, item)).filter(Boolean);
    // A malformed row means this tab was not written by the current schema.
    // Reject the tab rather than turning a corrupt non-empty payload into a
    // confident empty state.
    if (normalizedData.length !== tab.data.length) continue;
    const data = normalizedData.slice(0, MAX_DASHBOARD_CACHE_ROWS_PER_TAB);
    const meta = {
      at: tab.meta.at,
      truncated: tab.meta.truncated || normalizedData.length > MAX_DASHBOARD_CACHE_ROWS_PER_TAB,
    };
    tabs[tabKey] = { data, meta, lastOk };
  }
  if (Object.keys(tabs).length === 0) return null;
  const latestTab = Math.max(...Object.values(tabs).map((tab) => tab.lastOk));
  return {
    tabs,
    securityNotes: Array.isArray(entry.securityNotes)
      ? entry.securityNotes
          .filter((note) => typeof note === "string")
          .slice(0, ALERT_SOURCES.length)
          .map((note) => safe(note))
      : [],
    securityBlind: typeof entry.securityBlind === "boolean" ? entry.securityBlind : false,
    updatedAt: cacheTimestamp(entry.updatedAt) ?? latestTab,
  };
}

function normalizeDashboardCache(cache) {
  if (!isRecord(cache)) return {};
  return limitDashboardCache(
    Object.fromEntries(
      Object.entries(cache)
        .map(([target, entry]) => [target, normalizeDashboardCacheEntry(entry)])
        .filter(([target, entry]) => target.length > 0 && entry !== null),
    ),
  );
}

function limitDashboardCache(cache) {
  return Object.fromEntries(
    Object.entries(cache)
      .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
      .slice(0, MAX_DASHBOARD_CACHE_TARGETS),
  );
}

function mergeDashboardCacheEntry(cache, target, entry) {
  const normalized = normalizeDashboardCacheEntry(entry);
  return normalized === null ? cache : limitDashboardCache({ ...cache, [target]: normalized });
}

function decodeDashboardCache(raw) {
  let document;
  try {
    document = JSON.parse(raw);
  } catch (error) {
    return { cache: {}, error };
  }
  if (
    !isRecord(document) ||
    document.version !== DASHBOARD_CACHE_VERSION ||
    !isRecord(document.targets)
  ) {
    return { cache: {}, error: new Error("Unsupported dashboard cache document") };
  }
  return { cache: normalizeDashboardCache(document.targets), error: null };
}

function serializeDashboardCache(cache, { normalized = false } = {}) {
  return `${JSON.stringify(
    { version: DASHBOARD_CACHE_VERSION, targets: normalized ? cache : normalizeDashboardCache(cache) },
    null,
    2,
  )}\n`;
}

function loadDashboardCache(path, target) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    return error?.code === "ENOENT"
      ? { cache: {}, entry: null, error: null }
      : { cache: {}, entry: null, error };
  }
  const decoded = decodeDashboardCache(raw);
  return {
    cache: decoded.cache,
    entry: pick(decoded.cache, target, null),
    error: decoded.error,
  };
}

function saveDashboardCache(path, cache, { normalized = false, base = null } = {}) {
  try {
    const parent = dirname(path);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") chmodSync(parent, 0o700);
    return withPersistenceLock(path, () => {
      let tempPath = null;
      try {
        const disk = base === null ? {} : loadDashboardCache(path, "").cache;
        const merged = base === null
          ? cache
          : limitDashboardCache(mergeDashboardCacheSnapshots(base, disk, cache));
        dashboardCacheTempSequence += 1;
        tempPath = `${path}.${process.pid}.${Date.now()}.${dashboardCacheTempSequence}.tmp`;
        writeFileSync(tempPath, serializeDashboardCache(merged, { normalized }), {
          encoding: "utf8",
          mode: 0o600,
          flag: "wx",
        });
        renameSync(tempPath, path);
        return { ok: true, persisted: normalizeDashboardCache(merged) };
      } catch (error) {
        if (tempPath !== null) {
          try {
            unlinkSync(tempPath);
          } catch {
            // Cleanup targets only this operation's exact temporary file.
          }
        }
        return { ok: false, error };
      }
    });
  } catch (error) {
    return { ok: false, error };
  }
}

function nextSecurityRaw(previousRaw, raw, blind) {
  if (blind === true) return null;
  return previousRaw === raw ? previousRaw : raw;
}

const CACHE_FRESHNESS_CHECKPOINT_MS = 60_000;

function shouldCheckpointFreshness({ persistedAt, completedAt }) {
  return !Number.isFinite(persistedAt) || completedAt - persistedAt >= CACHE_FRESHNESS_CHECKPOINT_MS;
}

// The one place the cadence table is decided. It used to be spread across a
// fixed active floor, a fixed four-floor background slot, and a Security-only
// unchanged rule -- three policies that could disagree, and did: Security
// slowed after a single unchanged poll while every other tab never slowed at
// all. Everything now derives from this function, so a resource's cadence is
// stated once and read everywhere.
function pollPolicyInterval({
  tab,
  floorMs,
  demand = "active",
  unchangedCount = 0,
  inProgressCI = false,
  background = "all",
}) {
  if (demand === "none") return Number.POSITIVE_INFINITY;
  if (demand === "inactive") {
    if (background === "off") return Number.POSITIVE_INFINITY;
    return Math.max(BACKGROUND_EVERY * floorMs, pick(POLL_BACKGROUND_MS, tab, 0));
  }
  // Work in flight outranks the quiet counter: a repository whose list has not
  // changed in an hour still has a run finishing right now.
  if (tab === "actions" && inProgressCI === true) return Math.max(floorMs, POLL_ACTIVE_CI_MS);
  if (unchangedCount >= POLL_QUIET_AFTER) return Math.max(floorMs, pick(POLL_QUIET_MS, tab, 0));
  return floorMs;
}

// Only a validated observation moves this counter. An error, a blind Security
// source, or an unusable payload is the absence of evidence, not evidence of
// quiet -- counting them would slow a tab precisely because it is broken.
function advanceUnchangedCount(previous, outcome) {
  const current = Number.isSafeInteger(previous) && previous > 0 ? previous : 0;
  if (outcome === "unchanged") return current + 1;
  if (outcome === "changed" || outcome === "subscribed") return 0;
  return current;
}

// Two manual intentions, deliberately separated. `r` used to mean both "check
// now" and "throw away every validator", so the key that a user presses on a
// quiet repository -- the one case where a conditional check is free -- was the
// key guaranteed to spend.
function refreshIntent(input, { widthMode = false } = {}) {
  // Width mode owns both keys: `r` resets the selected column and `R` resets
  // the tab's widths. Leaking a refresh into either would make a layout action
  // spend quota.
  if (widthMode === true) return null;
  if (input === "r") return "conditional";
  if (input === "R") return "resync";
  return null;
}

function manualRefreshRequest(intent) {
  if (intent === "conditional") {
    return { kind: "manual", force: false, dropValidators: false, clearCapabilityBackoff: false };
  }
  if (intent === "resync") {
    return { kind: "manual", force: true, dropValidators: true, clearCapabilityBackoff: true };
  }
  return null;
}

// A press during automatic work either rides that work or schedules exactly one
// follow-up. Without the follow-up, pressing `r` while a poll that started
// before the press was still running silently did nothing.
function planManualRefresh({ requestedAt, inFlightStartedAt = null, followUpPending = false }) {
  if (!Number.isFinite(inFlightStartedAt)) return { join: false, start: true, followUp: false };
  if (inFlightStartedAt >= requestedAt) return { join: true, start: false, followUp: false };
  return { join: followUpPending, start: false, followUp: !followUpPending };
}

// A 304 whose entity is gone is a broken pair, not data. One unconditional
// recovery, separately admitted, and then the tab says so -- because the
// alternative is a conditional request that can never be satisfied, retried at
// the poll cadence forever.
function conditionalRecoveryPlan({ status, entity, hasEntity = typeof entity === "string" && entity.length > 0, attempts = 0 }) {
  if (status !== 304 || hasEntity === true) return { recover: false, unusable: false };
  if (!Number.isSafeInteger(attempts) || attempts <= 0) return { recover: true, unusable: false };
  return { recover: false, unusable: true };
}

function shouldShowFetchLoading({ hasData, manual }) {
  return !hasData || manual === true;
}

function tabHold(tab, heldResources = {}) {
  const costs = tabRequestCost(tab);
  const holds = RATE_RESOURCES.flatMap((resource) => {
    if (costs[resource] <= 0) return [];
    const value = heldResources[resource];
    if (value === true) return [{ retryAt: Number.POSITIVE_INFINITY }];
    return value?.held ? [value] : [];
  });
  return {
    held: holds.length > 0,
    retryAt: holds.reduce(
      (latest, hold) => Math.max(latest, hold.retryAt ?? Number.POSITIVE_INFINITY),
      0,
    ),
  };
}

function rotateFrom(keys, index) {
  if (keys.length === 0) return keys;
  const start = ((Number.isSafeInteger(index) ? index : 0) % keys.length + keys.length) % keys.length;
  return keys.map((_, offset) => keys[(start + offset) % keys.length]);
}

// Every tab now carries its own deadline rather than sharing one active slot
// and one rotating background slot. That is what lets the cadence differ per
// resource: a quiet Security tab at 300s and an Actions tab watching a running
// job at 5s cannot be expressed by two shared timers.
function pollSchedule({
  nowMs,
  floorMs,
  activeKey,
  dueAt = {},
  backgroundIndex = 0,
  heldResources = {},
  background = "all",
  states = {},
}) {
  const due = [];
  const next = {};
  const backgroundKeys = TAB_KEYS.filter((key) => key !== activeKey);
  let nextBackgroundIndex = backgroundIndex;
  // At most one inactive tab per wake, still round robin. Three inactive tabs
  // all becoming due together would otherwise open three concurrent panes of
  // demand against one lane slot.
  let backgroundTaken = false;

  for (const key of [activeKey, ...rotateFrom(backgroundKeys, backgroundIndex)]) {
    const isActive = key === activeKey;
    const step = pollPolicyInterval({
      tab: key,
      floorMs,
      demand: isActive ? "active" : "inactive",
      unchangedCount: states[key]?.unchangedCount ?? 0,
      inProgressCI: states[key]?.inProgressCI === true,
      background,
    });
    if (!Number.isFinite(step)) {
      next[key] = Number.POSITIVE_INFINITY;
      continue;
    }
    const at = Number.isFinite(dueAt[key]) ? dueAt[key] : nowMs;
    if (at > nowMs) {
      next[key] = at;
      continue;
    }
    const hold = tabHold(key, heldResources);
    if (hold.held) {
      next[key] = hold.retryAt;
      continue;
    }
    if (!isActive) {
      if (backgroundTaken) {
        next[key] = at;
        continue;
      }
      backgroundTaken = true;
      nextBackgroundIndex = (backgroundKeys.indexOf(key) + 1) % backgroundKeys.length;
    }
    due.push({ key, kind: isActive ? "active" : "background" });
    next[key] = nowMs + step;
  }
  return {
    due,
    dueAt: next,
    backgroundIndex: nextBackgroundIndex,
    nextAt: Math.min(...Object.values(next)),
  };
}

function retryPollAfterAdmissionFailure({
  key,
  kind,
  retryAt,
  dueAt,
  backgroundIndex,
  previousBackgroundIndex,
}) {
  const previous = Number.isFinite(dueAt?.[key]) ? dueAt[key] : Number.POSITIVE_INFINITY;
  return {
    dueAt: { ...dueAt, [key]: Math.min(previous, retryAt) },
    // A background tab that could not be admitted did not consume its turn.
    backgroundIndex: kind === "background" ? previousBackgroundIndex : backgroundIndex,
  };
}

function governorWakeTimes(state, nowMs, floorMs, leaseId = null) {
  const budgets = Object.values(state?.budgets ?? {});
  // A failed observer's own retry, not its stale sample's cadence, says when
  // that resource is next worth reading. Suppress the cadence per resource: a
  // global suppression let one failure silence a healthy lane's wake, and no
  // suppression let the failed lane spin on the sample it already knows is old.
  const observedCandidates = RATE_RESOURCES.flatMap((resource) => {
    const budget = state?.budgets?.[resource];
    if (!budget || state?.observers?.[resource]?.outcome === "failed") return [];
    return [budget.observedAt + BUDGET_PROBE_MS];
  });
  const controlAt = Math.min(
    ...observedCandidates,
    ...budgets.map((budget) => budget.resetMs + BUDGET_RESET_GRACE_MS),
    ...RATE_RESOURCES.map((resource) => state?.probeClaims?.[resource]?.leaseUntil ?? Number.POSITIVE_INFINITY),
    ...RATE_RESOURCES.map((resource) => state?.observers?.[resource]?.nextAt ?? Number.POSITIVE_INFINITY),
  );
  const reservationAt = Object.values(state?.reservations ?? {})
    .filter((reservation) => reservation.status === "scheduled" &&
      (leaseId == null || reservation.leaseId === leaseId))
    .reduce((earliest, reservation) => Math.min(earliest, reservation.notBefore), Number.POSITIVE_INFINITY);
  return {
    controlAt: Number.isFinite(controlAt) ? Math.max(nowMs + 1, controlAt) : nowMs + floorMs,
    dataAt: Number.isFinite(reservationAt) ? Math.max(nowMs + 1, reservationAt) : Number.POSITIVE_INFINITY,
  };
}

function governorProtocolReady(refreshResult, snapshot, nowMs) {
  if (!refreshResult?.ok || !snapshot?.ok) return false;
  if (["waiting", "paused", "probe"].includes(refreshResult.value?.status)) return false;
  if (RATE_RESOURCES.some((resource) => snapshot.value.probeClaims[resource]) ||
    RATE_RESOURCES.some((resource) => snapshot.value.observers[resource]?.outcome !== "healthy")) return false;
  return RATE_RESOURCES.every((resource) => {
    const budget = snapshot.value.budgets[resource];
    return budget && nowMs - budget.observedAt <= budgetSnapshotTtl(resource);
  });
}

function governorControlReady(refreshResult, snapshot, nowMs) {
  if (governorProtocolReady(refreshResult, snapshot, nowMs)) return true;
  // A losing probe claimant can exhaust its bounded reinspection just before
  // the winner publishes. Its return value is still `waiting`, but the locked
  // snapshot taken immediately afterwards is authoritative. Adopt only that
  // successful handoff; failures and every incomplete snapshot remain closed.
  return refreshResult?.ok && refreshResult.value?.status === "waiting" &&
    governorProtocolReady({ ok: true, value: { status: "published" } }, snapshot, nowMs);
}

function tabEpochChanged(previous, next, key) {
  const costs = tabRequestCost(key);
  if (!costs || !isRecord(previous) || !isRecord(next)) return false;
  return RATE_RESOURCES.some((resource) =>
    costs[resource] > 0 && previous[resource] !== next[resource]);
}

function governorDataReady(refreshResult, snapshot, activeKey, nowMs) {
  if (!governorProtocolReady(refreshResult, snapshot, nowMs)) return false;
  const costs = tabRequestCost(activeKey);
  return RATE_RESOURCES.every((resource) => {
    if (costs[resource] <= 0) return true;
    const budget = snapshot.value.budgets[resource];
    return budget && nowMs - budget.observedAt <= budgetSnapshotTtl(resource) &&
      budget.blockUntil <= nowMs &&
      availableForGrant({ budget, resource, nowMs }).mode === "open";
  });
}

function governorControlRetryAt(nowMs, floorMs) {
  return nowMs + Math.min(floorMs, 1000);
}

function createWakeScheduler({
  now = Date.now,
  set = setTimeout,
  clear = clearTimeout,
} = {}) {
  const entries = new Map();
  return {
    arm(kind, at, run) {
      if (!Number.isFinite(at) || at >= (entries.get(kind)?.at ?? Number.POSITIVE_INFINITY)) return false;
      const previous = entries.get(kind);
      if (previous) clear(previous.id);
      const entry = { at, id: null };
      entry.id = set(() => {
        if (entries.get(kind) !== entry) return;
        entries.delete(kind);
        void run();
      }, Math.max(0, at - now()));
      entries.set(kind, entry);
      return true;
    },
    clear(kind) {
      const entry = entries.get(kind);
      if (!entry) return false;
      clear(entry.id);
      entries.delete(kind);
      return true;
    },
    clearAll() {
      for (const entry of entries.values()) clear(entry.id);
      entries.clear();
    },
    at: (kind) => entries.get(kind)?.at ?? Number.POSITIVE_INFINITY,
    size: () => entries.size,
  };
}

function createSingleFlightWake(run, onSettled = () => {}) {
  let running = false;
  let pendingArgs = null;
  return async (...args) => {
    if (running) {
      pendingArgs = args;
      return false;
    }
    running = true;
    try {
      let nextArgs = args;
      do {
        pendingArgs = null;
        await run(...nextArgs);
        nextArgs = pendingArgs;
      } while (nextArgs !== null);
      return true;
    } finally {
      running = false;
      onSettled();
    }
  };
}

function pendingFailureIsTerminal(reason) {
  return reason === "stale";
}

function runtimeIntentGate(liveScheduling, { force = false, protocolReady = false } = {}) {
  return liveScheduling || protocolReady
    ? { registerIntent: true, requestProbe: false }
    : { registerIntent: false, requestProbe: force === true };
}

function admitGovernorOperation(scope, leaseId, operation, priority, nowMs, intentId = governorId()) {
  const costs = operationCost(operation);
  if (!costs || !validGovernorId(leaseId) || !validGovernorId(intentId)) {
    return { ok: false, reason: "corrupt" };
  }
  const decision = registerIntent(scope, {
    id: intentId,
    leaseId,
    tab: operation,
    priority,
    costs,
    requestedAt: nowMs,
    expiresAt: nowMs + GOVERNOR_LEASE_TTL_MS,
  });
  if (!decision.ok || decision.value.status !== "scheduled") return decision;
  const startAt = governorEffectiveTime(scope, nowMs);
  if (decision.value.notBefore > startAt) return decision;
  return startReservation(scope, decision.value.reservationId, startAt);
}

function governorOutcomeForError(error) {
  if (error?.name === "AbortError") return "abort";
  if (error?.signal) return "signal";
  if (error?.code === "ETIMEDOUT") return "timeout";
  return "rejected";
}

function rateLimitBlockDecision(results, resetMs) {
  const publications = Array.isArray(results) ? results : [];
  const failure = publications.find((result) => result?.ok !== true);
  if (publications.length === 0 || failure || !Number.isFinite(resetMs)) {
    return {
      mode: "paused",
      reason: failure?.reason ?? "block-unpublished",
      coordinationError: true,
      failClosed: true,
    };
  }
  return {
    mode: "paused",
    reason: "rate-limit",
    resetMs,
    coordinationError: false,
    failClosed: false,
  };
}

// Identity reasons that name a condition the user can act on or wait out. The
// list previously stopped short of identity-unavailable -- the ordinary "not
// signed in" or "proof denied" case, and precisely the one this phase requires
// to read as an honest unavailable state rather than a generic retry -- and of
// identity-capacity and transport-busy.
//
// Purely internal reasons (corrupt, unwritable, unknown-host, closed) stay on
// the generic message on purpose: this surface must not leak internal
// vocabulary, which is the contract "coordination notices translate raw reasons
// without exposing internal vocabulary" in test/unit.test.mjs pins.
const IDENTITY_COORDINATION_REASONS = [
  "restart-required", "migration-hold", "legacy-unresolved", "legacy-corrupt",
  "credential-unavailable", "identity-backoff", "identity-busy",
  "identity-unavailable", "identity-capacity", "transport-busy", "throttle-paused",
];

function coordinationNotice(reason) {
  if (reason === "unknown-scope") return "Confirming your GitHub login…";
  if (reason === "block-unpublished") return "Holding until the rate-limit block is shared";
  if (reason === "busy" || reason === "stale") return "Coordinating with your other panes";
  if (IDENTITY_COORDINATION_REASONS.includes(reason)) return identityCoordinationMessage(reason);
  return "Can't coordinate API use — retrying";
}

function retryRateLimitBlockPublication(pending, nowMs, publish) {
  const blocks = Array.isArray(pending?.blocks) ? pending.blocks : [];
  if (blocks.length === 0 || blocks.some((block) =>
    !Number.isFinite(block.resetMs) || block.resetMs <= nowMs)) {
    return { status: "probe", pending };
  }
  const results = blocks.map((block) => publish(block.resource, block.resetMs));
  const resetMs = Math.min(...blocks.map((block) => block.resetMs));
  const decision = rateLimitBlockDecision(results, resetMs);
  return decision.failClosed
    ? { status: "waiting", pending: { ...pending, reason: decision.reason } }
    : { status: "published", pending: null, decision };
}

function mergeRateLimitBlockPublications(current, key, blocks, nowMs) {
  const merged = new Map(current);
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (!RATE_RESOURCES.includes(block?.resource)) continue;
    const previous = merged.get(block.resource);
    const previousBlock = previous?.blocks?.[0];
    merged.set(block.resource, {
      key,
      failedAt: Math.min(previous?.failedAt ?? nowMs, nowMs),
      reason: previous?.reason ?? "block-unpublished",
      blocks: [{
        resource: block.resource,
        resetMs: Number.isFinite(previousBlock?.resetMs)
          ? previousBlock.resetMs
          : block.resetMs,
        epoch: validGovernorEpoch(previousBlock?.epoch)
          ? previousBlock.epoch
          : block.epoch,
      }],
    });
  }
  return merged;
}

function hydrateRateLimitBlockPublication(pending, state) {
  const blocks = Array.isArray(pending?.blocks) ? pending.blocks : [];
  return {
    ...pending,
    blocks: blocks.map((block) => {
      const budget = state?.budgets?.[block.resource];
      if (!budget || budget.observedAt <= pending.failedAt) return block;
      return {
        ...block,
        resetMs: Number.isFinite(block.resetMs) ? block.resetMs : budget.resetMs,
        epoch: validGovernorEpoch(block.epoch) ? block.epoch : budget.epoch,
      };
    }),
  };
}

function rateLimitBlockProbeRecovered(pending, state, nowMs) {
  const blocks = Array.isArray(pending?.blocks) ? pending.blocks : [];
  return blocks.length > 0 && blocks.every((block) => {
    const budget = state?.budgets?.[block.resource];
    if (!budget || budget.observedAt <= pending.failedAt) return false;
    if (!validGovernorEpoch(block.epoch)) return false;
    if (budget.epoch === block.epoch) return false;
    return !Number.isFinite(block.resetMs) || nowMs >= block.resetMs;
  });
}

// How long a separately admitted operation may wait for a lane slot the
// governor has already granted it. Every request inside one tab fetch asks a
// moment after the tab's own grant advanced the lane, so without this the second
// request -- a later list page, or the workflow catalog -- is refused every
// single time and the feature never runs at all. A named `notBefore` is a
// schedule, not a refusal; anything past this bound still declines, and
// startReservation revalidates the budget when the wait is over.
const GOVERNOR_ADMISSION_WAIT_MS = 2_000;

async function runAdmittedOperation({
  scope,
  leaseId,
  operation,
  priority = "manual",
  signal,
  run,
  waitMs = 0,
  // One clock for the whole admission, so the wait below is measured against
  // the same time the governor scheduled the slot on.
  now = Date.now,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  let admitted = admitGovernorOperation(scope, leaseId, operation, priority, now());
  const scheduled = admitted.ok &&
    ["scheduled", "waiting"].includes(admitted.value?.status) &&
    typeof admitted.value.reservationId === "string" &&
    Number.isFinite(admitted.value.notBefore)
      ? admitted.value
      : null;
  if (waitMs > 0 && scheduled) {
    // The named slot can already have arrived while the intent was being
    // persisted, so a delay that is gone is retried at once rather than treated
    // as a refusal -- that race alone made this path intermittent.
    const delay = scheduled.notBefore - now();
    if (delay <= waitMs) {
      if (delay > 0) await wait(delay);
      if (!signal?.aborted) {
        admitted = startReservation(scope, scheduled.reservationId, now());
      }
    }
  }
  if (!admitted.ok || admitted.value.status !== "started") {
    // The reservation is named by its intent, so a slot this call decided not
    // to take is released rather than left scheduled against the budget.
    const abandoned = admitted.value?.intentId ??
      (typeof admitted.value?.reservationId === "string"
        ? admitted.value.reservationId.slice(12)
        : scheduled?.reservationId?.slice(12));
    if (validGovernorId(abandoned)) cancelIntent(scope, abandoned, now());
    const detail = admitted.value?.resetMs
      ? ` until ${new Date(admitted.value.resetMs).toISOString()}`
      : admitted.value?.notBefore ? ` until ${new Date(admitted.value.notBefore).toISOString()}` : "";
    return { ok: false, skipped: true, decision: admitted, error: new Error(`API budget paused${detail}`) };
  }
  const reservationId = admitted.value.reservationId;
  const settlementScope = { ...scope, identityProvider: null };
  try {
    const value = await requestIdentityStorage.run(scope, () => run(signal));
    const costs = operationCost(operation);
    completeReservation(settlementScope, reservationId, {
      outcome: "measured-success",
      actualCost: costs,
    }, now());
    if (scope.accessKey && scope.accessKey !== runtimeIdentityCoordinator?.current()?.accessKey) return { ok: false, error: new Error("Credential changed"), reservationId };
    return { ok: true, value, reservationId };
  } catch (error) {
    completeReservation(settlementScope, reservationId, { outcome: governorOutcomeForError(error) }, now());
    return { ok: false, error, reservationId };
  }
}

function pollResultTransition({ key, previousRaw, raw, parse, limit, completedAt }) {
  if (previousRaw === raw) return { kind: "unchanged", completedAt };
  let value;
  try {
    value = parse();
  } catch (error) {
    if (isUnusableOutput(error)) return { kind: "unusable", nextRaw: null };
    throw error;
  }
  if (value?.unusable) return { kind: "unusable", nextRaw: null };
  if (key === "security" && value?.blind) {
    return {
      kind: "blind",
      nextRaw: nextSecurityRaw(previousRaw, raw, true),
      notes: value.notes ?? [],
      blind: true,
    };
  }
  const data = value?.alerts ?? value;
  return {
    kind: "changed",
    nextRaw: key === "security" ? nextSecurityRaw(previousRaw, raw, false) : raw,
    data,
    meta: {
      at: completedAt,
      truncated: value?.truncated ?? data.length >= limit,
    },
    notes: value?.notes,
    blind: Boolean(value?.blind),
  };
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

function tabFailureSuffix({ count, failed, brokenCI }) {
  if (count == null) return failed ? " x" : "";
  return ` (${count}${brokenCI ? "!" : ""}${failed ? "x" : ""})`;
}

function TabBar({ activeIndex, counts, brokenCI, firstLoad, failed, spin, useShort }) {
  return e(
    Box,
    { flexDirection: "row" },
    ...TABS.map((tab, i) => {
      const active = i === activeIndex;
      const count = counts[tab.key];
      // A tab that has never resolved shows the spinner where its count will
      // go, so the first load reads as "working" rather than "empty".
      const suffix =
        count == null
          ? firstLoad[tab.key]
            ? ` ${spin}`
            : tabFailureSuffix({ count, failed: failed[tab.key], brokenCI: false })
          : tabFailureSuffix({
              count,
              failed: failed[tab.key],
              brokenCI: brokenCI[tab.key],
            });
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

// Control-hint glyphs are width-1 ASCII, deliberately, with one exception: the
// Move arrows. Semantic status glyphs come from the selected profile below.
// The return symbol and box-drawing separator stay out because they are
// East-Asian-Ambiguous -- ink measures them as two columns, and a status bar
// built from them overflowed an 80-column terminal by six columns once
// selection added a hint. The arrow pair is a deliberate exception, and it
// is NOT covered by a width assertion -- an earlier version of this comment
// claimed `npm run test:pty` would catch a double-width rendering, and that was
// wrong twice over. Each hint is wrap: "truncate-end", so the failure mode is
// silent text loss rather than overflow, which no width check can see; and at 80
// columns the panel border is 79 cells against a 54-cell status bar, so the bar
// is not what sets the maximum anyway -- the arrows would have to add 25 columns
// to move it, not 2. What actually bounds the risk is that there are two of
// them and the compact breakpoint below keeps the whole set inside the frame.
// Anything wider added here needs its own check, not this comment's assurance.
//
// Tab switching is not listed: the tab bar already renders "1:Actions", so the
// digits document themselves, and the arrow keys are in --help. The hints that
// survive are the ones nothing else on screen reveals.
const KEY_HINTS = [
  { label: "Move", keys: "↑↓" },
  { label: "Open", keys: "Ent" },
  { label: "Refresh", keys: "r" },
  { label: "Width", keys: "w" },
  { label: "Quit", keys: "q" },
];

function activeKeyHints({
  interactive,
  remoteSetup = false,
  canMove = false,
  canOpen = false,
  canResize = false,
}) {
  if (!interactive) return [{ label: "Quit", keys: "^C" }];
  if (remoteSetup) return REMOTE_SETUP_HINTS;
  return KEY_HINTS.filter((hint) => {
    if (hint.label === "Move") return canMove;
    if (hint.label === "Open") return canOpen;
    if (hint.label === "Width") return canResize;
    return true;
  });
}

const REMOTE_SETUP_HINTS = [
  { label: "Create remote", keys: "Ent" },
  { label: "Quit", keys: "q" },
];

const REMOTE_SETUP_LINES = [
  "No GitHub remote found",
  "gh-glance needs a GitHub repository to show this dashboard.",
  "Enter  Start `gh repo create` (choose Push an existing local repository)",
  "q/Esc  Quit, or restart with `gh-glance --repo owner/name`",
];

const REMOTE_SETUP_NONINTERACTIVE_LINES = [
  "No GitHub remote found",
  "Run `gh repo create` in an interactive terminal.",
  "Choose Push an existing local repository.",
  "Or use `gh-glance --repo owner/name`; Ctrl+C quits.",
];

// Reserved so the hints never shift when the active tab changes state. Every
// status label below fits this fixed cell in both icon profiles.
const REFRESH_STATUS_WIDTH = 12;
const WIDE_STATE_WIDTH = REFRESH_STATUS_WIDTH + 1 + 12;
// StatusBar receives the drawable frame width, which is one column narrower
// than the terminal. A 44-cell threshold preserves the 45-column contract.
const WIDE_STATE_MIN_COLS = 44;
const NOTICE_ROWS = 1;

const REFRESH_STATUS_GLYPHS = Object.freeze({
  unicode: Object.freeze({
    setup: "·",
    checking: SPINNER[0],
    paused: "‖",
    failed: "!",
    limited: "?",
    watching: "·",
  }),
  ascii: Object.freeze({
    setup: ".",
    checking: ".",
    paused: "|",
    failed: "!",
    limited: "?",
    watching: ".",
  }),
});

function isMandatoryHint(hint) {
  return hint?.label === "Refresh" || hint?.label === "Quit";
}

function refreshStatus({
  widthMode = false,
  remoteSetup = false,
  visibleLoading = false,
  visibleInFlight = false,
  automaticStatusVisible = false,
  governorDecision = null,
  activeError = null,
  securityIncomplete = false,
  screenReader = false,
} = {}) {
  const status = (kind, glyphKind, label, tone, animate = false, detailKind = null) => ({
    kind,
    glyphKind,
    label,
    tone,
    animate,
    detailKind,
  });
  if (widthMode) return status("width", null, "Width", "normal");
  if (remoteSetup) return status("setup", "setup", "Setup", "inert");
  if (visibleLoading) return status("checking", "checking", "Checking", "active", true);
  if (visibleInFlight && automaticStatusVisible && !screenReader) {
    return status("checking", "checking", "Checking", "active");
  }

  const mode = governorDecision?.mode ?? governorDecision?.status ?? null;
  const detailKind = governorDecision?.detailKind ?? (
    Number.isFinite(governorDecision?.resetMs)
      ? "reset"
      : governorDecision?.probing
        ? "probing"
        : null
  );
  if (mode === "paused" || activeError?.verdict === "rate-limited") {
    return status("paused", "paused", "Paused", "attention", false, detailKind);
  }
  if (["waiting", "pending", "probe"].includes(mode)) {
    const sharing = sharedLaneProvenance(governorDecision).waitCause === "shared-lane";
    const watchingDetail = sharing
      ? "sharing"
      : Number.isFinite(governorDecision?.notBefore) ? "next" : detailKind;
    return status("watching", "watching", "Watching", "inert", false, watchingDetail);
  }
  if (activeError) return status("failed", "failed", "Failed", "attention");
  if (securityIncomplete) return status("limited", "limited", "Limited", "attention");
  return status("watching", "watching", "Watching", "inert");
}

function statusInterval(at, nowMs = Date.now()) {
  if (!Number.isFinite(at) || !Number.isFinite(nowMs)) return null;
  const remaining = at - nowMs;
  if (remaining < 60_000) return "<1m";
  const minutes = Math.ceil(remaining / 60_000);
  return minutes > 99 ? "99m+" : `${minutes}m`;
}

function statusDetailVariants(status, detail, nowMs) {
  if (!status?.detailKind) return [];
  if (status.detailKind === "probing") return ["probing"];
  if (status.detailKind === "sharing") {
    const sharing = sharedLaneProvenance(detail);
    return sharing.waitCause
      ? [`sharing ${sharing.sharingCount}`]
      : [];
  }
  const at = status.detailKind === "next" ? detail?.notBefore : detail?.resetMs;
  const interval = statusInterval(at, nowMs);
  if (!interval) return [];
  return [`${status.detailKind} ${interval}`, interval];
}

function statusBarLayout({
  cols,
  interactive,
  availableHints,
  status,
  detail = null,
  stale = null,
  nowMs = Date.now(),
  version: currentVersion = "",
} = {}) {
  const width = Number.isSafeInteger(cols) ? Math.max(0, cols) : 0;
  const hints = Array.isArray(availableHints) ? availableHints : [];
  const mandatory = hints.filter(isMandatoryHint);
  const optional = hints.filter((hint) => !isMandatoryHint(hint));
  const stateWidth = width >= WIDE_STATE_MIN_COLS
    ? Math.min(width, WIDE_STATE_WIDTH)
    : Math.min(width, REFRESH_STATUS_WIDTH);
  let used = stateWidth;
  const selectedHints = [];
  const separatorWidth = () => selectedHints.length > 0 ? 1 : 0;
  const addHint = (hint, showLabel) => {
    const text = showLabel ? `${hint.label}: ${hint.keys}` : hint.keys;
    const separator = separatorWidth();
    const cost = separator + [...text].length;
    if (used + cost > width) return false;
    selectedHints.push({ ...hint, showLabel, text, start: used + separator });
    used += cost;
    return true;
  };

  for (const [index, hint] of mandatory.entries()) {
    // A full label is optional; every essential key is not. Reserve one
    // separator and the key itself for each action still to come before taking
    // the current action's long form. This keeps both r and q at the 24-column
    // terminal minimum, whose drawable frame is 23 cells wide.
    const remainingMinimum = mandatory.slice(index + 1).reduce(
      (total, candidate) => total + 1 + [...candidate.keys].length,
      0,
    );
    const fullText = `${hint.label}: ${hint.keys}`;
    const fullCost = separatorWidth() + [...fullText].length;
    if (used + fullCost + remainingMinimum <= width) addHint(hint, true);
    else addHint(hint, false);
  }

  const payloadWidth = stateWidth > REFRESH_STATUS_WIDTH
    ? stateWidth - REFRESH_STATUS_WIDTH - 1
    : 0;
  const staleText = typeof stale === "string" ? stale : null;
  const selectedStale = staleText && [...staleText].length <= payloadWidth ? staleText : null;
  let selectedDetail = null;
  if (!selectedStale) {
    selectedDetail = statusDetailVariants(status, detail, nowMs)
      .find((candidate) => [...candidate].length <= payloadWidth) ?? null;
  }

  for (const hint of optional) {
    if (!addHint(hint, true)) addHint(hint, false);
  }

  const versionText = String(currentVersion ?? "");
  const showVersion = versionText.length > 0 && used + 1 + versionText.length <= width;
  return {
    stateWidth,
    hints: selectedHints,
    mandatoryHints: selectedHints.filter(isMandatoryHint),
    optionalHints: selectedHints.filter((hint) => !isMandatoryHint(hint)),
    detail: selectedDetail,
    stale: selectedStale,
    version: showVersion ? versionText : null,
    interactive: Boolean(interactive),
  };
}

function freshnessDeadline({
  lastOk,
  refreshMs,
  grantedMs = null,
  governorDecision = null,
  currentEpochs = null,
} = {}) {
  if (!Number.isFinite(lastOk) || !Number.isFinite(refreshMs) || refreshMs < 0) return null;
  const cadenceMs = Number.isFinite(grantedMs) && grantedMs >= 0 ? grantedMs : refreshMs;
  const baseDeadline = lastOk + Math.max(STALE_AFTER_MS, cadenceMs * 6);
  const decisionEpochs = governorDecision?.epochs;
  const chargedEpochs = isRecord(decisionEpochs)
    ? Object.entries(decisionEpochs).filter(([, epoch]) => epoch !== null)
    : [];
  const validWaitingGrant =
    (governorDecision?.mode ?? governorDecision?.status) === "waiting" &&
    Number.isFinite(governorDecision.notBefore) &&
    chargedEpochs.length > 0 &&
    isRecord(currentEpochs) &&
    chargedEpochs.every(([resource, epoch]) => currentEpochs[resource] === epoch);
  return validWaitingGrant
    ? Math.max(baseDeadline, governorDecision.notBefore + GH_TIMEOUT_MS)
    : baseDeadline;
}

function nextAdmittedCadence(previous, startedAt) {
  if (!Number.isFinite(startedAt)) return previous ?? { startedAt: null, grantedMs: null };
  return {
    startedAt,
    grantedMs: Number.isFinite(previous?.startedAt)
      ? Math.max(0, startedAt - previous.startedAt)
      : null,
  };
}

function probingGovernorDecisions() {
  return Object.fromEntries(TABS.map((candidate) => [candidate.key, {
    mode: "waiting",
    probing: true,
  }]));
}

function retainDeferredGovernorHold({ automaticStatusVisible, screenReader }) {
  return automaticStatusVisible === true && screenReader === true;
}

function sameVisibleGovernorDecision(left, right) {
  if (left === right) return true;
  if (!left || !right) return false;
  for (const key of [
    "mode",
    "status",
    "reason",
    "resetMs",
    "retryAt",
    "notBefore",
    "resource",
    "probing",
    "detailKind",
    "waitCause",
    "sharingCount",
    "coordinationError",
    "reservationId",
  ]) {
    if (left[key] !== right[key]) return false;
  }
  return left.epochs?.core === right.epochs?.core &&
    left.epochs?.graphql === right.epochs?.graphql;
}

function widthStatusText({ label, width, cols, saveError = false }) {
  const budget = Number.isSafeInteger(cols) ? Math.max(0, cols) : 0;
  const safeLabel = String(label ?? "").replace(/[^\x20-\x7e]/g, "?");
  const safeWidth = Number.isSafeInteger(width) ? String(width) : "?";
  const variants = saveError
    ? [
        `Width: ${safeLabel} ${safeWidth}  Widths not saved`,
        `${safeLabel} ${safeWidth}  Widths not saved`,
        "Widths not saved",
      ]
    : [
        `Width: ${safeLabel} ${safeWidth}  Tab select  <- -> resize  r reset  Esc done`,
        `Width: ${safeLabel} ${safeWidth}  <- -> resize  r reset  Esc done`,
        `${safeLabel} ${safeWidth}  <- ->  r reset  Esc done`,
        `${safeLabel} ${safeWidth} <- -> r Esc`,
      ];
  const fitting = variants.find((variant) => variant.length <= budget);
  return fitting ?? variants[variants.length - 1].slice(0, budget);
}

// Compact drops the labels and keeps the keys, separated by a space:
// "↑↓ Ent r q". No constant for its width -- nothing branches on it, and the
// keys are short enough that it fits anywhere the frame itself does.
//
// The band where the full set fits. Below it the bar was the one part of the
// layout with no width awareness -- the table swaps to a compact header, the tab
// bar swaps to short labels, the panel edges drop their labels, and the status
// bar just let ink truncate. Because each hint is wrap: "truncate-end", the
// failure was silent text loss rather than overflow: at 45 columns the rendered
// bar read "Move: | Open:  | Refresh |Quit:…" -- the arrows gone, Refresh
// missing its key, and Quit, the last entry, first to be cut. That is the one
// hint a confused first-time user needs, in a full-screen alternate-screen app.
// Two tones rather than one flat gray: the keys you press are the part worth
// finding at a glance, so they get the accent colour and the words describing
// them stay dim. The accent is the panel-title cyan rather than the amber used
// for in-progress status, so amber means exactly one thing across the product.
function StatusBar({
  status,
  detail,
  spin,
  stale,
  nowMs,
  interactive,
  cols,
  remoteSetup = false,
  widthMode = false,
  widthColumn = null,
  widthSaveError = null,
  canMove = false,
  canOpen = false,
  canResize = false,
}) {
  // Width mode owns the whole bar, so coordination detail is deliberately not
  // shown here. This state is transient and explicitly entered; the active-tab
  // refresh state returns as soon as the user leaves it.
  if (widthMode && widthColumn) {
    return e(
      Box,
      { flexDirection: "row" },
      e(
        Text,
        { color: widthSaveError ? ATTENTION : undefined, wrap: "truncate-end" },
        widthStatusText({
          label: widthColumn.label,
          width: widthColumn.props.width,
          cols,
          saveError: Boolean(widthSaveError),
        }),
      ),
    );
  }
  // Without raw mode none of the key handlers run, so advertising them would be
  // telling the user something untrue about what the app can do. Ctrl+C still
  // works there, because the tty delivers a real SIGINT.
  const hints = activeKeyHints({ interactive, remoteSetup, canMove, canOpen, canResize });
  const semanticStatus = status ?? refreshStatus({ remoteSetup });
  const layout = statusBarLayout({
    cols,
    interactive,
    availableHints: hints,
    status: semanticStatus,
    detail,
    stale,
    nowMs,
    version,
  });
  const profile = ICON_PROFILE === "ascii" ? "ascii" : "unicode";
  const glyphs = REFRESH_STATUS_GLYPHS[profile];
  const glyph = profile !== "ascii" &&
      semanticStatus.glyphKind === "checking" && semanticStatus.animate && spin
    ? spin
    : glyphs[semanticStatus.glyphKind] ?? glyphs.watching;
  const statusColor = semanticStatus.tone === "active"
    ? TITLE_COLOR
    : semanticStatus.tone === "attention"
      ? ATTENTION
      : undefined;
  const renderHint = (hint, index, group) => [
    (index > 0 || group === "optional") &&
      e(Text, { key: `${group}:sep:${hint.label}`, color: BORDER_COLOR }, " "),
    e(
      Text,
      { key: `${group}:${hint.label}`, wrap: "truncate-end" },
      hint.showLabel ? e(Text, { dimColor: true }, `${hint.label}: `) : null,
      e(Text, { color: TITLE_COLOR, bold: true }, hint.keys),
    ),
  ].filter(Boolean);
  return e(
    Box,
    { flexDirection: "row" },
    e(
      Box,
      { width: layout.stateWidth, flexShrink: 0, flexDirection: "row" },
      e(
        Text,
        { color: statusColor, dimColor: semanticStatus.tone === "inert", wrap: "truncate-end" },
        `${glyph} ${semanticStatus.label}`,
      ),
      layout.detail
        ? e(Box, { marginLeft: 1, flexShrink: 0 }, e(Text, { dimColor: true }, layout.detail))
        : null,
      layout.stale
        ? e(Box, { marginLeft: 1, flexShrink: 0 }, e(Text, { color: ATTENTION }, layout.stale))
        : null,
    ),
    ...layout.mandatoryHints.flatMap((hint, index) => renderHint(hint, index, "mandatory")),
    ...layout.optionalHints.flatMap((hint, index) => renderHint(hint, index, "optional")),
    layout.version && e(Box, { flexGrow: 1 }),
    layout.version && e(Text, { key: "version", dimColor: true, wrap: "truncate-end" }, layout.version),
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

function App({ onCreateRemote = () => {} } = {}) {
  const screenReader = process.env.INK_SCREEN_READER === "true";
  const { stdout } = useStdout();
  const { isRawModeSupported } = useStdin();
  const { exit, suspendTerminal } = useApp();
  const [activeIndex, setActiveIndex] = useState(runtime.initialTabIndex);
  const [preferencePath] = useState(() => widthPreferencesPath());
  const [loadedWidthPreferences] = useState(() => loadWidthPreferences(preferencePath));
  const [widthOverrides, setWidthOverrides] = useState(() => loadedWidthPreferences.preferences);
  const widthOverridesRef = useRef(widthOverrides);
  widthOverridesRef.current = widthOverrides;
  const widthPersistedRef = useRef(loadedWidthPreferences.preferences);
  const [widthSaveError, setWidthSaveError] = useState(null);
  const widthPreferencesMountedRef = useRef(true);
  const [widthPreferenceWriter] = useState(() =>
    createWidthPreferenceWriter({
      write: (overrides) => {
        const result = saveWidthPreferences(preferencePath, overrides, TABS, {
          base: widthPersistedRef.current,
        });
        adoptPersistedSnapshot(result, widthPersistedRef, widthOverridesRef);
        return result;
      },
      onResult: (result) => {
        if (!widthPreferencesMountedRef.current) return;
        if (result?.ok === true) {
          setWidthOverrides((current) =>
            samePersistedValue(current, result.persisted) ? current : result.persisted,
          );
        }
        setWidthSaveError(
          result?.ok === false
            ? (result.error ?? new Error("Width preferences could not be saved"))
            : null,
        );
      },
    }),
  );
  useEffect(() => {
    widthPreferencesMountedRef.current = true;
    return () => {
      // saveWidthPreferences() itself runs synchronously inside dispose(), but
      // writer result reporting settles through a promise. Mark unmounted first
      // so that later callback cannot enqueue state on a departing App.
      widthPreferencesMountedRef.current = false;
      void widthPreferenceWriter.dispose();
    };
  }, [widthPreferenceWriter]);
  const [cachePath] = useState(() => dashboardCachePath());
  const [cacheTarget] = useState(() =>
    dashboardCacheTarget({
      repo: runtime.repo,
      ghRepo: process.env.GH_REPO,
      host: runtimeIdentityCoordinator?.current()?.host ?? effectiveRuntimeHost(),
      cwd: process.cwd(),
      account: runtimeIdentityCoordinator?.current()?.accessKey ?? "unverified",
    }),
  );
  const [loadedCache] = useState(() => loadDashboardCache(cachePath, cacheTarget));
  const dashboardCacheRef = useRef(loadedCache.cache);
  const dashboardCachePersistedRef = useRef(loadedCache.cache);
  const dashboardCacheTargetRef = useRef(cacheTarget);
  const [dashboardCacheWriter] = useState(() =>
    createCoalescedWriter({
      write: (cache) => {
        const result = saveDashboardCache(cachePath, cache, {
          normalized: true,
          base: dashboardCachePersistedRef.current,
        });
        adoptPersistedSnapshot(result, dashboardCachePersistedRef, dashboardCacheRef);
        return result;
      },
    }),
  );
  useEffect(() => () => {
    // Production writes start synchronously, so a pending latest snapshot is
    // not lost on quit. The cache is bounded; ignoring the advisory result keeps
    // a filesystem error from replacing terminal teardown.
    void dashboardCacheWriter.dispose();
  }, [dashboardCacheWriter]);
  const cachedEntry = loadedCache.entry;
  // `null` means "never resolved" -- distinct from `[]`, which means "resolved
  // and genuinely empty". The tab bar and the body render those differently.
  const [data, setData] = useState(() =>
    Object.fromEntries(TABS.map((candidate) => [candidate.key, cachedEntry?.tabs[candidate.key]?.data ?? null])),
  );
  const dataRef = useRef(data);
  dataRef.current = data;
  // The workflow catalog, kept across polls so a repository whose runs carry no
  // name of their own asks for it once every fifteen minutes rather than twice
  // per poll. A ref because it must not redraw anything by itself.
  const workflowCatalogRef = useRef(null);
  // What each paged tab has actually loaded, and whether more exists. Demand is
  // a page count so that holding `j` near the end asks for one more page rather
  // than one per keystroke.
  const pageStateRef = useRef({});
  const [meta, setMeta] = useState(() =>
    Object.fromEntries(TABS.map((candidate) => [candidate.key, cachedEntry?.tabs[candidate.key]?.meta ?? null])),
  );
  const metaRef = useRef(meta);
  metaRef.current = meta;
  const [securityNotes, setSecurityNotes] = useState(() => cachedEntry?.securityNotes ?? []);
  const securityNotesRef = useRef(securityNotes);
  securityNotesRef.current = securityNotes;
  // Whether the Security tab is currently unable to see its endpoints, as
  // opposed to seeing that they are switched off. Drives the count marker.
  const [securityBlind, setSecurityBlind] = useState(() => cachedEntry?.securityBlind ?? false);
  const securityBlindRef = useRef(securityBlind);
  securityBlindRef.current = securityBlind;
  // The `?` overlay. Renders only on a keypress, so consecutive idle frames are
  // still byte-identical and the redraw suppression is untouched.
  const [showHelp, setShowHelp] = useState(false);
  // Set once, ICON_HINT_AFTER_MS into a first load that is still running. Never
  // reset: it only gates a line that a resolved tab stops rendering anyway, and
  // clearing it would cost a second state write for no visible difference.
  const [iconHintDue, setIconHintDue] = useState(false);
  const [errors, setErrors] = useState({ actions: null, issues: null, prs: null, security: null });
  const [failureContext, setFailureContext] = useState(null);
  const [loading, setLoading] = useState({ actions: false, issues: false, prs: false, security: false });
  const [waiting, setWaiting] = useState({ actions: true, issues: true, prs: true, security: true });
  const [governorDecisions, setGovernorDecisions] = useState(probingGovernorDecisions);
  const [governorEpochs, setGovernorEpochs] = useState(null);
  const [requestStatuses, setRequestStatuses] = useState(() =>
    Object.fromEntries(TABS.map((candidate) => [candidate.key, null])),
  );
  const [visibleCoordinationCondition, setVisibleCoordinationCondition] = useState(null);
  const [now, setNow] = useState(new Date());
  const { rows, cols, useShortLabels } = useTerminalSize(stdout);
  const [frame, setFrame] = useState(0);
  // Per tab, so switching away and back keeps your place. Keyed by item, and
  // both are plain state: they change only on a keypress, so an idle repo still
  // renders byte-identical frames and ink still writes nothing.
  const [selected, setSelected] = useState({});
  const [offset, setOffset] = useState({});
  const [widthMode, setWidthMode] = useState(false);
  const [selectedWidthKeyByTab, setSelectedWidthKeyByTab] = useState({});

  const tab = TABS[activeIndex];
  const tabError = errors[tab.key];
  const activeGovernorDecision = governorDecisions[tab.key];
  const activeRequestStatus = requestStatuses[tab.key];
  // Once any endpoint proves the folder has no remote, the whole dashboard is
  // in setup mode. Keeping this tab-local made a quick tab switch replace the
  // onboarding prompt with a second raw fetch failure while another command
  // was still settling.
  const remoteSetup = Object.values(errors).some(
    (error) => error?.kind === "fetch" && error.verdict === "no-remote",
  );
  // The not-enabled notes are collapsed into a single line. Each unavailable
  // alert source used to contribute a full-width row above the column header,
  // and on any repo without Advanced Security that is two permanent lines --
  // roughly 10% of a twenty-row pane, forever, restating a fact that will never
  // change, on the tab whose job is making real alerts stand out. Failures that
  // are NOT "not enabled" keep their own lines: those are actionable and
  // transient, and they are the ones worth the space. Derived here at render
  // time rather than cached alongside the notes, because the unchanged-payload
  // short-circuit can skip parse() entirely and a cached string would go stale.
  const NOT_ENABLED = /not enabled/i;
  const disabledNotes = securityNotes.filter((n) => NOT_ENABLED.test(n));
  const otherNotes = securityNotes.filter((n) => !NOT_ENABLED.test(n));
  const securityLines =
    disabledNotes.length > 1
      ? [
          `${disabledNotes.map((n) => n.split(":")[0]).join(", ")}: not enabled here`,
          ...otherNotes,
        ]
      : securityNotes;
  // Counts the lines actually rendered, not the notes collected -- getting this
  // wrong by one row is what makes ink repaint the whole frame.
  const extraLines =
    NOTICE_ROWS +
    (tab.key === "security" && !remoteSetup ? securityLines.length : 0);
  // Reserve lines for: the tab bar and the divider under it (2), the panel's
  // top and bottom edges (2), the column header and its separator (2), and
  // the status line (1), plus a 1-line safety margin. Slack is absorbed by
  // the spacer in the tree below.
  const bodyRows = Math.max(1, rows - 8 - extraLines);

  // Read at fetch time rather than being a hook dependency, so dragging the
  // pane wider doesn't cancel and restart in-flight requests -- the next tick
  // simply asks for the new size.

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
  const admittedCadenceRef = useRef({});
  const rawRef = useRef({});
  const entityRef = useRef(new Map());
  // Last *successful* poll per tab, wall-clock. Wall-clock on purpose: a laptop
  // sleeping is exactly the gap this is meant to report, and a monotonic clock
  // does not advance across suspend. Never written on the failure path, or a
  // persistently failing tab would report itself fresh forever.
  const lastOkRef = useRef(
    Object.fromEntries(
      TABS.flatMap((candidate) => {
        const lastOk = cachedEntry?.tabs[candidate.key]?.lastOk;
        return lastOk == null ? [] : [[candidate.key, lastOk]];
      }),
    ),
  );
  const fetchTabRef = useRef(null);
  const contextCoordinatorRef = useRef(null);
  const governorRef = useRef(null);

  const interactive = Boolean(isRawModeSupported);

  // useInput's handler is created before the render body computes the visible
  // slice, so the movement handlers read through a ref -- the same pattern the
  // poll loop uses for activeIndexRef, and for the same reason:
  // the closure must see current values without being rebuilt on every change.
  const navRef = useRef({ items: [], key: null, bodyRows: 1, tabKey: "actions", offset: 0 });
  navRef.current = {
    items: data[tab.key] ?? [],
    key: selected[tab.key] ?? null,
    bodyRows,
    tabKey: tab.key,
    offset: offset[tab.key] ?? 0,
  };
  const pageStep = Math.max(1, bodyRows - 1);

  // Read through a ref for the same reason the poll loop does: the useInput
  // closure must see the current value without being rebuilt on every toggle.
  const showHelpRef = useRef(false);
  showHelpRef.current = showHelp;
  const remoteSetupRef = useRef(false);
  remoteSetupRef.current = remoteSetup;
  const headerRef = useRef(null);
  const dragRef = useRef(null);
  const resizeRef = useRef({
    active: false,
    tabKey: "actions",
    selectedKey: null,
    effectiveHeader: null,
    frameCols: 0,
    compact: true,
    fullHeaderVisible: false,
  });

  useEffect(() => {
    if (!shouldEnableMouseReporting({ interactive, widthMode })) {
      disableMouseReporting();
      return;
    }
    enableMouseReporting();
    return () => {
      dragRef.current = null;
      disableMouseReporting();
    };
  }, [interactive, widthMode]);

  function applyWidthOverrides(next) {
    const current = widthOverridesRef.current;
    if (next === current) return false;
    widthOverridesRef.current = next;
    setWidthOverrides(next);
    // Schedule in the input turn, not a post-render effect. Reset, mode exit and
    // quit all flush immediately, and must not race ahead of React committing the
    // state that contains the latest width.
    widthPreferenceWriter.schedule(next);

    const geometry = resizeRef.current;
    const activeTab = tabForKey(geometry.tabKey);
    if (activeTab) {
      const nextTabOverrides = pick(next, activeTab.key, EMPTY_WIDTH_OVERRIDES) ??
        EMPTY_WIDTH_OVERRIDES;
      const effective = effectiveHeaderFor(activeTab, nextTabOverrides, geometry.frameCols);
      resizeRef.current = {
        ...geometry,
        effectiveHeader: effective,
        compact: effective == null,
        fullHeaderVisible: geometry.fullHeaderVisible && effective != null,
      };
    }
    return true;
  }

  function flushWidthPreferences() {
    void widthPreferenceWriter.flush();
  }

  function leaveWidthMode() {
    dragRef.current = null;
    resizeRef.current = { ...resizeRef.current, active: false };
    setWidthMode(false);
    flushWidthPreferences();
  }

  function rememberWidthSelection(key) {
    if (key === null) return;
    const tabKey = resizeRef.current.tabKey;
    resizeRef.current = { ...resizeRef.current, selectedKey: key };
    setSelectedWidthKeyByTab((current) =>
      current[tabKey] === key ? current : { ...current, [tabKey]: key },
    );
  }

  function enterWidthMode(requestedKey = null) {
    const geometry = resizeRef.current;
    if (!geometry.fullHeaderVisible || geometry.compact) return false;
    const activeTab = tabForKey(geometry.tabKey);
    const selectedKey = selectWidthKey(activeTab, requestedKey ?? geometry.selectedKey);
    if (selectedKey === null) return false;
    rememberWidthSelection(selectedKey);
    resizeRef.current = { ...resizeRef.current, active: true, selectedKey };
    setWidthMode(true);
    return true;
  }

  function resizeSelectedWidth(delta) {
    const geometry = resizeRef.current;
    if (!geometry.active || !geometry.fullHeaderVisible || geometry.compact) return;
    const activeTab = tabForKey(geometry.tabKey);
    const column = geometry.effectiveHeader?.find(
      (candidate) => candidate.key === geometry.selectedKey,
    );
    if (!activeTab || !isAdjustableWidthColumn(column)) return;
    const next = updateWidthPreference({
      overrides: widthOverridesRef.current,
      tab: activeTab,
      key: geometry.selectedKey,
      nextWidth: column.props.width + delta,
      effectiveHeader: geometry.effectiveHeader,
      frameCols: geometry.frameCols,
    });
    applyWidthOverrides(next);
  }

  function resetSelectedWidth() {
    dragRef.current = null;
    const { tabKey, selectedKey } = resizeRef.current;
    applyWidthOverrides(resetWidthPreference(widthOverridesRef.current, tabKey, selectedKey));
    flushWidthPreferences();
  }

  function resetActiveTabWidths() {
    dragRef.current = null;
    const { tabKey } = resizeRef.current;
    applyWidthOverrides(resetTabWidthPreferences(widthOverridesRef.current, tabKey));
    flushWidthPreferences();
  }

  const cancelWidthDrag = useCallback(() => {
    if (dragRef.current === null) return false;
    dragRef.current = null;
    void widthPreferenceWriter.flush();
    return true;
  }, [widthPreferenceWriter]);

  const measuredHeader = useCallback(() => {
    return headerRef.current ? measureElement(headerRef.current) : null;
  }, []);

  function handleSgrMouse(event) {
    if (event.action === "release") {
      dragRef.current = null;
      flushWidthPreferences();
      return;
    }

    const geometry = resizeRef.current;
    if (event.action === "press") {
      if (!interactive || !geometry.active || !geometry.fullHeaderVisible || geometry.compact) return;
      const metrics = measuredHeader();
      if (!metrics) return;
      const drag = beginDividerDrag({
        event,
        handles: dividerHandles({ header: geometry.effectiveHeader, metrics }),
        tabKey: geometry.tabKey,
      });
      if (!drag || !enterWidthMode(drag.key)) return;
      dragRef.current = { ...drag, metrics };
      return;
    }

    const drag = dragRef.current;
    if (!drag) return;
    const metrics = measuredHeader();
    const layoutValid = sameElementMetrics(drag.metrics, metrics);
    const proposal = draggedWidth({
      drag,
      event,
      tabKey: geometry.tabKey,
      fullHeaderVisible: geometry.fullHeaderVisible,
      layoutValid,
    });
    if (!proposal) {
      if (!layoutValid || drag.tabKey !== geometry.tabKey || !geometry.fullHeaderVisible) {
        cancelWidthDrag();
      }
      return;
    }

    const activeTab = tabForKey(geometry.tabKey);
    if (!activeTab) {
      cancelWidthDrag();
      return;
    }
    applyWidthOverrides(
      updateWidthPreference({
        overrides: widthOverridesRef.current,
        tab: activeTab,
        key: proposal.key,
        nextWidth: proposal.nextWidth,
        effectiveHeader: geometry.effectiveHeader,
        frameCols: geometry.frameCols,
      }),
    );
  }

  function moveSelection(delta) {
    const { items, key: currentKey, bodyRows: rows_, tabKey, offset: offsetRaw } = navRef.current;
    if (items.length === 0) return;
    const current = currentKey == null ? -1 : items.findIndex((i) => itemKey(i) === currentKey);
    const maxStart = Math.max(0, items.length - rows_);
    // Re-clamped here for the same reason the render path re-clamps: the payload
    // can shrink between ticks, so a stored offset can point past the end.
    const start = Math.min(Math.max(0, offsetRaw), maxStart);
    // From "nothing selected", seed from what is on screen -- down takes the
    // first visible row, up the last. It used to take row 0 / the final row of
    // the whole list, which meant the 60s idle clear silently cost you your
    // place: scroll to row 80 of 150, read for a minute, press down, and you
    // were back at row 1 with no scroll animation to notice. For an unscrolled
    // list that fits the pane this is the same behaviour as before.
    const next =
      current === -1
        ? delta > 0
          ? start
          : Math.min(items.length - 1, start + rows_ - 1)
        : Math.min(items.length - 1, Math.max(0, current + delta));
    setSelected((s) => ({ ...s, [tabKey]: itemKey(items[next]) }));
    demandPages(tabKey, next, items.length);
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

  // A cursor within PAGE_DEMAND_THRESHOLD rows of the end is the only thing
  // that asks for another page. Demand is a count rather than an event, so ten
  // keystrokes near the bottom acquire one page, and a tab nobody scrolled
  // never acquires a second one at all.
  function demandPages(tabKey, selectedIndex, loadedRows) {
    const state = pageStateRef.current[tabKey];
    if (!state) return;
    const wanted = demandedPageCount(state.pages, {
      selectedIndex,
      loadedRows,
      hasNextPage: state.hasNextPage,
    });
    if (wanted <= state.pages) return;
    state.pages = wanted;
    // Manual priority: the user is scrolling toward rows that are not loaded.
    fetchTabRef.current?.(tabKey, { kind: "manual" });
  }

  // Rearms on every call to moveSelection (it's the only thing that changes
  // `selected`), so this fires exactly 60s after the *last* movement -- tab
  // switches and Enter don't count as activity and don't push it back. Clears
  // every tab's cursor at once rather than just the visible one, so a tab you
  // switch back to after being idle doesn't still show a stale row marked.
  useEffect(() => {
    if (Object.keys(selected).length === 0) return;
    const timer = setTimeout(() => {
      setSelected({});
      // Extra pages are held for a cursor. With no cursor there is nothing to
      // scroll toward, so they stop being refreshed on the next poll.
      for (const state of Object.values(pageStateRef.current)) state.pages = 1;
    }, SELECTION_IDLE_MS);
    return () => clearTimeout(timer);
  }, [selected]);

  // Guarded per item, not globally: holding Enter down produces terminal key
  // repeat at ~30/s, and every event used to spawn another `gh <kind> view --web`
  // and open another browser tab. The `r` key next to it already guards this way
  // through the poll loop's in-flight map; Enter simply never did. Keyed by item
  // rather than by tab so that moving to a different row and opening it
  // immediately still works -- selection does not move on Enter, so a second
  // press within the window is always a duplicate of the first.
  const [openRequests] = useState(() => createOpenRequestRegistry());
  useEffect(() => () => openRequests.abortAll(), [openRequests]);

  function openSelected() {
    const { items, key: currentKey, tabKey } = navRef.current;
    const item = items.find((i) => itemKey(i) === currentKey);
    if (!item) return;
    const guard = `${tabKey}:${itemKey(item)}`;
    // Fire and forget: a browser launch must not block the render loop, and a
    // failure surfaces through the tab's normal error line rather than as an
    // unhandled rejection.
    openRequests
      .start(guard, ({ signal }) => openInBrowser(tabKey, item, signal, governorRef.current))
      ?.catch((err) => {
        if (err?.name === "AbortError") return;
        setErrors((x) => ({ ...x, [tabKey]: textTabError(err) }));
      });
  }

  useInput(
    (input, key) => {
      // Ink delivers a complete unrecognised CSI token with its leading Escape
      // removed. Consume the whole SGR namespace here, including unsupported
      // buttons/modifiers, so no report can fall through to keyboard bindings.
      if (input.startsWith("[<")) {
        const mouse = parseSgrMouse(input);
        if (mouse) handleSgrMouse(mouse);
        return;
      }
      if (input === "q" || (input === "c" && key.ctrl)) {
        openRequests.abortAll();
        flushWidthPreferences();
        exit();
      } else if (resizeRef.current.active) {
        if (input === "w" || key.return || key.escape) {
          leaveWidthMode();
        } else if (key.tab) {
          const activeTab = tabForKey(resizeRef.current.tabKey);
          rememberWidthSelection(
            cycleWidthKey(activeTab, resizeRef.current.selectedKey, key.shift ? -1 : 1),
          );
        } else if (key.leftArrow) {
          resizeSelectedWidth(key.shift ? -5 : -1);
        } else if (key.rightArrow) {
          resizeSelectedWidth(key.shift ? 5 : 1);
        } else if (input === "r") {
          resetSelectedWidth();
        } else if (input === "R") {
          resetActiveTabWidths();
        }
        // Width mode owns every other key. In particular, digits, arrows, Tab,
        // Enter and r must never fall through to their ordinary meanings.
      } else if (key.escape) {
        openRequests.abortAll();
        flushWidthPreferences();
        exit();
      } else if (showHelpRef.current) {
        // Any key dismisses -- except quit, handled above, which must never be
        // swallowed by a modal in a full-screen app. Deliberately does not fall
        // through to the binding the key would normally trigger: closing the
        // overlay is the whole intent of that press.
        setShowHelp(false);
      } else if (input === "?") {
        setShowHelp(true);
      } else if (input === "w") {
        enterWidthMode();
      } else if (key.downArrow || input === "j") {
        moveSelection(1);
      } else if (key.upArrow || input === "k") {
        moveSelection(-1);
      } else if (key.pageDown) {
        moveSelection(pageStep);
      } else if (key.pageUp) {
        moveSelection(-pageStep);
      } else if (key.return) {
        if (remoteSetupRef.current) onCreateRemote(suspendTerminal);
        else openSelected();
      } else if (input === "r" || input === "R") {
        // Goes through the same per-tab in-flight guard as the poll loop, so
        // holding the key down cannot stack concurrent subprocesses. Both keys
        // bypass the scheduled deadline and the tab's failure ladder -- the user
        // is saying "try again now", and a refresh that silently declined to
        // refresh would be worse than no key at all. Only `R` also drops the
        // validators: `r` on a quiet repository answers 304 and costs nothing,
        // which is exactly when the key is most likely to be pressed.
        const request = manualRefreshRequest(refreshIntent(input));
        if (request) fetchTabRef.current?.(TABS[activeIndexRef.current].key, request);
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

  // Deliberately mount-only. Every changing value this closure needs is read
  // through a ref so tab changes and terminal resizes do not tear down the
  // lease, timers, or in-flight work.
  //
  // exhaustive-deps is satisfied as written -- every captured value is a ref,
  // a setState function, or the stable cache writer created once above. If a
  // changing dependency ever becomes necessary, that is the signal that the
  // mount-only contract has been broken.
  //
  // The data, control, and heartbeat schedulers are independent one-shot
  // timers. Each callback computes and arms its next wake inside this effect.
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    registerLiveAbort(controller);
    const withTargetHost = (context) => ({
      ...context,
      targetHost: failureTargetHost({
        runtimeHost: runtime.host,
        ghHost: process.env.GH_HOST,
        ghRepo: process.env.GH_REPO,
        accounts: context.accounts,
      }),
    });
    const coordinator = createFailureContextCoordinator({
      resolve: async (signal) => withTargetHost(await resolveFailureContext(signal, governorRef.current)),
      commit: (context) => {
        if (!cancelled) setFailureContext(context);
      },
      fallback: withTargetHost(missingFailureContext()),
    });
    contextCoordinatorRef.current = coordinator;

    function cacheSuccessfulTab(key, tabData, tabMeta, lastOk, security = {}) {
      const target = dashboardCacheTargetRef.current;
      const currentCache = dashboardCacheRef.current;
      const currentEntry = pick(currentCache, target, null) ?? {
        tabs: {},
        securityNotes: [],
        securityBlind: false,
        updatedAt: lastOk,
      };
      const nextEntry = {
        ...currentEntry,
        tabs: {
          ...currentEntry.tabs,
          [key]: { data: tabData, meta: tabMeta, lastOk },
        },
        securityNotes:
          key === "security" ? (security.notes ?? []) : currentEntry.securityNotes,
        securityBlind:
          key === "security" ? Boolean(security.blind) : currentEntry.securityBlind,
        updatedAt: lastOk,
      };
      const nextCache = mergeDashboardCacheEntry(currentCache, target, nextEntry);
      dashboardCacheRef.current = nextCache;
      dashboardCacheWriter.schedule(nextCache);
    }

    // Each tab commits its own result the moment it lands instead of waiting on
    // a Promise.allSettled barrier. Actions is by far the slowest fetch, so
    // barrelling everything together meant the three fast tabs sat invisible
    // behind it and nothing at all appeared until the slowest call returned.

    function setTabGovernorDecision(key, decision) {
      setGovernorDecisions((current) => sameVisibleGovernorDecision(current[key], decision)
        ? current
        : { ...current, [key]: decision });
    }

    function setTabWaiting(key, value) {
      setWaiting((current) => current[key] === value
        ? current
        : { ...current, [key]: value });
    }

    function publishGovernorEpochs(snapshot) {
      const epochs = snapshot?.value?.epochs;
      if (!isRecord(epochs)) return;
      setGovernorEpochs((current) =>
        current?.core === epochs.core && current?.graphql === epochs.graphql
          ? current
          : { core: epochs.core ?? null, graphql: epochs.graphql ?? null });
    }

    function visibleGovernorDecision(decision) {
      const mode = decision?.mode ?? decision?.status ?? "pending";
      if (mode === "paused" || decision?.reason === "reset") {
        return {
          ...decision,
          mode: "paused",
          detailKind: Number.isFinite(decision?.resetMs) ? "reset" : decision?.detailKind,
        };
      }
      if (["waiting", "pending", "probe"].includes(mode) ||
        mode === "scheduled" && Number.isFinite(decision?.notBefore)) {
        return {
          ...decision,
          mode: "waiting",
          probing: mode === "probe" || decision?.reason === "budget-unknown",
        };
      }
      return null;
    }

    function pauseCoordination(key, reason) {
      setTabGovernorDecision(key, {
        mode: "paused",
        reason: reason ?? "unavailable",
        coordinationError: true,
      });
    }

    // A folder with no repository target goes straight to setup. The no-remote
    // verdict is normally a fetch failure, but nothing can be fetched here --
    // there is no host to verify against -- so the same verdict is recorded on
    // every tab before coordination is attempted. remoteSetupRef then keeps the
    // scheduler out, and the Enter hint hands off to `gh repo create`.
    function enterRemoteSetup() {
      if (!runtimeHasNoRepositoryTarget()) return false;
      const failure = toTabError(new Error(NO_REMOTE_ERROR_TEXT));
      setErrors(Object.fromEntries(TABS.map((t) => [t.key, failure])));
      return true;
    }

    function publishControlStatus(key, refreshed, snapshot, nowMs) {
      if (pendingBlockPublications.size > 0) {
        pauseCoordination(key, "block-unpublished");
        return;
      }
      if (!refreshed?.ok) {
        pauseCoordination(key, refreshed?.reason);
        return;
      }
      if (!snapshot?.ok) {
        pauseCoordination(key, snapshot?.reason);
        return;
      }
      publishGovernorEpochs(snapshot);
      if (refreshed.value?.status === "waiting") {
        setTabGovernorDecision(key, { mode: "waiting", probing: true });
        return;
      }
      if (screenReader && inFlightRef.current[key]) return;
      const pendingIntent = pending.get(key);
      const reservation = pendingIntent
        ? snapshot.value.reservations[`reservation:${pendingIntent.intentId}`]
        : null;
      if (reservation?.status === "scheduled" && reservation.notBefore > nowMs) {
        setTabGovernorDecision(key, visibleGovernorDecision({
          status: "scheduled",
          reservationId: `reservation:${pendingIntent.intentId}`,
          ...reservation,
          ...currentSharedLaneProvenance(pendingIntent, snapshot.value.leases, nowMs),
        }));
        return;
      }
      const costs = tabRequestCost(key);
      for (const resource of RATE_RESOURCES) {
        if (costs[resource] <= 0) continue;
        const budget = snapshot.value.budgets[resource];
        const decision = budget
          ? resourceDecision({
              budget,
              resource,
              leases: snapshot.value.leases,
              reservations: Object.values(snapshot.value.reservations),
              nowMs,
              cost: costs[resource],
            })
          : { mode: "probe", reason: "budget-unknown" };
        if (decision.mode === "open") continue;
        const resetHold = ["budget-reset", "reset", "rate-limit"].includes(decision.reason) ||
          budget?.blockUntil > nowMs;
        setTabGovernorDecision(key, {
          mode: resetHold || decision.mode === "paused" ? "paused" : "waiting",
          reason: decision.reason,
          resetMs: budget?.resetMs ?? decision.resetMs ?? null,
          probing: decision.mode === "probe" && !resetHold,
        });
        return;
      }
      setTabGovernorDecision(key, null);
    }

    function commit(key, run, {
      force = false,
      manual = false,
      scope,
      reservationId,
      admittedAt,
      onSettled,
      automaticStatusVisible = false,
    } = {}) {
      // Per-tab rather than one flag for the whole tick, so switching tabs can
      // refresh the tab you just landed on without waiting on an unrelated
      // background fetch -- and so a slow repo can't stack refreshes.
      if (inFlightRef.current[key]) return Promise.resolve();
      const settlement = createSettlementContext(scope, runtimeIdentityCoordinator);
      const settlementScope = settlement.scope;
      const currentAccess = settlement.isCurrent;
      inFlightRef.current[key] = true;
      inFlightStartedAt[key] = admittedAt;
      if (manual) manualInFlight.add(key);
      admittedCadenceRef.current[key] = nextAdmittedCadence(
        admittedCadenceRef.current[key],
        admittedAt,
      );
      clearForcedBackoffAfterStart(key, force, "started");
      const visibleLoading = shouldShowFetchLoading({
        hasData: dataRef.current[key] !== null,
        manual,
      });
      if (visibleLoading) setLoading((l) => (l[key] ? l : { ...l, [key]: true }));
      const retainDeferredHold = retainDeferredGovernorHold({
        automaticStatusVisible,
        screenReader,
      });
      if (!retainDeferredHold) setTabGovernorDecision(key, null);
      const publishRequestStatus = visibleLoading ||
        (automaticStatusVisible && !screenReader);
      if (publishRequestStatus) {
        setRequestStatuses((current) => ({
          ...current,
          [key]: { automaticStatusVisible },
        }));
      }
      return requestIdentityStorage.run(scope, run)
        .then((result) => {
          settleReservationWithBudgetObservations(settlementScope, leaseId, reservationId, result?.measuredSuccess === false
            ? { outcome: "rejected", observations: result?.observations ?? [] }
            : {
                outcome: "measured-success",
                actualCosts: {
                  core: result?.restSpent ?? REST_PER_FETCH[key] ?? 0,
                  graphql: result?.graphqlSpent ?? GRAPHQL_PER_FETCH[key] ?? 0,
                },
                observations: result?.observations ?? [],
              }, Date.now());
          if (!currentAccess()) return;
          if (result?.rateLimited) {
            const blockAt = Date.now();
            const budget = inspectGovernor(scope, blockAt).value?.budgets?.core;
            handleRateLimitBlocks(key, [{
              resource: "core",
              resetMs: Number.isFinite(budget?.resetMs) ? budget.resetMs : null,
              epoch: budget?.epoch ?? null,
            }], blockAt);
          }
          if (cancelled) return;
          const { raw, parse, limit, stagedEntities } = result;
          // Identical payload: skip the parse *and* the state update. Returning
          // the same state object makes React bail out of the re-render, so an
          // idle repo stops redrawing the pane entirely.
          //
          // The cache write used to happen *before* parse(), so a payload that
          // threw was still cached -- and on the next tick the error was cleared
          // at the top of this handler and the early return fired before parse()
          // could be retried, leaving the tab permanently showing "no runs" with
          // no error at all. Both now happen only after a successful parse.
          // Freshness is recorded on every *successful poll*, including the
          // identical-payload path below, and deliberately not in `meta`. It used
          // to ride on meta.at, which is only written past the early return -- so
          // on a quiet repo, where every payload is byte-identical by design, the
          // timestamp froze at the last time data changed and the status bar
          // accrued a growing "stale 2h13m" while every poll was succeeding on
          // schedule. The indicator fired loudest in the one state that is
          // completely healthy. A ref rather than state because writing state here
          // would allocate a new object every tick and permanently defeat the
          // React bail-out this early return exists to preserve.
          const completedAt = Date.now();
          const transition = pollResultTransition({
            key,
            previousRaw: rawRef.current[key],
            raw,
            parse,
            limit,
            completedAt,
          });
          // The cadence follows the observation, not the tab: an error or an
          // unusable payload leaves the counter where it was, so a broken tab
          // is never slowed down for looking quiet.
          unchangedPolls[key] = advanceUnchangedCount(unchangedPolls[key], transition.kind);
          // Recomputed now that the outcome is known: the schedule chose this
          // tab's deadline before the observation that decides its cadence.
          rescheduleTab(key, admittedAt, {
            actionRows: key === "actions" && transition.kind === "changed" ? transition.data : undefined,
          });
          if (result?.catalog) workflowCatalogRef.current = result.catalog;
          if (Number.isFinite(result?.loadedPages)) {
            pageStateRef.current[key] = {
              pages: result.loadedPages,
              hasNextPage: result.hasNextPage === true,
            };
          }
          publishStagedEntities(entityRef.current, stagedEntities, transition.kind);
          if (transition.kind === "unchanged") {
            lastOkRef.current[key] = completedAt;
            // Clear on the first success or a single failure latches the ladder.
            clearBackoff(`tab:${key}`);
            setErrors((x) => (x[key] === null ? x : { ...x, [key]: null }));
            const cachedTab = pick(
              pick(dashboardCacheRef.current, dashboardCacheTargetRef.current, null)?.tabs ?? {},
              key,
              null,
            );
            if (
              cachedTab &&
              shouldCheckpointFreshness({ persistedAt: cachedTab.lastOk, completedAt })
            ) {
              cacheSuccessfulTab(
                key,
                dataRef.current[key],
                metaRef.current[key],
                completedAt,
                key === "security"
                  ? { notes: securityNotesRef.current, blind: securityBlindRef.current }
                  : {},
              );
            }
            return;
          }
          // Empty or truncated JSON is not a user-actionable fetch error. Keep
          // the last-good rows and freshness clock, and clear the raw comparison
          // so the next admitted tick parses its response instead of taking the
          // identical-output fast path.
          if (transition.kind === "unusable") {
            rawRef.current[key] = transition.nextRaw;
            setErrors((x) => (x[key] === null ? x : { ...x, [key]: null }));
            return;
          }
          // Security fetches resolve each source independently so their notes
          // remain visible. A blind result is still a failed observation: it
          // must not replace known alerts with a false empty state or advance
          // freshness. Do not retain its raw value either, so the next source
          // retry is parsed instead of taking the identical-payload fast path.
          if (transition.kind === "blind") {
            rawRef.current[key] = transition.nextRaw;
            setErrors((x) => (x[key] === null ? x : { ...x, [key]: null }));
            setSecurityNotes(transition.notes);
            setSecurityBlind(true);
            return;
          }
          const tabData = transition.data;
          const tabMeta = transition.meta;
          lastOkRef.current[key] = completedAt;
          clearBackoff(`tab:${key}`);
          rawRef.current[key] = transition.nextRaw;
          setErrors((x) => (x[key] === null ? x : { ...x, [key]: null }));
          setData((d) => ({ ...d, [key]: tabData }));
          setMeta((m) => ({ ...m, [key]: tabMeta }));
          if (transition.notes) setSecurityNotes(transition.notes);
          if (key === "security") {
            setSecurityBlind((b) => (b === transition.blind ? b : transition.blind));
          }
          cacheSuccessfulTab(key, tabData, tabMeta, completedAt, {
            notes: transition.notes,
            blind: transition.blind,
          });
        })
        .catch((err) => {
          settleReservationWithBudgetObservations(settlementScope, leaseId, reservationId, {
            outcome: governorOutcomeForError(err),
            observations: err?.budgetObservations ?? [],
          }, Date.now());
          if (cancelled || !currentAccess() || err?.name === "AbortError") return;
          // Preserve both the verdict and the bounded raw error in state. The
          // renderer translates recognized verdicts at draw time, which lets a
          // later repository/account context refine the one-line remedy without
          // throwing away the original evidence.
          const failure = toTabError(err);
          const verdict = failure.verdict;
          setErrors((x) => ({ ...x, [key]: failure }));
          if (verdict === "unavailable") coordinator.ensure(controller.signal);
          // ...and back off, which the list tabs never did at all. A tab wedged
          // on an expired token used to re-spawn `gh` every tick forever -- 720
          // subprocesses an hour, indefinitely, against a token that is already
          // refusing. "other" has no ladder on purpose: a network drop should
          // recover on the very next tick once the network is back.
          const steps = verdict === "rate-limited" ? null : pick(FAILURE_LADDER, verdict, null);
          if (steps) recordFailure(`tab:${key}`, performance.now(), steps);
          if (verdict === "rate-limited") {
            const snapshot = inspectGovernor(scope, Date.now());
            const costs = tabRequestCost(key);
            const blocks = [];
            for (const resource of RATE_RESOURCES) {
              if (costs[resource] <= 0) continue;
              const resourceResetMs = snapshot.value?.budgets?.[resource]?.resetMs;
              blocks.push({
                resource,
                resetMs: Number.isFinite(resourceResetMs) ? resourceResetMs : null,
                epoch: snapshot.value?.budgets?.[resource]?.epoch ?? null,
              });
            }
            handleRateLimitBlocks(key, blocks, Date.now());
          }
        })
        .finally(() => {
          inFlightRef.current[key] = false;
          delete inFlightStartedAt[key];
          if (!currentAccess() && !Object.values(inFlightRef.current).some(Boolean) && runtimeIdentityCoordinator?.current()?.quotaKey !== settlementScope.quotaKey) releaseLease(settlementScope, leaseId);
          manualInFlight.delete(key);
          onSettled?.();
          if (!cancelled) {
            setLoading((l) => (l[key] ? { ...l, [key]: false } : l));
            if (publishRequestStatus) {
              setRequestStatuses((current) => current[key] === null
                ? current
                : { ...current, [key]: null });
            }
            if (retainDeferredHold) {
              setGovernorDecisions((current) =>
                current[key]?.reservationId === reservationId
                  ? { ...current, [key]: null }
                  : current);
            }
          }
          const queued = queuedManual.get(key);
          if (!cancelled && queued) {
            queuedManual.delete(key);
            void requestTab(key, "manual", { force: queued.force });
          }
        });
    }

    const leaseId = governorId();
    const pending = new Map();
    // One manual handoff per tab, carrying which key produced it. A keypress
    // during an automatic request must not be lost, but repeated keypresses
    // during the manual request itself must not create a trailing second batch.
    // The intention has to travel with the handoff: replaying every queued press
    // as a resynchronization made `r` drop validators whenever it happened to
    // land while an automatic poll was in flight.
    const queuedManual = new Map();
    const manualInFlight = new Set();
    // When the work currently in flight for each tab was admitted, so a press
    // can tell an acquisition that already answers it from one that predates it.
    const inFlightStartedAt = {};
    const wakeScheduler = createWakeScheduler();
    let scope = null;
    let cleanupScope = null;
    let registeredScopeHash = null;
    // The access partition the retained rows belong to, kept across a window
    // where the identity is momentarily unknown so that an account which comes
    // back *different* still clears them. Null means nothing is retained.
    let retainedAccessKey = null;
    let remoteUrls = [];
    let liveScheduling = false;
    let controlEpochs = null;
    // One deadline per tab, not one active slot and one rotating background
    // slot. Two shared timers cannot express a Security tab quiet at 300s next
    // to an Actions tab watching a running job at 5s, which is the whole point
    // of the cadence table.
    const NEVER_DUE = Object.fromEntries(TAB_KEYS.map((key) => [key, Number.POSITIVE_INFINITY]));
    let pollDueAt = { ...NEVER_DUE };
    let backgroundIndex = 0;
    // Only the unchanged run counts live here. Whether Actions has work in
    // flight is read from the rows themselves, so there is no second copy of it
    // to fall out of step with what is on screen.
    const unchangedPolls = Object.fromEntries(TAB_KEYS.map((key) => [key, 0]));
    let pendingBlockPublications = new Map();

    // Rows are the only record of whether CI is busy, so this reads them rather
    // than keeping a second copy that can fall out of step with the screen. A
    // caller that has just parsed newer rows passes them, because dataRef only
    // catches up on the next render.
    function actionsInProgress(rows = dataRef.current.actions) {
      return Array.isArray(rows) && rows.some((row) => row.status !== "completed");
    }

    function pollIntervalFor(key, activeKey, { actionRows } = {}) {
      return pollPolicyInterval({
        tab: key,
        floorMs: runtime.refreshMs,
        demand: key === activeKey ? "active" : "inactive",
        unchangedCount: unchangedPolls[key],
        inProgressCI: key === "actions" && actionsInProgress(actionRows),
        background: runtime.background,
      });
    }

    function rescheduleTab(key, at, options = {}) {
      const step = pollIntervalFor(key, TABS[activeIndexRef.current].key, options);
      pollDueAt = {
        ...pollDueAt,
        [key]: Number.isFinite(step) ? at + step : Number.POSITIVE_INFINITY,
      };
    }

    // Polling opens with the active tab immediately and the inactive ones
    // staggered one background slot apart, exactly as the single rotating slot
    // used to place them. Opening them all at the same deadline would start
    // three fetches within one wake -- the herd the rotation exists to prevent,
    // and it only diverges again once each tab has taken its own interval.
    function openPollDeadlines(at) {
      const activeKey = TABS[activeIndexRef.current].key;
      const opened = { ...NEVER_DUE };
      opened[activeKey] = at + 1;
      let slot = 1;
      for (const key of TAB_KEYS) {
        if (key === activeKey) continue;
        opened[key] = Number.isFinite(pollIntervalFor(key, activeKey))
          ? at + slot * 4 * runtime.refreshMs
          : Number.POSITIVE_INFINITY;
        slot += 1;
      }
      pollDueAt = opened;
    }

    function armWake(kind, at, run) {
      if (!cancelled) wakeScheduler.arm(kind, at, run);
    }

    function failClosedRateLimit(key, reason) {
      liveScheduling = false;
      controlEpochs = null;
      pollDueAt = { ...NEVER_DUE };
      wakeScheduler.clear("data");
      pauseCoordination(key, reason);
      armWake("control", governorControlRetryAt(Date.now(), runtime.refreshMs), controlWake);
    }

    function attemptPendingBlockPublications(currentScope, nowMs, state = null, requestProbe = false) {
      for (const [resource, original] of [...pendingBlockPublications]) {
        if (state && rateLimitBlockProbeRecovered(original, state, nowMs)) {
          pendingBlockPublications.delete(resource);
          continue;
        }
        const candidate = state
          ? hydrateRateLimitBlockPublication(original, state)
          : original;
        const attempt = retryRateLimitBlockPublication(
          candidate,
          nowMs,
          (name, resetMs) => recordResourceBlock(currentScope, name, resetMs, "rate-limit"),
        );
        if (attempt.status === "published") {
          pendingBlockPublications.delete(resource);
          setTabGovernorDecision(candidate.key, attempt.decision);
          continue;
        }
        pendingBlockPublications.set(resource, attempt.pending);
        if (attempt.status === "probe" && requestProbe) {
          const budget = state?.budgets?.[resource];
          if (budget) requestManualProbe(
            currentScope,
            leaseId,
            budget.epoch,
            budget.observedAt,
            nowMs,
          );
        }
      }
    }

    function handleRateLimitBlocks(key, blocks, nowMs) {
      pendingBlockPublications = mergeRateLimitBlockPublications(
        pendingBlockPublications,
        key,
        blocks,
        nowMs,
      );
      attemptPendingBlockPublications(scope, nowMs);
      if (pendingBlockPublications.size > 0) {
        failClosedRateLimit(key, pendingBlockPublications.values().next().value?.reason);
      }
    }

    function identity() {
      return runtimeIdentityCoordinator?.current() ?? null;
    }

    function retireCurrentScope() {
      if (!cleanupScope || !registeredScopeHash) return;
      for (const item of pending.values()) cancelIntent(cleanupScope, item.intentId, Date.now());
      if (!Object.values(inFlightRef.current).some(Boolean)) releaseLease(cleanupScope, leaseId);
    }

    // discardData separates the two reasons this runs. An account *change* must
    // drop every row, validator and note, because they belong to an access
    // partition this pane no longer holds. An identity that is merely unknown
    // for a moment must not: the rows are still ours, and throwing away the
    // ETags with them makes the recovery round cost full price.
    function resetVisibleScope(nowMs, { immediate = false, discardData = true } = {}) {
      pending.clear();
      coordinator.invalidate();
      setFailureContext(null);
      if (discardData) {
        rawRef.current = {};
        entityRef.current.clear();
        lastOkRef.current = {};
        // The workflow catalog is repository payload, not scheduling state, so
        // it is fenced with the rows rather than carried into whatever account
        // this pane now holds. The page counts go with it: demand measured
        // against a list that has been discarded describes nothing.
        workflowCatalogRef.current = null;
        pageStateRef.current = {};
        setData(Object.fromEntries(TAB_KEYS.map((key) => [key, null])));
        setMeta({});
        setSecurityNotes([]);
        setSecurityBlind(false);
        retainedAccessKey = null;
      }
      pendingBlockPublications.clear();
      liveScheduling = false;
      pollDueAt = { ...NEVER_DUE };
      wakeScheduler.clear("data");
      wakeScheduler.clear("heartbeat");
      wakeScheduler.clear("control");
      setGovernorEpochs(null);
      setGovernorDecisions(probingGovernorDecisions());
      armWake(
        "control",
        immediate ? nowMs + 1 : governorControlRetryAt(nowMs, runtime.refreshMs),
        controlWake,
      );
    }

    function ensureScope(nowMs = Date.now(), { maintain = false } = {}) {
      const current = identity();
      const nextHash = current?.quotaKey;
      if (!nextHash) {
        if (scope !== null) {
          retireCurrentScope();
          registeredScopeHash = null;
          if (governorRef.current?.leaseId === leaseId) governorRef.current = null;
          scope = null;
          cleanupScope = null;
          // Unknown is not the same as changed. A contended registry lock, a
          // `gh` write that only touched an unrelated host's entry, or a
          // re-resolution still in flight all arrive here, and none of them says
          // the rows on screen stopped being ours. Stop scheduling and let them
          // age visibly; retainedAccessKey is what still clears them if the
          // account turns out to have actually changed.
          resetVisibleScope(nowMs, { discardData: false });
        }
        return null;
      }
      const migrating = scope !== null && (scope.hash !== nextHash || scope.accessKey !== current.accessKey);
      if (scope?.hash === nextHash && scope.accessKey === current.accessKey && registeredScopeHash === nextHash) {
        if (!maintain) return scope;
        const activeTab = TABS[activeIndexRef.current].key;
        const kept = maintainControlLease(scope, leaseId, runtime.refreshMs, activeTab, nowMs);
        if (kept.ok) return scope;
        registeredScopeHash = null;
        if (governorRef.current?.leaseId === leaseId) governorRef.current = null;
        return null;
      }
      if (scope?.hash !== nextHash || scope.accessKey !== current.accessKey) {
        retireCurrentScope();
        registeredScopeHash = null;
        // The second test covers the identity returning after a window where it
        // was unknown: scope is null by then, so `migrating` cannot see the
        // change, and retained rows from the previous access partition would
        // otherwise survive into an account that must not be able to read them.
        if (migrating || (scope === null && retainedAccessKey !== null && retainedAccessKey !== current.accessKey)) {
          // The failed publication belonged to the old account scope. Releasing
          // that lease guarantees this process will start no more work there;
          // the new scope must establish its own authoritative budget instead
          // of inheriting an unrelated account's local hold.
          resetVisibleScope(nowMs, { immediate: true });
        }
        scope = createQuotaScope(current, { root: runtimeIdentityCoordinator.root, identityProvider: identity });
        cleanupScope = { ...scope, identityProvider: null };
        const nextTarget = dashboardCacheTarget({ repo: runtime.repo, ghRepo: process.env.GH_REPO, host: current.host, account: current.accessKey });
        // The mount-time target had to guess the account, and guesses
        // "unverified" whenever the bounded warm resolution above did not land
        // in time -- so a session that has rows on disk can start with none.
        // Now that the partition is proven, take them. Guarded on having
        // published nothing yet, so this can never overwrite live rows.
        if (nextTarget !== dashboardCacheTargetRef.current && retainedAccessKey === null &&
            Object.values(dataRef.current).every((rows) => rows === null)) {
          const warm = pick(dashboardCacheRef.current, nextTarget, null);
          if (warm) {
            setData(Object.fromEntries(TABS.map((candidate) => [candidate.key, warm.tabs[candidate.key]?.data ?? null])));
            setMeta(Object.fromEntries(TABS.map((candidate) => [candidate.key, warm.tabs[candidate.key]?.meta ?? null])));
            setSecurityNotes(warm.securityNotes ?? []);
            setSecurityBlind(warm.securityBlind ?? false);
          }
        }
        retainedAccessKey = current.accessKey;
        dashboardCacheTargetRef.current = nextTarget;
      }
      const activeTab = TABS[activeIndexRef.current].key;
      const registered = registerLease(scope, {
        id: leaseId,
        expiresAt: nowMs + GOVERNOR_LEASE_TTL_MS,
        floorMs: runtime.refreshMs,
        activeTab,
        phaseSeed: { seed: leaseId, registeredAt: nowMs },
        demand: tabRequestCost(activeTab),
      });
      if (!registered.ok) return null;
      registeredScopeHash = nextHash;
      governorRef.current = { scope, leaseId };
      return scope;
    }

    function armFromState(nowMs = Date.now()) {
      if (!scope) return;
      if (!registeredScopeHash) {
        armWake("control", governorControlRetryAt(nowMs, runtime.refreshMs), controlWake);
        return;
      }
      const snapshot = inspectGovernor(scope, nowMs);
      if (!snapshot.ok) {
        pauseCoordination(TABS[activeIndexRef.current].key, snapshot.reason);
        armWake("control", governorControlRetryAt(nowMs, runtime.refreshMs), controlWake);
        return;
      }
      publishGovernorEpochs(snapshot);
      const wakes = governorWakeTimes(snapshot.value, nowMs, runtime.refreshMs, leaseId);
      armWake("control", wakes.controlAt, controlWake);
      const nextDataAt = Math.min(wakes.dataAt, ...Object.values(pollDueAt));
      if (liveScheduling) armWake("data", nextDataAt, dataWake);
    }

    function finishPending(key, intentId) {
      if (pending.get(key)?.intentId === intentId) pending.delete(key);
      armFromState();
    }

    // Manual and tab-switch work replaces the automatic check that would
    // otherwise be due, rather than being added to it.
    function replaceActivePoll(kind, at) {
      if (["manual", "tab-switch"].includes(kind)) {
        rescheduleTab(TABS[activeIndexRef.current].key, at);
      }
    }

    // `manual` is the user asking now: it bypasses the scheduled deadline and
    // the tab's failure ladder. `force` is the separate, stronger request that
    // also drops validators -- the `R` key. `r` is manual and not forced, which
    // is what makes a quiet refresh cost nothing.
    function requestTab(key, kind = "active", { force = false } = {}) {
      const manual = kind === "manual";
      const signal = controller.signal;
      const descriptor = tabForKey(key);
      const monotonicNow = performance.now();
      if (pendingBlockPublications.size > 0) {
        pauseCoordination(key, "block-unpublished");
        return Promise.resolve({ persisted: false, retry: false, kind, key });
      }
      if (inFlightRef.current[key]) {
        // A manual acquisition already in flight is work this user asked for,
        // so the press joins it. Automatic work that started before the press
        // cannot answer it, so schedule exactly one follow-up; further presses
        // coalesce into that one, and the stronger intention wins.
        if (manual && !manualInFlight.has(key)) {
          const plan = planManualRefresh({
            requestedAt: Date.now(),
            inFlightStartedAt: inFlightStartedAt[key] ?? null,
            followUpPending: queuedManual.has(key),
          });
          if (plan.followUp) queuedManual.set(key, { force });
        }
        if (force && queuedManual.has(key)) queuedManual.get(key).force = true;
        return Promise.resolve({ persisted: false, retry: false, kind, key });
      }
      if (!manual && backoffActive(`tab:${key}`, monotonicNow)) {
        return Promise.resolve({ persisted: false, retry: false, kind, key });
      }
      const nowMs = Date.now();
      const currentScope = ensureScope(nowMs);
      if (!currentScope) {
        pauseCoordination(key, "unknown-scope");
        return Promise.resolve({ persisted: false, retry: true, kind, key });
      }
      let protocolReady = liveScheduling;
      let resourceReady = liveScheduling;
      if (!liveScheduling || manual) {
        const snapshot = inspectGovernor(currentScope, nowMs);
        protocolReady = governorProtocolReady(
          { ok: true, value: { status: "published" } },
          snapshot,
          nowMs,
        );
        resourceReady = governorDataReady(
          { ok: true, value: { status: "published" } }, snapshot, key, nowMs);
        if (!liveScheduling && resourceReady) {
          liveScheduling = true;
          openPollDeadlines(nowMs - 1);
          armWake("heartbeat", nowMs + GOVERNOR_HEARTBEAT_MS, heartbeatWake);
        }
      }
      const intentGate = runtimeIntentGate(liveScheduling, { force: manual, protocolReady });
      if (intentGate.requestProbe || manual && !resourceReady) {
        const snapshot = inspectGovernor(currentScope, nowMs);
        const costs = tabRequestCost(key);
        for (const resource of RATE_RESOURCES) {
          const budget = snapshot.value?.budgets?.[resource];
          if (costs[resource] > 0 && budget) {
            requestManualProbe(currentScope, leaseId, budget.epoch, budget.observedAt, nowMs);
          }
        }
        armWake("control", nowMs + 1, controlWake);
      }
      if (!intentGate.registerIntent) {
        setTabGovernorDecision(key, { mode: "waiting", probing: true });
        setTabWaiting(key, true);
        return Promise.resolve({ persisted: false, retry: false, kind, key });
      }
      const existing = pending.get(key);
      if (existing) {
        if (!manual || existing.kind === "manual") {
          return Promise.resolve({ persisted: true, retry: false, kind, key });
        }
        cancelIntent(currentScope, existing.intentId, nowMs);
        pending.delete(key);
      }
      const intentId = governorId();
      const request = {
        id: intentId,
        leaseId,
        tab: key,
        priority: kind,
        costs: tabRequestCost(key),
        requestedAt: nowMs,
        expiresAt: nowMs + GOVERNOR_LEASE_TTL_MS,
      };
      const registered = registerIntent(currentScope, request);
      if (!registered.ok) {
        pauseCoordination(key, registered.reason);
        return Promise.resolve({ persisted: false, retry: true, kind, key });
      }
      const decision = registered.value;
      pending.set(key, {
        intentId,
        kind,
        force,
        manual,
        wasDeferred: false,
        ...sharedLaneEvidence(decision),
      });
      if (decision.status !== "scheduled" || decision.notBefore > nowMs) {
        const item = pending.get(key);
        if (item) item.wasDeferred = true;
        setTabGovernorDecision(key, visibleGovernorDecision(decision));
        setTabWaiting(key, true);
        if (manual && decision.resource) {
          const budget = inspectGovernor(currentScope, nowMs).value?.budgets?.[decision.resource];
          if (budget) requestManualProbe(currentScope, leaseId, budget.epoch, budget.observedAt, nowMs);
        }
        armWake("data", decision.retryAt ?? decision.notBefore ?? nowMs + runtime.refreshMs, dataWake);
        armFromState(nowMs);
        return Promise.resolve({ persisted: true, retry: false, kind, key });
      }
      const started = startReservation(currentScope, decision.reservationId, nowMs);
      if (!started.ok) {
        pauseCoordination(key, started.reason);
        if (pendingFailureIsTerminal(started.reason)) finishPending(key, intentId);
        else armWake("data", governorControlRetryAt(nowMs, runtime.refreshMs), dataWake);
        return Promise.resolve({ persisted: true, retry: false, kind, key });
      }
      if (started.value.status !== "started") {
        const item = pending.get(key);
        if (item) item.wasDeferred = true;
        setTabGovernorDecision(key, visibleGovernorDecision({
          ...decision,
          ...started.value,
        }));
        armWake("data", started.value.notBefore ?? nowMs + runtime.refreshMs, dataWake);
        return Promise.resolve({ persisted: true, retry: false, kind, key });
      }
      setTabWaiting(key, false);
      replaceActivePoll(kind, nowMs);
      if (force) coordinator.invalidate();
      return commit(
        key,
        () => descriptor.fetch({
          signal,
          entities: entityRef.current,
          force,
          catalog: workflowCatalogRef.current,
          pages: pageStateRef.current[key]?.pages ?? 1,
          governor: { scope: currentScope, leaseId },
          previousRaw: rawRef.current[key] ?? null,
        }),
        {
          force,
          manual,
          scope: currentScope,
          reservationId: decision.reservationId,
          admittedAt: nowMs,
          automaticStatusVisible: false,
          onSettled: () => finishPending(key, intentId),
        },
      ).then(() => ({ persisted: true, retry: false, kind, key }));
    }
    fetchTabRef.current = (key, { force = false, kind = force ? "manual" : "active" } = {}) => {
      if (kind === "tab-switch") {
        // A newly active subscription is not evidence of quiet: the tab you
        // just opened deserves a check at the floor, not at the interval it
        // earned while nobody was looking at it.
        unchangedPolls[key] = advanceUnchangedCount(unchangedPolls[key], "subscribed");
      }
      const requestedAt = Date.now();
      // Manual work replaces the active poll that would otherwise be due. Move
      // that deadline before touching the governor so a data wake already in
      // this event-loop turn cannot start a second batch as soon as the forced
      // batch settles. The in-flight guard still coalesces work that overlaps.
      replaceActivePoll(kind, requestedAt);
      const currentScope = ensureScope(requestedAt);
      if (currentScope) {
        heartbeatLease(currentScope, leaseId, tabRequestCost(key), requestedAt, key);
        if (kind === "tab-switch") {
          for (const [pendingKey, item] of [...pending]) {
            if (pendingKey !== key && ["active", "tab-switch"].includes(item.kind)) {
              cancelIntent(currentScope, item.intentId, requestedAt);
              pending.delete(pendingKey);
            }
          }
        }
      }
      return requestTab(key, kind, { force });
    };

    async function resumePending(nowMs) {
      for (const [key, item] of [...pending]) {
        if (inFlightRef.current[key]) continue;
        const currentScope = ensureScope(nowMs);
        if (!currentScope) continue;
        const decision = readIntentDecision(currentScope, item.intentId, nowMs, item);
        if (!decision.ok) {
          pauseCoordination(key, decision.reason);
          if (pendingFailureIsTerminal(decision.reason)) pending.delete(key);
          else armWake("data", governorControlRetryAt(nowMs, runtime.refreshMs), dataWake);
          continue;
        }
        Object.assign(item, sharedLaneEvidence(decision.value));
        if (decision.value.status !== "scheduled" || decision.value.notBefore > nowMs) {
          item.wasDeferred = true;
          setTabGovernorDecision(key, visibleGovernorDecision({
            ...decision.value,
            ...sharedLaneProvenance(decision.value),
          }));
          setTabWaiting(key, true);
          armWake("data", decision.value.retryAt ?? decision.value.notBefore ?? nowMs + runtime.refreshMs, dataWake);
          continue;
        }
        const started = startReservation(currentScope, decision.value.reservationId, nowMs);
        if (!started.ok) {
          pauseCoordination(key, started.reason);
          if (pendingFailureIsTerminal(started.reason)) pending.delete(key);
          else armWake("data", governorControlRetryAt(nowMs, runtime.refreshMs), dataWake);
          armFromState(nowMs);
          continue;
        }
        if (started.value.status !== "started") {
          item.wasDeferred = true;
          setTabGovernorDecision(key, visibleGovernorDecision({
            ...decision.value,
            ...started.value,
            ...sharedLaneProvenance(decision.value),
          }));
          armWake("data", started.value.notBefore ?? nowMs + runtime.refreshMs, dataWake);
          continue;
        }
        setTabWaiting(key, false);
        replaceActivePoll(item.kind, nowMs);
        if (item.force) coordinator.invalidate();
        const descriptor = tabForKey(key);
        void commit(
          key,
          () => descriptor.fetch({
            signal: controller.signal,
            entities: entityRef.current,
            force: item.force,
            catalog: workflowCatalogRef.current,
            pages: pageStateRef.current[key]?.pages ?? 1,
            governor: { scope: currentScope, leaseId },
            previousRaw: rawRef.current[key] ?? null,
          }),
          {
            force: item.force,
            manual: item.manual === true,
            scope: currentScope,
            reservationId: decision.value.reservationId,
            admittedAt: nowMs,
            automaticStatusVisible: item.wasDeferred && !item.force,
            onSettled: () => finishPending(key, item.intentId),
          },
        );
      }
    }

    async function runDataWake() {
      if (cancelled || remoteSetupRef.current) return;
      const nowMs = Date.now();
      await resumePending(nowMs);
      const currentScope = ensureScope(nowMs);
      const snapshot = currentScope ? inspectGovernor(currentScope, nowMs) : null;
      if (!snapshot?.ok) return;
      publishGovernorEpochs(snapshot);
      const wakes = governorWakeTimes(snapshot.value, nowMs, runtime.refreshMs, leaseId);
      const heldResources = Object.fromEntries(RATE_RESOURCES.map((resource) => {
        const budget = snapshot.value.budgets[resource];
        const decision = budget
          ? availableForGrant({ budget, resource, nowMs })
          : { mode: "paused" };
        const held = !budget || budget.blockUntil > nowMs || decision.mode !== "open";
        const retryAt = budget?.blockUntil > nowMs
          ? budget.blockUntil
          : decision.retryAt ?? wakes.controlAt;
        return [resource, { held, retryAt }];
      }));
      const active = TABS[activeIndexRef.current].key;
      const previousBackgroundIndex = backgroundIndex;
      const planned = pollSchedule({
        nowMs,
        floorMs: runtime.refreshMs,
        activeKey: active,
        dueAt: pollDueAt,
        backgroundIndex,
        heldResources,
        background: runtime.background,
        states: Object.fromEntries(TAB_KEYS.map((key) => [key, {
          unchangedCount: unchangedPolls[key],
          inProgressCI: key === "actions" && actionsInProgress(),
        }])),
      });
      pollDueAt = planned.dueAt;
      backgroundIndex = planned.backgroundIndex;
      const outcomes = await Promise.allSettled(
        planned.due.map(({ key, kind }) => requestTab(key, kind)),
      );
      const retryAt = governorControlRetryAt(Date.now(), runtime.refreshMs);
      let retryNeeded = false;
      for (const outcome of outcomes) {
        if (outcome.status !== "fulfilled" || outcome.value?.retry !== true) continue;
        ({ dueAt: pollDueAt, backgroundIndex } = retryPollAfterAdmissionFailure({
          key: outcome.value.key,
          kind: outcome.value.kind,
          retryAt,
          dueAt: pollDueAt,
          backgroundIndex,
          previousBackgroundIndex,
        }));
        retryNeeded = true;
      }
      if (retryNeeded) armWake("data", retryAt, dataWake);
      if (!cancelled) {
        setNow((prev) =>
          hasInProgressRef.current || Date.now() - prev.getTime() >= 60_000 ? new Date() : prev,
        );
      }
    }

    // A reset can make the old reservation wake and the control wake due in
    // the same turn. Both may arm `data` before either async callback reaches
    // pollSchedule(). Let one callback own that transition; the settled hook
    // retains every later useful wake. Without this guard one pane could
    // consume two freshly opened lane slots while another pane received none.
    const dataWake = createSingleFlightWake(runDataWake, () => {
      if (!cancelled) armFromState(Date.now());
    });

    async function controlWake() {
      if (cancelled) return;
      await runtimeIdentityCoordinator.refresh();
      if (cancelled) return;
      const nowMs = Date.now();
      const currentScope = ensureScope(nowMs, { maintain: true });
      if (currentScope && pendingBlockPublications.size > 0) {
        const beforeProbe = inspectGovernor(currentScope, nowMs);
        attemptPendingBlockPublications(
          currentScope,
          nowMs,
          beforeProbe.ok ? beforeProbe.value : null,
          true,
        );
      }
      const refreshed = currentScope
        ? await refreshSharedBudget(currentScope, leaseId, controller.signal)
        : { ok: false, reason: runtimeIdentityCoordinator?.inspect()?.reason ?? "stale" };
      if (cancelled) return;
      const checkedAt = Date.now();
      const snapshot = currentScope ? inspectGovernor(currentScope, checkedAt) : refreshed;
      const activeKey = TABS[activeIndexRef.current].key;
      if (currentScope && snapshot.ok && pendingBlockPublications.size > 0) {
        attemptPendingBlockPublications(currentScope, checkedAt, snapshot.value);
      }
      publishControlStatus(activeKey, refreshed, snapshot, checkedAt);
      const controlReady = pendingBlockPublications.size === 0 && governorControlReady(
        refreshed,
        snapshot,
        checkedAt,
      );
      const activeEpochChanged = controlReady && controlEpochs !== null &&
        tabEpochChanged(controlEpochs, snapshot.value.epochs, activeKey);
      if (controlReady) controlEpochs = { ...snapshot.value.epochs };
      if (controlReady && (!liveScheduling || activeEpochChanged)) {
        const starting = !liveScheduling;
        liveScheduling = true;
        if (starting) {
          openPollDeadlines(checkedAt);
          armWake("heartbeat", checkedAt + GOVERNOR_HEARTBEAT_MS, heartbeatWake);
        } else {
          // A new accounting epoch for a resource the active tab spends: check
          // it now rather than at whatever cadence it had settled into. Set
          // directly rather than through rescheduleTab, whose whole job is to
          // apply that cadence.
          pollDueAt = { ...pollDueAt, [TABS[activeIndexRef.current].key]: checkedAt + 1 };
        }
      }
      if (!refreshed.ok) {
        armWake("control", governorControlRetryAt(checkedAt, runtime.refreshMs), controlWake);
      }
      if (pendingBlockPublications.size > 0) {
        armWake("control", governorControlRetryAt(checkedAt, runtime.refreshMs), controlWake);
      }
      setNow((previous) => checkedAt - previous.getTime() >= 60_000 ? new Date(checkedAt) : previous);
      armFromState(checkedAt);
    }

    function heartbeatWake() {
      if (cancelled) return;
      const nowMs = Date.now();
      const currentScope = ensureScope(nowMs);
      const activeTab = TABS[activeIndexRef.current].key;
      if (currentScope) heartbeatLease(currentScope, leaseId, tabRequestCost(activeTab), nowMs, activeTab);
      armWake("heartbeat", nowMs + GOVERNOR_HEARTBEAT_MS, heartbeatWake);
    }

    async function bootstrap() {
      remoteUrls = runtimeRemoteUrls.length > 0 ? runtimeRemoteUrls : await gitRemoteUrls();
      runtimeRemoteUrls = remoteUrls;
      if (cancelled) return;
      if (enterRemoteSetup()) return;
      await runtimeIdentityCoordinator.refresh();
      if (cancelled) return;
      const currentScope = ensureScope(Date.now());
      if (!currentScope) {
        pauseCoordination(TABS[activeIndexRef.current].key, runtimeIdentityCoordinator?.inspect()?.reason ?? "unknown-scope");
        armWake("control", governorControlRetryAt(Date.now(), runtime.refreshMs), controlWake);
        return;
      }
      const refreshed = await refreshSharedBudget(currentScope, leaseId, controller.signal);
      if (cancelled) return;
      const checkedAt = Date.now();
      const snapshot = inspectGovernor(currentScope, checkedAt);
      const activeKey = TABS[activeIndexRef.current].key;
      publishControlStatus(activeKey, refreshed, snapshot, checkedAt);
      const controlReady = governorControlReady(
        refreshed,
        snapshot,
        checkedAt,
      );
      if (controlReady) {
        controlEpochs = { ...snapshot.value.epochs };
        liveScheduling = true;
        openPollDeadlines(checkedAt);
        armWake("heartbeat", checkedAt + GOVERNOR_HEARTBEAT_MS, heartbeatWake);
      }
      if (!refreshed.ok) {
        armWake("control", governorControlRetryAt(checkedAt, runtime.refreshMs), controlWake);
      }
      armFromState(checkedAt);
    }

    void bootstrap();
    return () => {
      cancelled = true;
      queuedManual.clear();
      manualInFlight.clear();
      wakeScheduler.clearAll();
      for (const item of pending.values()) cancelIntent(cleanupScope, item.intentId, Date.now());
      if (cleanupScope && registeredScopeHash) releaseLease(cleanupScope, leaseId);
      if (governorRef.current?.leaseId === leaseId) governorRef.current = null;
      if (contextCoordinatorRef.current === coordinator) contextCoordinatorRef.current = null;
      // `cancelled` stops state updates from a promise that already resolved;
      // the signal stops the subprocess itself, so quitting doesn't orphan up to
      // eight `gh` children mid-request. They cover different windows and both are
      // needed.
      controller.abort();
    };
  }, [dashboardCacheWriter, screenReader]);

  // Background tabs can be up to BACKGROUND_EVERY ticks stale, so the tab you
  // switch to refreshes straight away rather than showing old data until its
  // slot next comes round. On mount this is a no-op: the initial tick already
  // has every tab in flight, and the per-tab guard rejects the duplicate.
  useEffect(() => {
    fetchTabRef.current?.(TABS[activeIndex].key, { kind: "tab-switch" });
  }, [activeIndex]);

  // Animate only when something on screen is genuinely moving. Automatic polls
  // with settled data deliberately leave `loading` false; otherwise this timer
  // would restart every five seconds on an unchanged repository and undo the
  // redraw suppression above. The first load genuinely is worth animating,
  // because an empty pane with no motion reads as broken; after that, only a run
  // actually executing is.
  // "Never resolved" and "never *succeeded*" are different states, and conflating
  // them pinned the spinner on forever. setData is only ever called on success,
  // so a tab whose fetch keeps failing -- offline laptop, VPN down, expired auth,
  // Actions disabled on the repo -- kept data === null, kept firstLoad true, and
  // kept the 100ms interval running for the life of the process while the body
  // rendered "loading actions..." directly above the error explaining it had
  // failed. Measured at 7.8% of a core and 9.8 MB/hr of terminal writes,
  // indefinitely, on the single most ordinary failure there is. Motion now means
  // "still working"; the error line means "not working"; nothing claims both.
  const firstLoad = Object.fromEntries(
    TABS.map((t) => [t.key, data[t.key] == null && !errors[t.key] && loading[t.key]]),
  );
  const anyFirstLoad = Object.values(firstLoad).some(Boolean);
  const semanticStatus = refreshStatus({
    widthMode: resizeRef.current.active,
    remoteSetup,
    visibleLoading: Boolean(loading[tab.key]),
    visibleInFlight: Boolean(activeRequestStatus),
    automaticStatusVisible: Boolean(activeRequestStatus?.automaticStatusVisible),
    governorDecision: activeGovernorDecision,
    activeError: tabError,
    securityIncomplete:
      tab.key === "security" && securityBlind,
    screenReader,
  });
  const showSpinner = !remoteSetup && ANIMATE && (semanticStatus.animate || hasRunningVisible);
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

  // Armed on the same condition the loading line renders on, so a start that
  // resolves inside ICON_HINT_AFTER_MS clears the timer on the way past and
  // never writes state at all -- the fast path stays exactly as many renders as
  // it was. `anyFirstLoad` excludes tabs that failed (see firstLoad above), so a
  // wedged tab cannot hold this armed: an error line already says what happened,
  // and a font hint underneath it would be answering a question nobody asked.
  useEffect(() => {
    if (!anyFirstLoad || iconHintDue) return;
    const timer = setTimeout(() => setIconHintDue(true), ICON_HINT_AFTER_MS);
    return () => clearTimeout(timer);
  }, [anyFirstLoad, iconHintDue]);

  const items = data[tab.key];
  const displayError = formatTabErrorForWidth(tabError, failureContext, Math.max(1, cols - 5));
  const coordinationError = activeGovernorDecision?.coordinationError && !remoteSetup;
  const coordinationReason = activeGovernorDecision?.reason ?? "unavailable";
  const coordinationCondition = coordinationError ? `${tab.key}\0${coordinationReason}` : null;
  useEffect(() => {
    setVisibleCoordinationCondition(null);
    if (coordinationCondition === null) return;
    const timer = setTimeout(
      () => setVisibleCoordinationCondition(coordinationCondition),
      COORDINATION_NOTICE_AFTER_MS,
    );
    return () => clearTimeout(timer);
  }, [coordinationCondition]);
  const showCoordinationNotice = coordinationCondition !== null &&
    visibleCoordinationCondition === coordinationCondition;
  const noticeLine = showCoordinationNotice
    ? coordinationNotice(coordinationReason)
    : !remoteSetup && displayError ? displayError : "";
  const noticeTone = showCoordinationNotice ? ATTENTION : displayError ? ERROR_TEXT : undefined;
  const spin = SPINNER[frame % SPINNER.length];

  const counts = Object.fromEntries(
    TABS.map((t) => {
      const list = data[t.key];
      if (list == null) return [t.key, null];
      // Every tab can be truncated, not just Actions: issues and PRs cap at
      // LIST_LIMIT and each alert lane caps at 100. Reporting a filled newest or
      // priority lane as exact would hide that relevant rows can remain beyond
      // the bounded fetch.
      const suffix = meta[t.key]?.truncated ? "+" : "";
      // A blind Security tab reports "?" rather than a number it cannot stand
      // behind. Zero alerts and zero visibility look identical otherwise.
      if (t.key === "security" && securityBlind) return [t.key, "?"];
      return [t.key, `${list.length}${suffix}`];
    }),
  );
  // Kept out of `counts` because the two have different audiences. In the tab bar
  // `!` sits next to a label and means "the newest run failed"; interpolated into
  // the frame's bottom edge it produced "4 of 4!", where there is nothing for it
  // to attach to and it reads as emphasis or a typo. `+` composes fine in both
  // places, so only this one had to move. Newest first, so the head of the list
  // is the run that decides whether CI is currently red.
  const brokenCI = Object.fromEntries(
    TABS.map((t) => {
      const list = data[t.key];
      return [
        t.key,
        t.key === "actions" &&
          Array.isArray(list) &&
          list.length > 0 &&
          list[0].status === "completed" &&
          list[0].conclusion !== "success" &&
          list[0].conclusion !== "skipped",
      ];
    }),
  );
  const failed = Object.fromEntries(
    TABS.map((t) => [t.key, Boolean(errors[t.key]) && errors[t.key]?.verdict !== "no-remote"]),
  );

  // Data can be arbitrarily old without anything on screen saying so: a failing
  // poll only surfaces on the tab you have selected, and after a laptop sleep
  // every pane is plausible and wrong. Threshold-gated and minute-granular on
  // purpose -- see STALE_AFTER_MS.
  // Read from the ref written on every successful poll, not from meta.at, which
  // only moves when the *payload* changes -- see lastOkRef. Reading a ref during
  // render lags by one render, which is harmless here because `now` advances on
  // its own and the label is minute-granular by design.
  const lastOk = lastOkRef.current[tab.key];
  const staleFor = lastOk == null ? null : now.getTime() - lastOk;
  const staleAt = freshnessDeadline({
    lastOk,
    refreshMs: runtime.refreshMs,
    grantedMs: admittedCadenceRef.current[tab.key]?.grantedMs,
    governorDecision: activeGovernorDecision,
    currentEpochs: governorEpochs,
  });
  const staleLabel =
    staleFor != null && staleAt != null && now.getTime() > staleAt
      ? `stale ${formatDuration(Math.min(staleFor, 359_999_000))}`
      : null;

  const allItems = items ?? [];
  const tabOffsetRaw = offset[tab.key] ?? 0;
  const selectedKey = selected[tab.key] ?? null;
  // Re-clamped on every render rather than only on resize: the payload can
  // shrink under us between ticks, and a stale offset would render an empty
  // body while the count in the frame said otherwise.
  const maxOffset = Math.max(0, allItems.length - bodyRows);
  const reconciledSelection = reconcileSelectionViewport({
    items: allItems,
    key: selectedKey,
    offset: Math.min(tabOffsetRaw, maxOffset),
    rows: bodyRows,
  });
  const tabOffset = reconciledSelection.offset;
  const visibleItems = allItems.slice(tabOffset, tabOffset + bodyRows);

  // Matched by key, never by position. If the selected item is gone -- closed,
  // merged, or aged out of the fetch window -- no row matches and nothing is
  // highlighted, which is the honest state; the next arrow key selects from the
  // top again. Resolving to a neighbouring index instead would silently move
  // the cursor onto an unrelated row.
  useEffect(() => {
    if (reconciledSelection.key !== selectedKey) {
      setSelected((current) => {
        if (reconciledSelection.key !== null) {
          return { ...current, [tab.key]: reconciledSelection.key };
        }
        if (!Object.hasOwn(current, tab.key)) return current;
        const next = { ...current };
        delete next[tab.key];
        return next;
      });
    }
    if (reconciledSelection.offset !== tabOffsetRaw) {
      setOffset((current) => ({ ...current, [tab.key]: reconciledSelection.offset }));
    }
  }, [reconciledSelection.key, reconciledSelection.offset, selectedKey, tabOffsetRaw, tab.key]);
  // Bottom-right of the frame, lazygit style: how much of the tab you can
  // currently see out of how much there is.
  const countLabel =
    items == null
      ? null
      : tabOffset > 0
        ? `${tabOffset + 1}-${tabOffset + visibleItems.length} of ${counts[tab.key]}`
        : `${visibleItems.length} of ${counts[tab.key]}`;

  // One column short of the reported width, not the full width: some
  // terminals (observed in Ghostty, split-pane) clip or misrender whatever
  // glyph lands on the pane's absolute last column -- for this frame that is
  // always the right border. Stopping one column early costs a blank column
  // of slack but keeps the border visible everywhere, regardless of which
  // terminal is doing the clipping.
  const frameCols = Math.max(1, cols - 1);

  // Name the repository in the top edge when it was chosen explicitly, because
  // then it is not the one you would guess from the working directory. Nothing
  // on screen said which repo a pane was watching, and the documented workflow is
  // several panes side by side plus `--repo` from anywhere -- so telling them
  // apart meant quitting and running --doctor. Only the explicit cases are shown:
  // resolving the *inferred* repo would cost a subprocess call at startup for a
  // label that, by definition, names the directory you are already sitting in.
  //
  // GH_REPO is read straight from the environment and never went through
  // parseRepoTarget, so unlike runtime.repo it is unvalidated -- safe() before it
  // is drawn, on the same rule as every other string this app does not own.
  // Dropped before the tab name rather than with it: PanelEdge drops its whole
  // label when it cannot seat one, so a single concatenated string would take the
  // tab name down with the target at ordinary widths.
  const target = runtime.repo ?? safe(process.env.GH_REPO ?? "");
  const withTarget = target ? `${tab.label} · ${target}` : tab.label;
  const topLabel = frameCols - 3 - withTarget.length >= 0 ? withTarget : tab.label;

  // Fixed columns deliberately do not shrink, so BRANCH and TIME stay readable
  // at ordinary widths. Narrow panes drop columns instead, which keeps the
  // frame, the tab bar and the quit hint on screen -- the previous behaviour
  // pushed all three off the bottom. Measured against frameCols, the width the
  // frame itself actually gets, not the raw terminal width.
  // Per tab, not one global flag. MIN_TABLE_WIDTH is a max across all four, so
  // the widest tab was deciding for the narrowest: Pull requests needs 61
  // columns and Security only 44, which meant Security dropped two columns a
  // full 17 columns before it had to. Only one tab is on screen at a time, so
  // the cost -- different tabs showing different column counts at the same width
  // -- is not something you can actually see. MIN_TABLE_WIDTH stays as the
  // exported worst case, which is what the tests pin.
  const tabOverrides = pick(widthOverridesRef.current, tab.key, EMPTY_WIDTH_OVERRIDES) ??
    EMPTY_WIDTH_OVERRIDES;
  const effectiveHeader = useMemo(
    () => effectiveHeaderFor(tab, tabOverrides, frameCols),
    [tab, tabOverrides, frameCols],
  );
  const compact = effectiveHeader == null;
  const header = compact ? tab.compactHeader : effectiveHeader;

  // Below the compact set's own floor even the fixed columns overflow, which
  // hard-wraps every row and drives ink into clearing and repainting the whole
  // screen each frame -- the one failure mode this file is most engineered to
  // avoid, and it was reachable simply by dragging a sidebar narrow. The guard
  // sits after usableSize(), which substitutes DEFAULT_COLS for a 0 reported
  // mid-resize, so a transient zero cannot be mistaken for a genuinely tiny pane.
  const tooNarrow = frameCols < MIN_COMPACT_WIDTH;
  const fullHeaderVisible = !compact && !showHelp && !tooNarrow && !remoteSetup;
  const selectedWidthKey = selectedWidthKeyByTab[tab.key] ?? null;
  const selectedWidthColumn = effectiveHeader?.find(
    (column) => column.key === selectedWidthKey,
  ) ?? null;
  resizeRef.current = {
    active: widthMode && fullHeaderVisible && selectedWidthColumn !== null,
    tabKey: tab.key,
    selectedKey: selectedWidthKey,
    effectiveHeader,
    frameCols,
    compact,
    fullHeaderVisible,
  };

  // A resize, help/setup transition, or replacement layout can remove the full
  // header without a keypress. Stop owning input immediately through resizeRef,
  // then settle the visible mode state and durable write in the effect.
  useEffect(() => {
    let flushed = false;
    const drag = dragRef.current;
    if (drag) {
      const metrics = measuredHeader();
      if (
        drag.tabKey !== tab.key ||
        !fullHeaderVisible ||
        !sameElementMetrics(drag.metrics, metrics)
      ) {
        flushed = cancelWidthDrag();
      }
    }
    if (!widthMode || fullHeaderVisible) return;
    setWidthMode(false);
    if (!flushed) void widthPreferenceWriter.flush();
  }, [
    widthMode,
    fullHeaderVisible,
    tab.key,
    frameCols,
    extraLines,
    cancelWidthDrag,
    measuredHeader,
    widthPreferenceWriter,
  ]);

  // Keep one physical row below Ink's output, the vertical counterpart to the
  // spare column in `frameCols`. Incremental rendering assumes its cursor still
  // sits at the bottom of the previous frame; if dynamic content occupies the
  // terminal's last row, a terminal scroll can invalidate that assumption and
  // leave old status lines behind. A non-fullscreen frame gets a trailing
  // newline from Ink, so the cursor parks on the unused guard row while the
  // status bar remains one row above the scroll edge.
  const liveRows = Math.min(rows, usableSize(stdout?.rows, rows));
  const frameRows = Math.max(1, liveRows - 1);

  return e(
    Box,
    { flexDirection: "column", width: frameCols, height: frameRows },
    e(TabBar, {
      activeIndex,
      counts,
      brokenCI,
      firstLoad,
      failed,
      spin,
      useShort: useShortLabels,
    }),
    e(Divider, { width: frameCols }),
    e(PanelEdge, { width: frameCols, top: true, label: topLabel, labelColor: TITLE_COLOR }),
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
      // Below the compact floor, say so instead of rendering a table that cannot
      // fit. The frame, the tab bar and the quit hint stay, so widening the pane
      // recovers immediately -- this is a render-time branch and touches no state.
      // Short enough to survive at the widths it actually appears at -- a message
      // about the pane being too narrow that is itself truncated would be a joke.
      // Clamped to bodyRows so it can never push the frame past `rows` and
      // trigger the full repaint the height reservation exists to prevent, and
      // truncate-end so it degrades rather than wraps in a narrow pane. Every
      // glyph in KEY_TABLE is plain ASCII, which is what keeps it safe here.
      showHelp &&
        helpLines(bodyRows)
          .map((line, i) => e(Text, { key: `help${i}`, wrap: "truncate-end" }, line)),
      !showHelp &&
        tooNarrow &&
        e(Text, { dimColor: true, wrap: "truncate-end" }, "too narrow"),
      e(Text, { color: noticeTone, wrap: "truncate-end" }, noticeLine),
      !showHelp &&
        !tooNarrow &&
        !remoteSetup &&
        tab.key === "security" &&
        securityLines.map((note, i) =>
          e(Text, { key: i, dimColor: true, wrap: "truncate-end" }, note),
        ),
      !showHelp &&
        !tooNarrow &&
        remoteSetup &&
        (interactive ? REMOTE_SETUP_LINES : REMOTE_SETUP_NONINTERACTIVE_LINES).map(
          (line, index) =>
            e(
              Text,
              {
                key: `remote-setup-${index}`,
                color: index === 0 ? TITLE_COLOR : undefined,
                bold: index === 0,
                dimColor: index === 1,
                wrap: "truncate-end",
              },
              line,
            ),
        ),
      !showHelp &&
        !tooNarrow &&
        !remoteSetup &&
        e(MemoHeaderCells, {
          cells: header,
          selectedWidthKey: resizeRef.current.active ? selectedWidthKey : null,
          headerRef,
        }),
      ...(tooNarrow || showHelp || remoteSetup ? [] : visibleItems).map((item) => {
        const key = itemKey(item);
        return e(
          RowBoundary,
          { key, resetKey: item },
          e(tab.Row, {
            item,
            now,
            compact,
            columns: header,
            cursor: key === selectedKey,
            // Only an *executing* Actions row reads this. It used to go to every
            // visible row on the tab, so a prop that changes several times a
            // second defeated the memoisation below for all of them rather than
            // for the one or two actually spinning -- measured at 7,960 row
            // renders over 20s against 238 with this condition.
            spin:
              tab.key === "actions" && showSpinner && item.status === "in_progress" ? spin : null,
          }),
        );
      }),
      // Distinguishes "still fetching" from "resolved and empty" in the body,
      // which is the difference between a dashboard that looks hung and one
      // that looks correct. Driven by "never resolved" rather than by the
      // loading flag, which also covers a manual refresh and made a
      // settled-empty tab swap its message. Suppressed entirely when a tab has
      // an error and has never resolved: the error line directly above already
      // says what happened, and "no runs" underneath it reads as a fact about the
      // repository rather than the absence of an answer.
      !showHelp &&
        !tooNarrow &&
        !remoteSetup &&
        visibleItems.length === 0 &&
        !(tabError && items == null) &&
        e(
          Text,
          { dimColor: true },
          firstLoad[tab.key]
            ? `${showSpinner ? spin : SPINNER[0]} loading ${tab.label.toLowerCase()}…` +
              // Appended only once a first fetch has been running for
              // ICON_HINT_AFTER_MS, so an ordinary start never shows it: the
              // remedy is for someone looking at a pane of blank boxes, and by
              // then they have been looking long enough to want an explanation.
              // Suppressed once icons are already ASCII, since then there is
              // nothing to fix.
              (USING_NERD_ICONS && iconHintDue ? "   (icons blank? GH_GLANCE_ICONS=unicode)" : "")
            : semanticStatus.kind === "paused" || waiting[tab.key]
              ? "waiting for API budget…"
            : tab.key === "security" && securityNotes.length === ALERT_SOURCES.length
              ? "no alert sources available"
              : `no ${tab.countLabel}`,
        ),
      // Pushes the panel's bottom edge down to the foot of the pane, so the
      // frame stays put instead of closing up under the column headers on a
      // tab that only has a handful of rows.
      e(Box, { flexGrow: 1 }),
    ),
    e(PanelEdge, { width: frameCols, top: false, label: countLabel, labelColor: BORDER_COLOR }),
    e(StatusBar, {
      status: semanticStatus,
      detail: activeGovernorDecision,
      spin: showSpinner ? spin : null,
      stale: staleLabel,
      nowMs: now.getTime(),
      interactive,
      cols: frameCols,
      remoteSetup,
      widthMode: resizeRef.current.active,
      widthColumn: selectedWidthColumn,
      widthSaveError,
      canMove: allItems.length > 0,
      canOpen:
        selectedKey !== null &&
        OPENABLE.includes(tab.key) &&
        allItems.some((item) => itemKey(item) === selectedKey),
      canResize: fullHeaderVisible,
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

function createTerminalLifecycle(write) {
  if (typeof write !== "function") throw new TypeError("write must be a function");
  let mouseReportingEnabled = false;
  let screenRestored = false;

  function enableMouseReporting() {
    if (mouseReportingEnabled || screenRestored) return false;
    write("\x1b[?1002h\x1b[?1006h");
    mouseReportingEnabled = true;
    return true;
  }

  function disableMouseReporting() {
    if (!mouseReportingEnabled) return false;
    write("\x1b[?1002l\x1b[?1006l");
    mouseReportingEnabled = false;
    return true;
  }

  function restoreScreen() {
    if (screenRestored) return false;
    disableMouseReporting();
    screenRestored = true;
    // Ink restores the cursor only through its own unmount path, which an
    // explicit process.exit() skips.
    write("\x1b[?25h\x1b[?1049l");
    return true;
  }

  return {
    enableMouseReporting,
    disableMouseReporting,
    restoreScreen,
    isMouseReportingEnabled: () => mouseReportingEnabled,
  };
}

const terminalLifecycle = createTerminalLifecycle((output) => process.stdout.write(output));

function enableMouseReporting() {
  return terminalLifecycle.enableMouseReporting();
}

function disableMouseReporting() {
  return terminalLifecycle.disableMouseReporting();
}

// Idempotent because both the lifecycle controller and this process-level
// wrapper share one restored state. Mouse modes are always disabled before the
// alternate buffer is released, including when this is only the exit backstop.
function restoreScreen() {
  return terminalLifecycle.restoreScreen();
}

// A crash used to be indistinguishable from a clean quit. Ink catches render
// errors and draws them -- into the alternate screen, which the exit handler
// then discarded -- and nothing ever set a non-zero exit code, so the dashboard
// simply vanished and any wrapper saw success. Restore the primary buffer
// *first*, then write, or the fix reproduces the problem it is fixing.
//
// Unmount before restore so Ink's final repaint stays in the alternate buffer.
// A crash before app assignment, or another failure during unmount, can skip the
// poll effect's cleanup, so abortLiveRequests() remains an explicit backstop.
// It runs *after* restoreScreen() and is wrapped because an exception there must
// not replace the stack trace this handler exists to print.
//
// Both messages go through redact(): a stack can carry a URL with inline
// credentials, and this output is what a user pastes into a bug report -- the
// same reasoning --doctor already applies to its own report.
function installCrashHandlers(unmountApp) {
  const fail = (label) => (err) => {
    unmountApp();
    restoreScreen();
    try {
      abortLiveRequests();
    } catch {
      // Nothing useful to do about a failure here, and the stack below matters more.
    }
    console.error(`gh-glance: ${label}`);
    console.error(redact(err instanceof Error ? (err.stack ?? err.message) : String(err)));
    process.exit(1);
  };
  process.on("uncaughtException", fail("crashed"));
  process.on("unhandledRejection", fail("unhandled promise rejection"));
}

if (IS_MAIN) {
  let app;
  const unmountApp = () => {
    try {
      app?.unmount();
    } catch {
      // Teardown is best effort. Every caller still restores the terminal.
    }
  };
  disarmDevBuildLeak();
  installCrashHandlers(unmountApp);
  enterAlternateScreen();
  process.on("exit", restoreScreen);

  // Ink's default renderer erases and rewrites the whole viewport on every
  // change; incremental mode updates only the lines that differ. Measured on a
  // settled 80x24 pane: 13,918 bytes of terminal traffic down to the figure in
  // the commit message.
  //
  // PE-M1 flagged the risk: ink's own source notes a Windows-console desync for
  // frames that exactly fill the viewport, which this app always does since the
  // root box is the terminal height. Windows is already documented as untested
  // (README Limitations), and the pty harness covers the two platforms that are
  // supported, so the flag is verified where it is claimed to work.
  let remoteSetupStarted = false;
  const createRemote = (suspendTerminal) => {
    if (remoteSetupStarted) return;
    remoteSetupStarted = true;

    // Release Ink's raw-mode/parser state before the child inherits stdin.
    // Unmounting alone can leave an active readable dispatch racing the first
    // bytes typed for gh, so one immediate boundary lets that dispatch return;
    // the explicit stream cleanup below then prevents any future parent reads.
    void suspendTerminal()
      .then(async () => {
        await new Promise((resolve) => setImmediate(resolve));
        unmountApp();
        // This is a permanent handoff, so the parent must not retain any stream
        // consumer that can race the child for terminal bytes. Pausing/removing
        // Node listeners does not close fd 0; the spawned process still inherits
        // the same canonical TTY directly from the operating system.
        process.stdin.pause();
        process.stdin.removeAllListeners("readable");
        process.stdin.removeAllListeners("data");
        restoreScreen();
        abortLiveRequests();

        await new Promise((resolve) => {
          // Plain `gh repo create` is the interactive form. Supplying --source
          // here would switch gh to non-interactive mode and require gh-glance
          // to choose a visibility on the user's behalf, which this consent
          // boundary must never do. The prompt tells the user which interactive
          // path matches this folder.
          const child = spawn("gh", ["repo", "create"], {
            stdio: "inherit",
            env: process.env,
          });
          setupChild = child;
          child.once("error", (err) => {
            if (setupChild === child) setupChild = null;
            console.error(
              `gh-glance: could not start repository setup: ${redact(shortErr(err))}`,
            );
            process.exitCode = 1;
            resolve();
          });
          child.once("exit", (code, signal) => {
            if (setupChild === child) setupChild = null;
            process.exitCode = signal ? 1 : (code ?? 1);
            if (code === 0) {
              console.log(
                "gh repo create finished. Run gh-glance again when this folder has a remote.",
              );
            }
            resolve();
          });
        });
      })
      .catch((err) => {
        unmountApp();
        restoreScreen();
        try {
          abortLiveRequests();
        } catch {
          // Preserve the handoff error below.
        }
        console.error(`gh-glance: could not hand off the terminal: ${redact(shortErr(err))}`);
        process.exitCode = 1;
      });
  };
  app = render(e(App, { onCreateRemote: createRemote }), { incrementalRendering: true });
  // Ink's q/Esc/Ctrl+C exit unmounts directly rather than calling unmountApp.
  // Only close the identity coordinator after that actual application exit,
  // not when a polling effect reruns. Rejections reach the crash handler above.
  void app.waitUntilExit().then(abortLiveRequests);

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
  let signalExitStarted = false;
  const bySignal = (code, signal) => () => {
    if (signalExitStarted) return;
    signalExitStarted = true;
    const finish = () => {
      unmountApp();
      restoreScreen();
      abortLiveRequests();
      process.exit(code);
    };

    const child = setupChild;
    if (forwardSignalToChild(child, signal)) {
      const force = setTimeout(() => {
        forwardSignalToChild(child, "SIGKILL");
        finish();
      }, 1000);
      child.once("exit", () => {
        clearTimeout(force);
        finish();
      });
      return;
    }
    finish();
  };
  process.on("SIGINT", bySignal(130, "SIGINT"));
  process.on("SIGTERM", bySignal(143, "SIGTERM"));
  process.on("SIGHUP", bySignal(129, "SIGHUP"));
}

// Exported for unit tests. The dashboard itself is still one file; these are
// the pure functions worth pinning, and nothing here is part of the public API.
export {
  retryIdentityCompletion,
  createSettlementContext,
  startIdentityControl,
  settleIdentityControl,
  resolveEffectiveCredential,
  identityRegistryRoot,
  inspectIdentityRegistry,
  claimIdentityBootstrap,
  finishIdentityBootstrap,
  createIdentityCoordinator,
  createQuotaScope,
  acquireIdentityHttpPermit,
  releaseIdentityHttpPermit,
  parseArgs,
  validateArgs,
  parseRepoTarget,
  REPO_PATTERN,
  HOST_PATTERN,
  MIN_REFRESH_SECONDS,
  MAX_REFRESH_SECONDS,
  BACKGROUND_MODES,
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
  externalSampleIsUsable,
  BUDGET_SAFETY,
  BUDGET_RESERVE_FRACTION,
  BUDGET_SNAPSHOT_TTL_MS,
  GRAPHQL_BUDGET_SNAPSHOT_TTL_MS,
  budgetSnapshotTtl,
  currentSharedLaneProvenance,
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
  GOVERNOR_STATE_VERSION,
  RATE_RESOURCES,
  GOVERNOR_MAX_LEASES,
  GOVERNOR_MAX_INTENTS,
  GOVERNOR_MAX_RESERVATIONS,
  GOVERNOR_LOCK_WAIT_MS,
  GOVERNOR_PROBE_DRAIN_MS,
  GOVERNOR_ID_PATTERN,
  governorId,
  normalizeHost,
  remoteHost,
  resolveEffectiveHost,
  governorScopeHash,
  governorPath,
  createGovernorScope,
  emptyGovernorState,
  normalizeGovernorState,
  serializeGovernorState,
  readGovernorState,
  writeGovernorState,
  pidIsDead,
  releaseGovernorLock,
  withGovernorLock,
  registerLease,
  heartbeatLease,
  maintainControlLease,
  claimProbe,
  classifyThrottle,
  applyTransportCooldown,
  clearTransportThrottle,
  emptyTransportThrottle,
  throttleLadderMs,
  transportCooldownDeadline,
  retryThrottledTransport,
  THROTTLE_LADDER_MS,
  THROTTLE_PAUSE_AFTER,
  MANUAL_GRANT_STREAK_LIMIT,
  renewProbeClaim,
  publishProbe,
  failProbeClaim,
  requestManualProbe,
  registerIntent,
  readIntentDecision,
  cancelIntent,
  startReservation,
  completeReservation,
  settleReservationWithBudgetObservations,
  recordResourceBlock,
  releaseLease,
  inspectAdmittedHttpStart,
  inspectGovernor,
  governorHealth,
  refreshSharedBudget,
  readCoreBudget,
  readSharedBudgetSources,
  safe,
  shortErr,
  isUnavailable,
  isRateLimited,
  isAuthProblem,
  isMissingRemote,
  noRepositoryTarget,
  isUnusableOutput,
  forwardSignalToChild,
  toTabError,
  formatTabError,
  parseRepoContext,
  parseAuthContext,
  buildFailureContext,
  resolveFailureContext,
  failureTargetHost,
  unavailableRemedy,
  createFailureContextCoordinator,
  createOpenRequestRegistry,
  openInBrowser,
  AUTH_RETRY_MS,
  BACKOFF_STEPS_MS,
  redact,
  classify,
  parseJsonOutput,
  parseGhApiResponse,
  pickRateLimit,
  ghApiArgs,
  ghApi,
  actionsRunsArgs,
  actionsWorkflowsArgs,
  parseActionsBodies,
  parseActionsRuns,
  parseWorkflowCatalog,
  resolveWorkflowNames,
  workflowCatalogDemand,
  fetchActions,
  ACTIONS_RUN_LIMIT,
  WORKFLOW_CATALOG_TTL_MS,
  entityKey,
  fetchConditionalEntity,
  conditionalBatchResult,
  publishStagedEntities,
  fetchAlertSource,
  formatAge,
  formatDuration,
  usableSize,
  severityRank,
  pick,
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
  minimumWidthFor,
  WIDTH_PREFERENCES_VERSION,
  widthPreferencesPath,
  parseWidthPreferences,
  serializeWidthPreferences,
  loadWidthPreferences,
  saveWidthPreferences,
  createWidthPreferenceWriter,
  mergeWidthPreferenceSnapshots,
  adoptPersistedSnapshot,
  DASHBOARD_CACHE_VERSION,
  dashboardCachePath,
  dashboardCacheTarget,
  authCacheIdentity,
  serializeDashboardCache,
  loadDashboardCache,
  saveDashboardCache,
  mergeDashboardCacheSnapshots,
  nextSecurityRaw,
  shouldCheckpointFreshness,
  pollPolicyInterval,
  advanceUnchangedCount,
  POLL_ACTIVE_CI_MS,
  POLL_QUIET_AFTER,
  POLL_QUIET_MS,
  POLL_BACKGROUND_MS,
  shouldShowFetchLoading,
  refreshIntent,
  manualRefreshRequest,
  planManualRefresh,
  conditionalRecoveryPlan,
  pollSchedule,
  retryPollAfterAdmissionFailure,
  governorWakeTimes,
  governorControlReady,
  tabEpochChanged,
  governorDataReady,
  governorControlRetryAt,
  createWakeScheduler,
  createSingleFlightWake,
  pendingFailureIsTerminal,
  runtimeIntentGate,
  rateLimitBlockDecision,
  coordinationNotice,
  mergeRateLimitBlockPublications,
  hydrateRateLimitBlockPublication,
  retryRateLimitBlockPublication,
  rateLimitBlockProbeRecovered,
  admitGovernorOperation,
  runAdmittedOperation,
  GOVERNOR_ADMISSION_WAIT_MS,
  pollResultTransition,
  forcedBackoffKeys,
  clearForcedBackoffAfterStart,
  doctorProbePlan,
  rowBrowserUrl,
  admittedRowUrl,
  remoteSlug,
  resolveEffectiveRepository,
  graphqlPageVariables,
  graphqlRepositoryVariables,
  parseGraphqlEnvelope,
  graphqlInput,
  graphqlArgs,
  fetchGraphqlPage,
  fetchGraphqlList,
  PAGE_DEMAND_THRESHOLD,
  pageGeneration,
  paginationDemand,
  demandedPageCount,
  mergeDemandedPages,
  operationPausedUntil,
  LIST_LIMIT,
  readGraphqlObserver,
  GRAPHQL_QUERIES,
  GRAPHQL_PAGE_SIZE,
  GRAPHQL_PAGE_POINTS,
  GRAPHQL_OBSERVER_POINTS,
  mapAllSettledBounded,
  alertRequestArgs,
  shouldFetchAlertPriorityLanes,
  mergeAlertRows,
  reconcileSelectionViewport,
  runStatusIcon,
  RUN_STATUS_ICON,
  SEVERITY_STYLE,
  REVIEW_LABEL,
  MIN_TABLE_WIDTH,
  MIN_COMPACT_WIDTH,
  TABS,
  OCT_NERD,
  OCT_UNICODE,
  normalizeIconProfile,
  KEY_TABLE,
  KEY_HINTS,
  activeKeyHints,
  tabFailureSuffix,
  formatTabErrorForWidth,
  selectionLabel,
  helpLines,
  summarizeDoctorEnv,
  widthStatusText,
  refreshStatus,
  statusInterval,
  statusBarLayout,
  freshnessDeadline,
  nextAdmittedCadence,
  probingGovernorDecisions,
  retainDeferredGovernorHold,
  REFRESH_STATUS_GLYPHS,
  headerGutterKey,
  HeaderCells,
  parseSgrMouse,
  dividerHandles,
  hitDivider,
  beginDividerDrag,
  draggedWidth,
  shouldEnableMouseReporting,
  createTerminalLifecycle,
  RowBoundary,
  REMOTE_SETUP_HINTS,
  REMOTE_SETUP_LINES,
  REMOTE_SETUP_NONINTERACTIVE_LINES,
  VERDICT_REMEDY,
  FAILURE_LADDER,
  COORDINATION_NOTICE_AFTER_MS,
};
