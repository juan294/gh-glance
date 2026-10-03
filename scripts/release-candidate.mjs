#!/usr/bin/env node
// Candidate artifact, promotion and publication decisions for the release
// workflows. Pure functions decide; the CLI at the bottom only gathers inputs
// (environment, `gh api`, the registry) and writes outputs, so tests exercise
// the same decision code the workflows run.
//
//   plan-ci            role and job selection for one CI event
//   pack               the candidate's one `npm pack`
//   manifest           immutable input manifest for a packed candidate
//   use-candidate      hard-check a downloaded candidate (optionally install it)
//   aggregate          the `Release candidate` and `PTY` checks
//   verify-promotion   main push: the merge tree equals a tested candidate
//   bootstrap          publisher, from protected main: the tag is a release merge
//   verify-candidate   publisher: protected merge -> run -> artifact -> bytes
//   registry-state     classify the registry before publishing
//   deliver            bounded registry and provenance readback, with a receipt

import { execFileSync } from "node:child_process";
import { appendFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { inspectTarball, installPackage, integrityOf, packCheckout } from "./package-check.mjs";
import { PROFILE_SELECTIONS, ROOT, changedPaths, classifyChanges, escapeRegExp, writeAtomic } from "./test-select.mjs";

export const REPOSITORY = "juan294/gh-glance";
export const CI_WORKFLOW = ".github/workflows/ci.yml";
const RELEASE_WORKFLOW = ".github/workflows/release.yml";
export const MANIFEST_SCHEMA = 1;
// The reviewed runtime pins; a workflow test holds every literal to these.
export const PINS = { node22: "22.22.2", node24: "24.21.0", npm: "11.21.0" };
// Node 22's bundled npm 10.9 deletes its own modules while replacing itself
// with npm 11, so the pinned npm installs itself.
export const NPM_UPGRADE = `npx -y npm@${PINS.npm} install -g npm@${PINS.npm}`;
const NODE_MAJORS = [22, 24];

const SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SHA512 = /^sha512-[A-Za-z0-9+/]{86}==$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

// ---------------------------------------------------------------- CI routing

// Job ids in ci.yml. Legacy required context names stay on the jobs that now
// carry the real selected work: Lint, Test (Node N), Smoke (Node N), PTY.
export const CI_JOBS = ["lint", "test", "smoke", "pack", "terminal-smoke", "sustained",
  "pty-governor", "pty-rest", "pty", "promotion", "candidate"];

// While main still requires the legacy Test/Smoke/PTY contexts, every profile
// that can reach main runs real work behind each of them, so docs routes like
// ordinary; it differs only in what a later protection set may drop.
const QUICK_JOBS = ["lint", "smoke", "test", "terminal-smoke"];
const PROFILE_JOBS = {
  docs: QUICK_JOBS,
  ordinary: QUICK_JOBS,
  broad: [...QUICK_JOBS, "sustained", "pty-governor", "pty-rest"],
};

// `releasePrOpen`: a develop push while the develop -> main PR is open is
// already covered by that PR's candidate run on the same head; running the
// quick checks again would duplicate it.
export function planCi({ event, repository, baseRef, headRef, headRepository, changedPaths: paths,
  reviewedOrdinary = null, releasePrOpen = false }) {
  if (event === "push" && baseRef === "main") {
    return { role: "promotion", profile: null, jobs: ["promotion", "candidate"],
      reasons: ["push to main: promotion identity only, no suite repeats"] };
  }
  if (event === "push" && baseRef === "develop") {
    if (releasePrOpen) {
      return { role: "covered", profile: null, jobs: ["candidate"],
        reasons: ["push to develop with the release PR open: its candidate run covers this head"] };
    }
    return { role: "integration", profile: "ordinary", jobs: [...QUICK_JOBS, "candidate"],
      reasons: ["push to develop: quick integration checks"] };
  }
  const always = ["pty", "candidate"];
  if (event !== "pull_request") {
    return { role: "unsupported", profile: null, jobs: ["candidate"], reasons: [`unsupported event ${event}`] };
  }
  if (baseRef === "main" && !(headRepository === repository && headRef === "develop")) {
    return { role: "rejected", profile: "ordinary", jobs: [...QUICK_JOBS, ...always],
      reasons: ["main accepts only release pull requests from this repository's develop"] };
  }
  const decision = classifyChanges(paths, { reviewedOrdinary });
  if (baseRef !== "main") {
    return { role: "pull-request", profile: decision.profile, jobs: [...PROFILE_JOBS[decision.profile], ...always],
      reasons: ["pull request to develop: read-only checks, no publishable artifact", ...decision.reasons] };
  }
  return { role: "candidate", profile: decision.profile,
    jobs: [...PROFILE_JOBS[decision.profile], "pack", ...always],
    reasons: ["release pull request: the one authoritative candidate selection", ...decision.reasons] };
}

// GNU script(1) on Linux always; BSD on macOS only for a release candidate.
export function terminalRunners(plan) {
  return plan.role === "candidate" ? ["ubuntu-latest", "macos-latest"] : ["ubuntu-latest"];
}

// The aggregate behind `Release candidate` (every job) and `PTY` (`only` the
// terminal jobs). `needs` is GitHub's toJSON(needs). A selected job must have
// succeeded and an unselected one must not have run, so a skipped job never
// stands in for missing work.
export function aggregate({ plan, needs, only = null }) {
  const problems = [];
  if (!plan || !Array.isArray(plan.jobs)) return { ok: false, problems: ["no CI plan was produced"] };
  if (needs?.plan?.result !== "success") problems.push(`plan: ${needs?.plan?.result ?? "missing"}`);
  for (const job of only ?? CI_JOBS.filter((id) => id !== "candidate")) {
    const result = needs?.[job]?.result;
    const selected = plan.jobs.includes(job);
    if (selected && result !== "success") problems.push(`${job}: selected but ${result ?? "missing"}`);
    if (!selected && result !== undefined && result !== "skipped") problems.push(`${job}: not selected but ${result}`);
  }
  if (only) return { ok: problems.length === 0, problems };
  if (plan.role === "rejected" || plan.role === "unsupported") problems.push(...plan.reasons.slice(0, 1));
  if (plan.role === "candidate") {
    const pack = needs?.pack?.outputs ?? {};
    if (!SHA256.test(pack["tarball-sha256"] ?? "")) problems.push("pack: no tarball digest output");
    if (!/^\d+$/.test(pack["artifact-id"] ?? "")) problems.push("pack: no artifact id output");
  }
  return { ok: problems.length === 0, problems };
}

// ------------------------------------------------------------ the manifest

const MANIFEST_SHAPE = {
  schema: "number",
  repository: { id: "number", fullName: "string" },
  pullRequest: { number: "number", head: "sha", base: "sha" },
  checkout: { commit: "sha", tree: "sha" },
  workflow: { path: "string", ref: "string", runId: "number", runAttempt: "number", event: "string" },
  profile: "string",
  selections: "string[]",
  package: { name: "string", version: "version", files: "string[]" },
  runtime: { node: "string", npm: "string", platform: "string" },
  inputs: { lockSha256: "sha256", workflowSha256: "sha256" },
  tarball: { filename: "string", sha256: "sha256", integrity: "sha512" },
};

function checkShape(value, shape, path, problems) {
  if (typeof shape === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      problems.push(`${path || "manifest"} must be an object`);
      return;
    }
    for (const key of Object.keys(value)) if (!(key in shape)) problems.push(`${path}${path ? "." : ""}${key} is not allowed`);
    for (const [key, child] of Object.entries(shape)) checkShape(value[key], child, `${path}${path ? "." : ""}${key}`, problems);
    return;
  }
  const valid = {
    number: () => Number.isSafeInteger(value) && value >= 0,
    string: () => typeof value === "string" && value.length > 0 && value.length <= 512,
    "string[]": () => Array.isArray(value) && value.length <= 64 && value.every((item) => typeof item === "string" && item.length <= 128),
    sha: () => typeof value === "string" && SHA.test(value),
    sha256: () => typeof value === "string" && SHA256.test(value),
    sha512: () => typeof value === "string" && SHA512.test(value),
    version: () => typeof value === "string" && VERSION.test(value),
  }[shape];
  if (!valid()) problems.push(`${path} is not a valid ${shape}`);
}

