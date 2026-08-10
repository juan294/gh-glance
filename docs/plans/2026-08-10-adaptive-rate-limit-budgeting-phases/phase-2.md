# Phase 2 — `GH_GLANCE_REFRESH` environment variable

Not batch-eligible (edits `index.mjs`, shared with phases 1, 3, 4).

## Why

`--refresh` exists and is bounds-checked, but is flag-only. On a multi-repo day
the interval has to be retyped for every pane. `CONTRIBUTING.md:16-17` already
lists a config file or flags for the refresh interval as a wanted contribution.

This is also the floor the Phase 3-4 loop widens *from*, so a user who knows they
are opening ten panes can declare it once and let adaptation handle the rest.

## Design constraints from the existing code

- **One write site.** `index.mjs:1679-1683` is documented as "One place argv
  becomes runtime state" after a past drift bug. The env value must resolve
  *before* that block and flow through it, not be assigned beside it.
- **Flag wins over env.** Established three times for `GH_REPO`
  (`index.mjs:1141`, `index.mjs:1289-1291`, `index.mjs:3049`) and documented at
  `index.mjs:1642`.
- **Reuse the bounds logic.** `validateArgs` (`index.mjs:1538-1550`) already
  produces the two distinct error messages and the `* 1000` conversion. A second
  numeric validator would be the drift this file repeatedly warns about.
- Existing env idioms are truthiness opt-out (`index.mjs:200`) and exact-value
  opt-in (`index.mjs:1806`). Neither is numeric-with-bounds; this is the first,
  so it must borrow `validateArgs`' shape rather than invent one.

## Changes

### `index.mjs` — parse the env var through the same validator

The cleanest seam that preserves the single write site: let `parseArgs` keep
returning only what argv said, and have the *entry block* supply the env value as
the fallback before validation.

In the entry block, replacing `index.mjs:1663`:

```
- opts = validateArgs(parseArgs(process.argv.slice(2)), TAB_KEYS);
+ const argvOpts = parseArgs(process.argv.slice(2));
+ // The flag wins; the env var is the fallback, the same precedence GH_REPO has
+ // (documented in HELP's Environment block). Substituted before validation so
+ // an out-of-range GH_GLANCE_REFRESH is refused by the same two messages an
+ // out-of-range --refresh gets, rather than by a second copy of the bounds.
+ if (argvOpts.refresh === null && process.env.GH_GLANCE_REFRESH) {
+   argvOpts.refresh = process.env.GH_GLANCE_REFRESH;
+ }
+ opts = validateArgs(argvOpts, TAB_KEYS);
```

The existing catch at `index.mjs:1664-1666` already prints
`gh-glance: <message>` and exits 2, so a bad env value fails as loudly as a bad
flag. The message will say `--refresh` even when the value came from the env; fix
that by threading the source name:

```
  function validateArgs(opts, tabKeys) {
+   // Named so the message points at whichever surface supplied the value.
+   const refreshLabel = opts.refreshSource ?? "--refresh";
    ...
-     throw new Error(`--refresh must be a whole number of seconds, got: ${opts.refresh}`);
+     throw new Error(`${refreshLabel} must be a whole number of seconds, got: ${opts.refresh}`);
      ...
-       `--refresh must be between ${MIN_REFRESH_SECONDS} and ${MAX_REFRESH_SECONDS} seconds, got: ${seconds}`,
+       `${refreshLabel} must be between ${MIN_REFRESH_SECONDS} and ${MAX_REFRESH_SECONDS} seconds, got: ${seconds}`,
```

and set `argvOpts.refreshSource = "GH_GLANCE_REFRESH"` alongside the fallback
assignment above. `parseArgs`' returned literal gains `refreshSource: null`
(`index.mjs:1492-1500`) so the shape stays declared-up-front.

### `index.mjs` — doctor visibility

`DOCTOR_ENV_PLAIN` (`index.mjs:1164-1173`) is the allowlist of vars printed with
their value; anything else prints only `set`.

