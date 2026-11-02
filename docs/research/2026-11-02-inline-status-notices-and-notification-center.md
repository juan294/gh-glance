# Research: inline status notices and inputs for a notification section

> 2026-11-02 | Repository `juan294/gh-glance` | Branch `develop` @ `7686e40d2b2298785b53c7681fefeebe9e444574` (clean)
> Workflow: `rpi-research` (descriptive). No product code was changed.

## Question

How do the yellow lines above each table work today (for example `Waiting to update Actions`, `Checked 08:15`, `Core: GitHub budget evidence is old`, `Retry the shared budget check automatically; next <1m`, `cached 52s`)? Where are they produced and rendered, what triggers each one, how do they change the table height, how are the four sections defined and navigated, and what existing state or history could feed a fifth "Notifications" section? The owner also asked about GitHub platform status as a future input.

Owner context (2026-11-02, with screenshot of the Actions pane): these lines appear often, push the table down, and rarely need attention. The owner wants them moved into a separate notifications section that can be opened on demand.

## Summary

- The five lines in the screenshot come from two producers. `dashboardPresentation()` builds the title (`Waiting to update Actions`) and the source-check line (`Checked 08:15`) (`index.mjs:16678`, `index.mjs:16687-16696`, `index.mjs:16710`). `presentRecovery()` builds the three recovery lines from a recovery cause; the full sentence is longer than the pane, so it splits into resource+summary, action+retry, and cache age (`index.mjs:16635-16675`).
- The text for every recovery cause is in one table, `RECOVERY_COPY`, with 56 reason codes. Each code has a summary, an action and a short form (`index.mjs:16494-16551`).
- When a table is visible, the notice lines render as rows above the column header and reduce the table body by the same number of rows (`index.mjs:19141-19166`, `index.mjs:22377-22378`). The frame height does not change; the table body shrinks. When the cause clears, the rows go away at once and the table moves back up (`index.mjs:19021-19031`).
- A notice appears only after the condition lasts 800 ms (`index.mjs:213`, `index.mjs:19021-19031`). There is no minimum display time and no delay on removal.
- A persisted, bounded recovery journal already records recovery-cause transitions and clears per rate resource (Core, GraphQL): at most 128 entries and 128 KiB, stored next to the governor ledger as `<ledger>.recovery.json` (`index.mjs:16483-16484`, `index.mjs:16860-16862`, `index.mjs:16935-16976`). Today only `gh-glance --doctor` reads it (`index.mjs:11966-11988`).
- Several notice types are not journaled: the `Checked HH:MM` line, "needs an update" (overdue) state, render-time causes built when no retained recovery exists, tab fetch errors shown as `displayError`, Security source notes, Actions setup notes and feature notices.
- The sections are a fixed four-entry array `TABS` (`index.mjs:13339`) with a parallel `TAB_KEYS` (`index.mjs:237`). Both are coupled to data acquisition: each entry has a `fetch` function, row component and header, and the per-tab React state is keyed by the four names (`index.mjs:18901-18904`). Navigation uses digits `1`..`TABS.length`, Tab/Shift-Tab and arrow keys (`index.mjs:19746-19754`).
- No GitHub platform status integration exists in the code (no match for `githubstatus` or `status.github` in `index.mjs`). The public Statuspage API at `www.githubstatus.com` answered on 2026-11-02 (details below).

## Detailed findings

### 1. Producers of the notice text

#### 1a. Section state title and source check: `dashboardPresentation()`

`index.mjs:16678-16749`. Inputs include `rows`, `sourceAt`, `overdue`, `onDemand`, `requestState`, `error`, `recovery`, `disconnected` and Security notes.

| State | Condition | Title text | Evidence |
|---|---|---|---|
| `failed` | `error` or `disconnected` | `Could not refresh <Label>` / `Could not load <Label>` | `index.mjs:16705-16707` |
| `waiting` | a recovery cause exists or `requestState === "waiting"` | `Waiting to update <Label>` / `Waiting to check <Label>` | `index.mjs:16698`, `index.mjs:16708-16710` |
| `loading` / `waiting` | no snapshot yet | `Checking <Label>…` / `Waiting to check <Label>` | `index.mjs:16711-16714` |
| `overdue` | stale beyond the freshness deadline, not on-demand | `<Label> needs an update` | `index.mjs:16715-16717` |
| `saved` | on-demand view (non-Actions tabs in on-demand background mode) | `Saved <Label> view` | `index.mjs:16718-16722` |
| `ready` | none of the above | tab label, or the empty-state text | `index.mjs:16700` |

