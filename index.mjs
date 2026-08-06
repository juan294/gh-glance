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

// Alert endpoints are filtered server-side to open items and capped at one
// page. The previous --paginate walked the repo's entire alert history --
// mostly closed alerts -- and then discarded them client-side.
const ALERT_PER_PAGE = 100;
// Ordering is pinned rather than left to each endpoint's default. Severity
// sorting happens client-side over whatever this returns, so on a repo with more
// than a page of open alerts the *page boundary* decides what can be ranked at
// all -- a critical alert sitting 150th by some endpoint's arbitrary default was
// simply never fetched, and the pane showed "100+" with a screen of moderates.
// Newest-first at least makes the cut deterministic and explainable, and it
// survives GitHub changing a default underneath us. All three endpoints accept
// these parameters.
const ALERT_QUERY = `?state=open&per_page=${ALERT_PER_PAGE}&sort=created&direction=desc`;

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

// An auth failure is the opposite kind of thing: the user fixes it in seconds
// by re-authorizing in the browser, so a ladder measured in half-hours would
// leave the tab blank long after the cause was gone. A single short step keeps
// recovery bounded at ~30s while still bounding what a lapse that lasts all
// night costs -- two probes a minute per endpoint rather than one per tick.
const AUTH_RETRY_MS = [30_000];