```
  const DOCTOR_ENV_PLAIN = [
    ..., "GH_GLANCE_ICONS", "GH_GLANCE_NO_ANIMATION",
+   "GH_GLANCE_REFRESH",
    "NO_COLOR", "NODE_ENV",
  ];
```

### `index.mjs` — help text

In `HELP`'s `Environment:` block (`index.mjs:1641-1649`), matching the
`GH_REPO` line's precedence note and deriving the bounds rather than restating
them:

```
+   GH_GLANCE_REFRESH=<seconds>
+                             Active-tab poll interval, ${MIN_REFRESH_SECONDS}-${MAX_REFRESH_SECONDS}
+                             (--refresh takes precedence)
```

## Tests

### `test/args.test.mjs`

`parse` (`args.test.mjs:21`) is `validateArgs(parseArgs(argv), TAB_KEYS)` and
does not see the env var, because the substitution lives in the `IS_MAIN` entry
block. So test the *unit* here and the *wiring* in `doctor.test.mjs`:

```
test("refreshSource renames the bounds messages without duplicating them", () => {
  assert.throws(
    () => validateArgs({ ...defaults, refresh: "1", refreshSource: "GH_GLANCE_REFRESH" }, TAB_KEYS),
    /GH_GLANCE_REFRESH must be between 2 and 3600 seconds, got: 1/,
  );
  assert.throws(
    () => validateArgs({ ...defaults, refresh: "abc", refreshSource: "GH_GLANCE_REFRESH" }, TAB_KEYS),
    /GH_GLANCE_REFRESH must be a whole number of seconds/,
  );
});

test("without a source the messages still name the flag", () => {
  assert.throws(() => parse(["--refresh", "1"]), /--refresh must be between/);
});
```

Keep the existing `--refresh` corpus at `args.test.mjs:135-142` untouched — it is
the regression guard that the flag path is unchanged.

### `test/doctor.test.mjs`

The `doctor()` helper (`doctor.test.mjs:79-91`) already spawns a real child with
caller env last, which is exactly the wiring under test:

```
test("GH_GLANCE_REFRESH sets the interval and is reported by name", async () => {
  const report = await doctor({ env: { GH_GLANCE_REFRESH: "30" } });
  assert.match(report, /GH_GLANCE_REFRESH {2,}30/);
  assert.match(report, /this config spends .*refresh 30s/);
  assert.match(report, /~270 REST/);       // 1620 / 6, from phase 1's table
});

test("--refresh beats GH_GLANCE_REFRESH", async () => {
  const report = await doctor({ env: { GH_GLANCE_REFRESH: "30" }, args: ["--refresh", "10"] });
  assert.match(report, /this config spends .*refresh 10s/);
});

test("an out-of-range GH_GLANCE_REFRESH exits 2 naming the variable", async () => {
  await assert.rejects(
    () => doctor({ env: { GH_GLANCE_REFRESH: "1" } }),
    (err) => err.code === 2 && /GH_GLANCE_REFRESH must be between/.test(err.stderr),
  );
});
```

`doctor()` currently returns only `stdout` and throws on non-zero exit; the third
test needs `stderr` and `code`, so extend the helper to surface them rather than
adding a second spawner.

## Verification

### Automated
- `npm run lint`, `node --check index.mjs` clean
- `npm test` passes including the five new tests
- `GH_GLANCE_REFRESH=30 node index.mjs --doctor` reports `refresh 30s`,
  `~270 REST`, and a `GH_GLANCE_REFRESH  30` environment line
- `GH_GLANCE_REFRESH=1 node index.mjs --doctor; echo $?` prints 2 and a message
  naming `GH_GLANCE_REFRESH`
- `GH_GLANCE_REFRESH=30 node index.mjs --refresh 10 --doctor` reports `refresh 10s`

### Manual
None.

## Out of scope

No `GH_GLANCE_*` var for `BACKGROUND_EVERY` or the adaptive cap. One lever.
