import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import {
  loadWidthPreferences,
  saveWidthPreferences,
  serializeWidthPreferences,
} from "../index.mjs";

function withTemporaryRoot(run) {
  const root = mkdtempSync(join(tmpdir(), "gh-glance-preferences-"));
  try {
    return run(root);
  } finally {
    // The root came from this exact mkdtempSync call. Never broaden cleanup to
    // tmpdir() or to a preference parent supplied by somebody else.
    rmSync(root, { recursive: true, force: true });
  }
}

function preferencePath(root) {
  return join(root, "config", "gh-glance", "preferences.json");
}

test("a missing width preference file loads empty preferences", () => {
  withTemporaryRoot((root) => {
    const loaded = loadWidthPreferences(preferencePath(root));

    assert.deepEqual(loaded.preferences, {});
    assert.equal(loaded.error ?? null, null);
  });
});

test("corrupt and unknown-version preference files load defaults without throwing", () => {
  withTemporaryRoot((root) => {
    const path = preferencePath(root);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "not json\n", "utf8");

    const corrupt = loadWidthPreferences(path);
    assert.deepEqual(corrupt.preferences, {});
    assert.ok(corrupt.error instanceof Error, "corrupt JSON should retain nonfatal metadata");

    writeFileSync(path, '{"version":2,"tabs":{"actions":{"branch":18}}}\n', "utf8");
    const future = loadWidthPreferences(path);
    assert.deepEqual(future.preferences, {});
  });
});

test("valid width preferences round-trip through the real filesystem", () => {
  withTemporaryRoot((root) => {
    const path = preferencePath(root);
    const overrides = Object.freeze({
      actions: Object.freeze({ workflow: 7, branch: 18 }),
      issues: Object.freeze({ author: 9 }),
    });
    const before = structuredClone(overrides);

    const saved = saveWidthPreferences(path, overrides);
    const loaded = loadWidthPreferences(path);

    assert.equal(saved.ok, true);
    assert.deepEqual(loaded.preferences, before);
    assert.equal(loaded.error ?? null, null);
    assert.deepEqual(overrides, before, "filesystem persistence must not mutate session state");
  });
});

test("saving requests private directory and file permissions", () => {
  withTemporaryRoot((root) => {
    const path = preferencePath(root);
    const saved = saveWidthPreferences(path, { actions: { branch: 18 } });

    assert.equal(saved.ok, true);
    if (process.platform !== "win32") {
      assert.equal(statSync(dirname(path)).mode & 0o777, 0o700);
      assert.equal(statSync(path).mode & 0o777, 0o600);
    }
  });
});

test("repeated saves atomically replace content without leaving a temp file", () => {
  withTemporaryRoot((root) => {
    const path = preferencePath(root);
    const first = { actions: { branch: 18 } };
    const latest = { issues: { author: 9 }, security: { age: 7 } };

    assert.equal(saveWidthPreferences(path, first).ok, true);
    assert.equal(saveWidthPreferences(path, latest).ok, true);

    assert.equal(readFileSync(path, "utf8"), serializeWidthPreferences(latest));
    assert.deepEqual(readdirSync(dirname(path)), ["preferences.json"]);
  });
});

test("a file used as the preference parent is a nonfatal save failure", () => {
  withTemporaryRoot((root) => {
    const blockedParent = join(root, "not-a-directory");
    const path = join(blockedParent, "preferences.json");
    const sessionPreferences = Object.freeze({
      actions: Object.freeze({ branch: 18 }),
    });
    const before = structuredClone(sessionPreferences);
    writeFileSync(blockedParent, "occupied\n", "utf8");

    const saved = saveWidthPreferences(path, sessionPreferences);

    assert.equal(saved.ok, false);
    assert.ok(saved.error instanceof Error);
    assert.deepEqual(sessionPreferences, before, "failed storage must preserve live session state");
    assert.deepEqual(readdirSync(root), ["not-a-directory"]);
  });
});

test("a failed atomic rename removes only its exact temporary file", () => {
  withTemporaryRoot((root) => {
    const path = preferencePath(root);
    mkdirSync(path, { recursive: true });

    const saved = saveWidthPreferences(path, { actions: { branch: 18 } });

    assert.equal(saved.ok, false);
    assert.ok(saved.error instanceof Error);
    assert.deepEqual(
      readdirSync(dirname(path)),
      ["preferences.json"],
      "the destination directory must remain and the same-directory temp must be gone",
    );
  });
});
