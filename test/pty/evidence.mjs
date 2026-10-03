// Failure evidence for terminal captures.
//
// Every capture stages its raw terminal bytes, fixture call log and timing in a
// private directory. A test-file `afterEach` hook (verified on Node 22.22.2 and
// 24.21.0: it receives the finished TestContext with `passed`) decides what
// happens next:
//
// - a capture taken inside a test that passed is deleted at once;
// - a capture taken inside a failing test is retained;
// - a shared capture (taken at module scope or through `lazyCapture`, then
//   asserted on by several tests) is kept until the file ends and retained if
//   any test in the file failed, because a later assertion can fail on it.
//
// Retained bundles are redacted and bounded (2 MiB per failed test, 20 MiB per
// evidence root) and are written under GH_GLANCE_TEST_EVIDENCE_DIR, or
// <tmpdir>/gh-glance-test-evidence/run-<runner pid> when it is unset, so old
// local runs never crowd out a new one. Hooks are only registered under the
// test runner, so scripts such as readme-sample.mjs keep their plain output and
// delete every capture immediately.
//
// Known limit: node:test reports `passed` as true in afterEach for a test that
// fails later in its own `t.after` hook, and for a parent whose subtest failed
// (the subtest itself is reported). Such a capture is deleted. No PTY file
// uses subtests or asserts in `t.after` today.

import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, afterEach, beforeEach } from "node:test";

export const CASE_LIMIT_BYTES = 2 * 1024 * 1024;
export const ROOT_LIMIT_BYTES = 20 * 1024 * 1024;
const SENSITIVE_KEY = /TOKEN|SECRET|PASSWORD|PASSPHRASE|CREDENTIAL|PRIVATE|AUTH|KEY|(?:^|_)PAT(?:_|$)|COOKIE|SESSION/i;

const underTestRunner = process.env.NODE_TEST_CONTEXT !== undefined ||
  /\.test\.mjs$/.test(process.argv[1] ?? "");

let stagingRoot = null;
let currentTest = null;
let sharedDepth = 0;
let fileFailed = false;
let sequence = 0;
const perTest = [];
const retainedBytesByTest = new Map();
const shared = [];

function staging() {
  stagingRoot ??= mkdtempSync(join(tmpdir(), "gh-glance-pty-stage-"));
  return stagingRoot;
}

export function evidenceRoot(env = process.env) {
  return env.GH_GLANCE_TEST_EVIDENCE_DIR || join(tmpdir(), "gh-glance-test-evidence", `run-${process.ppid}`);
}

// Values of sensitive-looking variables are replaced wherever they appear.
export function redactor(...environments) {
  const secrets = environments.flatMap((env) => Object.entries(env ?? {}))
    .filter(([key, value]) => SENSITIVE_KEY.test(key) && typeof value === "string" && value.length >= 6)
    .map(([, value]) => value)
    .sort((a, b) => b.length - a.length);
  return (text) => secrets.reduce((result, secret) => result.split(secret).join("[REDACTED]"), text);
}

// Keep the start (setup and first frames) and the end (the failure) of an
// oversized text, with an explicit marker for what was dropped.
export function bound(text, limit) {
  const bytes = Buffer.byteLength(text);
  if (bytes <= limit) return text;
  const keep = Math.floor((limit - 128) / 2);
  const buffer = Buffer.from(text);
  return `${buffer.subarray(0, keep).toString("utf8")}\n[... truncated ${bytes - 2 * keep} bytes ...]\n` +
    buffer.subarray(buffer.length - keep).toString("utf8");
}

function directorySize(path) {
  if (!existsSync(path)) return 0;
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    total += entry.isDirectory() ? directorySize(child) : statSync(child).size;
  }
  return total;
}

// A capture calls this before launching run.sh and writes its terminal output
// to `bundle.out`. Outside the test runner it behaves like the old temporary
// files: finishCapture removes everything as soon as the capture ends.
export function stageCapture(meta) {
  const shared = currentTest == null || sharedDepth > 0;
  // The terminal smoke selection sets this so an excluded case can never cost a
  // capture taken at import time (any form: assignment, IIFE or hook).
  if (underTestRunner && process.env.GH_GLANCE_CAPTURE_REQUIRE_TEST === "1" && currentTest == null) {
    throw new Error("capture taken outside a test: wrap module-scope captures in lazyCapture");
  }
  sequence += 1;
  let dir;
  if (underTestRunner) {
    dir = join(staging(), `capture-${String(sequence).padStart(3, "0")}`);
    mkdirSync(dir, { mode: 0o700 });
  } else {
    dir = mkdtempSync(join(tmpdir(), "gh-glance-pty-"));
  }
  return {
    dir,
    out: join(dir, "terminal.raw"),
    meta: { ...meta, test: currentTest, shared, runtime: process.version,
      platform: `${process.platform}-${process.arch}`, startedAt: new Date().toISOString() },
    started: performance.now(),
  };
}

// Records the outcome. Frames and the caller's environment are only kept as
// references; they are serialized and redacted only if the bundle is retained.
export function finishCapture(bundle, { error = null, env = {}, result = null } = {}) {
  bundle.meta.durationMs = Math.round(performance.now() - bundle.started);
  bundle.meta.error = error ? String(error.message ?? error) : null;
  bundle.meta.exit = error ? { code: error.code ?? null, signal: error.signal ?? null, killed: error.killed ?? false } : null;
  if (!underTestRunner) {
    rmSync(bundle.dir, { recursive: true, force: true });
    return;
  }
  bundle.env = env;
  if (result) {
    bundle.frames = { exitCode: result.exitCode, finalFrame: result.finalFrame,
      liveScreen: result.liveScreen, afterRestore: result.afterRestore };
  }
  (bundle.meta.shared ? shared : perTest).push(bundle);
}

