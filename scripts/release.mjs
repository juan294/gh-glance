#!/usr/bin/env node
// gh-glance release driver: one command that shows the actual release stage
// and carries an owner's existing authority through the ordinary sequence in
// docs/release/release-playbook.md. It never creates authority.
//
//   node scripts/release.mjs prepare <version>          read-only preflight
//   node scripts/release.mjs status  <version> [--report <file>]
//   node scripts/release.mjs resume  <version> --authority <file> [--own <path>]...
//                                   [--correction-review <reference>]
//   node scripts/release.mjs protection                 next protection step (read-only)
//   --dry-run <fixture.json> runs any command against a simulated world:
//   nothing external is read or changed.
//
// Every stage first reads GitHub/npm/git state. An action runs only when that
// readback shows it has not happened, at most once per stage per run, with
// its intent written to the receipt first; if the readback after an action
// still does not show it, the driver stops instead of repeating it. A crash
// between intent and readback therefore resumes by reading, never repeating.

import { spawnSync } from "node:child_process";
import {
  closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { REPOSITORY, readRegistry } from "./release-candidate.mjs";
import { AGGREGATE_CONTEXT, planProtectionStep } from "./release-policy.mjs";
import { ROOT, escapeRegExp } from "./test-select.mjs";
export const RECEIPT_SCHEMA = 2;
export const STAGES = ["push", "pull-request", "checks", "merge", "tag", "release", "publish", "delivery", "cleanup"];
// Moving main is the release: `main` tracks released state, so merging needs
// publication authority just like the tag and the GitHub release.
const PUBLICATION_STAGES = new Set(["merge", "tag", "release", "publish", "delivery"]);
const WAIT_MS = { checks: 40 * 60_000, publish: 40 * 60_000, delivery: 5 * 60_000 };
const OWNED_MARKER = ".gh-glance-release-owned";
const SHA = /^[0-9a-f]{40}$/;

// ------------------------------------------------------------- authority

// The authority record documents a decision the owner already made in the
// session (its `reference` says where) for one reviewed candidate commit. The
// driver only refuses what it does not cover; it can never widen it.
export function validateAuthority(authority, version, candidateCommit) {
  const problems = [];
  if (!authority || typeof authority !== "object") return ["no authority record"];
  if (authority.version !== version) problems.push(`authority names ${authority.version}, not ${version}`);
  if (!SHA.test(authority.candidate ?? "")) problems.push("authority must name the reviewed candidate commit");
  else if (candidateCommit && authority.candidate !== candidateCommit) {
    problems.push(`authority covers candidate ${authority.candidate}, but HEAD is ${candidateCommit}`);
  }
  if (typeof authority.reference !== "string" || authority.reference.length < 8) {
    problems.push("authority needs a reference to the owner's decision");
  }
  if (typeof authority.integration !== "boolean" || typeof authority.publication !== "boolean") {
    problems.push("authority must state integration and publication explicitly");
  }
  if (![0, 1].includes(authority.correctiveAllowance)) problems.push("corrective allowance is 0 or 1");
  return problems;
}

export function covered(authority, stage) {
  if (stage === "cleanup") return true;
  if (PUBLICATION_STAGES.has(stage)) return authority.publication === true;
  return authority.integration === true;
}

// --------------------------------------------------------------- receipt

const LIMITATIONS = ["F12 personal and work EMU qualification: OPEN"];

// `authority.candidate` is the approved candidate for the whole release; a
// granted correction replaces `candidate` but never the recorded authority.
export function newReceipt({ version, candidate, authority, now }) {
  return { schema: RECEIPT_SCHEMA, version, tag: `v${version}`, candidate,
    authority: summarizeAuthority(authority), authorityUpdates: [], stage: "push", blocker: null, blockerKind: null, next: null,
    correctionsUsed: 0, observed: {}, intents: [], history: [], timings: { started: now }, ownedPaths: [] };
}

function summarizeAuthority(authority) {
  return authority ? { reference: authority.reference, candidate: authority.candidate, integration: authority.integration,
    publication: authority.publication, correctiveAllowance: authority.correctiveAllowance } : null;
}

export function readReceipt(path, version) {
  if (!existsSync(path)) return { state: "absent" };
  try {
    const receipt = JSON.parse(readFileSync(path, "utf8"));
    if (receipt?.schema !== RECEIPT_SCHEMA || !STAGES.includes(receipt.stage) && receipt.stage !== "complete") {
      return { state: "unreadable", reason: `unknown receipt schema or stage in ${path}` };
    }
    if (version && receipt.version !== version) return { state: "unreadable", reason: `${path} belongs to ${receipt.version}` };
    return { state: "ok", receipt };
  } catch (error) {
    return { state: "unreadable", reason: `receipt ${path} is corrupt: ${error.message}` };
  }
}

function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600 });
  renameSync(temporary, path);
}

export function saveReceipt(path, receipt) {
  writeAtomic(path, `${JSON.stringify(receipt, null, 2)}\n`);
}

// Blockers are kept: the current one drives `next`, and every one ever raised
// stays in the append-only history, so a failed check stays failed in the
// record after a later correction.
function block(receipt, kind, text, now) {
  receipt.blocker = text;
  receipt.blockerKind = kind;
  receipt.history.push({ at: new Date(now).toISOString(), stage: receipt.stage, kind, text });
}

// ------------------------------------------------------------------ lock

