import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { integrityOf } from "../scripts/package-check.mjs";
import {
  CANDIDATE_JOBS, CI_JOBS, bootstrapDecision, CI_WORKFLOW, MANIFEST_SCHEMA, aggregate, artifactName, checkCandidateJobs, classifyRegistry,
  deliveryCheck, planCi, pollRegistry, publishDecision, selectCandidate, terminalRunners, validateManifest,
  REPOSITORY, verifyArtifact, verifyPromotion, verifyProvenance,
} from "../scripts/release-candidate.mjs";
import { packageTarball } from "./fixtures/tarball.mjs";

const REPO = REPOSITORY;
const sha = (seed) => createHash("sha1").update(String(seed)).digest("hex");
const HEAD = sha("head");
const BASE = sha("base");
const TREE = sha("tree");
const MERGE = sha("merge");

const releasePr = (paths) => planCi({ event: "pull_request", repository: REPO, baseRef: "main",
  headRef: "develop", headRepository: REPO, changedPaths: paths });

test("RC-01 CI roles: one candidate selection, quick develop pushes, identity-only main", () => {
  const broad = releasePr(["index.mjs"]);
  assert.equal(broad.role, "candidate");
  assert.equal(broad.profile, "broad");
  for (const job of ["pack", "sustained", "pty-governor", "pty-rest", "terminal-smoke", "test", "smoke"]) {
    assert.ok(broad.jobs.includes(job), job);
  }
  assert.deepEqual(terminalRunners(broad), ["ubuntu-latest", "macos-latest"]);

  // While main requires the legacy contexts, a docs release PR still runs real
  // work behind Test, Smoke and PTY; it only skips the full suites.
  const docs = releasePr(["docs/release/notes.md"]);
  assert.deepEqual(docs.jobs.filter((job) => !["pty", "candidate"].includes(job)).sort(),
    ["lint", "pack", "smoke", "terminal-smoke", "test"]);

  const develop = planCi({ event: "push", repository: REPO, baseRef: "develop" });
  assert.equal(develop.role, "integration");
  assert.ok(!develop.jobs.some((job) => ["pack", "sustained", "pty-governor", "pty-rest", "pty"].includes(job)));
  assert.deepEqual(terminalRunners(develop), ["ubuntu-latest"]);
  const covered = planCi({ event: "push", repository: REPO, baseRef: "develop", releasePrOpen: true });
  assert.equal(covered.role, "covered");
  assert.deepEqual(covered.jobs, ["candidate"], "the open release PR's run already covers this head");

  const main = planCi({ event: "push", repository: REPO, baseRef: "main" });
  assert.deepEqual(main.jobs.sort(), ["candidate", "promotion"]);

  const fork = planCi({ event: "pull_request", repository: REPO, baseRef: "main", headRef: "develop",
    headRepository: "someone/gh-glance", changedPaths: ["README.md"] });
  assert.equal(fork.role, "rejected");
  assert.ok(!fork.jobs.includes("pack"), "a foreign PR never packs a publishable candidate");

  const feature = planCi({ event: "pull_request", repository: REPO, baseRef: "develop", headRef: "x",
    headRepository: REPO, changedPaths: null });
  assert.equal(feature.role, "pull-request");
  assert.equal(feature.profile, "broad", "missing diff base selects broad");
  assert.ok(!feature.jobs.includes("pack"));
});

function needsFor(plan, overrides = {}) {
  const needs = { plan: { result: "success", outputs: {} } };
  for (const job of CI_JOBS.filter((id) => id !== "candidate")) {
    needs[job] = { result: plan.jobs.includes(job) ? "success" : "skipped", outputs: {} };
  }
  needs.pack.outputs = { "tarball-sha256": "a".repeat(64), "artifact-id": "123" };
  return { ...needs, ...overrides };
}