// The one ownership path for capture and captureAsync: stage, run, then record
// the result or the error (and rethrow it).
export function withEvidence(meta, env, run) {
  const bundle = stageCapture(meta);
  const fail = (error) => {
    finishCapture(bundle, { error, env });
    throw error;
  };
  let value;
  try {
    value = run(bundle);
  } catch (error) {
    fail(error);
  }
  if (value instanceof Promise) {
    return value.then((result) => {
      finishCapture(bundle, { env, result });
      return result;
    }, fail);
  }
  finishCapture(bundle, { env, result: value });
  return value;
}

const PART_LIMITS = { "terminal.txt": 1536 * 1024, "fixture-calls.txt": 128 * 1024,
  "frames.json": 256 * 1024, "meta.json": 64 * 1024 };
let rootUsed = null;

function retain(bundle, reason) {
  const root = evidenceRoot();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  // Measured once per process, then tracked: a soft cap, not a lock.
  rootUsed ??= directorySize(root);
  const target = join(root, `${basename(process.argv[1] ?? "capture")}-${process.pid}`, basename(bundle.dir));
  mkdirSync(target, { recursive: true, mode: 0o700 });
  const sizeOf = (name) => existsSync(join(bundle.dir, name)) ? statSync(join(bundle.dir, name)).size : 0;
  // The four parts together stay under CASE_LIMIT_BYTES for one capture; decide
  // omission from upper bounds before reading or redacting anything.
  const upper = Math.min(sizeOf("terminal.raw"), PART_LIMITS["terminal.txt"]) +
    Math.min(sizeOf("terminal.raw.calls"), PART_LIMITS["fixture-calls.txt"]) +
    PART_LIMITS["frames.json"] + PART_LIMITS["meta.json"];
  const testKey = bundle.meta.test ?? "(shared)";
  const testBytes = retainedBytesByTest.get(testKey) ?? 0;
  const omitted = rootUsed + upper > ROOT_LIMIT_BYTES
    ? `evidence root already holds ${rootUsed} bytes; ${ROOT_LIMIT_BYTES}-byte limit`
    : testBytes + upper > CASE_LIMIT_BYTES
      ? `this test already retained ${testBytes} bytes; ${CASE_LIMIT_BYTES}-byte per-test limit`
      : null;
  const redact = redactor(process.env, bundle.env);
  const meta = (extra) => bound(redact(`${JSON.stringify({ ...bundle.meta, retainedBecause: reason, ...extra }, null, 2)}\n`),
    PART_LIMITS["meta.json"]);
  if (omitted) {
    writeFileSync(join(target, "meta.json"), meta({ omitted }), { mode: 0o600 });
  } else {
    const read = (name) => existsSync(join(bundle.dir, name)) ? readFileSync(join(bundle.dir, name), "utf8") : "";
    const files = {
      "terminal.txt": read("terminal.raw"),
      "fixture-calls.txt": read("terminal.raw.calls"),
      "frames.json": bundle.frames ? `${JSON.stringify(bundle.frames, null, 2)}\n` : "",
    };
    let size = 0;
    for (const [name, text] of Object.entries(files)) {
      const kept = bound(redact(text), PART_LIMITS[name]);
      size += Buffer.byteLength(kept);
      writeFileSync(join(target, name), kept, { mode: 0o600 });
    }
    const metaText = meta({});
    size += Buffer.byteLength(metaText);
    writeFileSync(join(target, "meta.json"), metaText, { mode: 0o600 });
    retainedBytesByTest.set(testKey, testBytes + size);
    rootUsed += size;
  }
  rmSync(bundle.dir, { recursive: true, force: true });
  return target;
}

function discard(bundles) {
  for (const bundle of bundles.splice(0)) rmSync(bundle.dir, { recursive: true, force: true });
}

if (underTestRunner) {
  beforeEach((t) => { currentTest = t.name; });
  afterEach((t) => {
    currentTest = null;
    if (t.passed) {
      discard(perTest);
      return;
    }
    fileFailed = true;
    for (const bundle of perTest.splice(0)) {
      t.diagnostic(`capture evidence retained: ${retain(bundle, `test failed: ${t.name}`)}`);
    }
  });
  after(() => {
    if (fileFailed) {
      const paths = shared.splice(0).map((bundle) => retain(bundle, "shared capture in a file with a failing test"));
      if (paths.length > 0) process.stderr.write(`shared capture evidence retained:\n${paths.join("\n")}\n`);
    }
    discard(shared);
    discard(perTest);
    if (stagingRoot) rmSync(stagingRoot, { recursive: true, force: true });
  });
}

// Memoize a capture that several tests assert on, so a name-filtered run only
// spawns the captures its selected tests actually use.
export function lazyCapture(take) {
  let outcome = null;
  return () => {
    if (outcome === null) {
      sharedDepth += 1;
      try {
        outcome = { value: take() };
      } catch (error) {
        outcome = { error };
      } finally {
        sharedDepth -= 1;
      }
    }
    if (outcome.error) throw outcome.error;
    return outcome.value;
  };
}