// One driver per release state directory. A live owner is never displaced; a
// dead owner's lock (process gone, or its pid reused by another process) is
// reclaimed by renaming it aside and re-checking that it is still the same
// lock, so two reclaimers cannot both win.
export function acquireLock(path, { pid = process.pid, start = processStart(process.pid), isAlive = processAlive } = {}) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeSync(fd, JSON.stringify({ pid, start, host: hostname(), at: new Date().toISOString() }));
      closeSync(fd);
      return { ok: true, release: () => rmSync(path, { force: true }) };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let text = null;
      let owner;
      try {
        text = readFileSync(path, "utf8");
        owner = JSON.parse(text);
      } catch {
        owner = null;
      }
      if (!owner) return { ok: false, reason: `lock ${path} exists but is unreadable; inspect it before removing` };
      if (owner.host !== hostname() || !Number.isSafeInteger(owner.pid) || isAlive(owner.pid, owner.start)) {
        return { ok: false, reason: `release driver already running as pid ${owner.pid} on ${owner.host}` };
      }
      const aside = `${path}.stale.${pid}`;
      try {
        renameSync(path, aside);
      } catch {
        continue;
      }
      if (readFileSync(aside, "utf8") !== text) {
        // Put it back only if nobody created a new lock meanwhile (link never
        // replaces); otherwise leave it aside and say so.
        try {
          linkSync(aside, path);
          rmSync(aside, { force: true });
        } catch {
          return { ok: false, reason: `the release lock changed while being reclaimed; a copy was left at ${aside}` };
        }
        return { ok: false, reason: "the release lock changed while it was being reclaimed" };
      }
      rmSync(aside, { force: true });
    }
  }
  return { ok: false, reason: "could not acquire the release lock" };
}

function processStart(pid) {
  const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

function processAlive(pid, start) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code !== "EPERM") return false;
  }
  return start == null || processStart(pid) === start;
}

// --------------------------------------------------------------- stages

// Merge duplicate check runs of one name (a push and a PR run of CodeQL, a
// superseded run): any failure fails; any still-running one keeps it pending;
// otherwise any pass passes; a name whose only runs were cancelled or skipped
// produced no evidence.
export function summarizeChecks(checks) {
  const byName = new Map();
  for (const check of checks) byName.set(check.name, [...(byName.get(check.name) ?? []), check.bucket]);
  return [...byName].map(([name, buckets]) => ({ name, bucket: buckets.includes("fail") ? "fail"
    : buckets.includes("pending") ? "pending" : buckets.includes("pass") ? "pass" : buckets[0] }));
}

