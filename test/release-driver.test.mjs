// R01/R09/R11 for the release driver. Decisions run against a simulated
// GitHub/npm/git world (the boundaries this project does not own) with crash
// injection after every external side effect; the real git adapter runs
// against a local bare remote.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  STAGES, acquireLock, correctionDecision, newReceipt, ownedPath, prepare, readReceipt, realWorld, reconcileReceipt,
  renderReport, replaceReportBlock, resumeRelease, saveReceipt, simulatedWorld, summarizeChecks, validateAuthority,
} from "../scripts/release.mjs";

const VERSION = "9.9.9";
const CANDIDATE = { commit: "c".repeat(40), tree: "t".repeat(40) };
const MERGE = "m".repeat(40);
const FULL = { version: VERSION, candidate: CANDIDATE.commit, reference: "owner message 2026-10-02 'release 9.9.9 to npm'",
  integration: true, publication: true, correctiveAllowance: 1 };
const SCRIPT = new URL("../scripts/release.mjs", import.meta.url).pathname;
const options = { timeout: 20_000 };

function world(overrides = {}) {
  return {
    branches: { develop: "o".repeat(40), main: "a".repeat(40) },
    ancestry: { [CANDIDATE.commit]: ["o".repeat(40)] },
    trees: { [MERGE]: CANDIDATE.tree },
    mergeCommit: MERGE,
    requiredContexts: ["Lint", "Release candidate"],
    checks: [{ name: "Lint", bucket: "pass" }, { name: "Release candidate", bucket: "pass" }],
    registryAfterPublish: { state: "present", integrity: "sha512-x", latest: VERSION },
    paths: ["/tmp/owned-install"],
    ownedPaths: ["/tmp/owned-install"],
    localFacts: { dirty: [], packageVersion: VERSION, lockVersion: VERSION, changelogHasVersion: true,
      mainIsAncestor: true, developIsAncestor: true, notesPresent: true,
      tools: { "gh auth": { ok: true, detail: "" } }, ...CANDIDATE },
    ...overrides,
  };
}

async function drive(sim, authority = FULL, receipt = null) {
  const current = receipt ?? { ...newReceipt({ version: VERSION, candidate: CANDIDATE, authority, now: "t0" }),
    ownedPaths: ["/tmp/owned-install"] };
  const result = await resumeRelease({ world: sim, receipt: current, authority, save: () => {},
    now: () => 0, sleep: async () => {}, pollMs: 0, waits: { checks: 0, publish: 0, delivery: 0 } });
  return { receipt: result };
}

test("DRV-01 full authority runs the whole ordinary sequence once without asking again", options, async () => {
  const sim = simulatedWorld(world());
  const { receipt } = await drive(sim);
  assert.equal(receipt.stage, "complete", receipt.blocker);
  assert.deepEqual(sim.calls.mutations, ["push", "pull-request", "merge", "tag", "release", "cleanup"]);
  assert.equal(sim.state.branches.develop, CANDIDATE.commit, "the candidate commit itself is pushed");
  assert.equal(receipt.observed.mergeCommit, MERGE);
  assert.match(renderReport(receipt), /Stage \| complete/);
});

test("DRV-19 report cells escape backslashes before table pipes", () => {
  const receipt = { ...newReceipt({ version: VERSION, candidate: CANDIDATE, authority: FULL, now: "t0" }),
    blocker: "path C:\\x | y" };
  assert.match(renderReport(receipt), /\| Blocker \| path C:\\\\x \\\| y \|/);
});

