// Structural oracles over the checked-in workflow files, read with the focused
// parser in fixtures/workflow.mjs, so routing, trigger and permission changes
// are checked against what CI will run.

import assert from "node:assert/strict";
import { test } from "node:test";

import { CANDIDATE_JOBS, CI_JOBS, NPM_UPGRADE, PINS, REPOSITORY, planCi } from "../scripts/release-candidate.mjs";
import { readWorkflow, renderJobName } from "./fixtures/workflow.mjs";

const REPO = REPOSITORY;

test("WF-01 ci.yml jobs are exactly the routed jobs, each gated on its own plan entry", () => {
  const ci = readWorkflow("ci.yml");
  assert.deepEqual(Object.keys(ci.jobs).sort(), ["plan", ...CI_JOBS].sort());
  for (const id of CI_JOBS.filter((job) => !["pty", "candidate"].includes(job))) {
    assert.match(ci.jobs[id].if ?? "", new RegExp(`contains\\(fromJSON\\(needs\\.plan\\.outputs\\.jobs\\), '${id}'\\)`),
      `${id} must run only when selected`);
  }
  assert.equal(ci.jobs.candidate.if, "always()", "the aggregate must always report");
  assert.equal(ci.jobs.pty.if, "always() && github.event_name == 'pull_request'",
    "the legacy PTY context reports on every pull request");
  assert.deepEqual(ci.jobs.candidate.needs.sort(), ["plan", ...CI_JOBS.filter((id) => id !== "candidate")].sort(),
    "the aggregate must see every job");
});

// Every name a job can render, per event, from its matrix rows.
function renderedNames(ci, event) {
  return Object.values(ci.jobs).flatMap((job) => {
    if (!job.name) return [];
    const rows = [...job.body.matchAll(/- \{ node: (\d+), node-version: ([\d.]+) \}/g)].map((row) => ({ node: row[1] }));
    const matrices = job.name.includes("matrix.node") ? rows
      : job.name.includes("matrix.os") ? ["ubuntu-latest", "macos-latest"].map((os) => ({ os })) : [{}];
    return matrices.map((matrix) => renderJobName(job.name, { event, matrix }));
  });
}

const REQUIRED = ["Lint", "Test (Node 22)", "Test (Node 24)", "Smoke (Node 22)", "Smoke (Node 24)", "PTY", "Release candidate"];

test("WF-02 required context names come only from pull_request runs, on jobs doing the selected work", () => {
  const ci = readWorkflow("ci.yml");
  const prNames = renderedNames(ci, "pull_request");
  assert.deepEqual(REQUIRED.filter((name) => !prNames.includes(name)), [], "every required context exists on a PR run");
  // A push run on the release head must not report under a required name. A
  // job skipped by its `if` still posts a (skipped) check run, so every job's
  // push name counts, including jobs that never run on push.
  const pushNames = renderedNames(ci, "push");
  assert.deepEqual(pushNames.filter((name) => REQUIRED.includes(name)), []);
  assert.match(ci.jobs.pty.if, /github\.event_name == 'pull_request'/, "PTY runs on pull requests only");
  for (const id of ["test", "smoke"]) {
    const rows = [...ci.jobs[id].body.matchAll(/- \{ node: (\d+), node-version: ([\d.]+) \}/g)];
    assert.deepEqual(rows.map((row) => [row[1], row[2]]), [["22", PINS.node22], ["24", PINS.node24]]);
  }
  assert.match(ci.jobs.test.body, /test-select\.mjs run fast/);
  // Every job name the publisher requires exists on the candidate's PR run.
  assert.deepEqual(CANDIDATE_JOBS.filter((name) => !prNames.includes(name)), []);
  assert.match(ci.jobs.smoke.body, /use-candidate candidate\n\s+- run: node scripts\/test-select\.mjs run package/,
    "every package job runs the package selection, on the exact tarball for a candidate");
});