// Each stage: observe(world, receipt) -> { done, blocker?, kind?, wait?, observed? }
// and act(world, receipt) for the single mutation that advances it.
const STAGE_RULES = {
  push: {
    observe: async (world, receipt) => {
      const remote = await world.git.remoteHead("develop");
      if (remote === receipt.candidate.commit) return { done: true };
      if (remote && !(await world.git.isAncestor(remote, receipt.candidate.commit))) {
        return { blocker: `origin/develop ${remote} is not an ancestor of the candidate; reconcile locally first`, kind: "diverged" };
      }
      return { done: false };
    },
    // The candidate commit itself, never whatever local develop holds; no force.
    act: (world, receipt) => world.git.pushCommit(receipt.candidate.commit, "develop"),
  },
  "pull-request": {
    observe: async (world, receipt) => {
      const pr = await world.github.releasePullRequest(receipt.candidate.commit);
      if (!pr) return { done: false };
      if (pr.headSha !== receipt.candidate.commit) {
        return { blocker: `release PR #${pr.number} head ${pr.headSha} is not the candidate`, kind: "moved" };
      }
      return { done: true, observed: { pullRequest: pr.number } };
    },
    act: (world, receipt) => world.github.createReleasePullRequest({ title: `release: ${receipt.tag}` }),
  },
  checks: {
    observe: async (world, receipt) => {
      const checks = summarizeChecks(await world.github.requiredChecks(receipt.observed.pullRequest));
      const failed = checks.filter((check) => ["fail", "cancel", "skipping"].includes(check.bucket));
      if (failed.length > 0) {
        return { blocker: `required checks failed: ${failed.map((check) => `${check.name} (${check.bucket})`).join(", ")}` +
          "; diagnose from the logs and repair locally, no hosted rerun", kind: "checks" };
      }
      const required = (await world.github.protection()).checks.map((check) => check.context);
      const seen = new Set(checks.map((check) => check.name));
      const missing = required.filter((context) => !seen.has(context));
      const pending = checks.filter((check) => check.bucket === "pending");
      if (missing.length === 0 && pending.length === 0) return { done: true };
      return { wait: `waiting for ${[...pending.map((check) => check.name), ...missing].join(", ")}` };
    },
  },
  merge: {
    observe: async (world, receipt) => {
      const pr = await world.github.pullRequest(receipt.observed.pullRequest);
      if (!pr.merged) {
        if (pr.headSha !== receipt.candidate.commit) {
          return { blocker: `release PR head moved to ${pr.headSha}; the approved candidate is ${receipt.candidate.commit}`, kind: "moved" };
        }
        return { done: false };
      }
      const tree = await world.git.treeOf(pr.mergeCommit);
      if (tree !== receipt.candidate.tree) {
        return { blocker: `production merge tree ${tree} is not the tested candidate tree ${receipt.candidate.tree}`, kind: "identity" };
      }
      return { done: true, observed: { mergeCommit: pr.mergeCommit } };
    },
    // Pinned to the approved head: GitHub refuses the merge if it moved.
    act: (world, receipt) => world.github.mergePullRequest(receipt.observed.pullRequest, receipt.candidate.commit),
  },
  tag: {
    observe: async (world, receipt) => {
      const target = await world.git.remoteTag(receipt.tag);
      if (!target) return { done: false };
      if (target !== receipt.observed.mergeCommit) {
        return { blocker: `${receipt.tag} already points at ${target}, not ${receipt.observed.mergeCommit}; a tag is never moved`, kind: "identity" };
      }
      return { done: true };
    },
    act: (world, receipt) => world.git.pushTag(receipt.tag, receipt.observed.mergeCommit),
  },
  release: {
    observe: async (world, receipt) => {
      const release = await world.github.release(receipt.tag);
      if (!release) return { done: false };
      if (release.draft) return { blocker: `${receipt.tag} exists as a draft; publish it deliberately`, kind: "identity" };
      return { done: true, observed: { releaseUrl: release.url } };
    },
    act: (world, receipt) => world.github.createRelease(receipt.tag),
  },
  publish: {
    observe: async (world, receipt) => {
      const run = await world.github.releaseRun(receipt.tag);
      if (!run) return { wait: "release workflow has not started" };
      const jobs = Object.fromEntries((run.jobs ?? []).map((job) => [job.name, job.conclusion]));
      // Publication and delivery are separate outcomes: a successful publish
      // job advances even when the delivery job missed its bound.
      if (jobs["Publish to npm"] === "success") {
        return { done: true, observed: { publisherRun: run.id, deliveryJob: jobs.Delivery ?? run.status } };
      }
      if (run.status !== "completed") return { wait: `release workflow run ${run.id} is ${run.status}` };
      if (jobs["Verify candidate"] && jobs["Verify candidate"] !== "success") {
        return { blocker: `release workflow run ${run.id} refused the candidate (Verify candidate ${jobs["Verify candidate"]}); read its log`, kind: "publish" };
      }
      return { blocker: `publication unknown or refused: release workflow run ${run.id} publish job ${jobs["Publish to npm"] ?? "missing"}; ` +
        "read its log and the registry before any retry (a version collision also lands here), nothing is republished", kind: "publish" };
    },
  },
  // Delivered means the publisher's Delivery job verified integrity,
  // provenance and a fresh install on both Node versions, or (when that job
  // failed, e.g. on registry lag) a later read-only `release-candidate.mjs
  // deliver` receipt for this version supplied with --delivery-receipt.
  delivery: {
    observe: async (world, receipt) => {
      const run = await world.github.releaseRun(receipt.tag, receipt.observed.publisherRun);
      const job = (run?.jobs ?? []).find((item) => item.name === "Delivery")?.conclusion ?? "missing";
      const registry = await world.npm.view(receipt.version);
      if (job !== "success" && !localDeliveryAccepted(receipt.observed.localDelivery, receipt, registry)) {
        if (["in_progress", "queued", "waiting", "pending"].includes(job)) return { wait: `Delivery job is ${job}` };
        return { blocker: `published; delivery unverified: the Delivery job is ${job}; run ` +
          "`node scripts/release-candidate.mjs deliver` read-only and resume with --delivery-receipt", kind: "delivery" };
      }
      if (registry.state === "unknown") return { wait: `registry unavailable: ${registry.reason}` };
      if (registry.state === "absent") return { wait: "published; delivery unverified (registry lag)" };
      if (registry.latest !== receipt.version) return { wait: `latest is ${registry.latest}` };
      return { done: true, observed: { deliveryJob: job, integrity: registry.integrity, registryGitHead: registry.gitHead ?? null } };
    },
  },
  cleanup: {
    observe: async (world, receipt) => {
      const remaining = receipt.ownedPaths.filter((path) => world.fs.exists(path));
      return remaining.length === 0 ? { done: true } : { done: false };
    },
    act: (world, receipt) => {
      for (const path of receipt.ownedPaths.filter((item) => world.fs.exists(item))) {
        if (!world.fs.owned(path, receipt.version)) {
          throw Object.assign(new Error(`refusing to remove ${path}: ownership not proven`), { blocker: true, kind: "cleanup" });
        }
        world.fs.remove(path);
      }
    },
  },
};

// A read-only `release-candidate.mjs deliver` receipt stands in for a failed
// Delivery job only if it delivered this version, its provenance check
// passed for this release's merge commit, and its integrity is what the
// registry serves now.
export function localDeliveryAccepted(local, receipt, registry) {
  return local?.delivered === true && local.version === receipt.version &&
    local.provenanceOk === true && local.productionCommit === receipt.observed.mergeCommit &&
    registry?.state === "present" && local.integrity === registry.integrity;
}

export function nextAction(receipt) {
  if (receipt.stage === "complete") return "none: release complete";
  if (receipt.blocker) return `resolve: ${receipt.blocker}`;
  return `${receipt.stage}${STAGE_RULES[receipt.stage].act ? "" : " (observe)"}`;
}

function minutes(ms) {
  return `${Math.round(ms / 60_000)} min`;
}

