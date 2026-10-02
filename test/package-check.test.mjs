import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";

import {
  PACKAGE_FILES, checkInstalled, exerciseInstalled, inspectTarball, installPackage, parsePackJson, readTarEntries,
} from "../scripts/package-check.mjs";
import { packageEntries, packageTarball, rechecksum, tarball } from "./fixtures/tarball.mjs";

const VERSION = "9.9.9";
const SCRIPT = new URL("../scripts/package-check.mjs", import.meta.url).pathname;

test("PKG-01 the exact five-file fixture passes static inspection with stable digests", () => {
  const bytes = packageTarball({ version: VERSION });
  const result = inspectTarball(bytes, { expectedVersion: VERSION });
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.files, [...PACKAGE_FILES].sort());
  assert.match(result.sha256, /^[0-9a-f]{64}$/);
  assert.match(result.sha512, /^sha512-[A-Za-z0-9+/]+=*$/);
  assert.equal(inspectTarball(bytes).sha256, result.sha256);
  assert.deepEqual(Object.keys(result.fileSha256).sort(), [...PACKAGE_FILES].sort());
});

test("PKG-02 extra, missing, duplicate, unsafe and linked entries are rejected", () => {
  const cases = [
    [packageEntries({ files: { "package/test/secret.mjs": "x" } }), /unexpected file test\/secret\.mjs/],
    [packageEntries({ files: { "package/LICENSE": null } }), /missing LICENSE/],
    [[...packageEntries(), { name: "package/README.md", body: "again" }], /duplicate entry README\.md/],
    [[...packageEntries(), { name: "package/../evil.mjs", body: "x" }], /unsafe path/],
    [[...packageEntries(), { name: "/etc/evil", body: "x" }], /unsafe path/],
    [[...packageEntries({ files: { "package/README.md": null } }),
      { name: "package/README.md", type: "2", linkname: "/etc/passwd" }], /README\.md is not a regular file/],
  ];
  for (const [entries, pattern] of cases) {
    const result = inspectTarball(tarball(entries), { expectedVersion: VERSION });
    assert.equal(result.ok, false);
    assert.match(result.problems.join("\n"), pattern);
  }
});

test("PKG-03 wrong version, bin, exports or shebang fail before installation", () => {
  const cases = [
    [packageEntries(), { expectedVersion: "1.0.0" }, /package version 9\.9\.9 is not 1\.0\.0/],
    [packageEntries({ manifest: { bin: { other: "./index.mjs" } } }), {}, /unexpected bin/],
    [packageEntries({ manifest: { exports: { ".": "./index.mjs" } } }), {}, /exports must stay/],
    [packageEntries({ files: { "package/index.mjs": "console.log(1)\n" } }), {}, /lost its node shebang/],
    [packageEntries({ files: { "package/package.json": "{" } }), {}, /not valid JSON/],
  ];
  for (const [entries, options, pattern] of cases) {
    assert.match(inspectTarball(tarball(entries), options).problems.join("\n"), pattern);
  }
  assert.match(inspectTarball(Buffer.from("not gzip")).problems[0], /unreadable tarball/);
});

