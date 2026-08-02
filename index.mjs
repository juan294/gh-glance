#!/usr/bin/env node
// gh-glance -- a live-refreshing GitHub dashboard sized for a narrow terminal
// pane: Actions, Issues, Pull Requests, and Security (Dependabot/
// code-scanning/secret-scanning alerts). All data comes from `gh` (issue/pr/
// run list + `gh api` for security alerts) -- no direct GitHub API calls of
// our own. Renders with ink so redraws are diffed in place, no full-screen
// clear/flash on refresh.

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import React, { useState, useEffect, useRef } from "react";
import { render, Box, Text, useStdout, useInput, useStdin } from "ink";

const e = React.createElement;
const execFileAsync = promisify(execFile);

const REFRESH_MS = 5000;

// `gh run list` costs roughly linearly in --limit (measured: ~1.2s at 20 runs,
// ~3.0s at 100, ~4.9s at 150), so asking for a fixed 150 to render ~35 visible
// rows was paying several seconds per refresh for rows nobody sees. Actions is
// a scrolling log whose count is arbitrary anyway, so it fetches only what the
// pane can show -- one extra row tells us whether to render the count as "n+".
const MIN_RUN_LIMIT = 20;

// Issues and PRs are sets rather than logs: the count *is* the signal, so these
// stay generous. They are also far cheaper, being bounded by what's open.
const LIST_LIMIT = 150;

// Alert endpoints are filtered server-side to open items and capped at one
// page. The previous --paginate walked the repo's entire alert history --
// mostly closed alerts -- and then discarded them client-side.
const ALERT_QUERY = "?state=open&per_page=100";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_MS = 100;

// ---------- Octicons (via the Nerd Font glyph set -- private-use-area
// codepoints from ryanoasis/nerd-fonts glyphnames.json). Same icon shapes
// github.com uses, not emoji. ----------
const OCT = {
  checkCircleFill: "",
  xCircleFill: "",
  skipFill: "",
  alertFill: "",
  dotFill: "",
  issueOpened: "",
  issueClosed: "",
  pullRequest: "",
  pullRequestClosed: "",
  gitMerge: "",
  pullRequestDraft: "",
  shield: "",
};