// Drive stages in order until done, blocked, waiting past the stage's bound,
// or an action the authority does not cover.
export async function resumeRelease({ world, receipt, authority, save, now = () => Date.now(),
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)), pollMs = 30_000, waits = WAIT_MS }) {
  receipt.blocker = null;
  receipt.blockerKind = null;
  const acted = new Set();
  const stop = (kind, text) => {
    block(receipt, kind, text, now());
    receipt.next = nextAction(receipt);
    save(receipt);
    return receipt;
  };
  while (receipt.stage !== "complete") {
    const stage = receipt.stage;
    const rule = STAGE_RULES[stage];
    let state;
    const waitStarted = now();
    const bound = waits[stage] ?? 0;
    for (;;) {
      try {
        state = await rule.observe(world, receipt);
      } catch (error) {
        state = { blocker: `${stage}: readback failed (${error.message}); nothing was changed`, kind: "readback" };
      }
      if (!state.wait) break;
      const elapsed = now() - waitStarted;
      receipt.next = `${state.wait} (${minutes(elapsed)} of ${minutes(bound)})`;
      save(receipt);
      if (elapsed >= bound) {
        state = { blocker: stage === "delivery" ? `published; delivery unverified: ${state.wait}; resume read-only later`
          : `${stage}: ${state.wait} after ${minutes(bound)}; resume later`, kind: "timeout" };
        break;
      }
      await sleep(pollMs);
    }
    if (state.observed) Object.assign(receipt.observed, state.observed);
    if (state.blocker) return stop(state.kind ?? "blocked", state.blocker);
    if (state.done) {
      receipt.timings[stage] = new Date(now()).toISOString();
      receipt.stage = STAGES[STAGES.indexOf(stage) + 1] ?? "complete";
      receipt.next = nextAction(receipt);
      save(receipt);
      continue;
    }
    if (acted.has(stage)) {
      return stop("readback", `${stage}: the action reported success but readback does not show it; ` +
        "nothing is repeated, inspect GitHub and git");
    }
    if (!covered(authority, stage)) {
      return stop("authority", PUBLICATION_STAGES.has(stage)
        ? "publication to npm was not authorized; stopped before the merge, tag and release"
        : `${stage} is not covered by the recorded authority`);
    }
    receipt.intents.push({ stage, at: new Date(now()).toISOString(), outcome: null });
    acted.add(stage);
    save(receipt);
    try {
      await rule.act(world, receipt);
      receipt.intents.at(-1).outcome = "performed";
    } catch (error) {
      receipt.intents.at(-1).outcome = `error: ${error.message}`;
      return stop(error.kind ?? "tool", error.blocker ? error.message
        : `${stage}: tool reported "${error.message}"; read back external state before any retry`);
    }
    save(receipt);
    // Loop back to observe: the readback, not the action's exit, advances.
  }
  return receipt;
}

// A hosted candidate failure may be followed by ONE corrective candidate, and
// only when the release decision granted the allowance, the previous candidate
// failed its required checks, the repair was independently reviewed, and it
// changes nothing outside the test tree (playbook Authority: no packaged,
// dependency, workflow, release-control or script change).
const CORRECTABLE = /^test\//;

export function correctionDecision({ receipt, authority, changedPaths, review }) {
  if (receipt.stage !== "checks" || receipt.blockerKind !== "checks") {
    return { ok: false, reason: `the candidate moved during ${receipt.stage}; only a failed check gate can be corrected` };
  }
  if (receipt.correctionsUsed >= authority.correctiveAllowance) {
    return { ok: false, reason: authority.correctiveAllowance === 0
      ? "this release's decision granted no corrective allowance"
      : "the corrective allowance is exhausted" };
  }
  if (typeof review !== "string" || review.length < 8) {
    return { ok: false, reason: "a correction needs --correction-review naming its independent review and local gate" };
  }
  const outside = changedPaths.filter((path) => !CORRECTABLE.test(path));
  if (outside.length > 0) return { ok: false, reason: `the correction changes more than tests and fixtures: ${outside.join(", ")}` };
  return { ok: true };
}

// Bring a stored (or new) receipt up to date with this invocation: authority,
// a possible granted correction, a supplied delivery receipt and owned paths.
// Returns the reason when nothing may be done.
export function reconcileReceipt({ receipt, local, authority, version, changedPaths, review, deliveryReceipt, own = [], now }) {
  const problems = validateAuthority(authority, version, receipt.authority?.candidate ?? local.commit);
  if (problems.length > 0) return { ok: false, reason: problems.join("; ") };
  if (!receipt.authority) receipt.authority = summarizeAuthority(authority);
  if (receipt.candidate.commit !== local.commit) {
    const correction = correctionDecision({ receipt, authority, changedPaths, review });
    if (!correction.ok) {
      return { ok: false, reason: `the candidate moved from ${receipt.candidate.commit} to ${local.commit}; ${correction.reason}` };
    }
    receipt.correctionsUsed += 1;
    receipt.history.push({ at: now, stage: receipt.stage, kind: "correction",
      text: `candidate ${receipt.candidate.commit} replaced by ${local.commit} (${review})` });
    receipt.candidate = { commit: local.commit, tree: local.tree };
    receipt.stage = "push";
  }
  const summary = summarizeAuthority(authority);
  if (JSON.stringify(summary) !== JSON.stringify(receipt.authorityUpdates.at(-1)?.authority ?? receipt.authority)) {
    receipt.authorityUpdates.push({ at: now, authority: summary });
  }
  if (deliveryReceipt) {
    receipt.observed.localDelivery = { version: deliveryReceipt.version, delivered: deliveryReceipt.delivered === true,
      provenanceOk: deliveryReceipt.provenance?.ok === true, productionCommit: deliveryReceipt.productionCommit ?? null,
      integrity: deliveryReceipt.integrity ?? null };
  }
  for (const path of own) if (!receipt.ownedPaths.includes(resolve(path))) receipt.ownedPaths.push(resolve(path));
  if (receipt.stage === "push") {
    const gates = localProblems(local, version);
    if (gates.length > 0) return { ok: false, reason: gates.join("; ") };
  }
  return { ok: true };
}

// --------------------------------------------------------------- report

