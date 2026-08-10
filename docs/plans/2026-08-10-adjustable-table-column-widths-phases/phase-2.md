# Phase 2 — Durable per-user preferences

> Files: `index.mjs`, `test/unit.test.mjs`, `test/preferences.test.mjs`,
> `test/pty/capture.mjs`
> Depends on: phase 1. Blocks: phases 3-5.
> Not batch-eligible: it connects phase 1's model to the App state used by both
> interaction phases.

## Objective

Load versioned per-tab width deviations at startup, render them safely, and
atomically persist later state changes without making filesystem availability a
startup or runtime requirement.

## Changes

### 1. Preference path helper

Extend Node imports with only built-ins (`node:fs`, `node:os`, `node:path`).

```text
widthPreferencesPath({env = process.env, platform = process.platform,
                      home = homedir()}):
    if env.XDG_CONFIG_HOME is non-empty and absolute:
        root = env.XDG_CONFIG_HOME
    else if platform == "darwin":
        root = join(home, "Library", "Application Support")
    else:
        root = join(home, ".config")
    return join(root, "gh-glance", "preferences.json")
```

An empty or relative XDG value is ignored. Do not add a CLI flag or a
gh-glance-specific environment variable.

### 2. Versioned parsing and serialization

Define `WIDTH_PREFERENCES_VERSION = 1` and pure helpers:

```text
parseWidthPreferences(raw, tabs = TABS):
    parse JSON
    require {version:1,tabs:object}
    for each known tab and adjustable column:
        accept safe integer >= minWidth
    drop unknown tabs/columns and invalid values
    return normalized overrides or empty overrides

serializeWidthPreferences(overrides, tabs = TABS):
    keep only known adjustable safe integers != descriptor default
    omit empty tab objects
    return JSON.stringify({version:1,tabs:...}, null, 2) + newline
```

Malformed JSON, an unknown version, wrong shapes, prototype keys, and unsafe
numbers yield ignored entries rather than an exception. Never merge parsed
objects through inherited properties.

### 3. Nonfatal atomic I/O

```text
loadWidthPreferences(path):
    read utf8
    ENOENT -> empty preferences
    any other read/parse failure -> empty preferences + nonfatal error metadata

saveWidthPreferences(path, overrides):
    payload = serializeWidthPreferences(overrides)
    mkdir parent recursively (requested mode 0700)
    write unique same-directory temp (requested mode 0600)
    rename temp to path
    failure -> best-effort unlink exact temp, return {ok:false,error}
```

Use explicit paths and a same-directory rename. Never recursively remove a
preference parent. The file contains layout integers only.

### 4. App state and fitting

Initialize once:

```text
const preferencePath = widthPreferencesPath()
const [widthOverrides, setWidthOverrides] = useState(
    () => loadWidthPreferences(preferencePath).preferences
)
```

Resolve the active tab's preferred header from its saved overrides, then use
phase 1's safe fitting. Compact descriptors remain defaults and saved full
preferences remain untouched while compact is visible.

Maintain `widthOverridesRef` for stable input/cleanup closures. Changes should
produce the same object when nothing changed.

### 5. Coalesced persistence coordinator

Add a small injected/testable coordinator rather than writing inside render:

```text
createWidthPreferenceWriter({write, delay = 200, onResult}):
    latest = empty
    timer = null

    schedule(value):
        latest = value
        replace trailing timer

    flush():
        clear timer
        write(latest) once if dirty
        report success/failure; never throw

    dispose(): flush()
```

App updates state first, then schedules the new normalized overrides. Width-
mode exit, mouse release, reset, and unmount call `flush()`. Repeated movement
within the delay coalesces. A successful write clears the prior warning; a
failure sets `Widths not saved` for the contextual width status added in phase
3. The dashboard and current state continue normally.

### 6. Isolate PTY config (`test/pty/capture.mjs`)

Every PTY process must be deterministic and must not read a developer's real
preferences. Extend `capture()` with optional `configHome`:

```text
capture(options):
    ownedConfigHome = options.configHome ?? unique tmpdir path
    child env includes XDG_CONFIG_HOME = ownedConfigHome
    caller-supplied env may not silently remove this isolation
    cleanup owned path only when capture created it
    leave caller-owned configHome intact for restart assertions
```

Use an explicit task-owned temp path and remove only that path. Existing capture
callers need no changes.

## Unit tests

### `test/unit.test.mjs`

- path resolution prefers an absolute XDG root on macOS and Linux;
- macOS fallback is Application Support and Linux fallback is `.config`;
- empty/relative XDG values are ignored;
- parser accepts only version 1, known tab/column keys, safe integers, and
  semantic minima;
- serializer stores only deviations and stable keys, with a trailing newline;
- parse/serialize round-trip is stable and does not mutate inputs;
- writer coalesces repeated schedules, flushes latest state exactly once,
  flushes on dispose, and converts write rejection/throw into result state.

### `test/preferences.test.mjs`

Use `mkdtempSync()` under `tmpdir()` and explicit child paths:

- missing file loads defaults;
- corrupt JSON and unknown version load defaults without throwing;
- valid preferences round-trip through the real filesystem;
- save creates parent/file with requested permissions where the platform
  exposes meaningful POSIX mode bits;
- repeated save atomically replaces content and leaves no temp file;
- an unwritable/file-as-parent case returns failure and preserves session data;
- cleanup removes only the exact test-owned directory in `finally`.

## Automated success criteria

Run sequentially:

```bash
npm run lint && npm test && node --check index.mjs && npm run test:pty
```

- Existing PTY runs cannot see real user preferences.
- Filesystem tests create nothing outside their explicit temporary roots.
- Corrupt/unwritable storage never exits the app or throws through render.

## Manual success criteria

- Place a valid hand-written preference at the resolved platform path and
  confirm it changes only the named full-layout columns.
- Corrupt the test copy (not a real user file) and confirm the dashboard opens
  with defaults and remains interactive.
- Make the test preference directory unwritable and confirm live state still
  works and later phases can surface `Widths not saved` without a crash.