export function validateManifest(manifest) {
  const problems = [];
  checkShape(manifest, MANIFEST_SHAPE, "", problems);
  if (problems.length === 0 && manifest.schema !== MANIFEST_SCHEMA) problems.push(`unknown manifest schema ${manifest.schema}`);
  return problems;
}

const sha256File = (path) => integrityOf(readFileSync(path)).sha256;

// ------------------------------------------- candidate and promotion proofs

const ARTIFACT_PREFIX = "release-candidate-";

export function artifactName(tree) {
  return `${ARTIFACT_PREFIX}${tree}`;
}

// Choose the one successful candidate run whose tested merge tree is exactly
// the production tree. Runs and artifacts are GitHub API objects.
export function selectCandidate({ runs, artifactsByRun, pullRequest, productionTree, repository = REPOSITORY, now = Date.now() }) {
  const problems = [];
  const eligible = [];
  for (const run of runs) {
    const reasons = [];
    if (run.path !== CI_WORKFLOW) reasons.push(`workflow ${run.path}`);
    if (run.event !== "pull_request") reasons.push(`event ${run.event}`);
    if (run.repository?.full_name !== repository || run.head_repository?.full_name !== repository) reasons.push("foreign repository");
    if (run.head_sha !== pullRequest.head) reasons.push(`head ${run.head_sha}`);
    if (run.head_branch !== "develop") reasons.push(`branch ${run.head_branch}`);
    if (run.status !== "completed" || run.conclusion !== "success") reasons.push(`${run.status}/${run.conclusion}`);
    const named = (artifactsByRun[run.id] ?? []).filter((item) => item.name === artifactName(productionTree));
    if (named.length !== 1) reasons.push(`${named.length} artifacts for the production tree`);
    const artifact = named[0];
    if (artifact) {
      if (artifact.expired || Date.parse(artifact.expires_at) <= now) reasons.push("artifact expired");
      if (artifact.workflow_run?.id !== run.id) reasons.push("artifact belongs to another run");
      if (!/^sha256:[0-9a-f]{64}$/.test(artifact.digest ?? "")) reasons.push("artifact has no server digest");
    }
    if (reasons.length === 0) eligible.push({ run, artifact });
    else problems.push(`run ${run.id} attempt ${run.run_attempt}: ${reasons.join(", ")}`);
  }
  if (eligible.length === 0) return { ok: false, problems: ["no eligible candidate run", ...problems] };
  // GitHub empties a run's pull_requests once the PR merges, so the PR number
  // is bound later, through each candidate's manifest (verifyArtifact). Offer
  // every eligible run newest first; the caller takes the first that verifies.
  eligible.sort((a, b) => b.run.id - a.run.id || b.run.run_attempt - a.run.run_attempt);
  return { ok: true, problems, candidates: eligible, ...eligible[0] };
}