test("DRV-02 without publication authority nothing reaches main; without integration nothing moves", options, async () => {
  const sim = simulatedWorld(world());
  const { receipt } = await drive(sim, { ...FULL, publication: false });
  assert.equal(receipt.stage, "merge");
  assert.equal(receipt.blocker, "publication to npm was not authorized; stopped before the merge, tag and release");
  assert.deepEqual(sim.calls.mutations, ["push", "pull-request"]);
  const none = simulatedWorld(world());
  const blocked = await drive(none, { ...FULL, integration: false, publication: false });
  assert.match(blocked.receipt.blocker, /push is not covered/);
  assert.deepEqual(none.calls.mutations, [], "no authority, no mutation");
  assert.deepEqual(validateAuthority(FULL, VERSION, CANDIDATE.commit), []);
  assert.match(validateAuthority({ ...FULL, candidate: undefined }, VERSION, CANDIDATE.commit).join("\n"), /must name the reviewed candidate/);
  assert.match(validateAuthority(FULL, VERSION, "d".repeat(40)).join("\n"), /covers candidate c+, but HEAD is d+/);
});

test("DRV-03 a crash after any side effect resumes by readback and never repeats it", options, async () => {
  for (const crashed of ["push", "pull-request", "merge", "tag", "release", "cleanup"]) {
    const sim = simulatedWorld(world({ crashAfter: [crashed] }));
    const first = await drive(sim);
    assert.ok(first.receipt.blocker, `${crashed}: the crash must surface`);
    assert.equal(first.receipt.intents.at(-1).stage, crashed);
    const second = await drive(sim, FULL, first.receipt);
    assert.equal(second.receipt.stage, "complete", `${crashed}: ${second.receipt.blocker}`);
    for (const name of ["push", "pull-request", "merge", "tag", "release"]) {
      assert.equal(sim.calls.mutations.filter((item) => item === name).length, 1, `${crashed}: ${name} repeated`);
    }
  }
});

test("DRV-04 an action whose readback never shows it is not repeated", options, async () => {
  const sim = simulatedWorld(world({ noEffect: ["push"] }));
  const { receipt } = await drive(sim);
  assert.equal(receipt.stage, "push");
  assert.match(receipt.blocker, /push: the action reported success but readback does not show it/);
  assert.deepEqual(sim.calls.mutations, ["push"]);
});

test("DRV-05 failed, cancelled, skipped or missing checks block without reruns; duplicates merge", options, async () => {
  const failed = simulatedWorld(world({ checks: [{ name: "Lint", bucket: "fail" }, { name: "Release candidate", bucket: "pass" }] }));
  const blocked = await drive(failed);
  assert.equal(blocked.receipt.stage, "checks");
  assert.equal(blocked.receipt.blockerKind, "checks");
  assert.match(blocked.receipt.blocker, /Lint \(fail\).*no hosted rerun/);
  const skipped = simulatedWorld(world({ checks: [{ name: "Lint", bucket: "skipping" }, { name: "Release candidate", bucket: "pass" }] }));
  assert.match((await drive(skipped)).receipt.blocker, /Lint \(skipping\)/);
  const missing = simulatedWorld(world({ checks: [{ name: "Lint", bucket: "pass" }] }));
  assert.match((await drive(missing)).receipt.blocker, /waiting for Release candidate after 0 min; resume later/);
  assert.ok(!failed.calls.mutations.includes("merge"));
  // A superseded cancelled run next to a passing re-run of the same name passes.
  assert.deepEqual(summarizeChecks([{ name: "PTY", bucket: "cancel" }, { name: "PTY", bucket: "pass" }]),
    [{ name: "PTY", bucket: "pass" }]);
  assert.deepEqual(summarizeChecks([{ name: "PTY", bucket: "pass" }, { name: "PTY", bucket: "fail" }]),
    [{ name: "PTY", bucket: "fail" }]);
  // CodeQL's push run passed while its PR run is still running: still pending.
  assert.deepEqual(summarizeChecks([{ name: "analyze", bucket: "pass" }, { name: "analyze", bucket: "pending" }]),
    [{ name: "analyze", bucket: "pending" }]);
});