export function renderReport(receipt) {
  const rows = [
    ["Stage", receipt.stage],
    ["Blocker", receipt.blocker ?? "none"],
    ["Next action", receipt.next ?? nextAction(receipt)],
    ["Candidate", `${receipt.candidate.commit} (tree ${receipt.candidate.tree})`],
    ["Release PR", receipt.observed.pullRequest ? `#${receipt.observed.pullRequest}` : "not yet"],
    ["Production merge", receipt.observed.mergeCommit ?? "not yet"],
    ["Publisher run", receipt.observed.publisherRun ?? "not yet"],
    ["Delivery job", receipt.observed.deliveryJob ?? "not yet"],
    ["Registry integrity", receipt.observed.integrity ?? "not yet verified"],
    ["Approved candidate", receipt.authority?.candidate ?? "none recorded"],
    ["Authority", receipt.authority ? `${receipt.authority.reference} (publication ${receipt.authority.publication ? "covered" : "NOT covered"}, corrections ${receipt.correctionsUsed}/${receipt.authority.correctiveAllowance})` : "none recorded"],
    ["Later authority records", receipt.authorityUpdates.length > 0 ? receipt.authorityUpdates.map((item) => `${item.at}: ${item.authority.reference}`).join("; ") : "none"],
    ["Optional observers", "Sutura and coverage are never waited for (not correlated by this driver)"],
    ["Accepted limitations", LIMITATIONS.join("; ")],
  ];
  const remaining = receipt.stage === "complete" ? [] : STAGES.slice(STAGES.indexOf(receipt.stage));
  const history = receipt.history.map((item) => `- ${item.at} ${item.stage} (${item.kind}): ${item.text}`);
  return [`## Current status: ${receipt.tag}`, "", "| Fact | Value |", "| --- | --- |",
    ...rows.map(([key, value]) => `| ${key} | ${String(value).replace(/\\/g, "\\\\").replace(/\|/g, "\\|")} |`), "",
    `Remaining stages: ${remaining.length > 0 ? remaining.join(" -> ") : "none"}.`, "",
    ...(history.length > 0 ? ["Blockers so far (kept after they are resolved):", "", ...history, ""] : [])].join("\n");
}

// The tracked release report keeps its history; only the block between the
// markers is the driver's, replaced in place (or added at the top).
const REPORT_START = "<!-- release-driver:current-status:start -->";
const REPORT_END = "<!-- release-driver:current-status:end -->";

export function replaceReportBlock(text, block_) {
  const wrapped = `${REPORT_START}\n${block_.trimEnd()}\n${REPORT_END}`;
  const start = text.indexOf(REPORT_START);
  const end = text.indexOf(REPORT_END);
  if (start !== -1 && end > start) return `${text.slice(0, start)}${wrapped}${text.slice(end + REPORT_END.length)}`;
  const firstBreak = text.indexOf("\n\n");
  return firstBreak === -1 ? `${text}\n\n${wrapped}\n` : `${text.slice(0, firstBreak)}\n\n${wrapped}${text.slice(firstBreak)}`;
}

function writeReportBlock(path, block_) {
  const text = existsSync(path) ? readFileSync(path, "utf8") : `# ${basename(path, ".md")}\n`;
  writeAtomic(path, replaceReportBlock(text, block_));
}

// ------------------------------------------------------------ real world

// Owned paths carry a marker naming the release and are never the checkout
// itself or one of its ancestors. A git worktree is removed through git.
export function ownedPath(path, version, root = ROOT) {
  const target = resolve(path);
  const checkout = resolve(root);
  if (target === checkout || `${checkout}${sep}`.startsWith(`${target}${sep}`)) return false;
  const marker = join(target, OWNED_MARKER);
  return existsSync(marker) && readFileSync(marker, "utf8").trim() === `v${version}`;
}

