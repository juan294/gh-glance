// `--doctor` is a report meant to be pasted into a chat window or attached to a
// bug report, which makes it a disclosure surface before it is a diagnostic.
// These tests pin the two properties that follow from that: nothing
// credential-shaped survives redaction, and the classification the report
// prints is the one the dashboard's own predicates would reach -- because a
// report that guesses differently from the code is worse than no report.
//
// package.json globs test/*.test.mjs, so this file needs no config change.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

import { redact, classify } from "../index.mjs";

const execFileAsync = promisify(execFile);
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = join(REPO, "index.mjs");
const FIXTURE_BIN = join(REPO, "test", "pty", "fixtures");

test("redact removes every token shape, anywhere in the text", () => {
  for (const token of [
    "gho_0123456789abcdefghij",
    "ghp_ABCDEFGHIJKLMNOPQRST",
    "ghu_0123456789abcdefghij",
    "ghs_0123456789abcdefghij",
    "ghr_0123456789abcdefghij",
    "github_pat_11ABCDE_0123456789abcdefghij",
  ]) {
    const out = redact(`token is ${token} ok`);
    assert.ok(!out.includes(token), token);
    assert.ok(out.includes("<redacted-token>"), token);
  }
});

test("redact strips credentials from proxy and remote URLs", () => {
  const out = redact("HTTPS_PROXY=http://alice:hunter2@proxy.corp:8080");
  assert.ok(!out.includes("hunter2"), out);
  assert.ok(out.includes("proxy.corp:8080"), out);

  // gh quotes the URL it failed on, so a remote with an embedded credential is
  // a real path for one to reach the report.
  const remote = redact("https://octocat:ghp_ABCDEFGHIJKLMNOPQRST@github.com/acme/widget.git");
  assert.ok(!remote.includes("ghp_ABCDEFGHIJKLMNOPQRST"), remote);
  assert.ok(!remote.includes("octocat:"), remote);
});

test("redact leaves ordinary diagnostic text intact", () => {
  // The verbatim tenant error is the payload of the whole command. Redaction
  // that ate it would defeat the purpose.
  const s = "HTTP 403: Resource protected by organization SAML enforcement";
  assert.equal(redact(s), s);
  assert.equal(redact("gh version 2.97.0 (2026-07-01)"), "gh version 2.97.0 (2026-07-01)");
});

test("classify agrees with the dashboard's own predicates", () => {
  assert.equal(classify(null), "ok");
  assert.equal(classify({ stderr: "HTTP 403: API rate limit exceeded" }), "rate-limited");
  assert.equal(
    classify({ stderr: "HTTP 403: Resource protected by organization SAML enforcement" }),
    "auth-problem",
  );
  assert.equal(classify({ stderr: "HTTP 404: Not Found" }), "unavailable");
  assert.equal(classify({ stderr: "dial tcp: lookup api.github.com" }), "other");
});

test("rate limiting outranks the auth marker", () => {
  // Both arrive as a 403. Reading a rate limit as a permissions problem would
  // put the endpoint on the wrong ladder and tell the user to re-authorize
  // something that is fine -- so the ordering is asserted, not assumed.
  assert.equal(classify({ stderr: "HTTP 403: API rate limit exceeded" }), "rate-limited");
});

