// A checkout with more than one remote (a fork with `upstream`, say) used to
// leave the dashboard with no repository and a misleading connection or
// coordination failure, while `--doctor` looked healthy because it only read
// `origin`. These tests pin three things: the default gh itself uses
// (`remote.<name>.gh-resolved`, written by `gh repo set-default`) selects the
// repository, a still-ambiguous set of remotes is named as such, and the doctor
// reports the repository the dashboard will actually use.

import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  AMBIGUOUS_REMOTE_ERROR_TEXT,
  AMBIGUOUS_REMOTE_HINTS,
  VERDICT_REMEDY,
  activeKeyHints,
  ambiguousRemoteLines,
  classify,
  contextHelpPages,
  gitRemoteUrls,
  readGitRemotes,
  remoteRepositorySlugs,
  repositoryTargetProblem,
  resolveEffectiveHost,
  resolveEffectiveRepository,
  selectGhDefaultRemoteUrls,
} from "../index.mjs";

const execFileAsync = promisify(execFile);
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = join(REPO, "index.mjs");
const FIXTURE_BIN = join(REPO, "test", "pty", "fixtures");

const ORIGIN = "https://github.com/acme/widget.git";
const UPSTREAM = "https://github.com/other/fork.git";

function checkout(t, { remotes = {}, resolved = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "gh-glance-target-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", root]);
  for (const [name, url] of Object.entries(remotes)) {
    execFileSync("git", ["-C", root, "remote", "add", name, url]);
  }
  for (const [name, value] of Object.entries(resolved)) {
    execFileSync("git", ["-C", root, "config", `remote.${name}.gh-resolved`, value]);
  }
  return root;
}

test("without a gh default every remote URL is kept", () => {
  const urls = selectGhDefaultRemoteUrls([
    { name: "origin", urls: [ORIGIN], resolved: null },
    { name: "upstream", urls: [UPSTREAM], resolved: null },
  ]);
  assert.deepEqual(urls, [ORIGIN, UPSTREAM]);
  assert.equal(resolveEffectiveRepository({ remoteUrls: urls }), null);
});

test("a remote marked base by gh repo set-default selects that remote", () => {
  const urls = selectGhDefaultRemoteUrls([
    { name: "origin", urls: [ORIGIN], resolved: "base" },
    { name: "upstream", urls: [UPSTREAM], resolved: null },
  ]);
  assert.deepEqual(urls, [ORIGIN]);
  assert.equal(resolveEffectiveRepository({ remoteUrls: urls }), "acme/widget");
});

test("a gh default naming owner/name keeps the remote's host", () => {
  // gh stores the parent's full name on the fork's remote when the parent is
  // chosen; the host still comes from the remote it is stored on.
  const urls = selectGhDefaultRemoteUrls([
    { name: "origin", urls: ["git@tenant.ghe.com:me/widget.git"], resolved: "acme/widget" },
    { name: "mirror", urls: ["https://github.com/someone/else.git"], resolved: null },
  ]);
  assert.equal(resolveEffectiveRepository({ remoteUrls: urls }), "acme/widget");
  assert.equal(resolveEffectiveHost({ remoteUrls: urls }), "tenant.ghe.com");
});

test("conflicting or malformed gh defaults do not invent a target", () => {
  const conflicting = selectGhDefaultRemoteUrls([
    { name: "origin", urls: [ORIGIN], resolved: "base" },
    { name: "upstream", urls: [UPSTREAM], resolved: "base" },
  ]);
  assert.equal(resolveEffectiveRepository({ remoteUrls: conflicting }), null);
  const malformed = selectGhDefaultRemoteUrls([
    { name: "origin", urls: [ORIGIN], resolved: "not a repository" },
    { name: "upstream", urls: [UPSTREAM], resolved: null },
  ]);
  assert.deepEqual(malformed, [ORIGIN, UPSTREAM]);
});

test("remotes naming different repositories are ambiguous, not missing", () => {
  assert.equal(repositoryTargetProblem({ remoteUrls: [] }), "no-remote");
  assert.equal(repositoryTargetProblem({ remoteUrls: [ORIGIN, UPSTREAM] }), "ambiguous-remote");
  assert.equal(repositoryTargetProblem({ remoteUrls: [ORIGIN] }), null);
  // The same repository over HTTPS and SSH is one repository.
  assert.equal(repositoryTargetProblem({ remoteUrls: [ORIGIN, "git@github.com:acme/widget.git"] }), null);
  assert.equal(repositoryTargetProblem({ runtimeRepo: "acme/widget", remoteUrls: [ORIGIN, UPSTREAM] }), null);
  assert.equal(repositoryTargetProblem({ ghRepo: "acme/widget", remoteUrls: [ORIGIN, UPSTREAM] }), null);
  assert.deepEqual(remoteRepositorySlugs([UPSTREAM, ORIGIN, ORIGIN]), ["acme/widget", "other/fork"]);
});