`sourceCheck` is `Checked HH:MM` (with a date prefix when not today), `Not checked yet`, or `Last-check time unavailable` (`index.mjs:16687-16696`). When a recovery cause exists, its summary is prefixed to the explanation and its action plus `; next <interval>` becomes `action` (`index.mjs:16728-16732`).

#### 1b. Recovery lines: `presentRecovery()`

`index.mjs:16635-16675`. The resource prefix is `Core`, `GraphQL` or `GitHub` (`index.mjs:16638`). The age part is `cached <duration>` from `sourceAt`, or `Not checked yet` / an unavailable form (`index.mjs:16639-16642`). The retry part is `; next <interval>` where `statusInterval()` returns `<1m`, `Nm` or `99m+` (`index.mjs:16643-16644`, `index.mjs:17620-17626`).

- Width at least 60: a single line `<Resource>: <summary>; <action><retry>; <age>` if it fits. Otherwise three lines: `<Resource>: <summary>`, `<action><retry>`, `<age>` (`index.mjs:16671-16674`). The screenshot is this three-line form.
- Width below 60: three short lines from the `short` copy and a reduced action (`index.mjs:16647-16669`).

#### 1c. Recovery cause vocabulary: `RECOVERY_COPY` and `recoveryCause()`

`RECOVERY_COPY` (`index.mjs:16494-16551`) has 56 codes in these families (grouping by observed copy):