// Shapes an extractor could read differently from a naive reader: each must be
// refused outright, never interpreted.
test("PKG-04 extension headers, trailing data and corrupt headers are refused", () => {
  const raw = gunzipSync(packageTarball({ version: VERSION }));
  const endOfEntries = raw.length - 1024;
  const hidden = gunzipSync(tarball([{ name: "package/hidden.mjs", body: "x" }])).subarray(0, 1024);
  const afterOneZeroBlock = gzipSync(Buffer.concat([raw.subarray(0, endOfEntries), Buffer.alloc(512), hidden, Buffer.alloc(1024)]));
  const badChecksum = Buffer.from(raw);
  badChecksum[0] ^= 1;
  const notUstar = Buffer.from(raw);
  notUstar.write("xxxxx", 257);
  rechecksum(notUstar);
  const prefixed = Buffer.from(raw);
  prefixed.write("package", 345);
  rechecksum(prefixed);
  const pax = "path=package/hidden.mjs\n";
  const record = `${pax.length + String(pax.length).length + 1} ${pax}`;
  const cases = [
    [afterOneZeroBlock, /data after the end-of-archive block/],
    [gzipSync(badChecksum), /bad checksum/],
    [gzipSync(notUstar), /not POSIX ustar/],
    [gzipSync(prefixed), /uses a path prefix/],
    [tarball([{ name: "PaxHeader", type: "x", body: record }, ...packageEntries()]), /PaxHeader is not a regular file \(type x\)/],
    [tarball([{ name: "GlobalHead", type: "g", body: record }, ...packageEntries()]), /type g/],
    [tarball([{ name: "././@LongLink", type: "L", body: "package/hidden.mjs" }, ...packageEntries()]), /type L|unsafe path/],
    [gzipSync(raw.subarray(0, endOfEntries)), /no end-of-archive block/],
  ];
  for (const [bytes, pattern] of cases) {
    const result = inspectTarball(bytes, { expectedVersion: VERSION });
    assert.equal(result.ok, false, String(pattern));
    assert.match(result.problems.join("\n"), pattern);
  }
  assert.equal(readTarEntries(packageTarball({ version: VERSION })).length, 5);
});

test("PKG-05 the installed exercise checks bytes, bin and behavior on the installed copy", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gh-glance-package-check-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const goodBytes = packageTarball({ version: VERSION });
  const good = join(root, "good.tgz");
  writeFileSync(good, goodBytes);
  const expectedFiles = inspectTarball(goodBytes).fileSha256;
  const installed = await installPackage(good);
  t.after(() => rmSync(installed.root, { recursive: true, force: true }));
  assert.deepEqual(installed.problems, []);
  const passed = await checkInstalled(installed.root, { expectedVersion: VERSION, expectedFiles });
  assert.deepEqual(passed.problems, []);
  assert.equal(passed.runtimes[0].version.stdout, VERSION);
  assert.match(passed.runtimes[0].help.stdout, /gh-glance fixture help/);
  // Different expectations against the same install.
  assert.match((await checkInstalled(installed.root, { expectedVersion: "9.9.10" })).problems.join("\n"),
    /--version gave 0 "9\.9\.9"/);
  assert.match((await checkInstalled(installed.root, { expectedVersion: VERSION,
    expectedFiles: { ...expectedFiles, "README.md": "0".repeat(64) } })).problems.join("\n"), /installed README\.md differs/);
  assert.match((await checkInstalled(installed.root, { expectedVersion: VERSION,
    expectedFiles: { ...expectedFiles, "hidden.mjs": "0".repeat(64) } })).problems.join("\n"), /are not the inspected five/);

  const broken = join(root, "broken.tgz");
  writeFileSync(broken, packageTarball({ version: VERSION,
    files: { "package/index.mjs": "#!/usr/bin/env node\nprocess.exit(3);\n" } }));
  const failed = await exerciseInstalled(broken, { expectedVersion: VERSION });
  assert.match(failed.problems.join("\n"), /direct bin --version gave 3/);
  assert.match(failed.problems.join("\n"), /--version gave 3/);
});

test("PKG-06 npm 11 and npm 12 pack JSON shapes both name the tarball", () => {
  const manifest = { filename: "gh-glance-9.9.9.tgz", files: [] };
  assert.deepEqual(parsePackJson(JSON.stringify([manifest])), manifest);
  assert.deepEqual(parsePackJson(JSON.stringify({ "gh-glance": manifest })), manifest);
  assert.throws(() => parsePackJson("{}"), /did not report a filename/);
});

test("PKG-07 --no-pack refuses to repack when the candidate tarball is missing", () => {
  const run = spawnSync(process.execPath, [SCRIPT, "--no-pack"], { encoding: "utf8" });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /--no-pack requires --tarball/);
});