function formatDuration(ms) {
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
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function shortErr(err) {
  return err?.shortMessage ?? err?.message ?? String(err);
}

// Some pty wrappers (and a terminal mid-resize) report a height of 0 or
// undefined. Taking that literally collapses the table to a single row, so
// fall back to a sane default until a real height arrives.
const DEFAULT_ROWS = 30;
function usableRows(rows) {
  return typeof rows === "number" && rows > 0 ? rows : DEFAULT_ROWS;
}

// ---------- Data fetchers ----------

async function fetchActions(limit) {
  const { stdout } = await execFileAsync("gh", [
    "run",
    "list",
    "--limit",
    String(limit),
    "--json",
    "databaseId,displayTitle,workflowName,number,headBranch,event,status,conclusion,startedAt,updatedAt",
  ]);
  return JSON.parse(stdout);
}

async function fetchIssues() {
  const { stdout } = await execFileAsync("gh", [
    "issue",
    "list",
    "--state",
    "open",
    "--limit",
    String(LIST_LIMIT),
    "--json",
    "number,title,author,labels,createdAt,updatedAt",
  ]);
  return JSON.parse(stdout);
}

async function fetchPRs() {
  const { stdout } = await execFileAsync("gh", [
    "pr",
    "list",
    "--state",
    "open",
    "--limit",
    String(LIST_LIMIT),
    "--json",
    "number,title,author,headRefName,isDraft,reviewDecision,createdAt,updatedAt",
  ]);
  return JSON.parse(stdout);
}

// Dependabot alerts are broadly available. Code scanning and secret scanning
// alerts require GitHub Advanced Security, which private repos on this
// account's plan don't have -- those calls reliably 403/404, so we surface a
// one-line note instead of a raw API error.
async function fetchDependabotAlerts() {
  try {
    const { stdout } = await execFileAsync("gh", [
      "api",
      `repos/{owner}/{repo}/dependabot/alerts${ALERT_QUERY}`,
    ]);
    const raw = JSON.parse(stdout);
    const alerts = raw
      .filter((a) => a.state === "open")
      .map((a) => ({
        id: `dependabot-${a.number}`,
        kind: "Dependabot",
        severity: a.security_advisory?.severity ?? "unknown",
        title: a.security_advisory?.summary ?? "(no summary)",
        detail: a.dependency?.package?.name ?? "",
        createdAt: a.created_at,
      }));
    return { alerts, note: null };
  } catch (err) {
    return { alerts: [], note: `Dependabot alerts: ${shortErr(err)}` };
  }
}

async function fetchCodeScanningAlerts() {
  try {
    const { stdout } = await execFileAsync("gh", [
      "api",
      `repos/{owner}/{repo}/code-scanning/alerts${ALERT_QUERY}`,
    ]);
    const raw = JSON.parse(stdout);
    const alerts = raw
      .filter((a) => a.state === "open")
      .map((a) => ({
        id: `codeql-${a.number}`,
        kind: "CodeQL",
        severity: a.rule?.security_severity_level ?? a.rule?.severity ?? "unknown",
        title: a.rule?.description ?? a.rule?.name ?? "(no description)",
        detail: a.most_recent_instance?.location?.path ?? "",
        createdAt: a.created_at,
      }));
    return { alerts, note: null };
  } catch {
    return { alerts: [], note: "Code scanning: not enabled (needs GitHub Advanced Security)" };
  }
}

async function fetchSecretScanningAlerts() {
  try {
    const { stdout } = await execFileAsync("gh", [
      "api",
      `repos/{owner}/{repo}/secret-scanning/alerts${ALERT_QUERY}`,
    ]);
    const raw = JSON.parse(stdout);
    const alerts = raw
      .filter((a) => a.state === "open")
      .map((a) => ({
        id: `secret-${a.number}`,
        kind: "Secret",
        severity: "critical",
        title: a.secret_type_display_name ?? a.secret_type ?? "(unknown secret type)",
        detail: "",
        createdAt: a.created_at,
      }));
    return { alerts, note: null };
  } catch {
    return { alerts: [], note: "Secret scanning: disabled" };
  }
}

async function fetchSecurity() {
  const [dependabot, codeScanning, secretScanning] = await Promise.all([
    fetchDependabotAlerts(),
    fetchCodeScanningAlerts(),
    fetchSecretScanningAlerts(),
  ]);
  return {
    alerts: [...dependabot.alerts, ...codeScanning.alerts, ...secretScanning.alerts],
    notes: [dependabot.note, codeScanning.note, secretScanning.note].filter(Boolean),
  };
}

// ---------- Shared layout primitives ----------

function Column({ width, grow, children, bold, color }) {
  return e(
    Box,
    { width, flexGrow: grow ? 1 : 0, flexShrink: grow ? 1 : 0, marginRight: 1 },
    e(Text, { bold, color, wrap: "truncate-end" }, children),
  );
}

function HeaderCells({ cells }) {
  return e(
    Box,
    { flexDirection: "row", borderStyle: "single", borderTop: false, borderLeft: false, borderRight: false },
    ...cells.map((c, i) => e(Column, { key: i, ...c.props, bold: true, color: "gray" }, c.label)),
  );
}

// ---------- Actions tab ----------

const RUN_STATUS_ICON = {
  success: { icon: OCT.checkCircleFill, color: "greenBright" },
  failure: { icon: OCT.xCircleFill, color: "redBright" },
  cancelled: { icon: OCT.skipFill, color: "gray" },
  skipped: { icon: OCT.skipFill, color: "gray" },
  timed_out: { icon: OCT.xCircleFill, color: "redBright" },
  action_required: { icon: OCT.alertFill, color: "yellowBright" },
  neutral: { icon: OCT.skipFill, color: "gray" },
  stale: { icon: OCT.skipFill, color: "gray" },
  startup_failure: { icon: OCT.xCircleFill, color: "redBright" },
};
const RUN_IN_PROGRESS_ICON = { icon: OCT.dotFill, color: "cyanBright" };
const RUN_PENDING_ICON = { icon: OCT.dotFill, color: "yellowBright" };

function runStatusIcon(run) {
  if (run.status === "in_progress") return RUN_IN_PROGRESS_ICON;
  if (run.status !== "completed") return RUN_PENDING_ICON;
  return RUN_STATUS_ICON[run.conclusion] ?? { icon: "?", color: "gray" };
}

const ACTIONS_HEADER = [
  { label: "", props: { width: 3 } },
  { label: "TITLE", props: { grow: true } },
  { label: "WORKFLOW", props: { width: 10 } },
  { label: "BRANCH", props: { width: 14 } },
  { label: "TIME", props: { width: 7 } },
  { label: "AGE", props: { width: 8 } },
];

function ActionsRow({ item, now }) {
  const { icon, color } = runStatusIcon(item);
  const started = new Date(item.startedAt);
  const finished = item.status === "completed" ? new Date(item.updatedAt) : now;
  return e(
    Box,
    { flexDirection: "row" },
    e(Column, { width: 3, color }, icon),
    e(Column, { grow: true }, item.displayTitle),
    e(Column, { width: 10, color: "blue" }, `${item.workflowName} #${item.number}`),
    e(Column, { width: 14, color: "magenta" }, item.headBranch),
    e(Column, { width: 7 }, formatDuration(finished - started)),
    e(Column, { width: 8, color: "gray" }, formatAge(started, now)),
  );
}

// ---------- Issues tab ----------

const ISSUES_HEADER = [
  { label: "", props: { width: 3 } },
  { label: "TITLE", props: { grow: true } },
  { label: "AUTHOR", props: { width: 12 } },
  { label: "LABEL", props: { width: 14 } },
  { label: "AGE", props: { width: 8 } },
];

function IssueRow({ item, now }) {
  return e(
    Box,
    { flexDirection: "row" },
    e(Column, { width: 3, color: "greenBright" }, OCT.issueOpened),
    e(Column, { grow: true }, `#${item.number} ${item.title}`),
    e(Column, { width: 12, color: "blue" }, item.author?.login ?? ""),
    e(Column, { width: 14, color: "magenta" }, item.labels?.[0]?.name ?? ""),
    e(Column, { width: 8, color: "gray" }, formatAge(new Date(item.updatedAt), now)),
  );
}

// ---------- Pull requests tab ----------

const PRS_HEADER = [
  { label: "", props: { width: 3 } },
  { label: "TITLE", props: { grow: true } },
  { label: "AUTHOR", props: { width: 12 } },
  { label: "BRANCH", props: { width: 14 } },
  { label: "REVIEW", props: { width: 10 } },
  { label: "AGE", props: { width: 8 } },
];

const REVIEW_LABEL = {
  APPROVED: { label: "approved", color: "greenBright" },
  CHANGES_REQUESTED: { label: "changes", color: "redBright" },
  REVIEW_REQUIRED: { label: "pending", color: "yellowBright" },
};

function PRRow({ item, now }) {
  const prIcon = item.isDraft ? { icon: OCT.pullRequestDraft, color: "gray" } : { icon: OCT.pullRequest, color: "greenBright" };
  const review = REVIEW_LABEL[item.reviewDecision] ?? { label: "", color: "gray" };
  return e(
    Box,
    { flexDirection: "row" },
    e(Column, { width: 3, color: prIcon.color }, prIcon.icon),
    e(Column, { grow: true }, `#${item.number} ${item.title}`),
    e(Column, { width: 12, color: "blue" }, item.author?.login ?? ""),
    e(Column, { width: 14, color: "magenta" }, item.headRefName),
    e(Column, { width: 10, color: review.color }, review.label),
    e(Column, { width: 8, color: "gray" }, formatAge(new Date(item.updatedAt), now)),
  );
}

// ---------- Security tab ----------

const SECURITY_HEADER = [
  { label: "", props: { width: 3 } },
  { label: "PACKAGE / FILE", props: { width: 20 } },
  { label: "SUMMARY", props: { grow: true } },
  { label: "AGE", props: { width: 8 } },
];

const SEVERITY_COLOR = {
  critical: "redBright",
  high: "redBright",
  medium: "yellowBright",
  low: "gray",
  unknown: "gray",
};

function SecurityRow({ item, now }) {
  const color = SEVERITY_COLOR[item.severity] ?? "gray";
  return e(
    Box,
    { flexDirection: "row" },
    e(Column, { width: 3, color }, OCT.shield),
    e(Column, { width: 20, color: "blue" }, item.detail || item.kind),
    e(Column, { grow: true }, item.title),
    e(Column, { width: 8, color: "gray" }, formatAge(new Date(item.createdAt), now)),
  );
}

// ---------- Tabs ----------

const TABS = [
  { key: "actions", label: "Actions", header: ACTIONS_HEADER, Row: ActionsRow, countLabel: "runs" },
  { key: "issues", label: "Issues", header: ISSUES_HEADER, Row: IssueRow, countLabel: "open issues" },
  { key: "prs", label: "Pull requests", header: PRS_HEADER, Row: PRRow, countLabel: "open PRs" },
  { key: "security", label: "Security", header: SECURITY_HEADER, Row: SecurityRow, countLabel: "alerts" },
];

function TabBar({ activeIndex, counts, loading, spin }) {
  return e(
    Box,
    { flexDirection: "row" },
    ...TABS.map((tab, i) => {
      const active = i === activeIndex;
      const count = counts[tab.key];
      // A tab that has never resolved shows the spinner where its count will
      // go, so the first load reads as "working" rather than "empty".
      const suffix = count == null ? (loading[tab.key] ? ` ${spin}` : "") : ` (${count})`;
      const label = `${i + 1}:${tab.label}${suffix}`;
      return e(
        Box,
        { key: tab.key, marginRight: 2 },
        e(Text, { bold: active, inverse: active, color: active ? undefined : "gray" }, ` ${label} `),
      );
    }),
  );
}

// ---------- App ----------

function App() {
  const { stdout } = useStdout();
  const { isRawModeSupported } = useStdin();
  const [activeIndex, setActiveIndex] = useState(0);
  // `null` means "never resolved" -- distinct from `[]`, which means "resolved
  // and genuinely empty". The tab bar and the body render those differently.
  const [data, setData] = useState({ actions: null, issues: null, prs: null, security: null });
  const [securityNotes, setSecurityNotes] = useState([]);
  const [errors, setErrors] = useState({ actions: null, issues: null, prs: null, security: null });
  const [loading, setLoading] = useState({ actions: true, issues: true, prs: true, security: true });
  const [now, setNow] = useState(new Date());
  const [lastFetched, setLastFetched] = useState(null);
  const [rows, setRows] = useState(usableRows(stdout?.rows));
  const [frame, setFrame] = useState(0);

  const tab = TABS[activeIndex];
  const extraLines = tab.key === "security" ? securityNotes.length : 0;
  // Reserve lines for: column header + its separator (2), the tab bar (1) and
  // the status line (1), plus a 1-line safety margin. Slack is absorbed by the
  // spacer in the tree below.
  const bodyRows = Math.max(1, rows - 5 - extraLines);

  // Read at fetch time rather than being a hook dependency, so dragging the
  // pane wider doesn't cancel and restart in-flight requests -- the next tick
  // simply asks for the new size.
  const runLimitRef = useRef(0);
  runLimitRef.current = Math.max(bodyRows + 1, MIN_RUN_LIMIT);

  const anyLoading = Object.values(loading).some(Boolean);

  // `isActive` has to be coerced: ink only skips raw mode when the flag is
  // strictly `false`, and Node reports `stdin.isTTY` as `undefined` -- not
  // `false` -- when stdin isn't a terminal. Passing the raw value through
  // would let ink call setRawMode() on a non-TTY stdin and throw on startup.
  useInput(
    (input, key) => {
      if (input >= "1" && input <= String(TABS.length)) {
        setActiveIndex(Number(input) - 1);
      } else if (key.tab && key.shift) {
        setActiveIndex((i) => (i - 1 + TABS.length) % TABS.length);
      } else if (key.tab || key.rightArrow) {
        setActiveIndex((i) => (i + 1) % TABS.length);
      } else if (key.leftArrow) {
        setActiveIndex((i) => (i - 1 + TABS.length) % TABS.length);
      }
    },
    { isActive: Boolean(isRawModeSupported) },
  );

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;

    // Each tab commits its own result the moment it lands instead of waiting on
    // a Promise.allSettled barrier. Actions is by far the slowest fetch, so
    // barrelling everything together meant the three fast tabs sat invisible
    // behind it and nothing at all appeared until the slowest call returned.
    function commit(key, run) {
      setLoading((l) => ({ ...l, [key]: true }));
      return run()
        .then((value) => {
          if (cancelled) return;
          setData((d) => ({ ...d, [key]: value.alerts ?? value }));
          if (value.notes) setSecurityNotes(value.notes);
          setErrors((x) => ({ ...x, [key]: null }));
          setNow(new Date());
        })
        .catch((err) => {
          if (!cancelled) setErrors((x) => ({ ...x, [key]: shortErr(err) }));
        })
        .finally(() => {
          if (!cancelled) setLoading((l) => ({ ...l, [key]: false }));
        });
    }

    async function tick() {
      // A slow repo used to outrun the interval: `gh run list --limit 150` took
      // ~5s against a 5s tick, so refreshes stacked on top of each other.
      if (inFlight) return;
      inFlight = true;
      const limit = runLimitRef.current;
      await Promise.allSettled([
        commit("actions", () => fetchActions(limit)),
        commit("issues", () => fetchIssues()),
        commit("prs", () => fetchPRs()),
        commit("security", () => fetchSecurity()),
      ]);
      inFlight = false;
      if (cancelled) return;
      setLastFetched(new Date());
      setNow(new Date());
    }

    tick();
    const id = setInterval(tick, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // Only animate while something is actually in flight -- an idle dashboard
  // should cost nothing, and a permanently ticking timer would redraw the pane
  // ten times a second forever.
  useEffect(() => {
    if (!anyLoading) return;
    const id = setInterval(() => setFrame((f) => (f + 1) % SPINNER.length), SPINNER_MS);
    return () => clearInterval(id);
  }, [anyLoading]);

  // React to the pane resizing immediately (desktop vs. laptop, or just
  // dragging the Ghostty window) instead of waiting for the next poll tick.
  useEffect(() => {
    if (!stdout) return;
    function onResize() {
      setRows(usableRows(stdout.rows));
    }
    stdout.on("resize", onResize);
    return () => stdout.off("resize", onResize);
  }, [stdout]);

  const items = data[tab.key];
  const error = errors[tab.key];
  const spin = SPINNER[frame % SPINNER.length];

  const counts = Object.fromEntries(
    TABS.map((t) => {
      const list = data[t.key];
      if (list == null) return [t.key, null];
      // Actions is capped to the pane height, so say so rather than implying
      // the repo only ever ran that many workflows.
      const capped = t.key === "actions" && list.length >= runLimitRef.current;
      return [t.key, `${list.length}${capped ? "+" : ""}`];
    }),
  );

  const visibleItems = (items ?? []).slice(0, bodyRows);
  const pending = TABS.filter((t) => loading[t.key] && data[t.key] == null).map((t) => t.label.toLowerCase());

  let status;
  if (!lastFetched) {
    status = `${spin} loading ${pending.join(", ") || "…"}`;
  } else if (anyLoading) {
    status = `${spin} refreshing · ←/→ or 1-4 to switch tabs`;
  } else {
    status = `updated ${formatAge(lastFetched, now)} · refreshing every ${REFRESH_MS / 1000}s · ←/→ or 1-4 to switch tabs`;
  }

  return e(
    Box,
    { flexDirection: "column", width: "100%", height: rows },
    error && e(Text, { color: "red" }, error),
    tab.key === "security" && securityNotes.map((note, i) => e(Text, { key: i, color: "gray" }, note)),
    e(HeaderCells, { cells: tab.header }),
    ...visibleItems.map((item) => e(tab.Row, { key: item.id ?? item.databaseId ?? item.number, item, now })),
    // Distinguishes "still fetching" from "resolved and empty" in the body,
    // which is the difference between a dashboard that looks hung and one that
    // looks correct.
    visibleItems.length === 0 &&
      e(
        Text,
        { color: "gray" },
        loading[tab.key] ? ` ${spin} loading ${tab.label.toLowerCase()}…` : `  no ${tab.countLabel}`,
      ),
    // Pins the tab bar and status line to the bottom of the pane, so the tabs
    // stay put instead of riding up under the column headers on a tab that
    // only has a handful of rows.
    e(Box, { flexGrow: 1 }),
    e(TabBar, { activeIndex, counts, loading, spin }),
    e(Text, { color: "gray" }, status),
  );
}

// ---------- Entry point ----------

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

const HELP = `gh-glance ${version} -- a live-refreshing GitHub dashboard for a narrow terminal pane.

Usage:
  gh-glance            Run the dashboard in the current repository
  gh-glance --help     Show this help
  gh-glance --version  Show the version

Run it from inside a locally cloned GitHub repository; the repo is inferred
from the git remote, the same way \`gh\` does it. Requires the \`gh\` CLI,
authenticated via \`gh auth login\`.

Keys:
  1 2 3 4            Actions / Issues / Pull requests / Security
  Left / Right       Previous / next tab
  Tab / Shift+Tab    Next / previous tab
  Ctrl+C             Quit
`;

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(HELP);
  process.exit(0);
}
if (args.includes("--version") || args.includes("-v")) {
  console.log(version);
  process.exit(0);
}
if (args.length > 0) {
  console.error(`gh-glance: unknown argument: ${args[0]}\nRun \`gh-glance --help\` for usage.`);
  process.exit(2);
}

// This is a full-screen live dashboard, not a reporting command -- piping it
// somewhere would emit an endless stream of redraw frames, so fail fast with
// an explanation instead.
if (!process.stdout.isTTY) {
  console.error("gh-glance: stdout is not a terminal. This is an interactive dashboard and can't be piped or redirected.");
  process.exit(1);
}

// Enter the alternate screen buffer, same as lazygit/htop/vim, so the shell
// prompt and the command that launched this script scroll out of view instead
// of sitting above the dashboard.
process.stdout.write("\x1b[?1049h\x1b[2J\x1b[H");

function restoreScreen() {
  process.stdout.write("\x1b[?1049l");
}
process.on("exit", restoreScreen);
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

render(e(App));
