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
  const { stdout } = await execFileAsync(process.execPath, [ENTRY, "--doctor", ...args], {
    cwd: REPO,
    env: {
      ...process.env,
      PATH: `${FIXTURE_BIN}:${process.env.PATH}`,
      GH_GLANCE_FIXTURE_LOG: "/dev/null",
      ...env,
    },
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
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
  // One block per diagnostic probe, including failure-triggered repository access.
  assert.equal(out.match(/^ {2}classified {2}/gm)?.length, 7, out);
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

test("--doctor classifies a SAML 403 as an auth problem, end to end", async () => {
  // The executable statement of the whole plan's central claim: a lapsed
  // enterprise SAML session must never be reported as a disabled feature. The
  // fixture gh fails the api calls on demand, which is the only way to produce
  // this error without a real tenant.
  const message = "HTTP 403: Resource protected by organization SAML enforcement";
  const out = await doctor({ env: { GH_GLANCE_FIXTURE_FAIL: message } });
  assert.match(out, /^ {2}classified {2}auth-problem$/m, out);
  assert.match(out, /^ {2}http {8}403$/m, out);
  assert.ok(out.includes(message), "the verbatim tenant message must survive into the report");
  assert.ok(!out.includes("not enabled"), "a SAML lapse was reported as a disabled feature");
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