test("RC-02 the aggregate rejects skipped, missing, failed or unexpected work", () => {
  const plan = releasePr(["index.mjs"]);
  assert.deepEqual(aggregate({ plan, needs: needsFor(plan) }), { ok: true, problems: [] });
  const cases = [
    [{ sustained: { result: "skipped" } }, /sustained: selected but skipped/],
    [{ "pty-governor": undefined }, /pty-governor: selected but missing/],
    [{ "pty-rest": { result: "cancelled" } }, /pty-rest: selected but cancelled/],
    [{ promotion: { result: "success" } }, /promotion: not selected but success/],
    [{ plan: { result: "failure" } }, /plan: failure/],
    [{ pack: { result: "success", outputs: {} } }, /no tarball digest output/],
  ];
  for (const [override, pattern] of cases) {
    const result = aggregate({ plan, needs: needsFor(plan, override) });
    assert.equal(result.ok, false);
    assert.match(result.problems.join("\n"), pattern);
  }
  assert.equal(aggregate({ plan: null, needs: {} }).ok, false);
  const fork = planCi({ event: "pull_request", repository: REPO, baseRef: "main", headRef: "feature",
    headRepository: REPO, changedPaths: ["README.md"] });
  assert.match(aggregate({ plan: fork, needs: needsFor(fork) }).problems.join("\n"), /only release pull requests/);
  // The PTY context checks only the terminal jobs this run selected.
  const only = ["terminal-smoke", "pty-governor", "pty-rest"];
  assert.equal(aggregate({ plan, needs: needsFor(plan, { lint: { result: "failure" } }), only }).ok, true);
  assert.match(aggregate({ plan, needs: needsFor(plan, { "pty-rest": { result: "failure" } }), only }).problems.join("\n"),
    /pty-rest: selected but failure/);
});

function manifestFor(bytes, overrides = {}) {
  const { sha256, sha512 } = integrityOf(bytes);
  return {
    schema: MANIFEST_SCHEMA,
    repository: { id: 1, fullName: REPO },
    pullRequest: { number: 147, head: HEAD, base: BASE },
    checkout: { commit: MERGE, tree: TREE },
    workflow: { path: CI_WORKFLOW, ref: `${REPO}/${CI_WORKFLOW}@refs/pull/147/merge`, runId: 900, runAttempt: 1, event: "pull_request" },
    profile: "broad",
    selections: ["lint", "syntax", "package", "fast", "pty:smoke", "recovery", "efficiency", "pty"],
    package: { name: "gh-glance", version: "9.9.9", files: ["CHANGELOG.md", "LICENSE", "README.md", "index.mjs", "package.json"] },
    runtime: { node: "v22.22.2", npm: "11.21.0", platform: "linux-x64" },
    inputs: { lockSha256: "b".repeat(64), workflowSha256: "c".repeat(64) },
    tarball: { filename: "artifact.tgz", sha256, integrity: sha512 },
    ...overrides,
  };
}

test("RC-03 the manifest schema is strict and carries no self-reported outcome", () => {
  const bytes = packageTarball({ version: "9.9.9" });
  assert.deepEqual(validateManifest(manifestFor(bytes)), []);
  assert.match(validateManifest({ ...manifestFor(bytes), success: true }).join("\n"), /success is not allowed/);
  assert.match(validateManifest({ ...manifestFor(bytes), artifactId: 5 }).join("\n"), /artifactId is not allowed/);
  assert.match(validateManifest(manifestFor(bytes, { schema: 2 })).join("\n"), /unknown manifest schema 2/);
  assert.match(validateManifest(manifestFor(bytes, { checkout: { commit: "abc", tree: TREE } })).join("\n"),
    /checkout\.commit is not a valid sha/);
  assert.match(validateManifest(null).join("\n"), /must be an object/);
});

const pull = { number: 147, head: HEAD, headRef: "develop", headRepository: REPO, base: "main",
  mergedAt: "2026-10-02T00:00:00Z", mergeCommit: MERGE };

function run(id, overrides = {}) {
  return { id, run_attempt: 1, path: CI_WORKFLOW, event: "pull_request", status: "completed", conclusion: "success",
    head_sha: HEAD, head_branch: "develop", repository: { full_name: REPO }, head_repository: { full_name: REPO },
    // After the PR merges GitHub reports pull_requests: [] (real run 36996522942).
    pull_requests: [], ...overrides };
}
function artifact(id, runId, overrides = {}) {
  return { id, name: artifactName(TREE), expired: false, expires_at: "2099-01-01T00:00:00Z",
    digest: `sha256:${"d".repeat(64)}`, workflow_run: { id: runId }, ...overrides };
}

