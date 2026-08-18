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
const MIN_RUN_LIMIT = 20;

// Ceiling on the pane-height-derived run limit. Without it a very tall terminal
// asks for enough runs that the fetch outlasts REFRESH_MS, at which point ticks
// are permanently absorbed by the in-flight guard and the effective refresh rate
// silently becomes whatever `gh` can sustain.
const MAX_RUN_LIMIT = 60;

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

// Inactive tabs only feed the tab-bar counts, so they refresh every Nth tick
// rather than every tick. Raised from 4 to 12 (a 60s cycle at the default
// refresh) because the measured steady-state cost was 1,980-2,520 REST calls
// per hour against a 5,000/hr limit -- 40-50% of the user's entire budget for a
// single pane. Only the tab you are looking at needs REFRESH_MS latency; the
// other three exist to keep counts honest, which tolerates a minute.
const BACKGROUND_EVERY = 12;
// What one fetch of each tab costs lives in REST_PER_FETCH / GRAPHQL_PER_FETCH,
// declared with ALERT_SOURCES below because the security figure derives from it.

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
  liveAbort?.abort();
  liveAbort = null;
}

function forwardSignalToChild(child, signal) {
  // child.killed means only that kill() was called successfully; it becomes
  // true before the process exits and therefore cannot gate SIGKILL escalation.
  if (!child || child.exitCode !== null || child.signalCode !== null) return false;
  return child.kill(signal);
}