test("the ambiguous-remote verdict names the remotes and both remedies", () => {
  assert.equal(classify(new Error(AMBIGUOUS_REMOTE_ERROR_TEXT)), "ambiguous-remote");
  assert.match(VERDICT_REMEDY["ambiguous-remote"], /gh repo set-default/);
  for (const interactive of [true, false]) {
    const lines = ambiguousRemoteLines(["acme/widget", "other/fork"], { interactive });
    const text = lines.join("\n");
    assert.match(lines[0], /several GitHub repositories/i);
    assert.match(text, /acme\/widget/);
    assert.match(text, /other\/fork/);
    assert.match(text, /gh repo set-default/);
    assert.match(text, /gh-glance --repo owner\/name/);
    // There is nothing for Enter to start here.
    assert.doesNotMatch(text, /Enter/);
  }
  assert.ok(ambiguousRemoteLines(["acme/widget", "other/fork"], { interactive: false })
    .some((line) => line.includes("Ctrl+C")));
  assert.deepEqual(activeKeyHints({ interactive: true, remoteSetup: "ambiguous-remote" }), AMBIGUOUS_REMOTE_HINTS);
  assert.ok(AMBIGUOUS_REMOTE_HINTS.every((hint) => hint.keys !== "Ent"));
  const [page] = contextHelpPages({ view: { title: "x", action: "y", sourceCheck: "", notes: [], explanation: "" },
    target: { label: "Repository unresolved", repository: null, host: "github.com" }, tab: "actions",
    remoteSetup: "ambiguous-remote" });
  assert.ok(page.some((line) => /gh repo set-default/.test(line)), page.join("\n"));
  assert.ok(page.every((line) => !/gh repo create/.test(line)), page.join("\n"));
});

test("git remotes are read with their gh defaults from a real checkout", async (t) => {
  const plain = checkout(t, { remotes: { origin: ORIGIN, upstream: UPSTREAM } });
  assert.deepEqual((await readGitRemotes({ cwd: plain })).map(({ name, resolved }) => [name, resolved]),
    [["origin", null], ["upstream", null]]);
  assert.deepEqual([...await gitRemoteUrls({ cwd: plain })].sort(), [ORIGIN, UPSTREAM]);

  const chosen = checkout(t, { remotes: { origin: ORIGIN, upstream: UPSTREAM }, resolved: { origin: "base" } });
  assert.deepEqual(await gitRemoteUrls({ cwd: chosen }), [ORIGIN]);

  const outside = mkdtempSync(join(tmpdir(), "gh-glance-target-none-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  assert.deepEqual(await gitRemoteUrls({ cwd: outside }), []);
});

async function doctor(cwd) {
  const root = mkdtempSync(join(tmpdir(), "gh-glance-target-doctor-"));
  try {
    const { stdout } = await execFileAsync(process.execPath, [ENTRY, "--doctor"], {
      cwd,
      env: {
        ...(process.env.NODE_V8_COVERAGE ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE } : {}),
        PATH: `${FIXTURE_BIN}:${dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: root,
        GH_CONFIG_DIR: root,
        XDG_CONFIG_HOME: root,
        GH_GLANCE_FIXTURE_LOG: "/dev/null",
      },
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("--doctor names an ambiguous target and lists every remote", async (t) => {
  const out = await doctor(checkout(t, { remotes: { origin: ORIGIN, upstream: UPSTREAM } }));
  assert.match(out, /^slug {14}\(ambiguous: acme\/widget, other\/fork; run gh repo set-default or pass --repo\)$/m);
  assert.match(out, /^git remote {8}origin https:\/\/github\.com\/acme\/widget\.git$/m);
  assert.match(out, /^git remote {8}upstream https:\/\/github\.com\/other\/fork\.git$/m);
  assert.doesNotMatch(out, /inferred from the working directory/);
});

test("--doctor reports the repository the gh default selects", async (t) => {
  const out = await doctor(checkout(t, {
    remotes: { origin: ORIGIN, upstream: UPSTREAM }, resolved: { origin: "base" },
  }));
  assert.match(out, /^source {12}git remote \(gh default: origin\)$/m);
  assert.match(out, /^slug {14}acme\/widget$/m);
  assert.match(out, /^git remote {8}origin https:\/\/github\.com\/acme\/widget\.git \(gh default\)$/m);
});

test("--doctor reports a single inferred remote by name", async (t) => {
  const out = await doctor(checkout(t, { remotes: { origin: ORIGIN } }));
  assert.match(out, /^source {12}git remote$/m);
  assert.match(out, /^slug {14}acme\/widget$/m);
});