export function realWorld({ repository = REPOSITORY, root = ROOT } = {}) {
  const run = (command, args) => {
    const result = spawnSync(command, args, { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    if (result.error) throw result.error;
    return result;
  };
  const must = (command, args) => {
    const result = run(command, args);
    if (result.status !== 0) throw new Error(`${command} ${args[0]} failed: ${(result.stderr || result.stdout).trim().slice(-300)}`);
    return result.stdout.trim();
  };
  const api = (path) => JSON.parse(must("gh", ["api", path]));
  return {
    run,
    must,
    git: {
      remoteHead: async (branch) => must("git", ["ls-remote", "origin", `refs/heads/${branch}`]).split(/\s/)[0] || null,
      isAncestor: async (a, b) => run("git", ["merge-base", "--is-ancestor", a, b]).status === 0,
      treeOf: async (commit) => {
        const known = run("git", ["rev-parse", "--verify", "--quiet", `${commit}^{tree}`]);
        if (known.status === 0) return known.stdout.trim();
        must("git", ["fetch", "--quiet", "origin", "main"]);
        return must("git", ["rev-parse", `${commit}^{tree}`]);
      },
      remoteTag: async (tag) => {
        const lines = must("git", ["ls-remote", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`]).split("\n").filter(Boolean);
        const peeled = lines.find((line) => line.endsWith("^{}")) ?? lines[0];
        return peeled ? peeled.split(/\s/)[0] : null;
      },
      pushCommit: async (commit, branch) => must("git", ["push", "origin", `${commit}:refs/heads/${branch}`]),
      // A local tag left by an interrupted run is reused only if it already
      // names the merge commit; anything else blocks.
      pushTag: async (tag, commit) => {
        const local = run("git", ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`]);
        if (local.status === 0 && local.stdout.trim() !== commit) {
          throw Object.assign(new Error(`a local ${tag} names ${local.stdout.trim()}, not ${commit}; it is never moved`),
            { blocker: true, kind: "identity" });
        }
        if (local.status !== 0) must("git", ["tag", "-a", tag, commit, "-m", tag]);
        must("git", ["push", "origin", `refs/tags/${tag}`]);
      },
    },
    github: {
      // The open release PR, or (after a crash between merge and readback)
      // the merged one for this candidate; earlier releases' merged PRs share
      // the same head branch and are ignored.
      releasePullRequest: async (candidateCommit) => {
        const pulls = JSON.parse(must("gh", ["pr", "list", "--base", "main", "--head", "develop", "--state", "all",
          "--limit", "20", "--json", "number,headRefOid,state"]));
        const pr = pulls.find((item) => item.state === "OPEN") ??
          pulls.find((item) => item.state === "MERGED" && item.headRefOid === candidateCommit);
        return pr ? { number: pr.number, headSha: pr.headRefOid } : null;
      },
      createReleasePullRequest: async ({ title }) => must("gh", ["pr", "create", "--base", "main", "--head", "develop",
        "--title", title, "--body", "Release candidate. See docs/release/release-playbook.md."]),
      // `gh pr checks` exits 8 while checks are pending; any other failure
      // without JSON is a readback failure, never "no checks".
      requiredChecks: async (number) => {
        const result = run("gh", ["pr", "checks", String(number), "--required", "--json", "name,bucket"]);
        if (result.status !== 0 && !result.stdout.trim() && /no required checks reported/i.test(result.stderr)) return [];
        try {
          return JSON.parse(result.stdout);
        } catch {
          throw new Error(`gh pr checks failed (${result.status}): ${result.stderr.trim().slice(-200)}`);
        }
      },
      pullRequest: async (number) => {
        const pr = JSON.parse(must("gh", ["pr", "view", String(number), "--json", "state,mergeCommit,headRefOid"]));
        return { merged: pr.state === "MERGED", mergeCommit: pr.mergeCommit?.oid ?? null, headSha: pr.headRefOid };
      },
      mergePullRequest: async (number, headCommit) => must("gh", ["pr", "merge", String(number), "--merge",
        "--match-head-commit", headCommit]),
      release: async (tag) => {
        const result = run("gh", ["release", "view", tag, "--json", "url,isDraft"]);
        if (result.status !== 0) {
          if (/release not found/i.test(result.stderr)) return null;
          throw new Error(`gh release view failed (${result.status}): ${result.stderr.trim().slice(-200)}`);
        }
        const release = JSON.parse(result.stdout);
        return { url: release.url, draft: release.isDraft };
      },
      createRelease: async (tag) => {
        const notes = join(root, "docs/release", `notes-${tag}.md`);
        if (!existsSync(notes)) {
          throw Object.assign(new Error(`release notes ${relative(root, notes)} are missing`), { blocker: true, kind: "notes" });
        }
        must("gh", ["release", "create", tag, "--verify-tag", "--title", tag, "--notes-file", notes]);
      },
      // By run id once known; otherwise find the release-event run named for
      // the tag. One `gh run view` per poll after that.
      releaseRun: async (tag, knownId = null) => {
        let id = knownId;
        if (!id) {
          const [runInfo] = JSON.parse(must("gh", ["run", "list", "--workflow", "release.yml", "--event", "release",
            "--limit", "10", "--json", "databaseId,displayTitle"])).filter((item) => item.displayTitle === tag);
          if (!runInfo) return null;
          id = runInfo.databaseId;
        }
        const view = JSON.parse(must("gh", ["run", "view", String(id), "--json", "status,jobs"]));
        return { id, status: view.status, jobs: view.jobs.map((job) => ({ name: job.name, conclusion: job.conclusion || job.status })) };
      },
      // Observed means: a successful `Release candidate` check run from GitHub
      // Actions on the open release PR's head, from a same-repository develop run.
      aggregateObserved: async (headSha) => {
        if (!headSha) return false;
        const runs = api(`repos/${repository}/commits/${headSha}/check-runs?check_name=${encodeURIComponent(AGGREGATE_CONTEXT)}&status=completed`).check_runs;
        return runs.some((item) => item.conclusion === "success" && item.app?.id === 15368 &&
          item.check_suite?.head_branch === "develop");
      },
      // Read once per process: required contexts do not change mid-wait, and
      // the merge itself is still gated by GitHub's own protection.
      protection: (() => {
        let cached = null;
        return async () => (cached ??= api(`repos/${repository}/branches/main/protection/required_status_checks`));
      })(),
    },
    npm: {
      view: async (version) => {
        let registry;
        try {
          registry = await readRegistry();
        } catch (error) {
          return { state: "unknown", reason: error.message };
        }
        if (registry.status === 404) return { state: "absent" };
        if (registry.status !== 200) return { state: "unknown", reason: `registry answered ${registry.status}` };
        const published = registry.body.versions?.[version];
        if (!published) return { state: "absent" };
        return { state: "present", integrity: published.dist?.integrity, gitHead: published.gitHead ?? null,
          latest: registry.body["dist-tags"]?.latest };
      },
    },
    fs: {
      exists: (path) => existsSync(path),
      owned: (path, version) => ownedPath(path, version, root),
      remove: (path) => {
        if (existsSync(join(path, ".git")) && statSync(join(path, ".git")).isFile()) must("git", ["worktree", "remove", path]);
        else rmSync(path, { recursive: true, force: true });
      },
    },
  };
}

// ----------------------------------------------------------- dry-run world

// A simulated world from a fixture. Every "mutation" changes only the
// in-memory fixture and is counted.
export function simulatedWorld(fixture) {
  const state = structuredClone(fixture);
  const calls = { reads: 0, mutations: [] };
  const read = (value) => { calls.reads += 1; return value; };
  const prHead = () => state.pr?.headSha ?? state.branches.develop;
  const mutate = (name, apply) => {
    if ((state.failOn ?? []).includes(name)) throw new Error(`simulated ${name} failure`);
    // A runaway loop of mutations is a driver defect; fail it loudly.
    if (calls.mutations.length >= 50) throw new Error("simulated world: runaway mutations");
    calls.mutations.push(name);
    if (!(state.noEffect ?? []).includes(name)) apply();
    if ((state.crashAfter ?? []).includes(name)) {
      state.crashAfter = state.crashAfter.filter((item) => item !== name);
      throw new Error(`simulated crash after ${name}`);
    }
  };
  return {
    state, calls,
    git: {
      remoteHead: async (branch) => read(state.branches?.[branch] ?? null),
      isAncestor: async (a, b) => read(a === b || (state.ancestry?.[b] ?? []).includes(a)),
      treeOf: async (commit) => read(state.trees?.[commit] ?? null),
      remoteTag: async (tag) => read(state.tags?.[tag] ?? null),
      pushCommit: async (commit, branch) => mutate("push", () => { state.branches[branch] = commit; }),
      pushTag: async (tag, commit) => mutate("tag", () => { state.tags = { ...state.tags, [tag]: commit }; }),
    },
    github: {
      releasePullRequest: async () => read(state.pr ? { number: state.pr.number, headSha: prHead() } : null),
      createReleasePullRequest: async () => mutate("pull-request", () => { state.pr = { number: 200, merged: false }; }),
      requiredChecks: async () => {
        // A concurrent push to develop while the checks run.
        if (state.moveHeadDuringChecks) state.pr.headSha = state.moveHeadDuringChecks;
        return read(state.checks ?? []);
      },
      pullRequest: async () => read({ merged: Boolean(state.pr?.merged), mergeCommit: state.pr?.mergeCommit ?? null,
        headSha: prHead() }),
      mergePullRequest: async (_number, head) => mutate("merge", () => {
        if (head !== prHead()) throw new Error("head moved");
        state.pr.merged = true;
        state.pr.mergeCommit = state.mergeCommit;
        state.branches.main = state.mergeCommit;
      }),
      release: async (tag) => read(state.releases?.[tag] ?? null),
      createRelease: async (tag) => mutate("release", () => {
        state.releases = { ...state.releases, [tag]: { url: `https://example.invalid/${tag}`, draft: false } };
        const publish = state.publishConclusion ?? "success";
        state.releaseRun = { id: 1, status: "completed", jobs: [{ name: "Verify candidate", conclusion: "success" }, { name: "Publish to npm", conclusion: publish },
            { name: "Delivery", conclusion: state.deliveryFails ? "failure" : "success" }] };
        if (publish === "success") state.registry = state.registryAfterPublish;
      }),
      releaseRun: async () => read(state.releaseRun ?? null),
      aggregateObserved: async () => read(Boolean(state.aggregateObserved)),
      protection: async () => read(state.protection ?? { strict: true,
        checks: (state.requiredContexts ?? []).map((context) => ({ context, app_id: 15368 })) }),
    },
    npm: { view: async () => read(state.registry ?? { state: "absent" }) },
    fs: {
      exists: (path) => (state.paths ?? []).includes(path),
      owned: (path) => (state.ownedPaths ?? []).includes(path),
      remove: (path) => mutate("cleanup", () => { state.paths = state.paths.filter((item) => item !== path); }),
    },
  };
}

// ------------------------------------------------------------------- CLI

// Local gates that must hold before the first mutation (and in prepare).
export function localProblems(local, version) {
  const problems = [];
  if (local.dirty.length > 0) problems.push(`working tree has changes: ${local.dirty.join(", ")}`);
  if (local.packageVersion !== version) problems.push(`package.json is ${local.packageVersion}, not ${version}`);
  if (local.lockVersion !== version) problems.push(`package-lock.json is ${local.lockVersion}, not ${version}`);
  if (!local.changelogHasVersion) problems.push(`CHANGELOG.md has no ## [${version}] section`);
  if (!local.mainIsAncestor) problems.push("origin/main is not an ancestor of HEAD: merge it in locally first");
  if (!local.developIsAncestor) problems.push("origin/develop is not an ancestor of HEAD: integrate it locally first");
  if (!local.notesPresent) problems.push(`release notes docs/release/notes-v${version}.md are missing`);
  return problems;
}

export async function prepare({ world, version, local }) {
  const problems = localProblems(local, version);
  const required = await world.github.protection().then((value) => value.checks.map((check) => check.context),
    (error) => { problems.push(`cannot read protection: ${error.message}`); return []; });
  const registry = await world.npm.view(version);
  if (registry.state === "present") problems.push(`gh-glance@${version} is already on the registry`);
  if (registry.state === "unknown") problems.push(`registry state unknown: ${registry.reason}`);
  const tag = await world.git.remoteTag(`v${version}`);
  if (tag) problems.push(`v${version} already exists at ${tag}`);
  const pr = await world.github.releasePullRequest(local.commit);
  // Tool readiness before the first remote action: a missing or denied route
  // is reported now, not discovered mid-release.
  for (const [tool, ready] of Object.entries(local.tools ?? {})) {
    if (!ready.ok) problems.push(`${tool} is not ready: ${ready.detail}`);
  }
  return { ok: problems.length === 0, problems, requiredContexts: required, openReleasePr: pr,
    runtime: local.runtime ?? null };
}

// What `resume` needs from the checkout; `prepare` adds tool readiness and
// runtimes. Network reads `prepare` already makes (remote tags, the registry)
// are not repeated as probes.
function localFacts(version, world, { full = false } = {}) {
  const status = world.run("git", ["status", "--porcelain"]).stdout;
  world.run("git", ["fetch", "--quiet", "origin"]);
  const ancestor = (ref) => world.run("git", ["merge-base", "--is-ancestor", ref, "HEAD"]).status === 0;
  const readJson = (file) => JSON.parse(readFileSync(join(ROOT, file), "utf8"));
  const facts = {
    dirty: status.split("\n").filter(Boolean).map((line) => line.slice(3)),
    packageVersion: readJson("package.json").version,
    lockVersion: readJson("package-lock.json").version,
    changelogHasVersion: new RegExp(`^## \\[${escapeRegExp(version)}\\]`, "m").test(readFileSync(join(ROOT, "CHANGELOG.md"), "utf8")),
    mainIsAncestor: ancestor("origin/main"),
    developIsAncestor: ancestor("origin/develop"),
    notesPresent: existsSync(join(ROOT, "docs/release", `notes-v${version}.md`)),
    commit: world.must("git", ["rev-parse", "HEAD"]),
    tree: world.must("git", ["rev-parse", "HEAD^{tree}"]),
  };
  if (full) {
    const auth = world.run("gh", ["auth", "status"]);
    facts.tools = { "gh auth": { ok: auth.status === 0, detail: (auth.stderr || auth.stdout).trim().split("\n")[0] ?? "" } };
    facts.runtime = { node: process.version, npm: world.run("npm", ["--version"]).stdout.trim(),
      git: world.run("git", ["--version"]).stdout.trim() };
  }
  return facts;
}

export async function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
      "dry-run": { type: "string" }, authority: { type: "string" }, report: { type: "string" },
      own: { type: "string", multiple: true }, "correction-review": { type: "string" },
      "delivery-receipt": { type: "string" },
    } });
  } catch (error) {
    process.stderr.write(`release: ${error.message}\n`);
    return 2;
  }
  const { values, positionals: [command, version] } = parsed;
  const dryRun = values["dry-run"];
  if (dryRun !== undefined && (!dryRun || dryRun.startsWith("--") || !existsSync(dryRun))) {
    process.stderr.write("release: --dry-run needs an existing fixture file; nothing was run\n");
    return 2;
  }
  const world = dryRun ? simulatedWorld(JSON.parse(readFileSync(dryRun, "utf8"))) : realWorld();
  const out = (text) => process.stdout.write(`${text}\n`);
  if (command === "protection") {
    const head = (await world.github.releasePullRequest(null))?.headSha ?? null;
    const step = planProtectionStep(await world.github.protection(),
      { aggregateObservedSuccess: await world.github.aggregateObserved(head) });
    out(JSON.stringify(step, null, 2));
    return step.action === "blocked" ? 1 : 0;
  }
  if (!/^\d+\.\d+\.\d+$/.test(version ?? "") || !["prepare", "status", "resume"].includes(command)) {
    process.stderr.write("usage: release.mjs prepare|status|resume <x.y.z> [--authority file] [--dry-run fixture]\n");
    return 2;
  }
  const facts = (full) => (dryRun ? world.state.localFacts : localFacts(version, world, { full }));
  if (command === "prepare") {
    const local = facts(true);
    const result = await prepare({ world, version, local });
    out(JSON.stringify({ ...result, candidate: { commit: local.commit, tree: local.tree } }, null, 2));
    return result.ok ? 0 : 1;
  }
  // A dry run keeps no receipt unless a test names a private state directory.
  const dir = dryRun ? process.env.GH_GLANCE_RELEASE_STATE_DIR || null
    : resolve(ROOT, world.must("git", ["rev-parse", "--git-common-dir"]), "gh-glance-release", `v${version}`);
  const receiptPath = dir ? join(dir, "receipt.json") : null;
  if (command === "status") {
    const stored = receiptPath ? readReceipt(receiptPath, version) : { state: "absent" };
    if (stored.state === "unreadable") {
      out(`status unavailable: ${stored.reason}. Reconstruct from GitHub/npm readback; nothing was changed.`);
      return 1;
    }
    if (stored.state === "absent") {
      out(`no receipt for v${version}; run prepare, then resume with the owner's authority`);
      return 0;
    }
    if (values.report) writeReportBlock(values.report, renderReport(stored.receipt));
    out(renderReport(stored.receipt));
    return 0;
  }
  // resume
  const authority = values.authority ? JSON.parse(readFileSync(values.authority, "utf8")) : null;
  const lock = dir ? acquireLock(join(dir, "lock")) : { ok: true, release: () => {} };
  if (!lock.ok) {
    out(`no action taken: ${lock.reason}`);
    return 1;
  }
  try {
    // The receipt is read only while holding the lock.
    const stored = receiptPath ? readReceipt(receiptPath, version) : { state: "absent" };
    if (stored.state === "unreadable") {
      out(`no action taken: ${stored.reason}. Reconstruct from GitHub/npm readback.`);
      return 1;
    }
    const local = facts(false);
    const receipt = stored.state === "ok" ? stored.receipt
      : newReceipt({ version, candidate: { commit: local.commit, tree: local.tree }, authority, now: new Date().toISOString() });
    const changedPaths = receipt.candidate.commit === local.commit ? []
      : dryRun ? world.state.correctionPaths ?? []
        : world.must("git", ["diff", "--no-renames", "--name-only", receipt.candidate.commit, local.commit]).split("\n").filter(Boolean);
    const reconciled = reconcileReceipt({ receipt, local, authority, version, changedPaths, review: values["correction-review"],
      deliveryReceipt: values["delivery-receipt"] ? JSON.parse(readFileSync(values["delivery-receipt"], "utf8")) : null,
      own: values.own ?? [], now: new Date().toISOString() });
    if (!reconciled.ok) {
      out(`no action taken: ${reconciled.reason}`);
      return 1;
    }
    const save = (value) => { if (receiptPath) saveReceipt(receiptPath, value); };
    const finished = await resumeRelease({ world, receipt, authority, save,
      pollMs: dryRun ? 0 : 30_000, sleep: dryRun ? async () => {} : undefined });
    out(renderReport(finished));
    if (dryRun) out(`dry run: ${world.calls.reads} reads, simulated mutations: ${world.calls.mutations.join(", ") || "none"}`);
    return finished.stage === "complete" ? 0 : 1;
  } finally {
    lock.release();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    process.stderr.write(`release: ${error.stack ?? error.message}\n`);
    process.exitCode = 2;
  });
}
