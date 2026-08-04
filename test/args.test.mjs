// Argument parsing and validation.
//
// The argv surface was a strict allowlist that exited 2 on anything it did not
// recognise, and that strictness is the only input validation the CLI has --
// a typo failing loudly beats one being ignored. These tests pin that it
// survived being widened.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseArgs,
  validateArgs,
  parseRepoTarget,
  REPO_PATTERN,
  MIN_REFRESH_SECONDS,
  MAX_REFRESH_SECONDS,
  TAB_KEYS,
} from "../index.mjs";

const parse = (argv) => validateArgs(parseArgs(argv), TAB_KEYS);

test("no arguments keeps every default", () => {
  const opts = parse([]);
  assert.equal(opts.repo, null, "null means: let gh infer from the git remote");
  assert.equal(opts.refreshMs, null);
  assert.equal(opts.tabKey, null);
  assert.equal(opts.verbose, false);
});

test("unknown arguments are still rejected", () => {
  // This is the property that must survive widening the parser.
  for (const bad of [["--bogus"], ["-x"], ["extra"], ["--repo", "a/b", "--nope"]]) {
    assert.throws(() => parse(bad), /unknown argument/, JSON.stringify(bad));
  }
});

test("--repo accepts both spellings and both forms", () => {
  for (const argv of [
    ["--repo", "juan294/gh-glance"],
    ["-R", "juan294/gh-glance"],
    ["--repo=juan294/gh-glance"],
  ]) {
    assert.equal(parse(argv).repo, "juan294/gh-glance", JSON.stringify(argv));
  }
});

test("--repo rejects anything that is not owner/name", () => {
  // This value reaches a subprocess argument AND is interpolated into a `gh api`
  // request path. execFile with an array means there is no shell to inject into,
  // but an unvalidated value in the path would be a request-forgery primitive
  // against arbitrary endpoints -- so the pattern is the boundary.
  const hostile = [
    "not-a-repo",
    "owner/name/extra",
    "../../etc/passwd",
    "owner/name?foo=bar",
    "owner/name#frag",
    "owner /name",
    "/absolute",
    "owner/",
    "/name",
    "",
    "a/b/../../c",
    "owner/name%2F..",
  ];
  for (const value of hostile) {
    assert.throws(() => parse(["--repo", value]), /must look like owner\/name/, JSON.stringify(value));
  }
});

test("--repo accepts the host-qualified form gh itself accepts", () => {
  // `gh --repo` documents [HOST/]OWNER/REPO. Accepting the same shape is what
  // lets a data-residency tenant (<slug>.ghe.com) be watched from outside a
  // clone -- and the host has to travel separately from the slug, because the
  // slug is interpolated into a `gh api` path and the host never is.
  assert.deepEqual(parseRepoTarget("tenant.ghe.com/acme/widget"), {
    host: "tenant.ghe.com",
    slug: "acme/widget",
  });
  assert.deepEqual(parseRepoTarget("acme/widget"), { host: null, slug: "acme/widget" });
  assert.deepEqual(parseRepoTarget("github.com/cli/cli"), { host: "github.com", slug: "cli/cli" });

  const opts = parse(["--repo", "tenant.ghe.com/acme/widget"]);
  assert.equal(opts.repo, "acme/widget", "the api path gets the bare slug");
  assert.equal(opts.host, "tenant.ghe.com");
  assert.equal(parse(["--repo", "acme/widget"]).host, null);
  assert.equal(parse([]).host, null);
});

test("a host-qualified --repo still rejects everything the two-part form rejects", () => {
  for (const value of [
    "evil.com/owner/name/extra",
    "evil.com/owner/",
    "evil.com//name",
    "evil.com/../etc",
    "-bad.host/o/r",
    "bad-.host/o/r",
    "host..com/o/r",
    ".host.com/o/r",
    "host.com./o/r",
    "nodot/owner/name",
    "localhost/o/r",
  ]) {
    assert.throws(() => parseRepoTarget(value), /must look like owner\/name/, JSON.stringify(value));
  }
});

test("a three-part value whose first part is not a hostname is still a typo, not a host", () => {
  // The case the mandatory dot exists for: without it this would silently mean
  // "the repo name/extra on the host named owner".
  assert.throws(() => parseRepoTarget("owner/name/extra"), /must look like owner\/name/);
});

test("the repo pattern allows the names GitHub actually allows", () => {
  for (const good of [
    "juan294/gh-glance",
    "cli/cli",
    "a/b",
    "Org-Name/repo.name",
    "user123/repo_name",
    "o/repo-with.many_parts",
  ]) {
    assert.ok(REPO_PATTERN.test(good), good);
  }
});

test("--refresh takes whole seconds inside a stated range", () => {
  assert.equal(parse(["--refresh", "15"]).refreshMs, 15000);
  assert.equal(parse(["--refresh=30"]).refreshMs, 30000);
  assert.equal(parse(["--refresh", String(MIN_REFRESH_SECONDS)]).refreshMs, MIN_REFRESH_SECONDS * 1000);
  assert.equal(parse(["--refresh", String(MAX_REFRESH_SECONDS)]).refreshMs, MAX_REFRESH_SECONDS * 1000);
});

test("--refresh rejects values that would silently not be honoured", () => {
  // Below the floor a fetch cannot finish before the next tick, so the in-flight
  // guard absorbs every other one and the requested interval stops being real.
  // Refusing beats accepting a number that does not mean what it says.
  for (const bad of ["1", "0", "-5", "abc", "2.5", "", "Infinity", "1e9"]) {
    assert.throws(() => parse(["--refresh", bad]), /--refresh/, JSON.stringify(bad));
  }
});

test("--tab accepts exactly the four tab keys", () => {
  for (const key of TAB_KEYS) {
    assert.equal(parse(["--tab", key]).tabKey, key);
  }
  assert.throws(() => parse(["--tab", "Actions"]), /--tab must be one of/, "case sensitive");
  assert.throws(() => parse(["--tab", "nope"]), /--tab must be one of/);
});

test("a flag missing its value is an error, not a silent default", () => {
  for (const bad of [["--repo"], ["--refresh"], ["--tab"], ["-R"]]) {
    assert.throws(() => parse(bad), /needs a value/, JSON.stringify(bad));
  }
});

test("--help and --version survive validation", () => {
  // They were dropped by an earlier version of validateArgs, which made
  // `--help` fall through to the non-TTY guard and print the wrong message.
  assert.equal(parse(["--help"]).help, true);
  assert.equal(parse(["-h"]).help, true);
  assert.equal(parse(["--version"]).showVersion, true);
});

test("-v is rejected rather than silently meaning --version", () => {
  // It used to be an alias for --version, in a CLI that also has --verbose -- so
  // `gh-glance -v 2>log`, which is what you type when you want the log, printed a
  // version string and exited 0. The allowlist exists so a typo fails loudly, and
  // this was the one flag that failed quietly.
  assert.throws(() => parse(["-v"]), /unknown argument: -v/);
});

test("flags combine", () => {
  const opts = parse(["--repo", "cli/cli", "--refresh", "20", "--tab", "prs", "--verbose"]);
  assert.equal(opts.repo, "cli/cli");
  assert.equal(opts.refreshMs, 20000);
  assert.equal(opts.tabKey, "prs");
  assert.equal(opts.verbose, true);
});