export function verifyPromotion({ pullRequest, mergeCommit, productionTree, tag = null, version = null,
  changelog = null, repository = REPOSITORY }) {
  const problems = [];
  if (!pullRequest) return { ok: false, problems: ["no merged pull request is associated with this commit"] };
  if (pullRequest.base !== "main") problems.push(`pull request #${pullRequest.number} targets ${pullRequest.base}`);
  if (pullRequest.headRef !== "develop" || pullRequest.headRepository !== repository) {
    problems.push(`pull request #${pullRequest.number} is not this repository's develop`);
  }
  if (!pullRequest.mergedAt || pullRequest.mergeCommit !== mergeCommit) problems.push("commit is not the pull request's merge commit");
  if (!SHA.test(productionTree ?? "")) problems.push("production tree unknown");
  if (tag) {
    if (!VERSION.test(version ?? "")) return { ok: false, problems: [...problems, `invalid version ${version}`] };
    if (tag.commit !== mergeCommit) problems.push(`tag ${tag.name} points at ${tag.commit}, not ${mergeCommit}`);
    if (tag.name !== `v${version}`) problems.push(`tag ${tag.name} does not name version ${version}`);
    if (changelog !== null && !new RegExp(`^## \\[${escapeRegExp(version)}\\]`, "m").test(changelog)) {
      problems.push(`CHANGELOG.md has no ${version} section`);
    }
  }
  return { ok: problems.length === 0, problems };
}

// Hard identity checks on downloaded bytes: the archive digest GitHub computed
// at upload, the manifest, and the inner tarball.
export function verifyArtifact({ archiveSha256, artifact, manifest, tarballBytes, productionTree, pullRequest, run }) {
  const problems = [...validateManifest(manifest)];
  if (`sha256:${archiveSha256}` !== artifact.digest) problems.push("artifact archive digest does not match GitHub's");
  if (problems.length > 0) return { ok: false, problems };
  const inner = inspectTarball(tarballBytes, { expectedVersion: manifest.package.version });
  problems.push(...inner.problems);
  if (inner.sha256 !== manifest.tarball.sha256) problems.push("tarball sha256 differs from the manifest");
  if (inner.sha512 !== manifest.tarball.integrity) problems.push("tarball integrity differs from the manifest");
  if (manifest.checkout.tree !== productionTree) problems.push("tested tree differs from the production tree");
  if (manifest.pullRequest.head !== pullRequest.head) problems.push("manifest names another pull request head");
  if (manifest.pullRequest.number !== pullRequest.number) problems.push("manifest names another pull request");
  if (manifest.workflow.runId !== run.id || manifest.workflow.runAttempt !== run.run_attempt) {
    problems.push("manifest names another run or attempt");
  }
  if (manifest.workflow.path !== CI_WORKFLOW || manifest.workflow.event !== "pull_request") problems.push("manifest names another workflow");
  for (const required of PROFILE_SELECTIONS[manifest.profile] ?? ["unknown profile"]) {
    if (!manifest.selections.includes(required)) problems.push(`manifest lacks required selection ${required}`);
  }
  return { ok: problems.length === 0, problems, tarball: inner };
}