test("RC-04 candidate selection binds repository, workflow, event, head, tree and expiry", () => {
  const good = selectCandidate({ runs: [run(1)], artifactsByRun: { 1: [artifact(11, 1)] }, pullRequest: pull, productionTree: TREE });
  assert.equal(good.ok, true);
  assert.equal(good.artifact.id, 11);
  const newest = selectCandidate({ runs: [run(1), run(2)], artifactsByRun: { 1: [artifact(11, 1)], 2: [artifact(22, 2)] },
    pullRequest: pull, productionTree: TREE });
  assert.equal(newest.run.id, 2);
  // Every eligible run is offered newest first; the PR number is bound by the
  // manifest of whichever one verifies, so a same-tree run of another PR fails
  // closed in verifyArtifact instead of being trusted here.
  assert.deepEqual(newest.candidates.map((item) => item.run.id), [2, 1]);
  const cases = [
    [[run(1, { event: "push" })], { 1: [artifact(11, 1)] }, /event push/],
    [[run(1, { head_repository: { full_name: "fork/gh-glance" } })], { 1: [artifact(11, 1)] }, /foreign repository/],
    [[run(1, { conclusion: "failure" })], { 1: [artifact(11, 1)] }, /completed\/failure/],
    [[run(1, { head_sha: sha("other") })], { 1: [artifact(11, 1)] }, /head /],
    [[run(1, { path: ".github/workflows/other.yml" })], { 1: [artifact(11, 1)] }, /workflow/],
    [[run(1)], { 1: [artifact(11, 1, { expired: true })] }, /artifact expired/],
    [[run(1)], { 1: [artifact(11, 1, { expires_at: "2000-01-01T00:00:00Z" })] }, /artifact expired/],
    [[run(1)], { 1: [artifact(11, 1), artifact(12, 1)] }, /2 artifacts/],
    [[run(1)], { 1: [artifact(11, 2)] }, /another run/],
    [[run(1)], { 1: [artifact(11, 1, { name: artifactName(sha("changed-tree")) })] }, /0 artifacts for the production tree/],
    [[run(1)], { 1: [artifact(11, 1, { digest: null })] }, /no server digest/],
    [[], {}, /no eligible candidate run/],
  ];
  for (const [runs, artifactsByRun, pattern] of cases) {
    const result = selectCandidate({ runs, artifactsByRun, pullRequest: pull, productionTree: TREE });
    assert.equal(result.ok, false);
    assert.match(result.problems.join("\n"), pattern);
  }
});

test("RC-05 artifact verification fails closed on every identity mismatch", () => {
  const bytes = packageTarball({ version: "9.9.9" });
  const manifest = manifestFor(bytes);
  const base = { archiveSha256: "d".repeat(64), artifact: artifact(11, 900), manifest, tarballBytes: bytes,
    productionTree: TREE, pullRequest: pull, run: run(900) };
  assert.deepEqual(verifyArtifact(base).problems, []);
  const tampered = Buffer.from(bytes);
  tampered[tampered.length - 30] ^= 1;
  const cases = [
    [{ archiveSha256: "e".repeat(64) }, /archive digest/],
    [{ tarballBytes: packageTarball({ version: "9.9.9", files: { "package/README.md": "changed" } }) }, /sha256 differs/],
    [{ tarballBytes: tampered }, /unreadable|differs/],
    [{ productionTree: sha("other-tree") }, /tested tree differs/],
    [{ run: run(900, { run_attempt: 2 }) }, /another run or attempt/],
    [{ pullRequest: { ...pull, number: 148 } }, /another pull request/],
    [{ manifest: { ...manifest, success: true } }, /success is not allowed/],
    [{ manifest: { ...manifest, selections: ["lint"] } }, /lacks required selection fast/],
    [{ tarballBytes: packageTarball({ version: "9.9.9", files: { "package/../evil.mjs": "x" } }),
      manifest: manifestFor(packageTarball({ version: "9.9.9", files: { "package/../evil.mjs": "x" } })) }, /unsafe path/],
  ];
  for (const [override, pattern] of cases) {
    const result = verifyArtifact({ ...base, ...override });
    assert.equal(result.ok, false, String(pattern));
    assert.match(result.problems.join("\n"), pattern);
  }
});