test("DRV-06 identity mismatches block before the irreversible step and are never overwritten", options, async () => {
  const moved = simulatedWorld(world());
  moved.state.pr = { number: 200, merged: false, headSha: "e".repeat(40) };
  moved.state.branches.develop = CANDIDATE.commit;
  const movedResult = await drive(moved);
  assert.match(movedResult.receipt.blocker, /release PR #200 head e+ is not the candidate/);
  assert.ok(!moved.calls.mutations.includes("merge"));
  // The head moves after the PR stage, while the checks run: no merge.
  const late = simulatedWorld(world({ moveHeadDuringChecks: "f".repeat(40) }));
  const lateResult = await drive(late);
  assert.equal(lateResult.receipt.stage, "merge");
  assert.match(lateResult.receipt.blocker, /release PR head moved to f+; the approved candidate is c+/);
  assert.ok(!late.calls.mutations.includes("merge"));
  const movedTag = simulatedWorld(world());
  movedTag.state.tags = { "v9.9.9": "z".repeat(40) };
  assert.match((await drive(movedTag)).receipt.blocker, /already points at z+.*never moved/);
  const wrongTree = simulatedWorld(world({ trees: { [MERGE]: "q".repeat(40) } }));
  assert.match((await drive(wrongTree)).receipt.blocker, /not the tested candidate tree/);
  const diverged = simulatedWorld(world({ ancestry: {} }));
  assert.match((await drive(diverged)).receipt.blocker, /not an ancestor of the candidate/);
});

test("DRV-07 publication and delivery are separate outcomes; nothing is republished", options, async () => {
  const failedPublish = simulatedWorld(world({ publishConclusion: "failure" }));
  const failed = await drive(failedPublish);
  assert.equal(failed.receipt.stage, "publish");
  assert.match(failed.receipt.blocker, /publication unknown or refused: .*publish job failure; read its log and the registry/);
  // The publish job succeeded but the Delivery job failed (lag, provenance,
  // install): published, delivery unverified, even with the version visible.
  const slowDelivery = simulatedWorld(world({ deliveryFails: true }));
  const lagging = await drive(slowDelivery);
  assert.equal(lagging.receipt.stage, "delivery", "a successful publish job advances to delivery");
  assert.match(lagging.receipt.blocker, /published; delivery unverified: the Delivery job is failure/);
  // A later read-only delivery receipt completes it only if it matches this
  // release: merge commit, passed provenance, and the integrity served now.
  const good = { version: VERSION, delivered: true, provenanceOk: true, productionCommit: MERGE, integrity: "sha512-x" };
  for (const bad of [{ productionCommit: "z".repeat(40) }, { provenanceOk: false }, { integrity: "sha512-y" }, { version: "9.9.8" }]) {
    lagging.receipt.observed.localDelivery = { ...good, ...bad };
    const refused = await drive(slowDelivery, FULL, structuredClone(lagging.receipt));
    assert.equal(refused.receipt.stage, "delivery", JSON.stringify(bad));
  }
  lagging.receipt.observed.localDelivery = good;
  const later = await drive(slowDelivery, FULL, lagging.receipt);
  assert.equal(later.receipt.stage, "complete", later.receipt.blocker);
  assert.equal(slowDelivery.calls.mutations.filter((item) => item === "release").length, 1);
  const running = simulatedWorld(world());
  const pending = await drive(running);
  assert.equal(pending.receipt.stage, "complete");
  running.state.releaseRun.jobs.find((job) => job.name === "Delivery").conclusion = "in_progress";
  const stillRunning = await drive(running, FULL, { ...pending.receipt, stage: "delivery" });
  assert.match(stillRunning.receipt.blocker, /published; delivery unverified: Delivery job is in_progress; resume read-only later/);
});

test("DRV-08 tool failure is a reported restriction; cleanup removes only owned paths", options, async () => {
  const denied = simulatedWorld(world({ failOn: ["release"] }));
  const result = await drive(denied);
  assert.match(result.receipt.blocker, /release: tool reported "simulated release failure"; read back external state before any retry/);
  const unowned = simulatedWorld(world({ ownedPaths: [] }));
  const cleanup = await drive(unowned);
  assert.equal(cleanup.receipt.stage, "cleanup");
  assert.match(cleanup.receipt.blocker, /refusing to remove \/tmp\/owned-install: ownership not proven/);
  assert.ok(unowned.state.paths.includes("/tmp/owned-install"));
});

test("DRV-09 one correction after failed checks, reviewed, tests only; then exhausted", () => {
  const failedGate = { stage: "checks", blockerKind: "checks", correctionsUsed: 0 };
  const review = "independent review 2026-10-02 + local gate";
  assert.equal(correctionDecision({ receipt: failedGate, authority: FULL, changedPaths: ["test/pty/keys.test.mjs"], review }).ok, true);
  assert.match(correctionDecision({ receipt: failedGate, authority: FULL, changedPaths: ["test/x.test.mjs"] }).reason, /--correction-review/);
  assert.match(correctionDecision({ receipt: { ...failedGate, correctionsUsed: 1 }, authority: FULL,
    changedPaths: ["test/x.test.mjs"], review }).reason, /exhausted/);
  assert.match(correctionDecision({ receipt: failedGate, authority: { ...FULL, correctiveAllowance: 0 },
    changedPaths: ["test/x.test.mjs"], review }).reason, /granted no corrective allowance/);
  for (const path of ["index.mjs", "package-lock.json", ".github/workflows/ci.yml", "scripts/release-candidate.mjs",
    "scripts/package-check.mjs", ".npmrc", "npm-shrinkwrap.json", "README.md"]) {
    assert.match(correctionDecision({ receipt: failedGate, authority: FULL, changedPaths: [path], review }).reason,
      /more than tests and fixtures/, path);
  }
  assert.match(correctionDecision({ receipt: { ...failedGate, blockerKind: "timeout" }, authority: FULL,
    changedPaths: [], review }).reason, /only a failed check gate/);
});

test("DRV-10 receipts are atomic, versioned and keep history; the lock is never stolen", options, (t) => {
  const root = mkdtempSync(join(tmpdir(), "gh-glance-driver-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "receipt.json");
  assert.deepEqual(readReceipt(path), { state: "absent" });
  saveReceipt(path, newReceipt({ version: VERSION, candidate: CANDIDATE, authority: FULL, now: "t0" }));
  assert.equal(readReceipt(path, VERSION).receipt.stage, "push");
  assert.match(readReceipt(path, "1.0.0").reason, /belongs to 9\.9\.9/);
  writeFileSync(path, "{ torn");
  assert.match(readReceipt(path).reason, /corrupt/);
  writeFileSync(path, JSON.stringify({ schema: 99, stage: "push" }));
  assert.match(readReceipt(path).reason, /unknown receipt schema/);

  const lockPath = join(root, "lock");
  const first = acquireLock(lockPath, { pid: 4242, start: "a", isAlive: () => true });
  assert.equal(first.ok, true);
  assert.match(acquireLock(lockPath, { pid: 5151, start: "b", isAlive: () => true }).reason, /already running as pid 4242/);
  const reclaimed = acquireLock(lockPath, { pid: 5151, start: "b", isAlive: () => false });
  assert.equal(reclaimed.ok, true, "a dead owner's lock is reclaimed");
  assert.equal(JSON.parse(readFileSync(lockPath, "utf8")).pid, 5151);
  reclaimed.release();
});

test("DRV-11 history keeps every blocker after it is resolved", options, async () => {
  const sim = simulatedWorld(world({ checks: [{ name: "Lint", bucket: "fail" }] }));
  const first = await drive(sim);
  sim.state.checks = [{ name: "Lint", bucket: "pass" }, { name: "Release candidate", bucket: "pass" }];
  const second = await drive(sim, FULL, first.receipt);
  assert.equal(second.receipt.stage, "complete");
  assert.equal(second.receipt.blocker, null);
  assert.equal(second.receipt.history.length, 1);
  assert.match(renderReport(second.receipt), /Blockers so far[\s\S]*checks \(checks\): required checks failed: Lint \(fail\)/);
});

test("DRV-12 preflight names every local, registry and tool blocker before any remote action", options, async () => {
  const facts = world().localFacts;
  assert.deepEqual((await prepare({ world: simulatedWorld(world()), version: VERSION, local: facts })).problems, []);
  const dirty = await prepare({ world: simulatedWorld(world({ registry: { state: "present" }, tags: { "v9.9.9": MERGE } })),
    version: VERSION, local: { ...facts, dirty: ["index.mjs"], lockVersion: "9.9.8", changelogHasVersion: false,
      mainIsAncestor: false, developIsAncestor: false, notesPresent: false,
      tools: { "gh auth": { ok: false, detail: "You are not logged into any GitHub hosts" } } } });
  const text = dirty.problems.join("\n");
  for (const pattern of [/working tree has changes: index\.mjs/, /package-lock\.json is 9\.9\.8/, /no ## \[9\.9\.9\] section/,
    /origin\/main is not an ancestor/, /origin\/develop is not an ancestor/, /already on the registry/, /v9\.9\.9 already exists/,
    /gh auth is not ready: You are not logged/, /notes-v9\.9\.9\.md are missing/]) {
    assert.match(text, pattern);
  }
});

test("DRV-13 the tracked report keeps history and replaces only the driver's block", () => {
  const history = "# v9.9.9 release\n\nOlder notes stay.\n";
  const first = replaceReportBlock(history, "## Current status: v9.9.9\nStage | push");
  assert.match(first, /^# v9\.9\.9 release\n\n<!-- release-driver:current-status:start -->\n## Current status/);
  const second = replaceReportBlock(first, "## Current status: v9.9.9\nStage | complete");
  assert.equal((second.match(/release-driver:current-status:start/g) ?? []).length, 1);
  assert.match(second, /Stage \| complete/);
  assert.doesNotMatch(second, /Stage \| push/);
  assert.match(second, /Older notes stay\./);
});

// The real git adapter against a local bare origin: push of the candidate
// commit (not local develop), tag creation, reuse after an interrupted push,
// refusal of a mismatched local tag, peeled remote tags and merge trees.
test("DRV-14 the real git adapter pushes the candidate, tags once and peels tags", options, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gh-glance-driver-git-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env }).trim();
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  mkdirSync(work);
  git(work, "init", "-q", "-b", "develop");
  git(work, "remote", "add", "origin", origin);
  writeFileSync(join(work, "a.txt"), "1\n");
  git(work, "add", ".");
  git(work, "commit", "-qm", "one");
  git(work, "push", "-q", "origin", "develop", "develop:main");
  writeFileSync(join(work, "a.txt"), "2\n");
  git(work, "commit", "-qam", "candidate");
  const candidate = git(work, "rev-parse", "HEAD");
  writeFileSync(join(work, "a.txt"), "3\n");
  git(work, "commit", "-qam", "unreviewed local work");

  const real = realWorld({ root: work });
  await real.git.pushCommit(candidate, "develop");
  assert.equal(await real.git.remoteHead("develop"), candidate, "only the candidate is pushed, not later local commits");
  assert.equal(await real.git.isAncestor(candidate, "HEAD"), true);
  assert.equal(await real.git.treeOf(candidate), git(work, "rev-parse", `${candidate}^{tree}`));

  // An interrupted earlier run left the local tag; it is reused and pushed.
  git(work, "tag", "-a", "v9.9.9", candidate, "-m", "v9.9.9");
  await real.git.pushTag("v9.9.9", candidate);
  assert.equal(await real.git.remoteTag("v9.9.9"), candidate, "the annotated tag peels to its commit");
  // A local tag naming anything else is never moved.
  git(work, "tag", "-a", "v9.9.8", "HEAD", "-m", "v9.9.8");
  await assert.rejects(real.git.pushTag("v9.9.8", candidate), /never moved/);
  assert.equal(await real.git.remoteTag("v9.9.8"), null);
});

test("DRV-15 owned paths need the release marker and are never the checkout or its parents", (t) => {
  const root = mkdtempSync(join(tmpdir(), "gh-glance-owned-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const checkout = join(root, "checkout");
  const install = join(root, "install");
  mkdirSync(checkout);
  mkdirSync(install);
  assert.equal(ownedPath(install, VERSION, checkout), false, "no marker");
  writeFileSync(join(install, ".gh-glance-release-owned"), "v9.9.8\n");
  assert.equal(ownedPath(install, VERSION, checkout), false, "marker for another release");
  writeFileSync(join(install, ".gh-glance-release-owned"), "v9.9.9\n");
  assert.equal(ownedPath(install, VERSION, checkout), true);
  writeFileSync(join(root, ".gh-glance-release-owned"), "v9.9.9\n");
  assert.equal(ownedPath(root, VERSION, checkout), false, "an ancestor of the checkout is never owned");
  writeFileSync(join(checkout, ".gh-glance-release-owned"), "v9.9.9\n");
  assert.equal(ownedPath(checkout, VERSION, checkout), false, "the checkout itself is never owned");
});

test("DRV-16 the CLI dry run traces a release with zero external effects and refuses a bare --dry-run", options, (t) => {
  const root = mkdtempSync(join(tmpdir(), "gh-glance-driver-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = join(root, "world.json");
  writeFileSync(fixture, JSON.stringify(world()));
  const authority = join(root, "authority.json");
  writeFileSync(authority, JSON.stringify(FULL));
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  assert.equal(run("prepare", VERSION, "--dry-run", fixture).status, 0);
  const resumed = run("resume", VERSION, "--authority", authority, "--dry-run", fixture);
  assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
  // A fresh CLI receipt owns no paths yet, so cleanup has nothing to remove.
  assert.match(resumed.stdout, /simulated mutations: push, pull-request, merge, tag, release\n/);
  assert.match(run("resume", VERSION, "--dry-run", fixture).stdout, /no action taken: no authority record/);
  // A flag with no fixture must never fall through to the real world.
  for (const args of [["prepare", VERSION, "--dry-run"], ["resume", VERSION, "--authority", authority, "--dry-run"],
    ["resume", VERSION, "--dry-run", "--authority", authority], ["prepare", VERSION, "--bogus"],
    ["prepare", VERSION, "--dry-run", join(root, "missing.json")]]) {
    const refused = run(...args);
    assert.equal(refused.status, 2, args.join(" "));
    assert.equal(refused.stdout, "");
  }
  assert.equal(STAGES.at(-1), "cleanup");
});

// N2: a granted correction keeps the owner's approval as given. The authority
// file still names the approved candidate; the corrected commit, the review
// and the failed gate are recorded in the receipt.
test("DRV-17 a correction through the CLI keeps the approved authority and records the replacement", options, (t) => {
  const root = mkdtempSync(join(tmpdir(), "gh-glance-driver-correction-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, GH_GLANCE_RELEASE_STATE_DIR: join(root, "state") };
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env });
  const authority = join(root, "authority.json");
  writeFileSync(authority, JSON.stringify(FULL));
  const first = join(root, "first.json");
  writeFileSync(first, JSON.stringify(world({ checks: [{ name: "Lint", bucket: "fail" }] })));
  const blocked = run("resume", VERSION, "--authority", authority, "--dry-run", first);
  assert.equal(blocked.status, 1);
  assert.match(blocked.stdout, /Stage \| checks/);

  const corrected = { commit: "d".repeat(40), tree: "u".repeat(40) };
  const second = join(root, "second.json");
  const fixture = world({ ancestry: { [corrected.commit]: ["o".repeat(40)] }, trees: { [MERGE]: corrected.tree },
    correctionPaths: ["test/pty/keys.test.mjs"] });
  fixture.localFacts = { ...fixture.localFacts, ...corrected };
  writeFileSync(second, JSON.stringify(fixture));
  const unreviewed = run("resume", VERSION, "--authority", authority, "--dry-run", second);
  assert.match(unreviewed.stdout, /no action taken: .*--correction-review/);
  const done = run("resume", VERSION, "--authority", authority, "--dry-run", second, "--correction-review", "review note 7, local gate green");
  assert.equal(done.status, 0, done.stdout + done.stderr);
  assert.match(done.stdout, /Stage \| complete/);
  assert.match(done.stdout, /Approved candidate \| c{40}/);
  assert.match(done.stdout, /Candidate \| d{40}/);
  const receipt = JSON.parse(readFileSync(join(root, "state", "receipt.json"), "utf8"));
  assert.equal(receipt.authority.candidate, CANDIDATE.commit, "the recorded authority is never rewritten");
  assert.equal(receipt.correctionsUsed, 1);
  assert.deepEqual(receipt.history.map((item) => item.kind), ["checks", "correction"]);
  // The allowance is spent: another moved candidate is refused.
  const third = join(root, "third.json");
  const again = world();
  again.localFacts = { ...again.localFacts, commit: "e".repeat(40), tree: "v".repeat(40) };
  writeFileSync(third, JSON.stringify({ ...again, correctionPaths: ["test/x.test.mjs"] }));
  assert.match(run("resume", VERSION, "--authority", authority, "--dry-run", third, "--correction-review", "review note 8, gate").stdout,
    /no action taken: the candidate moved/);
});

test("DRV-18 receipt reconciliation is a pure decision: authority, correction, delivery receipt, owned paths, gates", () => {
  const local = world().localFacts;
  const base = () => newReceipt({ version: VERSION, candidate: CANDIDATE, authority: FULL, now: "t0" });
  assert.deepEqual(reconcileReceipt({ receipt: base(), local, authority: FULL, version: VERSION, changedPaths: [], now: "t1" }), { ok: true });
  assert.match(reconcileReceipt({ receipt: base(), local, authority: null, version: VERSION, changedPaths: [], now: "t1" }).reason,
    /no authority record/);
  assert.match(reconcileReceipt({ receipt: base(), local: { ...local, dirty: ["x"] }, authority: FULL, version: VERSION,
    changedPaths: [], now: "t1" }).reason, /working tree has changes/);
  const later = { ...FULL, reference: "owner follow-up 2026-10-03 granting publication" };
  const updated = base();
  assert.equal(reconcileReceipt({ receipt: updated, local, authority: later, version: VERSION, changedPaths: [],
    deliveryReceipt: { version: VERSION, delivered: true, provenance: { ok: true }, productionCommit: MERGE, integrity: "sha512-x" },
    own: ["/tmp/owned-install"], now: "t2" }).ok, true);
  assert.equal(updated.authority.reference, FULL.reference, "the first recorded authority is kept");
  assert.deepEqual(updated.authorityUpdates.map((item) => item.authority.reference), [later.reference]);
  assert.deepEqual(updated.observed.localDelivery, { version: VERSION, delivered: true, provenanceOk: true,
    productionCommit: MERGE, integrity: "sha512-x" });
  assert.deepEqual(updated.ownedPaths, ["/tmp/owned-install"]);
  const failed = { ...base(), stage: "checks", blockerKind: "checks" };
  const moved = { ...local, commit: "d".repeat(40), tree: "u".repeat(40) };
  assert.equal(reconcileReceipt({ receipt: failed, local: moved, authority: FULL, version: VERSION,
    changedPaths: ["test/x.test.mjs"], review: "review note 9, gate green", now: "t3" }).ok, true);
  assert.equal(failed.candidate.commit, "d".repeat(40));
  assert.equal(failed.stage, "push");
  assert.equal(failed.authority.candidate, CANDIDATE.commit);
});