// The report itself. --doctor exits before ink is imported, so a plain child
// process is enough -- no pty needed.
async function doctor({ env = {}, args = [] } = {}) {
  const root = env.XDG_CONFIG_HOME ?? mkdtempSync(join(tmpdir(), "gh-glance-doctor-case-"));
  try {
    const { stdout } = await execFileAsync(process.execPath, [ENTRY, "--doctor", ...args], {
      cwd: REPO,
      env: {
        ...process.env,
        PATH: `${FIXTURE_BIN}:${process.env.PATH}`,
        GH_GLANCE_FIXTURE_LOG: "/dev/null",
        XDG_CONFIG_HOME: root,
        ...env,
      },
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout;
  } finally {
    if (!env.XDG_CONFIG_HOME) rmSync(root, { recursive: true, force: true });
  }
}

function probeBlock(report, name) {
  const marker = `  ${name}\n`;
  const start = report.indexOf(marker);
  assert.notEqual(start, -1, `missing ${name} probe in report`);
  const end = report.indexOf("\n\n", start);
  return report.slice(start, end === -1 ? undefined : end);
}

test("--doctor exits 0 through a pipe and prints a complete report", async () => {
  // execFile gives the child a pipe for stdout, which is precisely the
  // condition the dashboard refuses to start under (exit 1). A reporting
  // command must return before that guard.
  const out = await doctor();
  assert.match(out, /gh-glance doctor/);
  assert.match(out, /Authenticated hosts/);
  assert.match(out, /Repository target/);
  assert.match(out, /Environment/);
  assert.match(out, /Endpoint probes/);
  assert.match(out, /^ {2}Repository access$/m);
  // One block per diagnostic request, including the bounded Security priority lanes.
  assert.equal(out.match(/^ {2}classified {2}/gm)?.length, 10, out);
});

test("--doctor reports governor health without a raw scope identifier", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gh-glance-doctor-governor-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const out = await doctor({
    env: { XDG_CONFIG_HOME: root },
    args: ["--repo", "acme/widget"],
  });
  assert.match(out, /API governor\n------------/);
  assert.match(out, /^status {12}healthy$/m);
  assert.match(out, /^live leases {7}0$/m);
  assert.ok(!/rate-governor-v1-|[0-9a-f]{64}/.test(out), out);
});

test("--doctor never prints a token that was planted in its environment", async () => {
  const planted = "ghp_PLANTEDTOKEN0123456789";
  const out = await doctor({
    env: {
      GH_TOKEN: planted,
      GH_ENTERPRISE_TOKEN: `${planted}X`,
      GITHUB_EMU_TOKEN: `${planted}Y`,
      HTTPS_PROXY: "http://alice:hunter2@proxy.corp:8080",
    },
  });
  assert.ok(!out.includes("PLANTEDTOKEN"), "a token value reached the report");
  assert.ok(!out.includes("hunter2"), "a proxy credential reached the report");
  assert.ok(!/Authorization/i.test(out), "an authorization header reached the report");
  // Presence is the useful signal and is still reported, including for a
  // variable the code never names explicitly.
  assert.match(out, /^GH_TOKEN {10}set$/m);
  assert.match(out, /^GITHUB_EMU_TOKEN {2}set$/m);
  assert.match(out, /^HTTPS_PROXY.*http:\/\/proxy\.corp:8080$/m);
});

test("--doctor reports rather than exits when gh is missing", async () => {
  // preflight() exits 3 on a missing gh and on a cwd outside a repository.
  // Those are exactly the conditions worth reporting.
  const out = await doctor({ env: { PATH: "/nonexistent" } });
  assert.match(out, /gh-glance doctor/);
  assert.match(out, /Endpoint probes/);
});

test("--doctor spends nothing when the free budget probe fails", async () => {
  const message = "HTTP 403: Resource protected by organization SAML enforcement";
  const out = await doctor({ env: { GH_GLANCE_FIXTURE_FAIL: message } });
  assert.match(out, /^REST core {9}unavailable$/m);
  assert.equal(out.match(/^ {2}classified {2}skipped$/gm)?.length, 10, out);
});

test("--doctor classifies a failed REST diagnostic", async () => {
  const message = "To get started with GitHub CLI, please run: gh auth login";
  const out = await doctor({
    env: { GH_GLANCE_FIXTURE_FAIL: message, GH_GLANCE_FIXTURE_FAIL_ON: "issue" },
  });
  const block = probeBlock(out, "Issues (issue list)");
  assert.match(block, /^ {2}classified {2}auth-problem$/m, block);
  assert.ok(block.includes(message), block);
});

test("--doctor classifies a failed GraphQL diagnostic", async () => {
  const message =
    "GraphQL: Could not resolve to a Repository with the name 'Nvteca/cashflor-forecast'. (repository)";
  const out = await doctor({
    env: { GH_GLANCE_FIXTURE_FAIL: message, GH_GLANCE_FIXTURE_FAIL_ON: "issue" },
  });
  const block = probeBlock(out, "Issues (issue list)");
  assert.match(block, /^ {2}classified {2}unavailable$/m, block);
  assert.ok(block.includes(message), block);
});

test("--doctor reports a failed repository-access probe separately", async () => {
  const message =
    "GraphQL: Could not resolve to a Repository with the name 'Nvteca/cashflor-forecast'. (repository)";
  const out = await doctor({
    env: { GH_GLANCE_FIXTURE_FAIL: message, GH_GLANCE_FIXTURE_FAIL_ON: "repo" },
  });
  const repositoryBlock = probeBlock(out, "Repository access");
  assert.match(repositoryBlock, /^ {2}classified {2}unavailable$/m, repositoryBlock);
  assert.ok(repositoryBlock.includes(message), repositoryBlock);

  const actions = probeBlock(out, "Actions (run list)");
  assert.match(actions, /^ {2}outcome {5}ok /m, actions);
  assert.match(actions, /^ {2}classified {2}ok$/m, actions);
  for (const name of ["Issues (issue list)", "Pull requests (pr list)"]) {
    const block = probeBlock(out, name);
    assert.match(block, /^ {2}outcome {5}ok /m, block);
    assert.match(block, /^ {2}classified {2}ok$/m, block);
  }
});

test("--doctor reports the host-qualified target it was given", async () => {
  const out = await doctor({ args: ["--repo", "tenant.ghe.com/acme/widget"] });
  assert.match(out, /^host {14}tenant\.ghe\.com$/m);
  assert.match(out, /^slug {14}acme\/widget$/m);
  assert.match(
    out,
    /argv {8}gh repo view tenant\.ghe\.com\/acme\/widget --json nameWithOwner,url,viewerPermission/,
  );
  // The D2 guard, stated in the report: the host travels as --hostname and
  // never as path text.
  assert.match(out, /argv {8}gh api repos\/acme\/widget\/.*--hostname tenant\.ghe\.com/);
  assert.ok(!out.includes("repos/tenant.ghe.com/"), out);
});

// GH_GLANCE_REFRESH is substituted in the IS_MAIN entry block, so unlike the
// --refresh flag it cannot be reached by calling validateArgs directly. These
// spawn a real child, which is the wiring under test.
test("GH_GLANCE_REFRESH sets the interval and is reported by name", async () => {
  const report = await doctor({ env: { GH_GLANCE_REFRESH: "30" } });
  assert.match(report, /GH_GLANCE_REFRESH\s+30/);
  assert.match(report, /this config spends .*refresh 30s/);
  // 1800 REST/hour at the default 5s, so a sixth of it at 30s.
  assert.match(report, /~300 REST/);
});

test("--refresh beats GH_GLANCE_REFRESH", async () => {
  const report = await doctor({ env: { GH_GLANCE_REFRESH: "30" }, args: ["--refresh", "10"] });
  assert.match(report, /this config spends .*refresh 10s/);
});

test("an out-of-range GH_GLANCE_REFRESH exits 2 naming the variable", async () => {
  // The same exit code and the same two messages a bad --refresh gets: a value
  // that arrived by environment must not fail more quietly than one typed.
  await assert.rejects(
    () => doctor({ env: { GH_GLANCE_REFRESH: "1" } }),
    (err) => err.code === 2 && /GH_GLANCE_REFRESH must be between/.test(err.stderr),
  );
});