test("WF-03 one pack per candidate, consumed by ID and hard-checked, never repacked", () => {
  const ci = readWorkflow("ci.yml");
  const code = ci.text.split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");
  assert.doesNotMatch(code, /npm pack/, "packing goes through the tested helper");
  assert.equal((ci.text.match(/release-candidate\.mjs pack /g) ?? []).length, 1);
  assert.match(ci.jobs.pack.body, /release-candidate\.mjs pack candidate/);
  assert.match(ci.jobs.pack.body, /overwrite: false/);
  assert.match(ci.jobs.pack.body, /retention-days: 30/);
  assert.ok(ci.jobs.pack.body.includes(NPM_UPGRADE), "the pack job runs the pinned npm");
  for (const id of ["smoke", "terminal-smoke"]) {
    assert.match(ci.jobs[id].body, /artifact-ids: \$\{\{ needs\.pack\.outputs\.artifact-id \}\}/);
    assert.match(ci.jobs[id].body, /digest-mismatch: error/);
    assert.match(ci.jobs[id].body, /EXPECTED_SHA256: \$\{\{ needs\.pack\.outputs\.tarball-sha256 \}\}\n\s+run: node scripts\/release-candidate\.mjs use-candidate candidate/);
  }
  assert.doesNotMatch(ci.text, /pull_request_target/);
});