// The candidate run's own job results, read from the API (never from the
// downloaded manifest). Every context main requires, the pack and the
// aggregate must have succeeded on this exact attempt.
export const CANDIDATE_JOBS = ["Plan", "Lint", "Pack candidate",
  ...NODE_MAJORS.flatMap((major) => [`Test (Node ${major})`, `Smoke (Node ${major})`]),
  ...terminalRunners({ role: "candidate" }).map((os) => `Terminal smoke (${os})`), "PTY", "Release candidate"];

export function checkCandidateJobs(jobs) {
  const problems = [];
  const results = Object.fromEntries(jobs.map((job) => [job.name, job.conclusion]));
  for (const name of CANDIDATE_JOBS) {
    if (results[name] !== "success") problems.push(`job ${name}: ${results[name] ?? "missing"}`);
  }
  for (const job of jobs) {
    if (!CANDIDATE_JOBS.includes(job.name) && !["success", "skipped"].includes(job.conclusion)) {
      problems.push(`job ${job.name}: ${job.conclusion}`);
    }
  }
  return { ok: problems.length === 0, problems, results };
}

// ------------------------------------------------------------ provenance

// Content check of npm's SLSA provenance statement for the published version.
// `npm audit signatures` verifies the signatures; this binds what was signed:
// the exact bytes, this repository's release workflow at the release tag, and
// the production commit.
export function verifyProvenance(attestations, { version, integrity, repository = REPOSITORY, commit }) {
  const problems = [];
  const statements = (attestations?.attestations ?? [])
    .filter((item) => item.predicateType === "https://slsa.dev/provenance/v1")
    .map((item) => {
      try {
        return JSON.parse(Buffer.from(item.bundle.dsseEnvelope.payload, "base64").toString("utf8"));
      } catch {
        return null;
      }
    });
  if (statements.length !== 1 || !statements[0]) return { ok: false, problems: ["no single SLSA provenance statement"] };
  const [statement] = statements;
  const expectedSha512 = integrity?.startsWith("sha512-")
    ? Buffer.from(integrity.slice(7), "base64").toString("hex") : null;
  const subject = statement.subject?.find((item) => item.name === `pkg:npm/gh-glance@${version}`);
  if (!subject) problems.push(`provenance subject is not pkg:npm/gh-glance@${version}`);
  else if (!expectedSha512 || subject.digest?.sha512 !== expectedSha512) problems.push("provenance subject digest is not the verified artifact");
  const workflow = statement.predicate?.buildDefinition?.externalParameters?.workflow ?? {};
  if (workflow.repository !== `https://github.com/${repository}`) problems.push(`provenance repository ${workflow.repository}`);
  if (workflow.path !== RELEASE_WORKFLOW) problems.push(`provenance workflow ${workflow.path}`);
  if (workflow.ref !== `refs/tags/v${version}`) problems.push(`provenance ref ${workflow.ref}`);
  const commits = (statement.predicate?.buildDefinition?.resolvedDependencies ?? []).map((item) => item.digest?.gitCommit);
  if (!commits.includes(commit)) problems.push(`provenance commit ${commits.join(", ") || "none"} is not ${commit}`);
  return { ok: problems.length === 0, problems };
}

// Before any tagged code runs: the tag must point at the triggering commit,
// that commit must be on main, and it must be the merge commit of exactly one
// merged develop -> main PR of this repository. Develop commits are ancestors
// of main too, so ancestry alone is not enough.
export function bootstrapDecision({ tagCommit, commit, compareStatus, pulls, repository = REPOSITORY }) {
  const problems = [];
  if (tagCommit !== commit) problems.push(`the tag points at ${tagCommit}, not the triggering ${commit}`);
  if (!["identical", "ahead"].includes(compareStatus)) problems.push(`${commit} is not on main (compare: ${compareStatus})`);
  const merges = (pulls ?? []).filter((pull) => pull.merged_at && pull.merge_commit_sha === commit &&
    pull.base?.ref === "main" && pull.head?.ref === "develop" && pull.head?.repo?.full_name === repository);
  if (merges.length !== 1) problems.push(`${commit} is the merge commit of ${merges.length} develop -> main release PRs, not exactly one`);
  return { ok: problems.length === 0, problems };
}

// ------------------------------------------------------------- registry

