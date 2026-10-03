// Failure evidence ownership for terminal captures (G04). Each case runs a
// scratch test file under the real node:test runner, so the afterEach/after
// contract in evidence.mjs is exercised exactly as PTY files use it.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { CASE_LIMIT_BYTES, ROOT_LIMIT_BYTES, bound, evidenceRoot, redactor } from "./evidence.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SECRET = "fixture-secret-7f3a9c";

function runScratch(t, body, { prefill = 0, env: extraEnv = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "gh-glance-evidence-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const evidence = join(root, "evidence");
  if (prefill > 0) {
    // A sparse file: the cap reads sizes, not bytes.
    mkdirSync(evidence, { recursive: true });
    writeFileSync(join(evidence, "filler.bin"), "");
    truncateSync(join(evidence, "filler.bin"), prefill);
  }
  // The scratch file lives outside the checkout and imports the real helpers.
  const file = join(root, "scratch.test.mjs");
  const helper = (name) => JSON.stringify(pathToFileURL(join(HERE, name)).href);
  writeFileSync(file, `import assert from "node:assert/strict";\nimport { test } from "node:test";\n` +
    `import { capture, lazyCapture } from ${helper("capture.mjs")};\n` +
    `import { finishCapture, stageCapture } from ${helper("evidence.mjs")};\n${body}`);
  const env = { ...process.env, GH_GLANCE_TEST_EVIDENCE_DIR: evidence, ...extraEnv };
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, ["--test", file], { encoding: "utf8", env });
  const bundles = [];
  if (existsSync(evidence)) {
    for (const fileDir of readdirSync(evidence, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
      for (const bundle of readdirSync(join(evidence, fileDir.name))) {
        const dir = join(evidence, fileDir.name, bundle);
        const read = (name) => existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8") : null;
        bundles.push({ dir, meta: JSON.parse(read("meta.json")), terminal: read("terminal.txt"),
          calls: read("fixture-calls.txt"), frames: read("frames.json") });
      }
    }
  }
  return { run, bundles, evidence };
}

// A capture without a terminal: the same staging and outcome calls as
// capture(), for cases about retention policy rather than terminal bytes.
const PLANTED = `import { writeFileSync } from "node:fs";
import { withEvidence } from ${JSON.stringify(pathToFileURL(join(HERE, "evidence.mjs")).href)};
const planted = (text) => withEvidence({ kind: "planted", cols: 10, rows: 5 }, {}, (bundle) => {
  writeFileSync(bundle.out, text);
  return { exitCode: 143, finalFrame: { lines: [text] } };
});`;

const REAL_CAPTURE = `capture({ cols: 80, rows: 24, settle: 3, args: "--repo acme/${SECRET}",
  env: { GH_TOKEN: "${SECRET}" } })`;

test("EVIDENCE-01 a later assertion failure retains the redacted capture bundle", (t) => {
  const { run, bundles } = runScratch(t, `test("asserts on a real frame", () => {
    const result = ${REAL_CAPTURE};
    assert.equal(result.exitCode, 999, "planted outer assertion failure");
  });\n`);
  assert.equal(run.status, 1, run.stdout);
  assert.match(run.stdout, /capture evidence retained: /);
  assert.equal(bundles.length, 1);
  const [bundle] = bundles;
  assert.equal(bundle.meta.test, "asserts on a real frame");
  assert.equal(bundle.meta.cols, 80);
  assert.equal(bundle.meta.timeoutMs, 28_000);
  assert.equal(bundle.meta.runtime, process.version);
  assert.match(bundle.meta.retainedBecause, /test failed/);
  assert.ok(bundle.terminal.length > 0, "terminal bytes retained");
  assert.ok(bundle.calls.length > 0, "fixture gh calls retained");
  assert.match(bundle.terminal, /\[REDACTED\]/, "the secret shown on screen was scrubbed");
  assert.ok(JSON.parse(bundle.frames).finalFrame.lines.length > 0, "parsed frames retained");
  for (const text of [bundle.terminal, bundle.calls, bundle.frames, JSON.stringify(bundle.meta)]) {
    assert.equal(text.includes(SECRET), false);
  }
});

test("EVIDENCE-02 a passing test leaves no evidence behind", (t) => {
  const { run, bundles } = runScratch(t, `test("passes", () => {
    assert.equal(${REAL_CAPTURE}.exitCode, 143);
  });\n`);
  assert.equal(run.status, 0, run.stdout);
  assert.deepEqual(bundles, []);
});

test("EVIDENCE-03 a shared capture is retained when a later test using it fails", (t) => {
  const { run, bundles } = runScratch(t, `${PLANTED}
  const shared = lazyCapture(() => planted("shared frame"));
  test("first user passes", () => { assert.equal(shared().exitCode, 143); });
  test("second user fails", () => { assert.equal(shared().exitCode, 999); });\n`);
  assert.equal(run.status, 1, run.stdout);
  assert.equal(bundles.length, 1);
  assert.equal(bundles[0].meta.shared, true);
  assert.match(bundles[0].meta.retainedBecause, /shared capture/);
});

test("EVIDENCE-04 a child failure keeps its partial output and exit details", (t) => {
  const { run, bundles } = runScratch(t, `test("child fails", async () => {
    const bundle = stageCapture({ kind: "planted", cols: 10, rows: 5 });
    (await import("node:fs")).writeFileSync(bundle.out, "partial frame");
    const error = Object.assign(new Error("spawnSync /bin/sh ETIMEDOUT"), { code: "ETIMEDOUT", signal: "SIGTERM" });
    finishCapture(bundle, { error });
    throw error;
  });\n`);
  assert.equal(run.status, 1, run.stdout);
  assert.equal(bundles.length, 1);
  assert.equal(bundles[0].terminal, "partial frame");
  assert.deepEqual(bundles[0].meta.exit, { code: "ETIMEDOUT", signal: "SIGTERM", killed: false });
  assert.match(bundles[0].meta.error, /ETIMEDOUT/);
});

test("EVIDENCE-05 a full evidence root keeps only a labeled metadata record", (t) => {
  const { run, bundles } = runScratch(t, `${PLANTED}
  test("fails", () => { assert.equal(planted("frame").exitCode, 999); });\n`, { prefill: ROOT_LIMIT_BYTES });
  assert.equal(run.status, 1, run.stdout);
  assert.equal(bundles.length, 1);
  assert.equal(bundles[0].terminal, null);
  assert.match(bundles[0].meta.omitted, /20971520-byte limit/);
});

test("EVIDENCE-07 several failed captures in one test stay inside the per-test limit", (t) => {
  const { run, bundles } = runScratch(t, `test("many big captures", async () => {
    const { writeFileSync } = await import("node:fs");
    for (let index = 0; index < 3; index += 1) {
      const bundle = stageCapture({ kind: "planted", cols: 10, rows: 5 });
      writeFileSync(bundle.out, "x".repeat(1536 * 1024));
      finishCapture(bundle);
    }
    throw new Error("planted");
  });\n`);
  assert.equal(run.status, 1, run.stdout);
  assert.equal(bundles.length, 3);
  const kept = bundles.filter((bundle) => bundle.terminal !== null);
  assert.equal(kept.length, 1, "only the first full bundle fits in 2 MiB");
  const total = kept.reduce((sum, bundle) => sum + Buffer.byteLength(bundle.terminal) +
    Buffer.byteLength(bundle.calls) + Buffer.byteLength(bundle.frames ?? "") + Buffer.byteLength(JSON.stringify(bundle.meta)), 0);
  assert.ok(total <= CASE_LIMIT_BYTES, `${total} bytes retained for one test`);
  assert.ok(bundles.filter((bundle) => bundle.terminal === null).every((bundle) => /per-test limit/.test(bundle.meta.omitted)));
});

test("EVIDENCE-08 the smoke guard rejects a capture taken outside any test", (t) => {
  const body = `${PLANTED}\nconst eager = planted("module scope");\ntest("uses it", () => { assert.equal(eager.exitCode, 143); });\n`;
  const guarded = runScratch(t, body, { env: { GH_GLANCE_CAPTURE_REQUIRE_TEST: "1" } });
  assert.notEqual(guarded.run.status, 0);
  assert.match(guarded.run.stdout + guarded.run.stderr, /capture taken outside a test: wrap module-scope captures in lazyCapture/);
  assert.equal(runScratch(t, body).run.status, 0, "without the smoke flag a module-scope capture still works");
  assert.equal(runScratch(t, `${PLANTED}\nconst lazy = lazyCapture(() => planted("lazy"));\n` +
    `test("uses it", () => { assert.equal(lazy().exitCode, 143); });\n`, { env: { GH_GLANCE_CAPTURE_REQUIRE_TEST: "1" } }).run.status, 0);
});

test("EVIDENCE-06 bounds and redaction are explicit", () => {
  const text = "a".repeat(5000) + "TAIL";
  const bounded = bound(text, 1024);
  assert.ok(Buffer.byteLength(bounded) <= 1024);
  assert.match(bounded, /\[\.\.\. truncated \d+ bytes \.\.\.\]/);
  assert.ok(bounded.endsWith("TAIL"));
  const redact = redactor({ GH_TOKEN: "abcdef123", HOME: "/Users/someone", API_SECRET: "short",
    NEBIUS_API_KEY: "key-value-1", SESSION_COOKIE: "cookie-value", GITHUB_PAT: "pat-value-1", PATH: "/usr/bin:/bin" });
  assert.equal(redact("t=abcdef123 home=/Users/someone k=key-value-1 c=cookie-value p=pat-value-1 path=/usr/bin:/bin"),
    "t=[REDACTED] home=/Users/someone k=[REDACTED] c=[REDACTED] p=[REDACTED] path=/usr/bin:/bin");
  assert.equal(redact("short"), "short", "values under six characters are too generic to scrub");
  assert.match(evidenceRoot({}), new RegExp(`gh-glance-test-evidence/run-${process.ppid}$`),
    "the default root is per test run");
  assert.equal(evidenceRoot({ GH_GLANCE_TEST_EVIDENCE_DIR: "/x" }), "/x");
});
