# Phase 1 — Host-aware repo targets

> Files: `index.mjs`, `test/args.test.mjs`
> Depends on: nothing. Blocks: phases 2, 3, 4.
> Not batch-eligible (shares `index.mjs` with phases 2 and 3).

## Why

`gh` accepts `[HOST/]OWNER/REPO` for `--repo` and `GH_REPO`; `gh-glance` accepts
only `OWNER/REPO` (`index.mjs:661`) and exits 2 on the host form. Separately,
`gh api` (`index.mjs:524`) is never told which host to use, so a host-qualified
target routes the four list-driven tabs correctly while sending the three alert
endpoints to `github.com` (defect D2 in the plan).

## Changes

### 1. `HOST_PATTERN` and `parseRepoTarget()`, beside `REPO_PATTERN` (`index.mjs:661`)

`REPO_PATTERN` itself is **unchanged** — it keeps validating the `owner/name`
half, and the existing test at `test/args.test.mjs:71-82` keeps passing
untouched.

```
# A dot is mandatory. Without it "owner/name/extra" -- already in the hostile
# list -- would silently mean "the repo acme/widget on the host named owner",
# i.e. a typo becomes a cross-host request.
HOST_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/

parseRepoTarget(value):
    parts <- String(value).split("/")
    if parts.length == 3 AND HOST_PATTERN.test(parts[0]):
        host <- parts[0]; slug <- parts[1] + "/" + parts[2]
    else if parts.length == 2:
        host <- null; slug <- value
    else:
        throw Error(REPO_MESSAGE(value))
    if NOT REPO_PATTERN.test(slug): throw Error(REPO_MESSAGE(value))
    return { host, slug }

REPO_MESSAGE(v) = `--repo must look like owner/name or host/owner/name, got: ${v}`
```

The message deliberately still contains the substring `must look like
owner/name`, so the existing assertion regex at `test/args.test.mjs:67` matches
without being edited.

### 2. `runtime` (`index.mjs:116-121`)

```
runtime.host <- null    # NEW. null unless the target was host-qualified.
```

`runtime.repo` keeps its current meaning and type: the `owner/name` slug, or
`null` for "let gh infer it".

### 3. `repoArgs()` (`index.mjs:317-319`) and a new `apiHostArgs()`

```
qualifiedRepo() -> runtime.host ? runtime.host + "/" + runtime.repo : runtime.repo

repoArgs()    -> runtime.repo ? ["--repo", qualifiedRepo()] : []
apiHostArgs() -> runtime.host ? ["--hostname", runtime.host] : []
```

`apiPath()` (`index.mjs:325-327`) is unchanged: it substitutes `runtime.repo`,
which is still the bare slug, so nothing host-shaped is ever interpolated into
a request path. That keeps the boundary described at `test/args.test.mjs:48-51`
exactly where it is.

### 4. The `gh api` call site (`index.mjs:524`)

```
runGh(["api", apiPath(source.path), ...apiHostArgs(), "--jq", source.jq], { signal })
```

With no host configured, `apiHostArgs()` is empty and the vector is
byte-identical to today's.

Do **not** add `--hostname` on the inferred-repo path. When the repo comes from
the working directory, `gh` resolves host and repo together from the git remote;
the research verified that an unauthenticated host fails there with a clear
`none of the git remotes ... point to a known GitHub host` message rather than
silently going somewhere wrong.

### 5. `validateArgs()` (`index.mjs:704-735`) and the entry point (`index.mjs:834`)

```
validateArgs:
    if opts.repo != null:
        { host, slug } <- parseRepoTarget(opts.repo)   # throws with REPO_MESSAGE
    else:
        host <- null; slug <- null
    return { ..., repo: slug, host }

entry point:
    runtime.repo <- opts.repo
    runtime.host <- opts.host        # NEW
```

### 6. Exports (`index.mjs:2046-2071`)

Add `parseRepoTarget` and `HOST_PATTERN`. `REPO_PATTERN` stays exported.

### 7. `--help` (`index.mjs:741-789`)

One line changes; no new flag appears.

```
-R, --repo <owner/name>  ->  -R, --repo [host/]owner/name
```

with the body noting that the host form targets a GitHub Enterprise or
EMU data-residency tenant, and that it is unnecessary when running inside a
clone of that repository.

## Tests (`test/args.test.mjs`)

Keep every existing test as-is. Add:

```
test("--repo accepts the host-qualified form gh itself accepts"):
    parseRepoTarget("tenant.ghe.com/acme/widget") == {host:"tenant.ghe.com", slug:"acme/widget"}
    parseRepoTarget("acme/widget")                == {host:null,             slug:"acme/widget"}
    parseRepoTarget("github.com/cli/cli")         == {host:"github.com",     slug:"cli/cli"}

test("a host-qualified --repo still rejects everything the two-part form rejects"):
    for v in ["evil.com/owner/name/extra", "evil.com/owner/", "evil.com//name",
              "evil.com/../etc", "-bad.host/o/r", "bad-.host/o/r",
              "host..com/o/r", ".host.com/o/r", "host.com./o/r",
              "nodot/owner/name", "localhost/o/r"]:
        assert throws parseRepoTarget(v)

test("a three-part value whose first part is not a hostname is still a typo, not a host"):
    # the case the mandatory dot exists for -- must keep throwing
    assert throws parseRepoTarget("owner/name/extra")
```

The existing hostile-input test (`test/args.test.mjs:47-69`) is the primary
artifact for this phase and must pass **unmodified**.

## Success criteria

### Automated
- `npm test` passes, including every pre-existing assertion in
  `test/args.test.mjs` with no edits to them.
- `npm run lint` and `node --check index.mjs` pass.
- `node index.mjs --repo tenant.ghe.com/acme/widget --help` exits 0;
  `node index.mjs --repo owner/name/extra` exits 2.

### Manual
- None.