async function runGh(args, { signal, operation } = {}) {
  if (operationCost(operation) === null) {
    throw new Error(`undeclared gh operation: ${operation ?? "missing"}`);
  }
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

// The target as `gh` spells it: host-qualified when a host was given, the bare
// slug otherwise -- which is exactly the [HOST/]OWNER/REPO form `gh --repo`
// documents.
function qualifiedRepo() {
  const host = runtime.repoExplicit ? effectiveRuntimeHost() : runtime.host;
  return host ? `${host}/${runtime.repo}` : runtime.repo;
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

// `--repo` for the list subcommands. Empty when unset, so the argv vector stays
// byte-identical to what shipped before.
function repoArgs() {
  return runtime.repo ? ["--repo", qualifiedRepo()] : [];
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
function repoContextArgs() {
  const target = runtime.repo ? qualifiedRepo() : null;
  return [
    "repo",
    "view",
    ...(target ? [target] : []),
    "--json",
    "nameWithOwner,url,viewerPermission",
  ];
}

function authContextArgs() {
  return [
    "auth",
    "status",
    "--active",
    "--json",
    "hosts",
    "--jq",
    ".hosts | to_entries | map(.key as $host | .value[] | select(.active == true) | {host: $host, login: .login})",
  ];
}

function parseRepoContext(raw) {
  try {
    const value = JSON.parse(raw);
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
        run: (admittedSignal) => run(repoContextArgs(), {
          signal: admittedSignal,
          operation: "failure-context:repository",
        }),
      }).then((result) => result.ok ? result.value : Promise.reject(result.error))
    : Promise.reject(new Error("API budget unavailable"));
  const [repo, auth] = await Promise.allSettled([
    repoCall,
    run(authContextArgs(), { signal, operation: "failure-context:auth" }),
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

function actionsArgs(limit) {
  return [
    "run",
    "list",
    ...repoArgs(),
    "--limit",
    String(limit),
    "--json",
    "databaseId,displayTitle,workflowName,number,headBranch,status,conclusion,startedAt,updatedAt",
  ];
}

async function fetchActions(limit, signal) {
  const raw = await runGh(actionsArgs(limit), { signal, operation: "tab:actions" });
  return {
    raw,
    limit,
    // What this fetch actually cost, read from the one cost table rather than
    // re-derived from the argv shape -- a second copy of the cost model is the
    // drift this file warns about repeatedly.
    restSpent: REST_PER_FETCH.actions,
    graphqlSpent: GRAPHQL_PER_FETCH.actions,
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

function issuesArgs() {
  return [
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
  ];
}

async function fetchIssues(signal) {
  const raw = await runGh(issuesArgs(), { signal, operation: "tab:issues" });
  return {
    raw,
    limit: LIST_LIMIT,
    // Stated rather than omitted so the zero is visibly deliberate: SORT_RECENT's
    // --search routes this through GraphQL, which is a separate budget.
    restSpent: REST_PER_FETCH.issues,
    graphqlSpent: GRAPHQL_PER_FETCH.issues,
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

function prsArgs() {
  return [
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
  ];
}

async function fetchPRs(signal) {
  const raw = await runGh(prsArgs(), { signal, operation: "tab:prs" });
  return {
    raw,
    limit: LIST_LIMIT,
    // Zero for the same reason as issues: --search makes this a GraphQL call.
    restSpent: REST_PER_FETCH.prs,
    graphqlSpent: GRAPHQL_PER_FETCH.prs,
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
// actions is 2, not 1: measured 2026-08-10 with `GH_DEBUG=api`, `gh run list`
// issues GET /actions/runs *and* GET /actions/workflows. The 1 that stood here
// understated the default tab -- the tab every pane starts on, since
// initialTabIndex defaults to 0 -- by half.
//
// issues and prs are 0 REST because SORT_RECENT's --search routes both through
// GraphQL entirely (2 POSTs each, confirmed by the same measurement).
const SECURITY_REQUESTS_PER_FETCH = ALERT_SOURCES.reduce(
  (total, source) => total + 1 + source.priorityQueries.length,
  0,
);
const REST_PER_FETCH = { actions: 2, issues: 0, prs: 0, security: SECURITY_REQUESTS_PER_FETCH };
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
  "tab:security-endpoint": { core: 1, graphql: 0 },
  "failure-context:repository": { core: 0, graphql: 1 },
  "failure-context:auth": { core: 0, graphql: 0 },
  "open:actions": { core: REST_PER_FETCH.actions, graphql: 0 },
  "open:issues": { core: 0, graphql: GRAPHQL_PER_FETCH.issues },
  "open:prs": { core: 0, graphql: GRAPHQL_PER_FETCH.prs },
  "doctor:repository": { core: 0, graphql: 1 },
  "doctor:actions": tabRequestCost("actions"),
  "doctor:issues": tabRequestCost("issues"),
  "doctor:prs": tabRequestCost("prs"),
  "doctor:security-endpoint": { core: 1, graphql: 0 },
  "rate-limit": { core: 0, graphql: 0 },
  "version": { core: 0, graphql: 0 },
  "auth-status": { core: 0, graphql: 0 },
  "local-git": { core: 0, graphql: 0 },
});

function operationCost(operation) {
  return pick(OPERATION_COSTS, operation, null);
}

// Target this fraction of what the token can afford, not all of it. The margin
// is for the user's own `gh` and `git` commands.
const BUDGET_SAFETY = 0.8;
const BUDGET_RESERVE_FRACTION = 1 - BUDGET_SAFETY;
const BUDGET_SNAPSHOT_TTL_MS = 65_000;
const GOVERNOR_HEARTBEAT_MS = 20_000;
const GOVERNOR_LEASE_TTL_MS = 90_000;
const GOVERNOR_PROBE_LEASE_MS = 70_000;
const GOVERNOR_ACTIVE_PROBE_LEASE_MS = 35_000;
const BUDGET_RESET_GRACE_MS = 2_000;
const GOVERNOR_PHASE_WINDOW_MS = 5_000;
const BUDGET_WINDOW_MS = 3_600_000;

// How often to re-read the budget. `gh api rate_limit` does not count against
// the limit (verified, delta 0 -- see rateBudget) but it is still a subprocess,
// so once a minute rather than once a tick: the quantity it measures moves on
// the scale of minutes.
const BUDGET_PROBE_MS = 60_000;

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
  return Number.isFinite(cost) && cost > 0 ? cost : 0;
}

function availableForGrant({
  budget,
  reservations = [],
  leases = {},
  nowMs,
  chargedCost = null,
}) {
  const normalized = normalizeBudgetResource(budget);
  if (!normalized) return { mode: "probe", reason: "budget-unknown" };
  if (normalized.observedAt > nowMs) return { mode: "probe", reason: "budget-future" };
  if (nowMs - normalized.observedAt > BUDGET_SNAPSHOT_TTL_MS) {
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
    (total, reservation) => total + reservationCost(reservation, budget.resource, leases, nowMs),
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
    budget: budget && { ...budget, resource },
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
  const priorities = [...new Set(valid.map((intent) => intent.normalizedPriority))].sort((a, b) => a - b);

  for (const priority of priorities) {
    const pending = valid.filter((intent) => intent.normalizedPriority === priority);
    const roundRobinState = createRoundRobinState(pending, updatedCursors);
    while (pending.length > 0) {
      if (grants.length >= maxGrants) break;
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
        denied.push({ intentId: intent.id, resource: blocked, ...decisions[blocked] });
        continue;
      }

      const phaseTimes = Object.fromEntries(resources.map((resource) => {
        return [
          resource,
          intent.normalizedPriority === REQUEST_PRIORITIES.manual
            ? nowMs
            : governorEpochPhaseAt(intent.phaseSeed, decisions[resource]),
        ];
      }));
      const notBefore = Math.max(
        nowMs,
        ...Object.values(phaseTimes),
        ...(intent.normalizedPriority === REQUEST_PRIORITIES.manual
          ? []
          : resources.map((resource) => updatedLanes[resource]?.nextAt ?? nowMs)),
      );
      const expiring = resources.find((resource) => notBefore >= decisions[resource].resetMs);
      if (expiring) {
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
      grants.push(reservation);
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
  };
}

// ---------- Shared account governor ----------

const GOVERNOR_STATE_VERSION = 1;
const GOVERNOR_MAX_LEASES = 128;
const GOVERNOR_MAX_INTENTS = 512;
const GOVERNOR_MAX_RESERVATIONS = 512;
const GOVERNOR_LOCK_WAIT_MS = 250;
const GOVERNOR_PROBE_DRAIN_MS = 30_000;
const GOVERNOR_PUBLICATION_REINSPECT_MS = 1_000;
const GOVERNOR_MAX_FUTURE_MS = 24 * 60 * 60 * 1000;
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
    .update(JSON.stringify({ version: GOVERNOR_STATE_VERSION, effectiveHost: host, authCacheIdentity: authIdentity }))
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
  const hash = governorScopeHash(current?.effectiveHost, current?.authIdentity);
  return hash === scope.hash ? { ok: true, value: scope } : { ok: false, reason: "stale" };
}

function emptyGovernorState() {
  return {
    version: GOVERNOR_STATE_VERSION,
    epochs: { core: null, graphql: null },
    budgets: {},
    probeClaim: null,
    probeOutcome: { status: "idle", at: 0, nextAt: 0 },
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

function normalizeGovernorBudget(raw, nowMs) {
  if (!exactKeys(raw, [
    "limit", "remaining", "used", "resetMs", "observedAt", "blockUntil",
    "blockReason", "laneNextAt", "roundRobinCursor", "lastExternalFactor", "epoch",
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
    "leaseId", "intentId", "costs", "actualCosts", "notBefore", "status", "epochs",
    "startedAt", "completedAt", "outcome",
  ])) return null;
  const costs = exactResourceCosts(raw.costs);
  const actualCosts = raw.actualCosts === null ? null : exactResourceCosts(raw.actualCosts);
  const epochs = exactKeys(raw.epochs, RATE_RESOURCES) &&
    RATE_RESOURCES.every((resource) => raw.epochs[resource] === null || validGovernorEpoch(raw.epochs[resource]))
    ? { ...raw.epochs }
    : null;
  if (
    !validGovernorId(raw.leaseId) || !validGovernorId(raw.intentId) ||
    !costs || actualCosts === null && raw.actualCosts !== null || !epochs ||
    finiteTimestamp(raw.notBefore, nowMs) === undefined ||
    !GOVERNOR_RESERVATION_STATUSES.has(raw.status) ||
    finiteTimestamp(raw.startedAt, nowMs, { nullable: true }) === undefined ||
    finiteTimestamp(raw.completedAt, nowMs, { nullable: true }) === undefined ||
    (raw.startedAt !== null && raw.startedAt > nowMs) ||
    (raw.completedAt !== null && raw.completedAt > nowMs) ||
    (raw.outcome !== null && !GOVERNOR_OUTCOMES.has(raw.outcome))
  ) return null;
  if (actualCosts && RATE_RESOURCES.some((resource) => actualCosts[resource] > costs[resource])) return null;
  return { ...raw, costs, actualCosts, epochs };
}

function normalizeProbeClaim(raw, nowMs) {
  if (raw === null) return null;
  if (!exactKeys(raw, ["ownerLeaseId", "nonce", "leaseUntil", "nextAt", "claimAt", "startedReservationIds"])) {
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

function normalizeGovernorState(raw, nowMs, { prune = true } = {}) {
  if (!exactKeys(raw, [
    "version", "epochs", "budgets", "probeClaim", "probeOutcome", "leases",
    "intents", "reservations", "manualProbe",
  ]) || raw.version !== GOVERNOR_STATE_VERSION) return null;
  if (
    !exactKeys(raw.epochs, RATE_RESOURCES) ||
    RATE_RESOURCES.some((resource) => raw.epochs[resource] !== null && !validGovernorEpoch(raw.epochs[resource])) ||
    !isRecord(raw.budgets) || Object.keys(raw.budgets).some((resource) => !RATE_RESOURCES.includes(resource)) ||
    !isRecord(raw.leases) || !isRecord(raw.intents) || !isRecord(raw.reservations) ||
    !exactKeys(raw.probeOutcome, ["status", "at", "nextAt"]) ||
    !GOVERNOR_PROBE_STATUSES.has(raw.probeOutcome.status) ||
    finiteTimestamp(raw.probeOutcome.at, nowMs) === undefined ||
    raw.probeOutcome.at > nowMs ||
    finiteTimestamp(raw.probeOutcome.nextAt, nowMs) === undefined
  ) return null;

  const state = emptyGovernorState();
  state.epochs = { ...raw.epochs };
  state.probeOutcome = { ...raw.probeOutcome };
  for (const resource of Object.keys(raw.budgets)) {
    const budget = normalizeGovernorBudget(raw.budgets[resource], nowMs);
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
  state.probeClaim = normalizeProbeClaim(raw.probeClaim, nowMs);
  if (state.probeClaim === undefined) return null;
  if (state.probeClaim?.leaseUntil <= nowMs) state.probeClaim = null;
  state.manualProbe = normalizeManualProbe(raw.manualProbe, nowMs);
  if (state.manualProbe === undefined) return null;
  return state;
}

function serializeGovernorState(state) {
  return `${JSON.stringify(state)}\n`;
}

function readGovernorState(path, nowMs) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    return error?.code === "ENOENT"
      ? { ok: true, value: emptyGovernorState(), missing: true }
      : { ok: false, reason: "unwritable" };
  }
  try {
    const value = normalizeGovernorState(JSON.parse(raw), nowMs);
    return value ? { ok: true, value } : { ok: false, reason: "corrupt" };
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
  const at = scopeNow(scope, nowMs);
  if (!Number.isFinite(at) || at < 0) return { ok: false, reason: "corrupt" };
  return withGovernorLock(scope, () => {
    // Scope can change while this process waits for the file lock. Admission
    // must bind to the host/account identity observed while exclusivity is
    // held, immediately before it reads and mutates the shared state.
    const current = currentGovernorScope(scope);
    if (!current.ok) return current;
    const loaded = readGovernorState(scope.path, at);
    if (!loaded.ok) return loaded;
    const state = loaded.value;
    const value = mutate(state, at);
    if (value?.ok === false && value.write !== true) return value;
    const normalized = normalizeGovernorState(state, at);
    if (!normalized) return { ok: false, reason: "corrupt" };
    const written = writeGovernorState(scope.path, normalized);
    if (!written.ok) return written;
    return value?.ok === false ? { ok: false, reason: value.reason } : { ok: true, value: value?.value };
  });
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
  const deferredBackground = state.probeOutcome.status === "failed"
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
  });
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

function claimProbe(scope, leaseId, nowMs) {
  return mutateGovernor(scope, nowMs, (state, at) => {
    if (!state.leases[leaseId]) return { ok: false, reason: "stale" };
    if (state.probeClaim && state.probeClaim.leaseUntil > at) {
      return { value: { status: "waiting", leaseUntil: state.probeClaim.leaseUntil } };
    }
    const resetProbeAt = Math.min(...Object.values(state.budgets).map(
      (budget) => budget.resetMs + BUDGET_RESET_GRACE_MS,
    ));
    const nextAt = Math.min(state.probeOutcome.nextAt, resetProbeAt);
    if (nextAt > at) return { value: { status: "waiting", nextAt } };
    const nonce = randomUUID();
    const startedReservationIds = Object.entries(state.reservations)
      .filter(([, reservation]) => reservation.status === "started")
      .map(([id]) => id);
    state.probeClaim = {
      ownerLeaseId: leaseId,
      nonce,
      leaseUntil: at + GOVERNOR_PROBE_LEASE_MS,
      nextAt: at,
      claimAt: at,
      startedReservationIds,
    };
    state.probeOutcome = { status: "waiting", at, nextAt: at + GOVERNOR_PROBE_LEASE_MS };
    return { value: { status: "claimed", nonce, leaseUntil: state.probeClaim.leaseUntil, startedReservationIds } };
  });
}

function renewProbeClaim(scope, leaseId, nonce, nowMs) {
  return mutateGovernor(scope, nowMs, (state, at) => {
    const claim = state.probeClaim;
    if (!claim || claim.ownerLeaseId !== leaseId || claim.nonce !== nonce || claim.leaseUntil <= at) {
      return { ok: false, reason: "stale" };
    }
    claim.leaseUntil = at + GOVERNOR_ACTIVE_PROBE_LEASE_MS;
    return { value: { nonce, leaseUntil: claim.leaseUntil } };
  });
}

function budgetFromProbe(raw, previous, nowMs) {
  const normalized = normalizeBudgetResource({ ...raw, observedAt: nowMs });
  if (!normalized || normalized.resetMs <= nowMs) return null;
  const baseEpoch = `${normalized.limit}:${normalized.resetMs}`;
  const epoch = previous && previous.resetMs === normalized.resetMs && previous.used <= normalized.used
    ? previous.epoch
    : previous && previous.resetMs === normalized.resetMs && normalized.used < previous.used
      ? `${baseEpoch}:${nowMs}`
      : baseEpoch;
  const epochChanged = !previous || previous.epoch !== epoch;
  const blockActive = !epochChanged && Number.isFinite(previous.blockUntil) && previous.blockUntil > nowMs;
  return {
    ...normalized,
    blockUntil: blockActive ? previous.blockUntil : null,
    blockReason: blockActive ? previous.blockReason : null,
    laneNextAt: epochChanged ? nowMs : previous.laneNextAt,
    roundRobinCursor: previous?.roundRobinCursor ?? null,
    lastExternalFactor: previous?.lastExternalFactor ?? 1,
    epoch,
  };
}

function publishProbe(scope, leaseId, nonce, budgets, nowMs) {
  return mutateGovernor(scope, nowMs, (state, at) => {
    const claim = state.probeClaim;
    if (!claim || claim.ownerLeaseId !== leaseId || claim.nonce !== nonce || claim.leaseUntil <= at) {
      return { ok: false, reason: "stale" };
    }
    const nextBudgets = {};
    for (const resource of RATE_RESOURCES) {
      nextBudgets[resource] = budgetFromProbe(budgets?.[resource], state.budgets[resource], at);
      if (!nextBudgets[resource]) return { ok: false, reason: "corrupt" };
    }
    const nextEpochs = Object.fromEntries(RATE_RESOURCES.map((resource) => [
      resource,
      budgetEpoch(nextBudgets[resource]),
    ]));
    for (const resource of RATE_RESOURCES) {
      const previous = state.budgets[resource];
      if (!previous || nextBudgets[resource].used < previous.used) continue;
      const sharedCompletedDelta = Object.values(state.reservations)
        .filter((reservation) => reservation.status === "completed" && reservation.completedAt < claim.claimAt)
        .reduce((total, reservation) => total + reservationCost(reservation, resource, state.leases, at), 0);
      const factor = nextExternalFactor({
        lastExternalFactor: previous.lastExternalFactor,
        globalUsedDelta: nextBudgets[resource].used - previous.used,
        sharedCompletedDelta,
      });
      if (factor === null) return { ok: false, reason: "corrupt" };
      nextBudgets[resource].lastExternalFactor = factor;
    }
    const resetChanged = RATE_RESOURCES.some((resource) =>
      state.epochs[resource] !== null && state.epochs[resource] !== nextEpochs[resource],
    );
    for (const [id, reservation] of Object.entries(state.reservations)) {
      if (reservation.status === "completed" && reservation.completedAt < claim.claimAt) {
        delete state.reservations[id];
      }
    }
    state.budgets = nextBudgets;
    state.epochs = nextEpochs;
    state.probeClaim = null;
    state.probeOutcome = { status: "healthy", at, nextAt: at + BUDGET_PROBE_MS };
    if (resetChanged) state.manualProbe = null;
    else if (state.manualProbe &&
      Object.values(nextEpochs).includes(state.manualProbe.requestedEpoch) &&
      RATE_RESOURCES.some((resource) => availableForGrant({ budget: nextBudgets[resource], nowMs: at }).spendable === 0)) {
      state.manualProbe.satisfiedAt = at;
    }
    scheduleGovernorState(state, at);
    return { value: { epochs: nextEpochs, retiredThrough: claim.claimAt } };
  });
}

function failProbeClaim(scope, leaseId, nonce, nowMs) {
  return mutateGovernor(scope, nowMs, (state, at) => {
    const claim = state.probeClaim;
    if (!claim || claim.ownerLeaseId !== leaseId || claim.nonce !== nonce) {
      return { ok: false, reason: "stale" };
    }
    state.probeClaim = null;
    state.probeOutcome = { status: "failed", at, nextAt: at + BUDGET_PROBE_MS };
    return { value: { retryAt: state.probeOutcome.nextAt } };
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
    state.probeOutcome.nextAt = Math.min(state.probeOutcome.nextAt || at, at);
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
    const denial = scheduled.denied.find((item) => item.intentId === intent.id);
    return { value: reservation
      ? { status: "scheduled", reservationId, ...reservation }
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

function readIntentDecision(scope, intentId, nowMs) {
  return mutateGovernor(scope, nowMs, (state, at) => {
    const scheduled = scheduleGovernorState(state, at);
    const reservationId = `reservation:${intentId}`;
    const reservation = state.reservations[reservationId];
    if (reservation) return { value: { status: reservation.status, reservationId, ...reservation } };
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
    if (state.probeClaim && state.probeClaim.leaseUntil > at) {
      return { value: { status: "waiting", reason: "probe", notBefore: state.probeClaim.leaseUntil } };
    }
    for (const resource of RATE_RESOURCES.filter((name) => reservation.costs[name] > 0)) {
      const budget = state.budgets[resource];
      if (
        !budget || at - budget.observedAt > BUDGET_SNAPSHOT_TTL_MS || at >= budget.resetMs ||
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
    return { value: { status: "completed", actualCosts: reservation.actualCosts } };
  });
}

function recordResourceBlock(scope, resource, resetMs, reason) {
  return mutateGovernor(scope, undefined, (state, nowMs) => {
    const budget = state.budgets[resource];
    if (!budget || !RATE_RESOURCES.includes(resource) || !Number.isFinite(resetMs) || resetMs <= nowMs ||
      !GOVERNOR_BLOCK_REASONS.has(reason)) return { ok: false, reason: "corrupt" };
    budget.blockUntil = resetMs;
    budget.blockReason = reason;
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
  const at = scopeNow(scope, nowMs);
  if (!Number.isFinite(at) || at < 0) return { ok: false, reason: "corrupt" };
  return withGovernorLock(scope, () => {
    const loaded = readGovernorState(scope.path, at);
    return loaded;
  });
}

function governorHealth(result, nowMs = Date.now()) {
  if (!result?.ok) return { status: "unavailable", leases: 0, resources: {} };
  const state = result.value;
  let status = "healthy";
  if (state.probeClaim?.leaseUntil > nowMs) status = "waiting for probe";
  else if (RATE_RESOURCES.some((resource) => !state.budgets[resource] || nowMs - state.budgets[resource].observedAt > BUDGET_SNAPSHOT_TTL_MS)) status = "stale";
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
      }]] : [];
    })),
  };
}

async function refreshSharedBudget(scope, leaseId, signal, {
  readBudgets = readRateBudgets,
  now = () => scopeNow(scope),
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  inspect = inspectGovernor,
  renew = renewProbeClaim,
} = {}) {
  let claim = claimProbe(scope, leaseId, now());
  if (!claim.ok) return claim;
  if (claim.value.status !== "claimed") {
    const startedAt = now();
    const deadline = Math.min(
      claim.value.leaseUntil ?? claim.value.nextAt ?? startedAt,
      startedAt + GOVERNOR_PUBLICATION_REINSPECT_MS,
    );
    let inspections = 0;
    while (!signal?.aborted && now() < deadline && inspections < 10) {
      await wait(Math.min(100, Math.max(1, deadline - now())));
      inspections += 1;
      const snapshot = inspect(scope, now());
      if (!snapshot.ok) return snapshot;
      if (
        RATE_RESOURCES.every((resource) =>
          snapshot.value.budgets[resource] &&
          now() - snapshot.value.budgets[resource].observedAt <= BUDGET_SNAPSHOT_TTL_MS,
        ) && snapshot.value.probeOutcome.status === "healthy"
      ) {
        return { ok: true, value: { status: "published", budgets: snapshot.value.budgets } };
      }
    }
    claim = claimProbe(scope, leaseId, now());
    if (!claim.ok || claim.value.status !== "claimed") return claim;
  }
  const { nonce, startedReservationIds } = claim.value;
  const drainUntil = now() + GOVERNOR_PROBE_DRAIN_MS;
  while (startedReservationIds.length > 0 && now() < drainUntil) {
    const snapshot = inspect(scope, now());
    if (!snapshot.ok) {
      failProbeClaim(scope, leaseId, nonce, now());
      return snapshot;
    }
    const stillStarted = startedReservationIds.some((id) => snapshot.value.reservations[id]?.status === "started");
    if (!stillStarted) break;
    if (signal?.aborted) {
      failProbeClaim(scope, leaseId, nonce, now());
      return { ok: false, reason: "stale" };
    }
    await wait(Math.min(100, Math.max(1, drainUntil - now())));
  }
  const renewed = renew(scope, leaseId, nonce, now());
  if (!renewed.ok) {
    failProbeClaim(scope, leaseId, nonce, now());
    return renewed;
  }
  let budgets;
  try {
    budgets = await readBudgets(signal, scope.host);
  } catch {
    budgets = null;
  }
  if (!budgets) {
    failProbeClaim(scope, leaseId, nonce, now());
    return { ok: false, reason: "stale" };
  }
  const published = publishProbe(scope, leaseId, nonce, budgets, now());
  if (!published.ok) failProbeClaim(scope, leaseId, nonce, now());
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

function resourcePerTick(table, activeKey) {
  let cost = table[activeKey] ?? 0;
  for (const key of TAB_KEYS) {
    if (key !== activeKey) cost += (table[key] ?? 0) / BACKGROUND_EVERY;
  }
  return cost;
}

function alertArgs(source, path = source.path) {
  return ["api", apiPath(path), ...apiHostArgs(), "--jq", source.jq];
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

function backoffActive(key, now) {
  const state = alertBackoff.get(key);
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
  const previous = alertBackoff.get(key);
  const step = Math.min((previous?.step ?? -1) + 1, steps.length - 1);
  alertBackoff.set(key, { step, until: now + steps[step] });
}

function clearBackoff(key) {
  alertBackoff.delete(key);
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

async function fetchAlertSource(source, signal, now) {
  if (backoffActive(source.key, now)) {
    const { note, verdict } = alertBackoff.get(source.key);
    // The verdict is replayed alongside the note. Replaying only the note left
    // the tab unable to tell "Dependabot is switched off here" from "we cannot
    // see Dependabot" for the whole length of a backoff window.
    // Nothing was spawned, so nothing was billed -- which is the whole reason
    // the meter is fed by the fetchers rather than by counting ticks.
    return {
      raw: `backoff:${note}`,
      completedCalls: 0,
      verdict,
      parse: () => ({ alerts: [], note, verdict, truncated: false }),
    };
  }
  let completedCalls = 0;
  try {
    const requests = alertRequestArgs(source);
    const payloads = [];
    const groups = [];
    for (const [index, args] of requests.entries()) {
      if (index > 0 && !shouldFetchAlertPriorityLanes(groups[0]?.length ?? 0)) break;
      completedCalls += 1;
      const payload = await runGh(args, { signal, operation: "tab:security-endpoint" });
      payloads.push(payload);
      groups.push(JSON.parse(payload).filter((alert) => alert.state === "open"));
    }
    const raw = payloads.join("\0");
    clearBackoff(source.key);
    return {
      raw,
      completedCalls,
      verdict: "ok",
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
    const note = verdict === "unavailable" ? source.unavailable : `${source.name}: ${shortErr(err)}`;
    const steps = pick(FAILURE_LADDER, verdict, null);
    if (steps) {
      recordFailure(source.key, now, steps);
      Object.assign(alertBackoff.get(source.key), { note, verdict });
    }
    return {
      raw: `unavailable:${note}`,
      // A failed call still bills: the request reached GitHub and was counted
      // whether it returned data, `[]`, or a 403.
      completedCalls,
      verdict,
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

async function fetchSecurity(signal) {
  // Monotonic, not wall-clock. These deadlines measure *elapsed* time, and
  // Date.now() can jump: a laptop resume or an NTP correction stepping the clock
  // backwards would hold an alert source in backoff for up to an hour of apparent
  // time that never passed -- on a security surface, which is exactly what the
  // capped ladder exists to prevent. Staleness deliberately stays on Date.now()
  // for the mirror-image reason: a sleep gap is the thing it reports, and
  // performance.now() does not advance across suspend.
  const now = performance.now();
  const parts = await Promise.all(ALERT_SOURCES.map((s) => fetchAlertSource(s, signal, now)));
  return {
    // Joined with a NUL so a change in any one of the three shows up as a
    // change in the combined payload, without risk of two different splits
    // colliding on the same string.
    raw: parts.map((p) => p.raw).join("\0"),
    limit: ALERT_PER_PAGE,
    // Summed from what each source reported rather than assumed to be
    // ALERT_SOURCES.length: a source held off by backoff spawned nothing and
    // must not be billed for it.
    restSpent: parts.reduce((total, part) => total + part.completedCalls, 0),
    graphqlSpent: 0,
    measuredSuccess: parts.every((part) => part.verdict === "ok"),
    rateLimited: parts.some((part) => part.verdict === "rate-limited"),
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

// `gh <kind> view --web` for the tabs that have a per-item command. The Security
// tab is absent on purpose: alerts have no `gh` view subcommand, so there is
// nothing honest to open.
const OPENABLE = { actions: "run", issues: "issue", prs: "pr" };

// Output is captured rather than inherited. `gh ... --web` prints "Opening ...
// in your browser" to stdout, and stdout is ink's frame stream -- letting that
// through would corrupt the diff and the alternate screen.
//
// `gh run view` takes the run's databaseId, not its display `number` -- the
// two are different ID spaces (databaseId is global across GitHub, number is
// per-workflow and restarts near 1 in every repo), so a run's `number` is
// almost never a valid databaseId elsewhere and 404s. `gh issue view` and
// `gh pr view` are the opposite: they take the issue/PR number, and neither
// row shape carries a databaseId to prefer instead.
async function openInBrowser(tabKey, item, signal, governor = null, { run = runGh } = {}) {
  const kind = pick(OPENABLE, tabKey, null);
  const id = kind === "run" ? (item?.databaseId ?? item?.number) : (item?.number ?? item?.databaseId);
  if (!kind || id == null) return;
  if (!governor) throw new Error("API budget unavailable; refresh and try again");
  const admitted = await runAdmittedOperation({
    ...governor,
    operation: `open:${tabKey}`,
    signal,
    run: (admittedSignal) => run([kind, "view", ...repoArgs(), String(id), "--web"], {
      signal: admittedSignal,
      operation: `open:${tabKey}`,
    }),
  });
  if (!admitted.ok) throw admitted.error;
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

async function probe(name, args, operation) {
  const startedAt = Date.now();
  try {
    const stdout = await runGh(args, { operation });
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
    const resources = preloadedResources ?? await readRateLimitResources();
    // formatAge() is for timestamps in the past and returns "-" for a future one,
    // so the reset is rendered as a forward interval instead.
    const fmt = (r) => {
      if (!r) return "(absent)";
      const inMs = r.reset * 1000 - Date.now();
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

async function readRateBudgets(signal, host = effectiveRuntimeHost()) {
  try {
    // apiHostArgs() for the same reason the alert endpoints carry it: --repo
    // host/owner/name sets runtime.host without setting GH_HOST, so without the
    // flag this reads github.com's budget while the pane spends against the
    // tenant -- and then throttles, or fails to, against an unrelated number.
    const resources = await readRateLimitResources(signal, host);
    return {
      core: normalizeRateBudget(resources?.core),
      graphql: normalizeRateBudget(resources?.graphql),
    };
  } catch {
    // A probe failure must never be louder than the pane's own data: the loop
    // simply does not adapt this cycle and stays at whatever it last applied.
    return null;
  }
}

// Requests per hour this configuration will spend once it settles, derived from
// the same constants the poll loop uses rather than from a number written down
// once and left to rot. The active tab refreshes every tick; the other three
// every BACKGROUND_EVERY ticks. The per-fetch prices come from REST_PER_FETCH
// and GRAPHQL_PER_FETCH, which are also what the spend meter bills against --
// two copies of them would diverge the first time one was fixed.
function projectedHourlyCost(activeKey) {
  const perHour = 3_600_000 / runtime.refreshMs;
  return {
    rest: Math.round(resourcePerTick(REST_PER_FETCH, activeKey) * perHour),
    graphql: Math.round(resourcePerTick(GRAPHQL_PER_FETCH, activeKey) * perHour),
  };
}

function doctorProbePlan() {
  return [
    ["Repository access", repoContextArgs(), "doctor:repository"],
    ["Actions (run list)", actionsArgs(MIN_RUN_LIMIT), "doctor:actions"],
    ["Issues (issue list)", issuesArgs(), "doctor:issues"],
    ["Pull requests (pr list)", prsArgs(), "doctor:prs"],
    ...ALERT_SOURCES.flatMap((source) =>
      alertRequestArgs(source).map((args, index) => [
        index === 0 ? source.name : `${source.name} (priority ${index})`,
        args,
        "doctor:security-endpoint",
      ]),
    ),
  ];
}

async function runDoctor() {
  // A live backoff would make an alert probe silently skip and report nothing,
  // which is the opposite of what a diagnostic run is for.
  alertBackoff.clear();

  const probes = doctorProbePlan();

  // Free checks run first. In particular the one rate_limit read both renders
  // the budget and seeds admission; diagnostics never spend before that proof.
  const [ghVersion, authStatus, remote, remoteUrls] = await Promise.all([
    captureGh(["--version"], "version"),
    captureGh(["auth", "status"], "auth-status"),
    gitRemote(),
    gitRemoteUrls(),
  ]);
  const effectiveHost = effectiveRuntimeHost({ remoteUrls });
  const resources = await readRateLimitResources(undefined, effectiveHost).catch(() => null);
  const budget = resources
    ? await rateBudget(resources)
    : { core: "unavailable", graphql: "unavailable" };
  const scopeResult = createGovernorScope({ effectiveHost });
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
      const normalized = resources && {
        core: normalizeRateBudget(resources.core),
        graphql: normalizeRateBudget(resources.graphql),
      };
      if (registered.ok && normalized?.core && normalized?.graphql) {
        const claim = claimProbe(scope, leaseId, nowMs);
        if (claim.value?.status === "claimed") {
          publishProbe(scope, leaseId, claim.value.nonce, normalized, nowMs);
        }
      }
      for (const [name, args, operation] of probes) {
        const admitted = registered.ok
          ? admitGovernorOperation(scope, leaseId, operation, "diagnostic", Date.now())
          : registered;
        if (!admitted?.ok || admitted.value.status !== "started") {
          results.push({
            name,
            args,
            skipped: true,
            classified: "skipped",
            skipReason: admitted?.value?.resetMs
              ? `budget paused; reset ${new Date(admitted.value.resetMs).toISOString()}`
              : admitted?.value?.notBefore
                ? `next safe slot ${new Date(admitted.value.notBefore).toISOString()}`
                : "budget unavailable",
          });
          continue;
        }
        const result = await probe(name, args, operation);
        completeReservation(scope, admitted.value.reservationId, result.failed
          ? { outcome: "rejected" }
          : { outcome: "measured-success", actualCost: operationCost(operation) }, Date.now());
        results.push(result);
      }
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
    ...section("API budget"),
    field("REST core", budget.core),
    field("GraphQL", budget.graphql),
    field(
      "this config spends",
      (() => {
        const active = TAB_KEYS[runtime.initialTabIndex] ?? TAB_KEYS[0];
        const { rest, graphql } = projectedHourlyCost(active);
        return `~${rest} REST + ~${graphql} GraphQL per hour (refresh ${runtime.refreshMs / 1000}s, "${active}" active)`;
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
          ? `${detail.remaining} remaining, ${detail.reserve} reserved, reset ${new Date(detail.resetMs).toISOString()}`
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
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

// Returns { repo, refreshMs, tabKey, verbose } or throws with a message that
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

  return {
    help: opts.help,
    showVersion: opts.showVersion,
    doctor: opts.doctor,
    repo: slug,
    host,
    refreshMs,
    tabKey: opts.tab,
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
  ["r", "Refresh the current tab now"],
  ["w", "Adjust table column widths"],
  ["?", "Show the keys (any key closes it)"],
  ["q / Esc / Ctrl+C", "Quit (Esc leaves width mode)"],
];
const KEY_COL = Math.max(...KEY_TABLE.map(([k]) => k.length)) + 3;
const keyTableLines = () => KEY_TABLE.map(([k, d]) => `${k.padEnd(KEY_COL)}${d}`);

function helpLines(maxRows) {
  const rows = Math.max(1, Number.isSafeInteger(maxRows) ? maxRows : 1);
  const all = keyTableLines();
  if (all.length <= rows) return all;
  if (rows === 1) return [`… ${all.length} keys: gh-glance --help`];
  const priority = [9, 6, 5, 3, 0, 7, 8, 1, 2, 4]
    .slice(0, rows - 1)
    .map((index) => all[index]);
  return [...priority, `… ${all.length - priority.length} more: gh-glance --help`];
}

const HELP = `gh-glance ${version} -- a live-refreshing GitHub dashboard for a narrow terminal pane.

Usage:
  gh-glance                     Run the dashboard in the current repository
  gh-glance --repo owner/name   Watch a specific repository instead
  gh-glance --refresh 15        Poll the active tab every 15 seconds
  gh-glance --tab security      Start on a specific tab
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
  --refresh <seconds>      Active-tab poll interval (${MIN_REFRESH_SECONDS}-${MAX_REFRESH_SECONDS},
                           default ${REFRESH_MS / 1000}). Background tabs stay at
                           ${BACKGROUND_EVERY}x this.
  --tab <name>             Tab to start on: ${TAB_KEYS.join(", ")}.
  --verbose                Write one line per gh invocation to stderr. stderr
                           must be redirected -- writing it to the terminal
                           would draw over the dashboard, so this refuses to
                           start otherwise.
  --doctor                 Gather versions, authenticated hosts, the resolved
                           repo target and one probe per endpoint, then exit.
                           Safe to redirect to a file and share -- tokens are
                           never printed, proxy credentials are stripped, and
                           no response bodies are included.

Run it from inside a locally cloned GitHub repository; the repo is inferred
from the git remote, the same way \`gh\` does it. Requires the \`gh\` CLI
(2.20 or newer), authenticated via \`gh auth login\`.

The active tab refreshes every ${REFRESH_MS / 1000}s; the other three refresh every
${(REFRESH_MS * BACKGROUND_EVERY) / 1000}s to keep their counts honest without spending the API rate limit.

Status icons are GitHub Octicons and need a Nerd Font. Without one, set
GH_GLANCE_ICONS=unicode for plain-unicode equivalents.

Keys:
${keyTableLines()
  .map((line) => `  ${line}`)
  .join("\n")}

The cursor clears itself after 60s with no movement.

Environment:
  GH_REPO=owner/name        Watch a specific repository (--repo takes precedence)
  GH_HOST=host              GitHub Enterprise or EMU host to send every call to.
                            A host-qualified GH_REPO does not route \`gh api\`;
                            this and --repo host/owner/name both do.
  GH_GLANCE_REFRESH=<seconds>
                            Active-tab poll interval, ${MIN_REFRESH_SECONDS}-${MAX_REFRESH_SECONDS}
                            (--refresh takes precedence)
  GH_GLANCE_ICONS=unicode   Plain-unicode status icons (no Nerd Font needed)
  GH_GLANCE_NO_ANIMATION=1  Freeze the spinner (no motion)
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
const USING_NERD_ICONS = process.env.GH_GLANCE_ICONS !== "unicode";
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
    fetch: ({ signal, runLimit }) => fetchActions(runLimit, signal),
    label: "Actions",
    short: "Actions",
    header: ACTIONS_HEADER,
    compactHeader: ACTIONS_HEADER_COMPACT,
    Row: MemoActionsRow,
    countLabel: "runs",
  },
  {
    key: "issues",
    fetch: ({ signal }) => fetchIssues(signal),
    label: "Issues",
    short: "Issues",
    header: ISSUES_HEADER,
    compactHeader: ISSUES_HEADER_COMPACT,
    Row: MemoIssueRow,
    countLabel: "open issues",
  },
  {
    key: "prs",
    fetch: ({ signal }) => fetchPRs(signal),
    label: "Pull requests",
    short: "PRs",
    header: PRS_HEADER,
    compactHeader: PRS_HEADER_COMPACT,
    Row: MemoPRRow,
    countLabel: "open PRs",
  },
  {
    key: "security",
    fetch: ({ signal }) => fetchSecurity(signal),
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

const persistenceWaitCell = new Int32Array(new SharedArrayBuffer(4));
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

const DASHBOARD_CACHE_VERSION = 2;
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
const SECURITY_UNCHANGED_POLL_MS = 60_000;

function shouldCheckpointFreshness({ persistedAt, completedAt }) {
  return !Number.isFinite(persistedAt) || completedAt - persistedAt >= CACHE_FRESHNESS_CHECKPOINT_MS;
}

function securityPollDelay({ unchangedPolls, floorMs, force = false }) {
  if (force) return 0;
  return unchangedPolls > 0 ? Math.max(floorMs, SECURITY_UNCHANGED_POLL_MS) : floorMs;
}

function shouldShowFetchLoading({ hasData, force }) {
  return !hasData || force === true;
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

function pollSchedule({
  nowMs,
  floorMs,
  activeKey,
  activeAt = nowMs,
  backgroundAt = nowMs + 4 * floorMs,
  backgroundIndex = 0,
  heldResources = {},
}) {
  const due = [];
  let nextActiveAt = activeAt;
  let nextBackgroundAt = backgroundAt;
  let nextBackgroundIndex = backgroundIndex;
  if (activeAt <= nowMs) {
    const activeHold = tabHold(activeKey, heldResources);
    if (activeHold.held) nextActiveAt = activeHold.retryAt;
    else {
      due.push(activeKey);
      nextActiveAt = nowMs + floorMs;
    }
  }
  // Three inactive tabs share one background slot every four active periods.
  // Select at most one usable tab and retain the cursor for the next slot.
  if (backgroundAt <= nowMs) {
    const background = TAB_KEYS.filter((key) => key !== activeKey);
    let selected = -1;
    for (let offset = 0; offset < background.length; offset += 1) {
      const index = (backgroundIndex + offset) % background.length;
      if (!tabHold(background[index], heldResources).held) {
        selected = index;
        break;
      }
    }
    if (selected >= 0) {
      due.push(background[selected]);
      nextBackgroundIndex = (selected + 1) % background.length;
      nextBackgroundAt = nowMs + 4 * floorMs;
    } else {
      nextBackgroundAt = background.reduce(
        (earliest, key) => Math.min(earliest, tabHold(key, heldResources).retryAt),
        Number.POSITIVE_INFINITY,
      );
    }
  }
  return {
    due,
    activeAt: nextActiveAt,
    backgroundAt: nextBackgroundAt,
    backgroundIndex: nextBackgroundIndex,
    nextAt: Math.min(nextActiveAt, nextBackgroundAt),
  };
}

function governorWakeTimes(state, nowMs, floorMs, leaseId = null) {
  const budgets = Object.values(state?.budgets ?? {});
  const observedCandidates = state?.probeOutcome?.status === "failed"
    ? []
    : budgets.map((budget) => budget.observedAt + BUDGET_PROBE_MS);
  const controlAt = Math.min(
    ...observedCandidates,
    ...budgets.map((budget) => budget.resetMs + BUDGET_RESET_GRACE_MS),
    state?.probeClaim?.leaseUntil ?? Number.POSITIVE_INFINITY,
    state?.probeOutcome?.nextAt ?? Number.POSITIVE_INFINITY,
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

function governorDataReady(refreshResult, snapshot, activeKey, nowMs) {
  if (!refreshResult?.ok || !snapshot?.ok) return false;
  if (["waiting", "paused", "probe"].includes(refreshResult.value?.status)) return false;
  if (snapshot.value.probeClaim || snapshot.value.probeOutcome?.status !== "healthy") return false;
  const costs = tabRequestCost(activeKey);
  return RATE_RESOURCES.every((resource) => {
    if (costs[resource] <= 0) return true;
    const budget = snapshot.value.budgets[resource];
    return budget && nowMs - budget.observedAt <= BUDGET_SNAPSHOT_TTL_MS &&
      budget.blockUntil <= nowMs && availableForGrant({ budget, nowMs }).mode === "open";
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
      for (const kind of [...entries.keys()]) this.clear(kind);
    },
    at: (kind) => entries.get(kind)?.at ?? Number.POSITIVE_INFINITY,
    size: () => entries.size,
  };
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
  if (decision.value.notBefore > nowMs) return decision;
  return startReservation(scope, decision.value.reservationId, nowMs);
}

async function runAdmittedOperation({ scope, leaseId, operation, priority = "manual", signal, run }) {
  const admitted = admitGovernorOperation(scope, leaseId, operation, priority, Date.now());
  if (!admitted.ok || admitted.value.status !== "started") {
    if (validGovernorId(admitted.value?.intentId)) {
      cancelIntent(scope, admitted.value.intentId, Date.now());
    }
    const detail = admitted.value?.resetMs
      ? ` until ${new Date(admitted.value.resetMs).toISOString()}`
      : admitted.value?.notBefore ? ` until ${new Date(admitted.value.notBefore).toISOString()}` : "";
    return { ok: false, skipped: true, decision: admitted, error: new Error(`API budget paused${detail}`) };
  }
  const reservationId = admitted.value.reservationId;
  try {
    const value = await run(signal);
    const costs = operationCost(operation);
    completeReservation(scope, reservationId, {
      outcome: "measured-success",
      actualCost: costs,
    }, Date.now());
    return { ok: true, value, reservationId };
  } catch (error) {
    const outcome = error?.name === "AbortError"
      ? "abort"
      : error?.signal ? "signal" : error?.code === "ETIMEDOUT" ? "timeout" : "rejected";
    completeReservation(scope, reservationId, { outcome }, Date.now());
    return { ok: false, error, reservationId };
  }
}

function pollResultTransition({ key, previousRaw, raw, parse, limit, completedAt }) {
  if (previousRaw === raw) return { kind: "unchanged", completedAt };
  const value = parse();
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

// Every glyph here is width-1 ASCII, deliberately, with one exception: the
// Move arrows. The return symbol and the box-drawing separator are still
// East-Asian-Ambiguous and stay out for that reason -- ink measures them as
// two columns in its width model, and a status bar built from them overflowed
// an 80-column terminal by six columns once selection added a hint. Same trap
// the unicode icon table already documents -- prefer strictly narrow ASCII
// over pretty-but-ambiguous. The arrow pair is a deliberate exception, and it
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

// Reserved so the hints don't shift sideways every time a refresh starts and
// finishes. Wide enough for the spinner, a space and "Fetching".
const FETCHING_WIDTH = 12;

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
  fetching,
  spin,
  stale,
  throttle,
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
  // Width mode owns the whole bar, so the throttle badge is deliberately not
  // shown here: this state is transient and explicitly entered, and the widened
  // interval is still reported the moment the user leaves it.
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
  const hintsFullWidth =
    hints.reduce((sum, hint) => sum + hint.label.length + 2 + [...hint.keys].length, 0) +
    (hints.length - 1) * 3;
  // Measured against the active full set even when a compact one is rendered.
  const compact = interactive && cols < FETCHING_WIDTH + hintsFullWidth;
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
        remoteSetup ? `${SPINNER[0]} Setup` : `${fetching && spin ? spin : SPINNER[0]} Fetching`,
      ),
    ),
    // No reserved width here, unlike the fetching slot above: this only
    // toggles on a real problem (a stalled poll, a laptop that just woke up),
    // not every refresh cycle, so letting the hints shift on that rare event
    // is worth getting the column back for the other 99% of the time.
    stale
      ? e(Box, { marginRight: 1, flexShrink: 0 }, e(Text, { color: ATTENTION }, stale))
      : null,
    // Same free-slot treatment as `stale` above. Dim rather than ATTENTION: a
    // widened interval is the throttle working, not a failure, and colouring it
    // like a problem would send the user looking for one.
    throttle
      ? e(Box, { marginRight: 1, flexShrink: 0 }, e(Text, { dimColor: true }, throttle))
      : null,
    ...hints
      .flatMap((hint, i) => [
        i > 0 &&
          e(Text, { key: `sep${i}`, color: BORDER_COLOR }, compact ? " " : " | "),
        e(
          Text,
          { key: hint.label, wrap: "truncate-end" },
          compact ? null : e(Text, { dimColor: true }, `${hint.label}: `),
          e(Text, { color: TITLE_COLOR, bold: true }, hint.keys),
        ),
      ])
      .filter(Boolean),
    // Right-aligned, like lazygit's footer. Dropped in compact mode rather than
    // left to shrink alongside the hints: it would compete for the same shrink
    // budget as "Quit", the one hint the comment above already fought to keep
    // on screen down to 45 columns, and version digits are not worth that.
    !compact && e(Box, { flexGrow: 1 }),
    !compact && e(Text, { key: "version", dimColor: true, wrap: "truncate-end" }, version),
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
      host: runtime.host ?? process.env.GH_HOST,
      cwd: process.cwd(),
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
  // The current governor wake delay, or null at the configured refresh.
  const [throttleMs, setThrottleMs] = useState(null);
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
    (tabError && !remoteSetup ? 1 : 0) +
    (tab.key === "security" && !remoteSetup ? securityLines.length : 0);
  // Reserve lines for: the tab bar and the divider under it (2), the panel's
  // top and bottom edges (2), the column header and its separator (2), and
  // the status line (1), plus a 1-line safety margin. Slack is absorbed by
  // the spacer in the tree below.
  const bodyRows = Math.max(1, rows - 8 - extraLines);

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
  // poll loop uses for runLimitRef and activeIndexRef, and for the same reason:
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

  // Rearms on every call to moveSelection (it's the only thing that changes
  // `selected`), so this fires exactly 60s after the *last* movement -- tab
  // switches and Enter don't count as activity and don't push it back. Clears
  // every tab's cursor at once rather than just the visible one, so a tab you
  // switch back to after being idle doesn't still show a stale row marked.
  useEffect(() => {
    if (Object.keys(selected).length === 0) return;
    const timer = setTimeout(() => setSelected({}), SELECTION_IDLE_MS);
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
      } else if (input === "r") {
        // Goes through the same per-tab in-flight guard as the poll loop, so
        // holding the key down cannot stack concurrent subprocesses. `force`
        // bypasses (and clears) any failure backoff: this key is the user saying
        // "try again now", and a refresh that silently declined to refresh would
        // be worse than no key at all.
        fetchTabRef.current?.(TABS[activeIndexRef.current].key, { force: true });
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
    let securityUnchangedPolls = 0;
    let securityNextPollAt = 0;

    function commit(key, run, { force = false, scope, reservationId, onSettled } = {}) {
      // Per-tab rather than one flag for the whole tick, so switching tabs can
      // refresh the tab you just landed on without waiting on an unrelated
      // background fetch -- and so a slow repo can't stack refreshes.
      if (inFlightRef.current[key]) return Promise.resolve();
      inFlightRef.current[key] = true;
      clearForcedBackoffAfterStart(key, force, "started");
      const visibleLoading = shouldShowFetchLoading({
        hasData: dataRef.current[key] !== null,
        force,
      });
      if (visibleLoading) setLoading((l) => (l[key] ? l : { ...l, [key]: true }));
      return run()
        .then((result) => {
          completeReservation(scope, reservationId, result?.measuredSuccess === false
            ? { outcome: "rejected" }
            : {
                outcome: "measured-success",
                actualCost: {
                  core: result?.restSpent ?? REST_PER_FETCH[key] ?? 0,
                  graphql: result?.graphqlSpent ?? GRAPHQL_PER_FETCH[key] ?? 0,
                },
              }, Date.now());
          if (result?.rateLimited) {
            const resetMs = inspectGovernor(scope, Date.now()).value?.budgets?.core?.resetMs;
            if (Number.isFinite(resetMs) && resetMs > Date.now()) {
              recordResourceBlock(scope, "core", resetMs, "rate-limit");
            }
          }
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
          if (key === "security") {
            securityUnchangedPolls = transition.kind === "unchanged" ? securityUnchangedPolls + 1 : 0;
            securityNextPollAt =
              performance.now() +
              securityPollDelay({
                unchangedPolls: securityUnchangedPolls,
                floorMs: runtime.refreshMs,
                force,
              });
          }
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
          const outcome = err?.name === "AbortError"
            ? "abort"
            : err?.signal ? "signal" : err?.code === "ETIMEDOUT" ? "timeout" : "rejected";
          completeReservation(scope, reservationId, { outcome }, Date.now());
          if (cancelled || err?.name === "AbortError") return;
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
            for (const resource of RATE_RESOURCES) {
              const resetMs = snapshot.value?.budgets?.[resource]?.resetMs;
              if (costs[resource] > 0 && Number.isFinite(resetMs) && resetMs > Date.now()) {
                recordResourceBlock(scope, resource, resetMs, "rate-limit");
              }
            }
          }
        })
        .finally(() => {
          inFlightRef.current[key] = false;
          onSettled?.();
          if (!cancelled) {
            setLoading((l) => (l[key] ? { ...l, [key]: false } : l));
          }
        });
    }

    const leaseId = governorId();
    const pending = new Map();
    const wakeScheduler = createWakeScheduler();
    let scope = null;
    let cleanupScope = null;
    let registeredScopeHash = null;
    let remoteUrls = [];
    let liveScheduling = false;
    let activePollAt = Number.POSITIVE_INFINITY;
    let backgroundPollAt = Number.POSITIVE_INFINITY;
    let backgroundIndex = 0;

    function armWake(kind, at, run) {
      if (!cancelled) wakeScheduler.arm(kind, at, run);
    }

    function identity() {
      return {
        effectiveHost: effectiveRuntimeHost({ remoteUrls }),
        authIdentity: authCacheIdentity(),
      };
    }

    function ensureScope(nowMs = Date.now()) {
      const current = identity();
      const nextHash = governorScopeHash(current.effectiveHost, current.authIdentity);
      if (!nextHash) return null;
      if (scope?.hash === nextHash && registeredScopeHash === nextHash) return scope;
      if (scope?.hash !== nextHash) {
        if (cleanupScope && registeredScopeHash) releaseLease(cleanupScope, leaseId);
        registeredScopeHash = null;
        const created = createGovernorScope({ ...current, identityProvider: identity });
        if (!created.ok) return null;
        scope = created.value;
        cleanupScope = { ...scope, identityProvider: null };
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
        armWake("control", governorControlRetryAt(nowMs, runtime.refreshMs), controlWake);
        return;
      }
      const wakes = governorWakeTimes(snapshot.value, nowMs, runtime.refreshMs, leaseId);
      armWake("control", wakes.controlAt, controlWake);
      const nextDataAt = Math.min(wakes.dataAt, activePollAt, backgroundPollAt);
      if (liveScheduling) armWake("data", nextDataAt, dataWake);
      const delay = Math.max(0, Math.min(nextDataAt, wakes.controlAt) - nowMs);
      setThrottleMs(delay > runtime.refreshMs ? delay : null);
    }

    function finishPending(key, intentId) {
      if (pending.get(key)?.intentId === intentId) pending.delete(key);
      armFromState();
    }

    function requestTab(key, kind = "active", { force = false } = {}) {
      const signal = controller.signal;
      const descriptor = tabForKey(key);
      const monotonicNow = performance.now();
      if (inFlightRef.current[key]) return Promise.resolve();
      if (!force && backoffActive(`tab:${key}`, monotonicNow)) return Promise.resolve();
      if (!force && key === "security" && monotonicNow < securityNextPollAt) return Promise.resolve();
      const nowMs = Date.now();
      const currentScope = ensureScope(nowMs);
      if (!currentScope) return Promise.resolve();
      const existing = pending.get(key);
      if (existing) {
        if (!force || existing.kind === "manual") return Promise.resolve();
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
      if (!registered.ok) return Promise.resolve();
      pending.set(key, { intentId, kind, force });
      const decision = registered.value;
      if (decision.status !== "scheduled" || decision.notBefore > nowMs) {
        setWaiting((current) => current[key] ? current : { ...current, [key]: true });
        if (force && decision.resource) {
          const budget = inspectGovernor(currentScope, nowMs).value?.budgets?.[decision.resource];
          if (budget) requestManualProbe(currentScope, leaseId, budget.epoch, budget.observedAt, nowMs);
        }
        armWake("data", decision.retryAt ?? decision.notBefore ?? nowMs + runtime.refreshMs, dataWake);
        armFromState(nowMs);
        return Promise.resolve();
      }
      const started = startReservation(currentScope, decision.reservationId, nowMs);
      if (!started.ok) {
        finishPending(key, intentId);
        return Promise.resolve();
      }
      if (started.value.status !== "started") {
        armWake("data", started.value.notBefore ?? nowMs + runtime.refreshMs, dataWake);
        return Promise.resolve();
      }
      setWaiting((current) => current[key] ? { ...current, [key]: false } : current);
      if (force) coordinator.invalidate();
      return commit(
        key,
        () => descriptor.fetch({ signal, runLimit: runLimitRef.current }),
        {
          force,
          scope: currentScope,
          reservationId: decision.reservationId,
          onSettled: () => finishPending(key, intentId),
        },
      );
    }
    fetchTabRef.current = (key, { force = false, kind = force ? "manual" : "active" } = {}) => {
      const requestedAt = Date.now();
      if (kind === "tab-switch") activePollAt = requestedAt + runtime.refreshMs;
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
        const decision = readIntentDecision(currentScope, item.intentId, nowMs);
        if (!decision.ok) {
          pending.delete(key);
          continue;
        }
        if (decision.value.status !== "scheduled" || decision.value.notBefore > nowMs) {
          setWaiting((current) => current[key] ? current : { ...current, [key]: true });
          armWake("data", decision.value.retryAt ?? decision.value.notBefore ?? nowMs + runtime.refreshMs, dataWake);
          continue;
        }
        const started = startReservation(currentScope, decision.value.reservationId, nowMs);
        if (!started.ok) {
          pending.delete(key);
          armFromState(nowMs);
          continue;
        }
        if (started.value.status !== "started") {
          armWake("data", started.value.notBefore ?? nowMs + runtime.refreshMs, dataWake);
          continue;
        }
        setWaiting((current) => current[key] ? { ...current, [key]: false } : current);
        if (item.force) coordinator.invalidate();
        const descriptor = tabForKey(key);
        void commit(
          key,
          () => descriptor.fetch({ signal: controller.signal, runLimit: runLimitRef.current }),
          {
            force: item.force,
            scope: currentScope,
            reservationId: decision.value.reservationId,
            onSettled: () => finishPending(key, item.intentId),
          },
        );
      }
    }

    async function dataWake() {
      if (cancelled || remoteSetupRef.current) return;
      const nowMs = Date.now();
      await resumePending(nowMs);
      const currentScope = ensureScope(nowMs);
      const snapshot = currentScope ? inspectGovernor(currentScope, nowMs) : null;
      if (!snapshot?.ok) {
        armFromState(nowMs);
        return;
      }
      const wakes = governorWakeTimes(snapshot.value, nowMs, runtime.refreshMs, leaseId);
      const heldResources = Object.fromEntries(RATE_RESOURCES.map((resource) => {
        const budget = snapshot.value.budgets[resource];
        const decision = budget ? availableForGrant({ budget, nowMs }) : { mode: "paused" };
        const held = !budget || budget.blockUntil > nowMs || decision.mode !== "open";
        const retryAt = budget?.blockUntil > nowMs
          ? budget.blockUntil
          : decision.retryAt ?? wakes.controlAt;
        return [resource, { held, retryAt }];
      }));
      const active = TABS[activeIndexRef.current].key;
      const planned = pollSchedule({
        nowMs,
        floorMs: runtime.refreshMs,
        activeKey: active,
        activeAt: activePollAt,
        backgroundAt: backgroundPollAt,
        backgroundIndex,
        heldResources,
      });
      activePollAt = planned.activeAt;
      backgroundPollAt = planned.backgroundAt;
      backgroundIndex = planned.backgroundIndex;
      await Promise.allSettled(planned.due.map((key, index) =>
        requestTab(key, index === 0 ? "active" : "background")));
      if (!cancelled) {
        setNow((prev) =>
          hasInProgressRef.current || Date.now() - prev.getTime() >= 60_000 ? new Date() : prev,
        );
        armFromState(Date.now());
      }
    }

    async function controlWake() {
      if (cancelled) return;
      const nowMs = Date.now();
      const currentScope = ensureScope(nowMs);
      const refreshed = currentScope
        ? await refreshSharedBudget(currentScope, leaseId, controller.signal)
        : { ok: false, reason: "stale" };
      if (cancelled) return;
      const checkedAt = Date.now();
      const snapshot = currentScope ? inspectGovernor(currentScope, checkedAt) : refreshed;
      if (!liveScheduling && governorDataReady(
        refreshed,
        snapshot,
        TABS[activeIndexRef.current].key,
        checkedAt,
      )) {
        liveScheduling = true;
        activePollAt = checkedAt + 1;
        backgroundPollAt = checkedAt + 4 * runtime.refreshMs;
        armWake("heartbeat", checkedAt + GOVERNOR_HEARTBEAT_MS, heartbeatWake);
      }
      if (!refreshed.ok) {
        armWake("control", governorControlRetryAt(checkedAt, runtime.refreshMs), controlWake);
      }
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
      remoteUrls = await gitRemoteUrls();
      runtimeRemoteUrls = remoteUrls;
      if (cancelled) return;
      const currentScope = ensureScope(Date.now());
      if (!currentScope) {
        armWake("control", governorControlRetryAt(Date.now(), runtime.refreshMs), controlWake);
        return;
      }
      const refreshed = await refreshSharedBudget(currentScope, leaseId, controller.signal);
      if (cancelled) return;
      const checkedAt = Date.now();
      const snapshot = inspectGovernor(currentScope, checkedAt);
      if (governorDataReady(
        refreshed,
        snapshot,
        TABS[activeIndexRef.current].key,
        checkedAt,
      )) {
        liveScheduling = true;
        activePollAt = checkedAt + 1;
        backgroundPollAt = checkedAt + 4 * runtime.refreshMs;
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
  }, [dashboardCacheWriter]);

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
  // A visible fetch is the third thing worth animating, and the status line
  // already gates its glyph on this exact flag -- without it in the condition
  // here the frame counter never advances during a manual refresh, so the slot
  // turned amber and then sat still on frame 0. `loading` is deliberately left
  // false by automatic polls over settled data (see shouldShowFetchLoading), so
  // this cannot restart the timer every five seconds on a quiet repository:
  // it runs for the length of a first load or an `r`, and stops.
  const anyLoading = Object.values(loading).some(Boolean);
  const showSpinner =
    !remoteSetup && ANIMATE && (anyFirstLoad || hasRunningVisible || anyLoading);
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
  const staleThreshold = Math.max(STALE_AFTER_MS, runtime.refreshMs * 6);
  const staleLabel =
    staleFor != null && staleFor > staleThreshold
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
      !showHelp &&
        !tooNarrow &&
        !remoteSetup &&
        displayError &&
        e(Text, { color: ERROR_TEXT, wrap: "truncate-end" }, displayError),
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
            : waiting[tab.key]
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
      fetching: anyLoading,
      spin: showSpinner ? spin : null,
      stale: staleLabel,
      throttle: throttleMs ? `throttled ${Math.round(throttleMs / 1000)}s` : null,
      interactive,
      cols: frameCols,
      remoteSetup,
      widthMode: resizeRef.current.active,
      widthColumn: selectedWidthColumn,
      widthSaveError,
      canMove: allItems.length > 0,
      canOpen:
        selectedKey !== null &&
        Object.hasOwn(OPENABLE, tab.key) &&
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
  parseArgs,
  validateArgs,
  parseRepoTarget,
  REPO_PATTERN,
  HOST_PATTERN,
  MIN_REFRESH_SECONDS,
  MAX_REFRESH_SECONDS,
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
  claimProbe,
  renewProbeClaim,
  publishProbe,
  failProbeClaim,
  requestManualProbe,
  registerIntent,
  readIntentDecision,
  cancelIntent,
  startReservation,
  completeReservation,
  recordResourceBlock,
  releaseLease,
  inspectGovernor,
  governorHealth,
  refreshSharedBudget,
  safe,
  shortErr,
  isUnavailable,
  isRateLimited,
  isAuthProblem,
  isMissingRemote,
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
  securityPollDelay,
  shouldShowFetchLoading,
  pollSchedule,
  governorWakeTimes,
  governorDataReady,
  governorControlRetryAt,
  createWakeScheduler,
  admitGovernorOperation,
  runAdmittedOperation,
  pollResultTransition,
  forcedBackoffKeys,
  clearForcedBackoffAfterStart,
  doctorProbePlan,
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
  KEY_TABLE,
  KEY_HINTS,
  activeKeyHints,
  tabFailureSuffix,
  formatTabErrorForWidth,
  selectionLabel,
  helpLines,
  summarizeDoctorEnv,
  widthStatusText,
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
};