- Multi-pane coordination: `busy`, `stale`, `identity-busy`, `transport-busy`, `acquisition-busy`, `request-queue`, `receipt-retry`, `interrupted-request`.
- Budget and quota pacing: `budget-unknown`, `budget-stale` (the screenshot's "GitHub budget evidence is old"), `budget-future`, `budget-reset`, `reset`, `rate-limit`, `priority`, `local-reserve`, `reserve`, `probe-failed`, `identity-backoff`, `identity-capacity`, `block-unpublished`.
- GitHub-imposed limits: `rate-limited`, `blocked`, `secondary`, `secondary-rate-limit`, `abuse-limit`, `throttle-paused` (the only one whose action asks for a key press).
- Connectivity and auth: `network-outage`, `credential-unavailable`, `identity-unavailable`, `auth-problem`, `unknown-scope`, `disconnected`, `app-auth`.
- Source quality: `unavailable`, `source-incomplete`, `security-incomplete`, `clock-recovery`.
- Local storage needing manual repair: `unwritable`, `corrupt`, `capacity`, `accounting-overflow`, `debt-journal-full`, `reservations-invalid`, `external-factor-invalid`, `pacing-invalid`, `budget-resource`, `legacy-unresolved`, `legacy-corrupt`, `migration-hold`, `restart-required`, `backup-conflict`, `version-mismatch`, `unsafe-permissions`, `disk-full`, `coordination` (fallback).

`recoveryCause()` normalizes a reason into a cause record with `code`, `resource`, `origin` (`source` or `coordination`), `tab`, `at`, `firstAt`, `retryAt`, `sourceAt`, ledger counters, `summary`, `action`, `short` (`index.mjs:16553-16577`). Unknown reasons fall back to `coordination` (`index.mjs:16557-16559`).

`HARD_STORAGE_REASONS` (`corrupt`, `unwritable`, `capacity`, `accounting-overflow`, `backup-conflict`) are kept sticky; no retry clears them and doctor names the manual remedy (`index.mjs:16486-16488`).

### 2. Which cause a pane shows, and when

In `App()`:

1. Per-resource causes live in state `recoveryCauses = { core, graphql }` (`index.mjs:18907`). The active tab's resource is the first rate resource the tab's request cost uses (`index.mjs:18939`). A cause with `origin: "source"` is shown only on its own tab (`index.mjs:18940-18942`).
2. `noticeReason` is chosen in this order: retained recovery code, then the tab fetch error verdict, then a paused or coordination-error governor reason, then a disconnected/identity reason (`index.mjs:19009-19013`).
3. If no retained recovery exists, a cause is built at render time from that reason (`index.mjs:19033-19039`). These render-time causes are not written to the journal.
4. Debounce: `coordinationCondition` is the tab key while a reason exists. An effect sets the visible condition to `null` immediately on any change and to the tab key after `COORDINATION_NOTICE_AFTER_MS = 800` (`index.mjs:213`, `index.mjs:19016-19029`). Removal is immediate; there is no minimum on-screen time.
5. `recoveryLines` is the `presentRecovery()` output when the notice is visible, else the formatted tab error (`displayError`) (`index.mjs:19040-19042`). Tone is `ATTENTION` (`yellowBright`, `index.mjs:12776`) for a recovery notice or `ERROR_TEXT` (`red`, `index.mjs:12778`) for an error (`index.mjs:19043`).

Writes to `recoveryCauses` happen in the poll machinery. `setRuntimeRecovery` skips a write when the same code, retry time, origin and tab were recorded less than 60 s before (`index.mjs:19862-19864`), then updates state and schedules a journal write (`index.mjs:19865-19873`). `clearRuntimeRecovery` clears state and journals a `clear` entry, except while receipt or cleanup backlogs remain (`index.mjs:19876-19888`). Other `setRecoveryCauses` call sites: `index.mjs:19988`, `index.mjs:20970`, `index.mjs:21054`.

### 3. Layout effect (why the table moves)

`index.mjs:19141-19166` and the JSX at `index.mjs:22377-22386`:

- `tableNoticeCapacity = max(0, rows - 9)` (`index.mjs:19142`).
- For states `failed`, `overdue`, `waiting` (`needsTableContext`, `index.mjs:19143`), `tableNotices` is `[title, sourceCheck, ...recoveryLines]` when capacity is 4 or more, or a shortened 1 to 3 line form on small panes (`index.mjs:19146-19152`). Other states use only `recoveryLines`.
- `noticeLines` merges focus lines, coordination notices, Actions setup title/action/notes, `tableNotices` and feature notices, deduplicated and capped at capacity (`index.mjs:19157-19159`).
- Security tab adds `visibleSecurityLines` in the remaining capacity (`index.mjs:19160-19161`).
- `extraLines = noticeLines.length + visibleSecurityLines.length` when a table is visible, and `bodyRows = max(1, rows - 6 - 2 (header) - extraLines)` (`index.mjs:19162-19166`). `bodyRows` also drives cursor paging (`index.mjs` `navRef`, `pageStep`).
- Each notice is one `Text` row with `wrap: "truncate-end"`, rendered before the column header (`index.mjs:22377-22378`). The comment at `index.mjs:22361-22363` states that truncation is what keeps the one-line-per-notice reservation exact.

Effect in the screenshot (observed): state `waiting` with recovery present, capacity at least 4, so 2 presentation lines plus 3 recovery lines take 5 rows from the table body.

When no table is visible (no rows, help, CI, attention views), the same information appears in a full-body panel from `contextualPanelLayout()` instead (`index.mjs:16776-16790`, `index.mjs:19136-19139`, `index.mjs:22434-22438`).

The 2026-08-29 plan set the goal "A notice appearing must not change the frame height" (`docs/plans/2026-08-29-conditional-polling-and-calm-status.md`, Goal section). The current code keeps the frame height fixed and takes the rows from the table body.

### 4. Other status surfaces that already exist

- **Status bar** (bottom row): `refreshStatus()` maps state to `Width`, `Setup`, `Checking`, `Paused`, `Disconnected`, `Stale`, `Failed`, `Limited`, `Cached`, `Shared`, `Watching` (`index.mjs:17558-17618`). `statusBarLayout()` adds a compact detail such as `next <1m`, `reset 3m`, `sharing 2`, a governor cause string, or a stale age (`index.mjs:17620-17720`). It is rendered by `StatusBar` (`index.mjs:17830`, call at `index.mjs:22445-22467`).
- **Tab bar**: a tab whose fetches fail renders in `redBright`; Actions shows a broken-CI suffix (`index.mjs:17401-17447`, `index.mjs:22133-22149`). The comment at `index.mjs:17434-17437` records that background-tab failures are otherwise invisible.
- **Context help** (`?`): paginated panel with title, action, source check, target, explanation, notes and the full diagnostic (`index.mjs:16809-16857`, `index.mjs:19168-19177`).
- **Doctor**: `gh-glance --doctor` reads the recovery journal and reports the current cause, last failed transition and next retry (`index.mjs:11966-11988`).
- **Verbose**: `--verbose` writes one stderr line per `gh` invocation (`index.mjs:655-664`, `index.mjs:12577`). This is a request log, not a notice history.

### 5. Section definition and navigation

- `TAB_KEYS = ["actions", "issues", "prs", "security"]` (`index.mjs:237`) is used for `--tab` validation and help text (`index.mjs:12273-12274`, `index.mjs:12454`, `index.mjs:12580`) and for cause and journal validation (`index.mjs:16565`, `index.mjs:16891`). 44 lines in `index.mjs` reference `TAB_KEYS`.
- `TABS` (`index.mjs:13339` onward) holds `key`, `fetch`, `label`, `short`, `header`, `compactHeader`, `Row`, `countLabel` for each section. 64 lines reference `TABS` through `.map`, `.find`, `.length`, `.flatMap` or indexing.
- Per-tab React state is initialized with the four keys explicitly: `errors`, `loading`, `waiting` (`index.mjs:18901-18904`); `requestStatuses` derives from `TABS` (`index.mjs:18910-18912`).
- `activeIndex` starts at `runtime.initialTabIndex` (`index.mjs:18641`). Keys: digit `1`..`TABS.length`, Shift-Tab and Left (previous), Tab and Right (next) (`index.mjs:19746-19754`). `TabBar` renders `[n:Name suffix]` for each entry (`index.mjs:17401-17447`).
- Inference: adding a fifth `TABS` entry without a `fetch` would reach every loop that assumes each tab is a data source (poll loop, request cost, cache entry tabs). The exact set of those loops was not enumerated in this session.

### 6. Existing state that could feed a notification history

| Source | What it holds | Persistence and scope | Evidence |
|---|---|---|---|
| Recovery journal `<ledger>.recovery.json` | `current` cause per resource and up to 128 `entries` (cause records or `{code:"clear", resource, at}`) | File, mode 0600, atomic rename, under a persistence lock; ledger lives in the `coordination-v2` config directory | `index.mjs:16860-16976`, `index.mjs:3400` |
| `recoveryCauses` state | live Core/GraphQL cause | in memory, per pane | `index.mjs:18907` |
| `errors`, `acquisitionFailures`, `governorDecisions`, `requestStatuses` | per-tab live failure and governor state | in memory, per pane | `index.mjs:18901-18912` |
| `lastOkRef`, collector source ages | last successful observation per tab | in memory, seeded from cache | `index.mjs:18978-18991` |
| Security source notes | per-source unavailable/not-enabled notes | derived at render time | `index.mjs:18951-18971` |

Journal details:

- An entry is appended only when code, origin or tab changes; repeats update `current` only (`index.mjs:16957-16959`). Clears append a `clear` entry (`index.mjs:16947-16950`).
- Readers validate strictly and return `status` of `healthy`, `missing`, `unavailable` or `corrupt` (`index.mjs:16902-16933`). A write fails closed (returns `ok:false`) on a non-healthy journal (`index.mjs:16940`). The journal is advisory: a failed write never blocks data work (comment at `index.mjs:16480-16482`, `safeRecordRecoveryTransition` at `index.mjs:16978-16980`).
- `visibleRecoveryEvent()` re-attaches `summary`, `action`, `short` from `RECOVERY_COPY` on read (`index.mjs:16896-16900`), so entries can be displayed with the same copy as the inline notice.
- Inference: the ledger path is the shared governor scope, so panes using the same GitHub identity and host write to the same journal (ADR `docs/decisions/0003-file-backed-api-coordination.md` describes file-backed shared coordination; the scope hashing itself was not traced in this session).

Events that today exist only at render time and are not recorded anywhere: `Checked HH:MM`, overdue/"needs an update", render-time causes from fetch verdicts or governor pauses (`index.mjs:19033-19039`), `displayError` text, Security source notes, Actions setup notes, feature notices.

### 7. Recovery and visibility of failure states (as observed)

- Automatic retry causes show their retry time inline and in the status bar; they clear on the next success for the same tab or on scheduled-hold clearance (`shouldClearRecoveryCause`, `index.mjs:16579-16586`).
- Hard storage causes stay until manual repair; the inline action and doctor output name `gh-glance --doctor` (`index.mjs:16486-16488`, `index.mjs:16650`).
- `throttle-paused` waits for `r` (`index.mjs:16530`, manual refresh handler at `index.mjs:19741-19745`).
- Background-tab failures are visible only as tab-bar colour (`index.mjs:17434-17437`).

## External observation: GitHub platform status

Retrieved 2026-11-02 with `curl`:

- `GET https://www.githubstatus.com/api/v2/status.json` returned `HTTP/2 200`, `content-type: application/json`, `cache-control: max-age=10, public, s-maxage=10, stale-while-revalidate=20, stale-if-error=3600`, and a weak `ETag`.
- `GET https://www.githubstatus.com/api/v2/components.json` listed components including `Git Operations`, `Webhooks`, `API Requests`, `Issues`, `Pull Requests`, `Actions`, `Packages`, `Pages`, `Copilot`, `Codespaces`.

Inference (not verified): this host is separate from `api.github.com`, so it is not metered by the GitHub REST/GraphQL rate limits the governor tracks, and it describes github.com only, not GitHub Enterprise Server hosts selected with `--repo HOST/OWNER/REPO`.

## Test surfaces that pin current notice behavior

Unit tests calling `presentRecovery` or `dashboardPresentation`: `test/recovery.test.mjs` (8 references), `test/onboarding.test.mjs` (3), `test/governor.test.mjs`, `test/governor-v8.test.mjs`, `test/identity.test.mjs`, `test/context-help.test.mjs` (2 each). PTY tests asserting notice text or rows inserted above the table: `test/pty/status.test.mjs`, `test/pty/runtime-remediation.test.mjs`. `test/unit.test.mjs` pins that coordination notices do not expose internal vocabulary (comment at `index.mjs:16462-16465`).

## Historical context

- `docs/plans/2026-08-29-conditional-polling-and-calm-status.md`: set the fixed-frame-height goal and the calm status bar.
- `docs/plans/2026-09-28-durable-freshness-and-recovery-notes.md`: introduced durable recovery notes; records the journal clock-skew repair now present in `recoveryEvent()` (`index.mjs:16876-16880`).
- `docs/research/2026-08-11-rate-limit-rendering-and-restart-state.md`, `docs/research/2026-09-28-persistent-staleness-and-github-web-updates.md`: earlier work on rate-limit rendering and staleness reporting.

## Open questions

1. Which loops would a fifth, non-data section reach? Section 5 records the coupling counts; the poll loop, cache entry, request-cost and focus/CI/attention paths were not enumerated. A planner needs this list to size the change.
2. Shared or per-pane history? The journal is shared per governor scope (inferred) and holds only Core/GraphQL recovery transitions. Render-time events are per pane and unrecorded. The owner decides which events a notification list should hold.
3. Journal capacity: 128 entries per scope across all panes. Whether that window is long enough for the intended history was not measured.
4. Which inline information must stay inline? Hard-storage causes and `throttle-paused` need user action; the remaining codes retry automatically. This is an owner decision, not a research finding.
5. GitHub status polling cost and GHES behaviour are inferred, not verified.

## Handoff

- Objective: descriptive research only, requested 2026-11-02. No plan or implementation authorized yet.
- Baseline: `develop` @ `7686e40d2b2298785b53c7681fefeebe9e444574`, primary checkout `/Users/juan/code/gh-glance`, clean before this artifact.
- Checks: none run (read-only research). External check: two `curl` requests to `www.githubstatus.com` on 2026-11-02.
- Next phase: `rpi-plan` (or `rpi-assess` first if design alternatives for the notification section need evaluation). Revalidate line numbers against the then-current `develop` before planning.