// Real Git: the tested PR merge tree equals the production merge tree even
// though the two merge commits differ; any later input change breaks it.
test("RC-06 promotion compares real merge trees, not commit identities", (t) => {
  const root = mkdtempSync(join(tmpdir(), "gh-glance-promotion-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
  git("init", "-q", "-b", "main");
  writeFileSync(join(root, "index.mjs"), "1\n");
  git("add", "."); git("commit", "-qm", "base");
  git("checkout", "-qb", "develop");
  writeFileSync(join(root, "index.mjs"), "2\n");
  git("commit", "-qam", "change");
  git("checkout", "-q", "main");
  git("merge", "-q", "--no-ff", "-m", "pr merge ref", "develop");
  const testedTree = git("rev-parse", "HEAD^{tree}");
  const testedCommit = git("rev-parse", "HEAD");
  git("reset", "-q", "--hard", "HEAD~1");
  git("merge", "-q", "--no-ff", "-m", "production merge", "develop");
  const productionCommit = git("rev-parse", "HEAD");
  const productionTree = git("rev-parse", "HEAD^{tree}");
  assert.notEqual(productionCommit, testedCommit);
  assert.equal(productionTree, testedTree);

  const pr = { ...pull, mergeCommit: productionCommit };
  assert.equal(verifyPromotion({ pullRequest: pr, mergeCommit: productionCommit, productionTree }).ok, true);
  const bytes = packageTarball({ version: "9.9.9" });
  const verified = verifyArtifact({ archiveSha256: "d".repeat(64), artifact: artifact(11, 900),
    manifest: manifestFor(bytes, { checkout: { commit: testedCommit, tree: testedTree } }), tarballBytes: bytes,
    productionTree, pullRequest: pr, run: run(900) });
  assert.equal(verified.ok, true, verified.problems.join("\n"));

  // A test-only file changed after the candidate froze: new tree, no match.
  writeFileSync(join(root, "test.mjs"), "late\n");
  git("add", "."); git("commit", "-qm", "late test change");
  const changedTree = git("rev-parse", "HEAD^{tree}");
  assert.notEqual(changedTree, testedTree);
  assert.match(verifyArtifact({ archiveSha256: "d".repeat(64), artifact: artifact(11, 900),
    manifest: manifestFor(bytes, { checkout: { commit: testedCommit, tree: testedTree } }), tarballBytes: bytes,
    productionTree: changedTree, pullRequest: pr, run: run(900) }).problems.join("\n"), /tested tree differs/);

  const tagged = (tag, version, changelog) => verifyPromotion({ pullRequest: pr, mergeCommit: productionCommit,
    productionTree, tag, version, changelog });
  assert.equal(tagged({ name: "v9.9.9", commit: productionCommit }, "9.9.9", "## [9.9.9] - 2026-10-02\n").ok, true);
  assert.match(tagged({ name: "v9.9.9", commit: testedCommit }, "9.9.9", "## [9.9.9]\n").problems.join("\n"), /tag v9\.9\.9 points at/);
  assert.match(tagged({ name: "v9.9.8", commit: productionCommit }, "9.9.9", "## [9.9.9]\n").problems.join("\n"), /does not name version/);
  assert.match(tagged({ name: "v9.9.9", commit: productionCommit }, "9.9.9", "## [9.9.8]\n").problems.join("\n"), /no 9\.9\.9 section/);
  assert.match(verifyPromotion({ pullRequest: { ...pr, headRef: "feature" }, mergeCommit: productionCommit, productionTree })
    .problems.join("\n"), /not this repository's develop/);
  assert.match(verifyPromotion({ pullRequest: null, mergeCommit: productionCommit, productionTree }).problems.join("\n"),
    /no merged pull request/);
  assert.match(tagged({ name: "v1", commit: productionCommit }, "1.0.0|.*", "").problems.join("\n"), /invalid version/);
});

test("RC-07 registry outcomes: only proven absence publishes, exact bytes resume, the rest block", () => {
  const integrity = "sha512-x";
  const body = (dist, latest = "1.0.0") => ({ versions: { "1.2.0": { dist } }, "dist-tags": { latest } });
  assert.deepEqual(publishDecision(classifyRegistry({ status: 404, version: "1.2.0", integrity }), "1.2.0").action, "publish");
  assert.equal(publishDecision(classifyRegistry({ status: 200, body: { versions: {}, "dist-tags": { latest: "1.1.0" } },
    version: "1.2.0", integrity }), "1.2.0").action, "publish");
  assert.equal(publishDecision(classifyRegistry({ status: 200, body: body({ integrity }), version: "1.2.0", integrity }), "1.2.0").action, "verify");
  const collision = publishDecision(classifyRegistry({ status: 200, body: body({ integrity: "sha512-y" }), version: "1.2.0", integrity }), "1.2.0");
  assert.equal(collision.action, "block");
  assert.match(collision.reason, /sha512-y/);
  for (const status of [401, 403, 500, null]) {
    const unknown = publishDecision(classifyRegistry({ status, body: null, version: "1.2.0", integrity }), "1.2.0");
    assert.equal(unknown.action, "block", `status ${status} must not look like absence`);
    assert.match(unknown.reason, /unknown/);
  }
  const regression = publishDecision(classifyRegistry({ status: 200, body: { versions: {}, "dist-tags": { latest: "1.10.0" } },
    version: "1.9.0", integrity }), "1.9.0");
  assert.match(regression.reason, /dist-tag regression/);
});

function fakeClock() {
  let now = 0;
  const sleeps = [];
  return { now: () => now, sleep: async (ms) => { sleeps.push(ms); now += ms; }, sleeps };
}

test("RC-08 delivery readback is bounded, honors Retry-After and recovers read-only", async () => {
  const integrity = "sha512-good";
  const ready = { status: 200, body: { versions: { "1.2.0": { dist: { integrity,
    attestations: { url: "https://registry.npmjs.org/-/npm/v1/attestations/gh-glance@1.2.0" } } } },
  "dist-tags": { latest: "1.2.0" } } };
  const check = deliveryCheck({ version: "1.2.0", integrity });

  const lagging = [{ status: 404 }, { status: 429, retryAfterMs: 20_000 }, null, ready];
  let clock = fakeClock();
  let calls = 0;
  const recovered = await pollRegistry({ read: async () => {
    const next = lagging[calls++];
    if (next === null) throw new Error("ECONNRESET");
    return next;
  }, check, now: clock.now, sleep: clock.sleep });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.gitHead, null, "a tarball publish has no gitHead; it is recorded, not required");
  assert.match(recovered.attestationsUrl, /attestations\/gh-glance@1\.2\.0$/);
  assert.equal(calls, 4);
  assert.ok(clock.sleeps[1] >= 20_000, `Retry-After ignored: ${clock.sleeps}`);
  assert.ok(clock.sleeps.every((ms) => ms <= 30_000));

  clock = fakeClock();
  const unverified = await pollRegistry({ read: async () => ({ status: 404 }), check, now: clock.now, sleep: clock.sleep });
  assert.equal(unverified.ok, false);
  assert.match(unverified.reason, /published; delivery unverified/);
  assert.ok(clock.now() <= 300_000);

  clock = fakeClock();
  const wrong = await pollRegistry({ read: async () => ({ status: 200, body: { versions: { "1.2.0": { dist: { integrity: "sha512-bad" } } } } }),
    check, now: clock.now, sleep: clock.sleep });
  assert.match(wrong.reason, /not the verified artifact's/);
  assert.equal(clock.sleeps.length, 0, "a byte mismatch is final, not lag");

  assert.match(check({ status: 200, body: { versions: { "1.2.0": { dist: { integrity } } },
    "dist-tags": { latest: "1.2.0" } } }).reason, /provenance/);
  assert.match(check({ ...ready, body: { ...ready.body, "dist-tags": { latest: "1.1.0" } } }).reason, /latest is 1\.1\.0/);
});

test("RC-09 the candidate run's own job results must all have succeeded", () => {
  const jobs = CANDIDATE_JOBS.map((name) => ({ name, conclusion: "success" }));
  assert.deepEqual(checkCandidateJobs([...jobs, { name: "Recovery", conclusion: "success" }]).problems, []);
  assert.match(checkCandidateJobs(jobs.filter((job) => job.name !== "Release candidate")).problems.join("\n"),
    /job Release candidate: missing/);
  assert.match(checkCandidateJobs(jobs.map((job) => job.name === "Test (Node 24)" ? { ...job, conclusion: "skipped" } : job))
    .problems.join("\n"), /Test \(Node 24\): skipped/);
  assert.match(checkCandidateJobs([...jobs, { name: "Efficiency", conclusion: "failure" }]).problems.join("\n"),
    /Efficiency: failure/);
});

// The statement shape npm attaches (SLSA provenance v1), built locally.
function attestation({ version = "1.2.0", sha512Hex, repository = "https://github.com/juan294/gh-glance",
  path = ".github/workflows/release.yml", ref = `refs/tags/v${version}`, commit = MERGE } = {}) {
  const statement = { subject: [{ name: `pkg:npm/gh-glance@${version}`, digest: { sha512: sha512Hex } }],
    predicate: { buildDefinition: { externalParameters: { workflow: { ref, repository, path } },
      resolvedDependencies: [{ uri: `git+${repository}@${ref}`, digest: { gitCommit: commit } }] } } };
  return { attestations: [
    { predicateType: "https://github.com/npm/attestation/tree/main/specs/publish/v0.1",
      bundle: { dsseEnvelope: { payload: Buffer.from(JSON.stringify({ subject: statement.subject })).toString("base64") } } },
    { predicateType: "https://slsa.dev/provenance/v1",
      bundle: { dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement)).toString("base64") } } },
  ] };
}