// Classify a registry metadata read for one exact version. Only a definite
// 404 is absence; anything that is not a clean answer is unknown.
export function classifyRegistry({ status, body, integrity, version }) {
  if (status === 404) return { state: "absent" };
  if (status !== 200 || body == null || typeof body !== "object") {
    return { state: "unknown", reason: `registry answered ${status ?? "nothing"}` };
  }
  const published = body.versions?.[version];
  if (!published) return { state: "absent", latest: body["dist-tags"]?.latest ?? null };
  if (published.dist?.integrity === integrity) return { state: "match", latest: body["dist-tags"]?.latest ?? null };
  return { state: "collision", reason: `registry ${version} has integrity ${published.dist?.integrity ?? "none"}` };
}

function compareVersions(a, b) {
  const parse = (value) => value.split(/[.-]/).slice(0, 3).map(Number);
  const [x, y] = [parse(a), parse(b)];
  for (let index = 0; index < 3; index += 1) if (x[index] !== y[index]) return x[index] - y[index];
  return 0;
}

export function publishDecision(registry, version) {
  if (registry.state === "unknown") return { action: "block", reason: `registry state unknown: ${registry.reason}` };
  if (registry.state === "collision") return { action: "block", reason: registry.reason };
  if (registry.latest && compareVersions(version, registry.latest) < 0) {
    return { action: "block", reason: `${version} is older than latest ${registry.latest}; refusing a dist-tag regression` };
  }
  if (registry.state === "match") return { action: "verify", reason: "exact bytes already published" };
  return { action: "publish", reason: "version absent" };
}

// Bounded readback with capped backoff that honors Retry-After. `read` returns
// { status, body, retryAfterMs? } or throws on a network error.
export async function pollRegistry({ read, check, deadlineMs = 300_000, now = Date.now,
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)), initialMs = 2_000, capMs = 30_000 }) {
  const started = now();
  let delay = initialMs;
  const attempts = [];
  for (;;) {
    let outcome;
    try {
      const response = await read();
      outcome = { status: response.status, ...check(response) };
      attempts.push({ at: now() - started, status: response.status, ok: outcome.ok, reason: outcome.reason });
      if (outcome.ok) return { ok: true, attempts, ...outcome };
      if (outcome.final) return { ok: false, attempts, ...outcome };
      if (response.retryAfterMs != null) delay = Math.min(Math.max(response.retryAfterMs, delay), capMs);
    } catch (error) {
      attempts.push({ at: now() - started, error: error.message });
    }
    const remaining = deadlineMs - (now() - started);
    if (remaining <= 0) return { ok: false, attempts, reason: "published; delivery unverified at the deadline" };
    await sleep(Math.min(delay, remaining));
    delay = Math.min(delay * 2, capMs);
  }
}

// Readiness for read-only delivery checks. A tarball publish carries no
// gitHead (npm reads it from a git checkout), so it is recorded, not required;
// the production commit is bound by the provenance statement instead.
export function deliveryCheck({ version, integrity }) {
  return ({ status, body }) => {
    if (status === 404) return { ok: false, reason: "not yet visible (404)" };
    if (status !== 200) return { ok: false, reason: `registry answered ${status}` };
    const published = body?.versions?.[version];
    if (!published) return { ok: false, reason: `${version} not yet listed` };
    if (published.dist?.integrity !== integrity) {
      return { ok: false, final: true, reason: `registry integrity ${published.dist?.integrity} is not the verified artifact's` };
    }
    if (!published.dist?.attestations?.url) return { ok: false, reason: "provenance not yet visible" };
    if (body["dist-tags"]?.latest !== version) return { ok: false, reason: `latest is ${body["dist-tags"]?.latest}` };
    return { ok: true, gitHead: published.gitHead ?? null, attestationsUrl: published.dist.attestations.url };
  };
}

// ------------------------------------------------------------------- CLI

function gh(args, options = {}) {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });
}

function ghJson(path) {
  return JSON.parse(gh(["api", "-H", "Accept: application/vnd.github+json", path]));
}

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

function output(values) {
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
  process.stdout.write(`${lines.join("\n")}\n`);
}