test("WF-12 the pinned npm installs itself, and artifact paths are absolute", () => {
  // Node 22's bundled npm 10.9 cannot replace itself with npm 11: it deletes
  // its own modules mid-install (MODULE_NOT_FOUND promise-retry). Only the
  // pinned npm, run through npx, may install the pin.
  assert.equal(NPM_UPGRADE, `npx -y npm@${PINS.npm} install -g npm@${PINS.npm}`);
  for (const file of ["ci.yml", "release.yml"]) {
    const { text } = readWorkflow(file);
    const installs = text.match(/[^\n]*install -g npm@[^\n]*/g) ?? [];
    assert.ok(installs.length > 0, `${file} installs the pinned npm`);
    for (const line of installs) assert.ok(line.includes(NPM_UPGRADE), `${file}: ${line.trim()}`);
    // actions/upload-artifact rejects any path with a '..' segment. Command
    // arguments such as `verify-candidate ../verified` are not upload paths.
    const paths = text.match(/^\s*path:.*$/gm) ?? [];
    for (const line of paths) assert.doesNotMatch(line, /(^|[\s/:])\.\.(\/|\s|$)/, `${file}: ${line.trim()}`);
    assert.doesNotMatch(text, /\/\.\.\//, `${file} builds a path through '..'`);
  }
  const ci = readWorkflow("ci.yml");
  for (const id of ["terminal-smoke", "pty-governor", "pty-rest"]) {
    const { body } = ci.jobs[id];
    assert.match(body, /GH_GLANCE_TEST_EVIDENCE_DIR: \$\{\{ runner\.temp \}\}\/evidence/, `${id} writes evidence`);
    assert.match(body, /path: \$\{\{ runner\.temp \}\}\/evidence/, `${id} uploads that evidence`);
  }
});

// Count full-suite invocations per event by combining the real routing code
// with the job bodies that run each suite.
const FULL_SUITES = { sustained: /test-select\.mjs run recovery efficiency/,
  "pty-governor": /test-select\.mjs run pty:governor/, "pty-rest": /test-select\.mjs run pty:rest/ };

test("WF-04 simulated events: one authoritative selection, zero full suites on develop, main and publish", () => {
  const ci = readWorkflow("ci.yml");
  for (const [job, pattern] of Object.entries(FULL_SUITES)) assert.match(ci.jobs[job].body, pattern);
  const fullSuites = (plan) => Object.keys(FULL_SUITES).filter((job) => plan.jobs.includes(job));
  const events = {
    developPush: planCi({ event: "push", repository: REPO, baseRef: "develop" }),
    releasePr: planCi({ event: "pull_request", repository: REPO, baseRef: "main", headRef: "develop",
      headRepository: REPO, changedPaths: [".github/workflows/ci.yml"] }),
    mainPush: planCi({ event: "push", repository: REPO, baseRef: "main" }),
    featurePr: planCi({ event: "pull_request", repository: REPO, baseRef: "develop", headRef: "fix",
      headRepository: REPO, changedPaths: ["test/args.test.mjs"] }),
    coordinationPr: planCi({ event: "pull_request", repository: REPO, baseRef: "develop", headRef: "fix",
      headRepository: REPO, changedPaths: ["index.mjs"] }),
  };
  assert.deepEqual(fullSuites(events.releasePr), Object.keys(FULL_SUITES));
  assert.deepEqual(fullSuites(events.developPush), []);
  assert.deepEqual(fullSuites(events.mainPush), []);
  assert.deepEqual(fullSuites(events.featurePr), [], "an ordinary PR to develop runs quick checks only");
  assert.deepEqual(fullSuites(events.coordinationPr), Object.keys(FULL_SUITES),
    "a PR to develop that may affect coordination gets the broad suites, but no pack");
  assert.ok(!events.coordinationPr.jobs.includes("pack"));
  assert.ok(events.releasePr.jobs.includes("pack") && !events.developPush.jobs.includes("pack") &&
    !events.featurePr.jobs.includes("pack") && !events.mainPush.jobs.includes("pack"));

  const release = readWorkflow("release.yml");
  assert.doesNotMatch(release.text, /npm (test|ci)\b|test-select|npm run|npm pack/,
    "the publisher must not repeat suites or repack");
});

test("WF-05 release.yml: published-release trigger, least privilege, serialized, verifier first", () => {
  const release = readWorkflow("release.yml");
  assert.equal(release.on.trim(), "release:\n    types: [published]");
  assert.equal(release.top("permissions").trim(), "contents: read");
  assert.match(release.top("concurrency"), /cancel-in-progress: false/);
  const withIdToken = Object.entries(release.jobs).filter(([, job]) => /id-token: write/.test(job.body)).map(([id]) => id);
  assert.deepEqual(withIdToken, ["publish"]);
  assert.equal(release.jobs.publish.environment, "npm");
  assert.deepEqual(release.jobs.publish.needs, ["verify"]);
  assert.doesNotMatch(release.jobs.verify.body + release.jobs.delivery.body, /id-token/);
  const verifySteps = release.jobs.verify.body;
  const mainCheckout = verifySteps.indexOf("ref: main");
  const bootstrap = verifySteps.indexOf("protected-main/scripts/release-candidate.mjs bootstrap");
  const taggedCheckout = verifySteps.indexOf("path: tagged");
  assert.ok(mainCheckout >= 0 && mainCheckout < bootstrap && bootstrap < taggedCheckout,
    "the bootstrap runs protected main's verifier before any tagged code is checked out");
  assert.match(release.jobs.publish.body, /artifact-ids: \$\{\{ needs\.verify\.outputs\.artifact-id \}\}/);
  // Untrusted-looking values reach shells through env, never interpolation.
  for (const [id, job] of Object.entries(release.jobs)) {
    assert.ok(!job.body.split("\n").some((line) => /^\s+run: .*\$\{\{/.test(line)), `${id}: inline expression in a run line`);
  }
  assert.match(release.jobs.publish.body, /steps\.registry\.outputs\.action == 'publish'/);
  const code = release.text.split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");
  assert.doesNotMatch(code, /NPM_TOKEN|NODE_AUTH_TOKEN|secrets\./, "publication is OIDC only");
});

test("WF-06 coverage leaves the push path; security checks keep their triggers", () => {
  const coverage = readWorkflow("coverage.yml");
  assert.doesNotMatch(coverage.on, /push:/);
  assert.match(coverage.on, /schedule:/);
  assert.match(coverage.on, /workflow_dispatch:/);
  const codeql = readWorkflow("codeql.yml");
  assert.match(codeql.on, /pull_request:\n {4}branches: \[main, develop\]/);
  assert.match(readWorkflow("dependency-review.yml").on, /pull_request:/);
  const sutura = readWorkflow("sutura.yml");
  assert.match(sutura.on, /workflows: \["CI"\]/);
});

test("WF-07 every runtime pin in the workflows is a reviewed PINS value", () => {
  const nodePins = new Set([PINS.node22, PINS.node24]);
  for (const name of ["ci.yml", "release.yml", "coverage.yml"]) {
    const { text } = readWorkflow(name);
    for (const [, version] of text.matchAll(/node-version: ([\d.]+)/g)) {
      assert.ok(nodePins.has(version), `${name}: node ${version} is not a PINS value`);
    }
    for (const [, version] of text.matchAll(/npm@([\w.]+)/g)) {
      assert.equal(version, PINS.npm, `${name}: npm@${version} is not the pinned npm`);
    }
  }
});