test("RC-10 provenance must bind these bytes, this workflow at this tag, and the production commit", () => {
  const bytes = packageTarball({ version: "1.2.0" });
  const { sha512 } = integrityOf(bytes);
  const hex = Buffer.from(sha512.slice(7), "base64").toString("hex");
  const expected = { version: "1.2.0", integrity: sha512, commit: MERGE };
  assert.deepEqual(verifyProvenance(attestation({ sha512Hex: hex }), expected).problems, []);
  const cases = [
    [{ sha512Hex: "00".repeat(64) }, /subject digest/],
    [{ sha512Hex: hex, repository: "https://github.com/someone/gh-glance" }, /provenance repository/],
    [{ sha512Hex: hex, path: ".github/workflows/other.yml" }, /provenance workflow/],
    [{ sha512Hex: hex, ref: "refs/heads/develop" }, /provenance ref/],
    [{ sha512Hex: hex, commit: sha("elsewhere") }, /provenance commit/],
    [{ sha512Hex: hex, version: "1.1.9" }, /subject is not pkg:npm\/gh-glance@1\.2\.0/],
  ];
  for (const [shape, pattern] of cases) {
    assert.match(verifyProvenance(attestation(shape), expected).problems.join("\n"), pattern);
  }
  assert.match(verifyProvenance({ attestations: [] }, expected).problems.join("\n"), /no single SLSA provenance/);
});