function exportEnv(values) {
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`);
  if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, `${lines.join("\n")}\n`);
}

function fail(problems) {
  for (const problem of problems) process.stderr.write(`::error::${problem}\n`);
  return 1;
}

function mergedPullRequestFor(commit, repository) {
  const pulls = ghJson(`repos/${repository}/commits/${commit}/pulls`)
    .filter((pull) => pull.merged_at && pull.merge_commit_sha === commit);
  if (pulls.length !== 1) return null;
  const [pull] = pulls;
  return { number: pull.number, head: pull.head.sha, headRef: pull.head.ref,
    headRepository: pull.head.repo?.full_name ?? null, base: pull.base.ref,
    mergedAt: pull.merged_at, mergeCommit: pull.merge_commit_sha };
}

// The candidate runs for a merged release PR whose artifact is named for the
// production tree (one artifacts query, then only the runs that have one).
function promotedCandidate(commit, repository, tagCheck = null) {
  const pullRequest = mergedPullRequestFor(commit, repository);
  const productionTree = git(["rev-parse", `${commit}^{tree}`]);
  const promotion = verifyPromotion({ pullRequest, mergeCommit: commit, productionTree, repository, ...tagCheck });
  if (!promotion.ok) return promotion;
  const artifacts = ghJson(`repos/${repository}/actions/artifacts?name=${artifactName(productionTree)}&per_page=100`).artifacts;
  const runIds = [...new Set(artifacts.map((item) => item.workflow_run?.id))];
  const runs = runIds.map((id) => ghJson(`repos/${repository}/actions/runs/${id}`));
  const artifactsByRun = Object.groupBy(artifacts, (item) => item.workflow_run?.id);
  const candidate = selectCandidate({ runs, artifactsByRun, pullRequest, productionTree, repository });
  return { ...candidate, pullRequest, productionTree };
}

// Download and verify one eligible run's artifact: the run's own job results,
// GitHub's archive digest, the exact two entries, then the manifest/tarball.
function acceptCandidate({ repository, run, artifact, pullRequest, productionTree, version, dir }) {
  const jobs = checkCandidateJobs(ghJson(
    `repos/${repository}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`).jobs);
  if (!jobs.ok) return jobs;
  mkdirSync(dir, { recursive: true });
  const zip = join(dir, "artifact.zip");
  writeFileSync(zip, gh(["api", `repos/${repository}/actions/artifacts/${artifact.id}/zip`], { encoding: "buffer" }));
  const archiveSha256 = sha256File(zip);
  if (`sha256:${archiveSha256}` !== artifact.digest) return { ok: false, problems: ["artifact archive digest does not match GitHub's"] };
  const entries = execFileSync("unzip", ["-Z1", zip], { encoding: "utf8" }).split("\n").filter(Boolean).sort();
  if (JSON.stringify(entries) !== JSON.stringify(["artifact.tgz", "manifest.json"])) {
    return { ok: false, problems: [`artifact holds ${entries.join(", ")}, not exactly artifact.tgz and manifest.json`] };
  }
  execFileSync("unzip", ["-q", zip, "-d", join(dir, "x")]);
  for (const name of entries) {
    if (!lstatSync(join(dir, "x", name)).isFile()) return { ok: false, problems: [`artifact entry ${name} is not a regular file`] };
  }
  const manifest = JSON.parse(readFileSync(join(dir, "x", "manifest.json"), "utf8"));
  const tarballBytes = readFileSync(join(dir, "x", "artifact.tgz"));
  const verified = verifyArtifact({ archiveSha256, artifact, manifest, tarballBytes, productionTree, pullRequest, run });
  if (!verified.ok) return verified;
  if (manifest.package.version !== version) return { ok: false, problems: [`candidate version ${manifest.package.version} is not ${version}`] };
  return { ok: true, manifest, tarballBytes, jobs: jobs.results };
}

// The registry's view of the package, as { status, body } for classifyRegistry
// and deliveryCheck. A network error throws; callers decide what that means.
export async function readRegistry() {
  const response = await fetch("https://registry.npmjs.org/gh-glance", { headers: { accept: "application/json" } });
  const retryAfter = Number(response.headers.get("retry-after"));
  return { status: response.status, body: response.status === 200 ? await response.json() : null,
    retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null };
}

const commands = {
  "plan-ci"() {
    const env = process.env;
    const event = env.GITHUB_EVENT_NAME;
    const baseRef = event === "push" ? env.GITHUB_REF_NAME : env.GITHUB_BASE_REF;
    const changed = event === "pull_request" ? changedPaths(`origin/${baseRef}`, "HEAD^2") : null;
    const owner = env.GITHUB_REPOSITORY.split("/")[0];
    const releasePrOpen = event === "push" && baseRef === "develop" &&
      ghJson(`repos/${env.GITHUB_REPOSITORY}/pulls?base=main&head=${owner}:develop&state=open`).length > 0;
    const plan = planCi({ event, repository: env.GITHUB_REPOSITORY, baseRef, headRef: env.GITHUB_HEAD_REF,
      headRepository: env.HEAD_REPOSITORY, changedPaths: changed, releasePrOpen });
    output({ plan: JSON.stringify(plan), jobs: JSON.stringify(plan.jobs), "terminal-os": JSON.stringify(terminalRunners(plan)) });
    return 0;
  },
  async pack(args) {
    const destination = resolve(args[0] ?? "candidate");
    mkdirSync(destination, { recursive: true });
    const packed = await packCheckout(destination);
    execFileSync("mv", [packed, join(destination, "artifact.tgz")]);
    return 0;
  },
  manifest(args) {
    const env = process.env;
    const bytes = readFileSync(resolve(args[0]));
    const plan = JSON.parse(env.CI_PLAN);
    const inspected = inspectTarball(bytes);
    const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
    const manifest = {
      schema: MANIFEST_SCHEMA,
      repository: { id: Number(env.GITHUB_REPOSITORY_ID), fullName: env.GITHUB_REPOSITORY },
      pullRequest: { number: event.pull_request.number, head: event.pull_request.head.sha, base: event.pull_request.base.sha },
      checkout: { commit: git(["rev-parse", "HEAD"]), tree: git(["rev-parse", "HEAD^{tree}"]) },
      workflow: { path: CI_WORKFLOW, ref: env.GITHUB_WORKFLOW_REF, runId: Number(env.GITHUB_RUN_ID),
        runAttempt: Number(env.GITHUB_RUN_ATTEMPT), event: env.GITHUB_EVENT_NAME },
      profile: plan.profile,
      selections: PROFILE_SELECTIONS[plan.profile],
      package: { name: "gh-glance", version: inspected.version, files: inspected.files },
      runtime: { node: process.version, npm: execFileSync("npm", ["--version"], { encoding: "utf8" }).trim(),
        platform: `${process.platform}-${process.arch}` },
      inputs: { lockSha256: sha256File(join(ROOT, "package-lock.json")), workflowSha256: sha256File(join(ROOT, CI_WORKFLOW)) },
      tarball: { filename: "artifact.tgz", sha256: inspected.sha256, integrity: inspected.sha512 },
    };
    const problems = [...validateManifest(manifest), ...inspected.problems];
    if (problems.length > 0) return fail(problems);
    writeAtomic(args[1], `${JSON.stringify(manifest, null, 2)}\n`);
    output({ "tarball-sha256": inspected.sha256, "artifact-name": artifactName(manifest.checkout.tree) });
    return 0;
  },
  // A downloaded candidate: find artifact.tgz under <dir>, require the pack
  // job's digest, export it for the package selection and, with --install,
  // install it for the terminal smoke.
  async "use-candidate"(args) {
    const dir = resolve(args[0] ?? "candidate");
    const found = readdirSync(dir, { recursive: true }).filter((name) => basename(String(name)) === "artifact.tgz");
    if (found.length !== 1) return fail([`expected one artifact.tgz under ${dir}, found ${found.length}`]);
    const tarball = join(dir, String(found[0]));
    const actual = sha256File(tarball);
    if (actual !== process.env.EXPECTED_SHA256) return fail([`candidate tarball ${actual} is not the packed ${process.env.EXPECTED_SHA256}`]);
    const values = { GH_GLANCE_PACKAGE_TARBALL: tarball, GH_GLANCE_PACKAGE_REQUIRE_TARBALL: "1" };
    if (args.includes("--install")) {
      const installed = await installPackage(tarball);
      if (installed.problems.length > 0) return fail(installed.problems);
      values.GH_GLANCE_CAPTURE_ENTRY = join(installed.root, "node_modules/gh-glance/index.mjs");
    }
    exportEnv(values);
    output(values);
    return 0;
  },
  aggregate() {
    const plan = JSON.parse(process.env.CI_PLAN || "null");
    const only = process.env.CI_ONLY ? process.env.CI_ONLY.split(",") : null;
    const result = aggregate({ plan, needs: JSON.parse(process.env.CI_NEEDS || "{}"), only });
    process.stdout.write(`role: ${plan?.role}\nprofile: ${plan?.profile}\nselected: ${plan?.jobs?.join(", ")}\n` +
      `checked: ${(only ?? ["every job"]).join(", ")}\nreasons:\n${(plan?.reasons ?? []).map((reason) => `  - ${reason}`).join("\n")}\n`);
    return result.ok ? 0 : fail(result.problems);
  },
  "verify-promotion"(args) {
    const repository = process.env.GITHUB_REPOSITORY || REPOSITORY;
    const candidate = promotedCandidate(args[0] || process.env.GITHUB_SHA, repository);
    if (!candidate.ok) return fail(candidate.problems);
    process.stdout.write(`candidate run ${candidate.run.id}, artifact ${candidate.artifact.id}, tree ${candidate.productionTree}\n`);
    return 0;
  },
  bootstrap() {
    const repository = process.env.GITHUB_REPOSITORY || REPOSITORY;
    const commit = process.env.GITHUB_SHA;
    const decision = bootstrapDecision({ repository, commit,
      tagCommit: ghJson(`repos/${repository}/commits/${process.env.GITHUB_REF_NAME}`).sha,
      compareStatus: ghJson(`repos/${repository}/compare/${commit}...main`).status,
      pulls: ghJson(`repos/${repository}/commits/${commit}/pulls`) });
    if (!decision.ok) return fail(decision.problems);
    process.stdout.write(`${process.env.GITHUB_REF_NAME} is the protected release merge ${commit}\n`);
    return 0;
  },
  "verify-candidate"(args) {
    const repository = process.env.GITHUB_REPOSITORY || REPOSITORY;
    const tagName = process.env.GITHUB_REF_NAME;
    const commit = process.env.GITHUB_SHA;
    const destination = resolve(args[0] ?? "verified");
    const version = JSON.parse(git(["show", `${commit}:package.json`])).version;
    const candidate = promotedCandidate(commit, repository, { tag: { name: tagName, commit: git(["rev-list", "-n1", tagName]) },
      version, changelog: git(["show", `${commit}:CHANGELOG.md`]) });
    if (!candidate.ok) return fail(candidate.problems);
    const work = mkdtempSync(join(tmpdir(), "gh-glance-candidate-"));
    const rejected = [];
    try {
      for (const { run, artifact } of candidate.candidates) {
        const accepted = acceptCandidate({ repository, run, artifact, pullRequest: candidate.pullRequest,
          productionTree: candidate.productionTree, version, dir: join(work, String(run.id)) });
        if (!accepted.ok) {
          rejected.push(`run ${run.id} attempt ${run.run_attempt}: ${accepted.problems.join("; ")}`);
          continue;
        }
        mkdirSync(destination, { recursive: true });
        writeFileSync(join(destination, "artifact.tgz"), accepted.tarballBytes);
        const receipt = { schema: 1, version, tag: tagName, productionCommit: commit, productionTree: candidate.productionTree,
          pullRequest: candidate.pullRequest, candidateRun: { id: run.id, attempt: run.run_attempt, url: run.html_url, jobs: accepted.jobs },
          artifact: { id: artifact.id, name: artifact.name, digest: artifact.digest, expiresAt: artifact.expires_at },
          manifest: accepted.manifest, rejectedCandidates: rejected };
        writeAtomic(join(destination, "candidate-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
        output({ version, sha256: accepted.manifest.tarball.sha256, integrity: accepted.manifest.tarball.integrity });
        return 0;
      }
      return fail(["no eligible candidate verified", ...rejected]);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  },
  async "registry-state"() {
    const version = process.env.RELEASE_VERSION;
    const integrity = process.env.RELEASE_INTEGRITY;
    let registry;
    try {
      registry = classifyRegistry({ ...(await readRegistry()), version, integrity });
    } catch (error) {
      registry = classifyRegistry({ status: null, version, integrity, error });
    }
    const decision = publishDecision(registry, version);
    output({ state: registry.state, action: decision.action, reason: decision.reason });
    return decision.action === "block" ? fail([decision.reason]) : 0;
  },
  async deliver() {
    const version = process.env.RELEASE_VERSION;
    const integrity = process.env.RELEASE_INTEGRITY;
    const commit = process.env.GITHUB_SHA;
    const result = await pollRegistry({ read: readRegistry, check: deliveryCheck({ version, integrity }) });
    if (result.ok) {
      let attestations;
      try {
        const response = await fetch(result.attestationsUrl, { headers: { accept: "application/json" } });
        attestations = response.ok ? await response.json() : null;
      } catch {
        attestations = null;
      }
      result.provenance = attestations ? verifyProvenance(attestations, { version, integrity, commit })
        : { ok: false, problems: ["provenance attestations could not be read; delivery unverified, resume read-only"] };
      if (!result.provenance.ok) {
        result.ok = false;
        result.reason = `provenance does not bind the release: ${result.provenance.problems.join("; ")}`;
      }
    }
    const receipt = { schema: 1, version, integrity, productionCommit: commit, registryGitHead: result.gitHead ?? null,
      delivered: result.ok, reason: result.reason ?? null, attempts: result.attempts, provenance: result.provenance ?? null };
    if (process.env.DELIVERY_RECEIPT) writeAtomic(process.env.DELIVERY_RECEIPT, `${JSON.stringify(receipt, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
    return result.ok ? 0 : fail([result.reason]);
  },
};

export async function main(argv = process.argv.slice(2)) {
  const [name, ...args] = argv;
  const command = commands[name];
  if (!command) {
    process.stderr.write(`usage: release-candidate.mjs ${Object.keys(commands).join("|")} ...\n`);
    return 2;
  }
  return command(args);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    process.stderr.write(`release-candidate: ${error.stack ?? error.message}\n`);
    process.exitCode = 2;
  });
}