// A rate limit is the third shape: it clears on GitHub's schedule, usually
// within the hour, and continuing to hammer is actively counterproductive --
// the secondary limiter keys on sustained request rate against a token that is
// already limited, so re-asking every tick can turn a self-clearing primary
// limit into a longer block, and the block applies to the *token*, not to this
// tool. A wedged pane could therefore degrade `git push` and everything else.
// One minute, flat: long enough to stop amplifying, short enough that the pane
// is current again well before a reset the user never notices.
const RATE_LIMIT_RETRY_MS = [60_000];

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
  refreshMs: REFRESH_MS,
  verbose: false,
  initialTabIndex: 0,
};

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
function isUnavailable(err) {
  const text = errText(err);
  return (
    /HTTP (403|404)/.test(text) ||
    /Could not resolve to a Repository with the name .* \(repository\)/i.test(text)
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
  "auth-problem":
    "GitHub login or authorization required -- run `gh auth status`, then `gh auth login` or `gh auth refresh`",
  "rate-limited": "GitHub rate limit reached -- backing off, this clears on its own",
  unavailable:
    "Repository not found or inaccessible to the active `gh` account -- check `gh auth status` and the repository target",
};

function toTabError(err) {
  return { kind: "fetch", verdict: classify(err), raw: shortErr(err) };
}

function textTabError(err) {
  return { kind: "text", text: shortErr(err) };
}

function formatTabError(error, failureContext = null) {
  if (error == null) return null;
  if (error.kind === "text") return error.text;
  if (error.verdict === "other") return error.raw;
  if (error.verdict === "unavailable" && failureContext?.repo?.ok) {
    return "not available for this repository";
  }
  return pick(VERDICT_REMEDY, error.verdict, null) ?? error.raw;
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
function registerLiveAbort(controller) {
  liveAbort = controller;
}
function abortLiveRequests() {
  liveAbort?.abort();
  liveAbort = null;
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

// The target as `gh` spells it: host-qualified when a host was given, the bare
// slug otherwise -- which is exactly the [HOST/]OWNER/REPO form `gh --repo`
// documents.
function qualifiedRepo() {
  return runtime.host ? `${runtime.host}/${runtime.repo}` : runtime.repo;
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
function apiHostArgs() {
  return runtime.host ? ["--hostname", runtime.host] : [];
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
  const raw = await runGh(actionsArgs(limit), { signal });
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
  const raw = await runGh(issuesArgs(), { signal });
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
  const raw = await runGh(prsArgs(), { signal });
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

function alertArgs(source) {
  return ["api", apiPath(source.path), ...apiHostArgs(), "--jq", source.jq];
}

// Per-source backoff. Keyed by source so one unavailable endpoint cannot slow
// the other two, and capped rather than permanent so enabling Advanced Security
// mid-session is picked up within the hour.
const alertBackoff = new Map();

function backoffActive(key, now) {
  const state = alertBackoff.get(key);
  return Boolean(state) && now < state.until;
}

// Which ladder each verdict takes. "other" stays absent on purpose: a network
// drop clears when the network does, and re-asking every tick is how the pane
// comes back the moment it does. "rate-limited" used to be absent for the same
// stated reason, which had it backwards -- see RATE_LIMIT_RETRY_MS.
const FAILURE_LADDER = {
  unavailable: BACKOFF_STEPS_MS,
  "auth-problem": AUTH_RETRY_MS,
  "rate-limited": RATE_LIMIT_RETRY_MS,
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

async function fetchAlertSource(source, signal, now) {
  if (backoffActive(source.key, now)) {
    const { note, verdict } = alertBackoff.get(source.key);
    // The verdict is replayed alongside the note. Replaying only the note left
    // the tab unable to tell "Dependabot is switched off here" from "we cannot
    // see Dependabot" for the whole length of a backoff window.
    return { raw: `backoff:${note}`, parse: () => ({ alerts: [], note, verdict, truncated: false }) };
  }
  try {
    const raw = await runGh(alertArgs(source), { signal });
    clearBackoff(source.key);
    return {
      raw,
      parse: () => {
        const rows = JSON.parse(raw).filter((a) => a.state === "open");
        return {
          alerts: rows.map(source.map),
          note: null,
          verdict: "ok",
          truncated: rows.length >= ALERT_PER_PAGE,
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
async function openInBrowser(tabKey, item, signal) {
  const kind = pick(OPENABLE, tabKey, null);
  const id = kind === "run" ? (item?.databaseId ?? item?.number) : (item?.number ?? item?.databaseId);
  if (!kind || id == null) return;
  await runGh([kind, "view", ...repoArgs(), String(id), "--web"], { signal });
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
  if (DOCTOR_ENV_PLAIN.includes(name)) return value;
  return "set";
}

// gh writes some of this to stdout and some to stderr depending on version and
// on whether it succeeded, and a non-zero exit is itself worth reporting rather
// than throwing. Both streams, whatever happened.
async function captureGh(args) {
  try {
    return (await runGh(args)).trim();
  } catch (err) {
    const both = `${err?.stdout ?? ""}${err?.stderr ?? ""}`.trim();
    return both || shortErr(err);
  }
}

const PROBE_STDERR_LIMIT = 400;

async function probe(name, args) {
  const startedAt = Date.now();
  try {
    const stdout = await runGh(args);
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

function targetSource() {
  if (runtime.repo) return "flag";
  if (process.env.GH_REPO) return "GH_REPO";
  return "git remote (or none, if this is not a checkout)";
}

// How much of the hourly API budget is left, and roughly how fast this
// configuration spends it. The steady-state cost is not small and was invisible:
// at the default 5s refresh with the Security tab open it is around 2,200 REST
// requests an hour -- about 44% of a personal token's 5,000 -- and `--refresh 2`
// projects past the limit outright, so it exhausts inside the hour, every hour.
// The budget is shared with everything else the token does, so the first symptom
// is usually "GitHub is broken" somewhere else entirely.
//
// `gh api rate_limit` is documented as not counting against the limit, and it
// measures as free (verified: delta 0), so this is safe to run on a diagnostic
// path. GHES tenants can be configured with a different ceiling, which is
// exactly why this reports the server's own numbers rather than asserting 5,000.
async function rateBudget() {
  try {
    const raw = await runGh(["api", "rate_limit"]);
    const { resources } = JSON.parse(raw);
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

// Requests per hour this configuration will spend once it settles, derived from
// the same constants the poll loop uses rather than from a number written down
// once and left to rot. The active tab refreshes every tick; the other three
// every BACKGROUND_EVERY ticks. Security is three REST calls per fetch, Actions
// one, and Issues/PRs go to GraphQL instead (two POSTs each, because --search
// routes through the search connection).
function projectedHourlyCost(activeKey) {
  const perHour = 3_600_000 / runtime.refreshMs;
  const restCalls = { actions: 1, issues: 0, prs: 0, security: ALERT_SOURCES.length };
  const graphqlCalls = { actions: 0, issues: 2, prs: 2, security: 0 };
  let rest = 0;
  let graphql = 0;
  // TAB_KEYS rather than TABS: this runs on the --doctor path, which deliberately
  // returns before the render tree is reached, and TABS is declared down there.
  for (const key of TAB_KEYS) {
    const ticks = key === activeKey ? perHour : perHour / BACKGROUND_EVERY;
    rest += ticks * restCalls[key];
    graphql += ticks * graphqlCalls[key];
  }
  return { rest: Math.round(rest), graphql: Math.round(graphql) };
}

async function runDoctor() {
  // A live backoff would make an alert probe silently skip and report nothing,
  // which is the opposite of what a diagnostic run is for.
  alertBackoff.clear();

  const probes = [
    ["Actions (run list)", actionsArgs(MIN_RUN_LIMIT)],
    ["Issues (issue list)", issuesArgs()],
    ["Pull requests (pr list)", prsArgs()],
    ...ALERT_SOURCES.map((source) => [source.name, alertArgs(source)]),
  ];

  // allSettled, and every probe already resolves rather than rejects, so one
  // slow endpoint cannot suppress the other five. runGh's own GH_TIMEOUT_MS
  // bounds each one.
  const [ghVersion, authStatus, remote, budget, results] = await Promise.all([
    captureGh(["--version"]),
    captureGh(["auth", "status"]),
    gitRemote(),
    rateBudget(),
    Promise.all(probes.map(([name, args]) => probe(name, args))),
  ]);

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
    field("host", runtime.host ?? "(default -- gh infers it)"),
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
      result.failed ? `FAILED in ${result.ms}ms` : `ok ${result.bytes}B in ${result.ms}ms`,
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
  ["Enter", "Open the selected item in your browser"],
  ["r", "Refresh the current tab now"],
  ["?", "Show the keys (any key closes it)"],
  ["q / Esc / Ctrl+C", "Quit"],
];
const KEY_COL = Math.max(...KEY_TABLE.map(([k]) => k.length)) + 3;
const keyTableLines = () => KEY_TABLE.map(([k, d]) => `${k.padEnd(KEY_COL)}${d}`);

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
    opts = validateArgs(parseArgs(process.argv.slice(2)), TAB_KEYS);
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
            : ""
          : ` (${count}${brokenCI[tab.key] ? "!" : ""})`;
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
  { label: "Quit", keys: "q" },
];

// Reserved so the hints don't shift sideways every time a refresh starts and
// finishes. Wide enough for the spinner, a space and "Fetching".
const FETCHING_WIDTH = 12;

// Width the full hint set needs: every "Label: keys" plus a " | " between each.
// Derived from KEY_HINTS rather than written down, for the same reason
// minimumWidthFor() derives the table breakpoint from its header descriptors --
// a copy change must not be able to invalidate the number.
const HINTS_FULL_WIDTH =
  KEY_HINTS.reduce((sum, h) => sum + h.label.length + 2 + [...h.keys].length, 0) +
  (KEY_HINTS.length - 1) * 3;
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
const STATUS_FULL_WIDTH = FETCHING_WIDTH + HINTS_FULL_WIDTH;

// Two tones rather than one flat gray: the keys you press are the part worth
// finding at a glance, so they get the accent colour and the words describing
// them stay dim. The accent is the panel-title cyan rather than the amber used
// for in-progress status, so amber means exactly one thing across the product.
function StatusBar({ fetching, spin, stale, interactive, cols }) {
  // Without raw mode none of the key handlers run, so advertising them would be
  // telling the user something untrue about what the app can do. Ctrl+C still
  // works there, because the tty delivers a real SIGINT.
  const hints = interactive
    ? KEY_HINTS
    : [{ label: "Quit", keys: "^C" }];
  // Measured against the *full* set even when a compact one is rendered, so the
  // breakpoint does not move as the bar's own contents change.
  const compact = interactive && cols < STATUS_FULL_WIDTH;
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
    // No reserved width here, unlike the fetching slot above: this only
    // toggles on a real problem (a stalled poll, a laptop that just woke up),
    // not every refresh cycle, so letting the hints shift on that rare event
    // is worth getting the column back for the other 99% of the time.
    stale
      ? e(Box, { marginRight: 1, flexShrink: 0 }, e(Text, { color: ATTENTION }, stale))
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
  // Whether the Security tab is currently unable to see its endpoints, as
  // opposed to seeing that they are switched off. Drives the count marker.
  const [securityBlind, setSecurityBlind] = useState(false);
  // The `?` overlay. Renders only on a keypress, so consecutive idle frames are
  // still byte-identical and the redraw suppression is untouched.
  const [showHelp, setShowHelp] = useState(false);
  // Set once, ICON_HINT_AFTER_MS into a first load that is still running. Never
  // reset: it only gates a line that a resolved tab stops rendering anyway, and
  // clearing it would cost a second state write for no visible difference.
  const [iconHintDue, setIconHintDue] = useState(false);
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
  const tabError = errors[tab.key];
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
    (tabError ? 1 : 0) + (tab.key === "security" ? securityLines.length : 0);
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
  const cleanRef = useRef({});
  // Last *successful* poll per tab, wall-clock. Wall-clock on purpose: a laptop
  // sleeping is exactly the gap this is meant to report, and a monotonic clock
  // does not advance across suspend. Never written on the failure path, or a
  // persistently failing tab would report itself fresh forever.
  const lastOkRef = useRef({});
  const fetchTabRef = useRef(null);

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
  const openingRef = useRef({});

  function openSelected() {
    const { items, key: currentKey, tabKey } = navRef.current;
    const item = items.find((i) => itemKey(i) === currentKey);
    if (!item) return;
    const guard = `${tabKey}:${itemKey(item)}`;
    if (openingRef.current[guard]) return;
    openingRef.current[guard] = true;
    // Fire and forget: a browser launch must not block the render loop, and a
    // failure surfaces through the tab's normal error line rather than as an
    // unhandled rejection.
    openInBrowser(tabKey, item)
      .catch((err) => {
        setErrors((x) => ({ ...x, [tabKey]: textTabError(err) }));
      })
      .finally(() => {
        delete openingRef.current[guard];
      });
  }

  useInput(
    (input, key) => {
      if (input === "q" || key.escape) {
        exit();
      } else if (showHelpRef.current) {
        // Any key dismisses -- except quit, handled above, which must never be
        // swallowed by a modal in a full-screen app. Deliberately does not fall
        // through to the binding the key would normally trigger: closing the
        // overlay is the whole intent of that press.
        setShowHelp(false);
      } else if (input === "?") {
        setShowHelp(true);
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
    registerLiveAbort(controller);

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
          lastOkRef.current[key] = Date.now();
          // Clear on the first success or a single failure latches the ladder.
          clearBackoff(`tab:${key}`);
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
          if (key === "security") {
            setSecurityBlind((b) => (b === Boolean(value.blind) ? b : Boolean(value.blind)));
          }
        })
        .catch((err) => {
          if (cancelled || err?.name === "AbortError") return;
          cleanRef.current[key] = false;
          // Preserve both the verdict and the bounded raw error in state. The
          // renderer translates recognized verdicts at draw time, which lets a
          // later repository/account context refine the one-line remedy without
          // throwing away the original evidence.
          const failure = toTabError(err);
          const verdict = failure.verdict;
          setErrors((x) => ({ ...x, [key]: failure }));
          // ...and back off, which the list tabs never did at all. A tab wedged
          // on an expired token used to re-spawn `gh` every tick forever -- 720
          // subprocesses an hour, indefinitely, against a token that is already
          // refusing. "other" has no ladder on purpose: a network drop should
          // recover on the very next tick once the network is back.
          const steps = pick(FAILURE_LADDER, verdict, null);
          if (steps) recordFailure(`tab:${key}`, performance.now(), steps);
        })
        .finally(() => {
          inFlightRef.current[key] = false;
          if (!cancelled) setLoading((l) => (l[key] ? { ...l, [key]: false } : l));
        });
    }

    // `force` is what the `r` key passes, and it is the whole reason the backoff
    // above is safe to add. Without it, pressing refresh on a backed-off tab
    // would silently do nothing -- taking away the one control the user has at
    // exactly the moment the pane looks broken and they reach for it.
    function fetchTab(key, { force = false } = {}) {
      const signal = controller.signal;
      const descriptor = TABS.find((t) => t.key === key);
      if (!force && backoffActive(`tab:${key}`, performance.now())) return Promise.resolve();
      if (force) clearBackoff(`tab:${key}`);
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
      // Mapped explicitly rather than passing fetchTab by reference: Array.map
      // hands the callback an index as its second argument, which would land in
      // the options bag and make every background tab look force-refreshed.
      await Promise.allSettled(due.map((key) => fetchTab(key)));
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
    TABS.map((t) => [t.key, data[t.key] == null && !errors[t.key]]),
  );
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
  const displayError = formatTabError(tabError, null);
  const spin = SPINNER[frame % SPINNER.length];

  const counts = Object.fromEntries(
    TABS.map((t) => {
      const list = data[t.key];
      if (list == null) return [t.key, null];
      // Every tab can be truncated, not just Actions: issues and PRs cap at
      // LIST_LIMIT and alerts at one page of 100. Reporting those as exact made
      // the count stop moving through a genuine change on any repo big enough
      // for this tool to matter.
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
  const failed = Object.fromEntries(TABS.map((t) => [t.key, Boolean(errors[t.key])]));

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
  const compact = frameCols < minimumWidthFor(tab.header);
  const header = compact ? tab.compactHeader : tab.header;

  // Below the compact set's own floor even the fixed columns overflow, which
  // hard-wraps every row and drives ink into clearing and repainting the whole
  // screen each frame -- the one failure mode this file is most engineered to
  // avoid, and it was reachable simply by dragging a sidebar narrow. The guard
  // sits after usableSize(), which substitutes DEFAULT_COLS for a 0 reported
  // mid-resize, so a transient zero cannot be mistaken for a genuinely tiny pane.
  const tooNarrow = frameCols < MIN_COMPACT_WIDTH;

  return e(
    Box,
    { flexDirection: "column", width: frameCols, height: Math.min(rows, usableSize(stdout?.rows, rows)) },
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
        keyTableLines()
          .slice(0, bodyRows)
          .map((line, i) => e(Text, { key: `help${i}`, wrap: "truncate-end" }, line)),
      !showHelp &&
        tooNarrow &&
        e(Text, { dimColor: true, wrap: "truncate-end" }, "too narrow"),
      !showHelp &&
        !tooNarrow &&
        displayError &&
        e(Text, { color: ERROR_TEXT, wrap: "truncate-end" }, displayError),
      !showHelp &&
        !tooNarrow &&
        tab.key === "security" &&
        securityLines.map((note, i) =>
          e(Text, { key: i, dimColor: true, wrap: "truncate-end" }, note),
        ),
      !showHelp && !tooNarrow && e(HeaderCells, { cells: header }),
      ...(tooNarrow || showHelp ? [] : visibleItems).map((item) => {
        const key = itemKey(item);
        return e(
          RowBoundary,
          { key, resetKey: key },
          e(tab.Row, {
            item,
            now,
            compact,
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
      // loading flag, which toggles on every tick and made a settled-empty tab
      // swap its message every five seconds. Suppressed entirely when a tab has
      // an error and has never resolved: the error line directly above already
      // says what happened, and "no runs" underneath it reads as a fact about the
      // repository rather than the absence of an answer.
      !showHelp &&
        !tooNarrow &&
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
      fetching: Object.values(loading).some(Boolean),
      spin: showSpinner ? spin : null,
      stale: staleLabel,
      interactive,
      cols: frameCols,
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
//
// Aborting in-flight `gh` children is the poll effect's job on every other exit
// path, but its cleanup only runs through ink's unmount -- which an explicit
// process.exit() skips. Without this, a crash orphaned up to six subprocesses
// for the length of GH_TIMEOUT_MS. The abort runs *after* restoreScreen() and is
// wrapped, because an exception thrown here would replace the stack trace this
// handler exists to print with an unrelated one.
//
// Both messages go through redact(): a stack can carry a URL with inline
// credentials, and this output is what a user pastes into a bug report -- the
// same reasoning --doctor already applies to its own report.
function installCrashHandlers() {
  const fail = (label) => (err) => {
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
  disarmDevBuildLeak();
  installCrashHandlers();
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
  const app = render(e(App), { incrementalRendering: true });

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
  parseRepoTarget,
  REPO_PATTERN,
  HOST_PATTERN,
  MIN_REFRESH_SECONDS,
  MAX_REFRESH_SECONDS,
  TAB_KEYS,
  safe,
  shortErr,
  isUnavailable,
  isRateLimited,
  isAuthProblem,
  toTabError,
  formatTabError,
  AUTH_RETRY_MS,
  BACKOFF_STEPS_MS,
  redact,
  classify,
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
  KEY_TABLE,
  KEY_HINTS,
  VERDICT_REMEDY,
  RATE_LIMIT_RETRY_MS,
  FAILURE_LADDER,
};