test("RC-11 the publisher bootstrap accepts only the tag of a protected release merge", () => {
  const pull = (overrides = {}) => ({ merged_at: "2026-10-02T00:00:00Z", merge_commit_sha: MERGE,
    base: { ref: "main" }, head: { ref: "develop", repo: { full_name: REPO } }, ...overrides });
  const good = { tagCommit: MERGE, commit: MERGE, compareStatus: "identical", pulls: [pull()] };
  assert.deepEqual(bootstrapDecision(good).problems, []);
  assert.equal(bootstrapDecision({ ...good, compareStatus: "ahead" }).ok, true, "main moved on after the release");
  const cases = [
    [{ tagCommit: HEAD }, /tag points at/],
    [{ compareStatus: "diverged" }, /not on main/],
    // A develop commit is an ancestor of main but no release merge.
    [{ pulls: [] }, /merge commit of 0/],
    [{ pulls: [pull({ head: { ref: "feature", repo: { full_name: REPO } } })] }, /merge commit of 0/],
    [{ pulls: [pull({ head: { ref: "develop", repo: { full_name: "fork/gh-glance" } } })] }, /merge commit of 0/],
    [{ pulls: [pull({ merged_at: null })] }, /merge commit of 0/],
    [{ pulls: [pull(), pull()] }, /merge commit of 2/],
  ];
  for (const [override, pattern] of cases) {
    assert.match(bootstrapDecision({ ...good, ...override }).problems.join("\n"), pattern);
  }
});
