#!/usr/bin/env node
// One exact-tarball exercise shared by the package test, the candidate CI jobs
// and the release delivery check.
//
//   node scripts/package-check.mjs --tarball <path> [--no-pack] [--expected-version x.y.z]
//                                  [--node <path>]... [--report <path>] [--static-only]
//   node scripts/package-check.mjs --installed gh-glance@x.y.z --expected-version x.y.z
//
// With --tarball the given bytes are checked and never repacked. Without it the
// script packs the checkout once into a private directory, which is only for
// standalone developer use; candidate CI passes the uploaded artifact with
// --no-pack, which turns a missing tarball into an error instead of a repack.
// --installed checks a published version from the registry, including
// `npm audit signatures` for its provenance attestation.

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";

const execFileAsync = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const PACKAGE_FILES = ["CHANGELOG.md", "LICENSE", "README.md", "index.mjs", "package.json"];
const MAX_TARBALL_BYTES = 10 * 1024 * 1024;
const MAX_ENTRY_BYTES = 8 * 1024 * 1024;

function octal(field) {
  const text = field.toString("latin1").replace(/\0.*$/s, "").trim();
  return text === "" ? 0 : Number.parseInt(text, 8);
}

function cString(field) {
  return field.toString("utf8").replace(/\0.*$/s, "");
}

// A strict ustar reader: it sees every entry's real path, type and bytes
// without trusting a platform tar's extraction rules, and refuses any shape an
// extractor could read differently. `npm pack` writes only regular-file ustar
// headers and an all-zero trailer, so PAX/GNU extension headers (x, g, L, K),
// links, bad checksums and any non-zero byte after the first zero block are
// rejected rather than interpreted.
export function readTarEntries(gzipped) {
  const tar = gunzipSync(gzipped, { maxOutputLength: MAX_TARBALL_BYTES * 4 });
  if (tar.length % 512 !== 0) throw new Error("tar stream is not block aligned");
  const entries = [];
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (!tar.subarray(offset).every((byte) => byte === 0)) {
        throw new Error(`data after the end-of-archive block at ${offset}`);
      }
      return entries;
    }
    let sum = 0;
    for (let index = 0; index < 512; index += 1) sum += index >= 148 && index < 156 ? 32 : header[index];
    if (octal(header.subarray(148, 156)) !== sum) throw new Error(`tar header at ${offset} has a bad checksum`);
    if (header.subarray(257, 265).toString("latin1") !== "ustar\u000000") throw new Error(`tar header at ${offset} is not POSIX ustar`);
    const size = octal(header.subarray(124, 136));
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_ENTRY_BYTES) {
      throw new Error(`tar entry at ${offset} has an invalid size`);
    }
    const typeflag = String.fromCharCode(header[156] || 48);
    // npm pack never uses the prefix field; extractors disagree on reading it.
    if (header.subarray(345, 500).some((byte) => byte !== 0)) throw new Error(`tar header at ${offset} uses a path prefix`);
    const name = cString(header.subarray(0, 100));
    const dataStart = offset + 512;
    const data = tar.subarray(dataStart, dataStart + size);
    if (data.length !== size) throw new Error("tar entry is truncated");
    offset = dataStart + Math.ceil(size / 512) * 512;
    entries.push({ path: name, type: typeflag, size, data: Buffer.from(data),
      linkname: cString(header.subarray(157, 257)) });
  }
  throw new Error("tar stream has no end-of-archive block");
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function integrityOf(bytes) {
  return {
    sha256: sha256(bytes),
    sha512: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  };
}

// Static identity checks: exactly the five public files, all regular files under
// package/, no traversal, links or duplicates, and the manifest the installed
// executable depends on.
export function inspectTarball(bytes, { expectedVersion = null } = {}) {
  const problems = [];
  if (bytes.length > MAX_TARBALL_BYTES) problems.push(`tarball is ${bytes.length} bytes, over ${MAX_TARBALL_BYTES}`);
  let entries;
  try {
    entries = readTarEntries(bytes);
  } catch (error) {
    return { ok: false, problems: [`unreadable tarball: ${error.message}`], files: [], ...integrityOf(bytes) };
  }
  // One pass: every regular, safely named entry, keyed by its package path.
  const files = new Map();
  for (const entry of entries) {
    const { path } = entry;
    if (entry.type !== "0") {
      problems.push(`${path} is not a regular file (type ${entry.type}${entry.linkname ? ` -> ${entry.linkname}` : ""})`);
      continue;
    }
    if (!path.startsWith("package/") || path.includes("\\") || path.includes("\0") ||
        path.split("/").some((part) => part === ".." || part === "." || part === "")) {
      problems.push(`unsafe path ${JSON.stringify(path)}`);
      continue;
    }
    const relativePath = path.slice("package/".length);
    if (files.has(relativePath)) problems.push(`duplicate entry ${relativePath}`);
    files.set(relativePath, entry);
  }
  for (const file of PACKAGE_FILES) if (!files.has(file)) problems.push(`missing ${file}`);
  for (const file of files.keys()) if (!PACKAGE_FILES.includes(file)) problems.push(`unexpected file ${file}`);
  let manifest = null;
  if (files.has("package.json")) {
    try {
      manifest = JSON.parse(files.get("package.json").data.toString("utf8"));
    } catch {
      problems.push("package.json is not valid JSON");
    }
  }
  if (manifest) {
    if (manifest.name !== "gh-glance") problems.push(`package name is ${manifest.name}`);
    if (expectedVersion && manifest.version !== expectedVersion) {
      problems.push(`package version ${manifest.version} is not ${expectedVersion}`);
    }
    if (JSON.stringify(manifest.bin) !== JSON.stringify({ "gh-glance": "./index.mjs" })) {
      problems.push(`unexpected bin ${JSON.stringify(manifest.bin)}`);
    }
    if (JSON.stringify(manifest.exports) !== "{}") problems.push("package exports must stay {}");
  }
  const entry = files.get("index.mjs");
  if (entry && !entry.data.subarray(0, 64).toString("utf8").startsWith("#!/usr/bin/env node")) {
    problems.push("index.mjs lost its node shebang");
  }
  return {
    ok: problems.length === 0,
    problems,
    files: [...files.keys()].sort(),
    version: manifest?.version ?? null,
    fileSha256: Object.fromEntries([...files].map(([path, item]) => [path, sha256(item.data)])),
    ...integrityOf(bytes),
  };
}

async function run(command, args, options = {}) {
  try {
    const result = await execFileAsync(command, args, {
      encoding: "utf8", maxBuffer: 10 * 1024 * 1024, timeout: 120_000, ...options,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (typeof error.code !== "number") throw error;
    return { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

async function listFiles(dir, base = dir) {
  const found = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (dir === base && entry.name === "node_modules") continue;
      Object.assign(found, await listFiles(path, base));
    } else {
      found[relative(base, path)] = sha256(await readFile(path));
    }
  }
  return found;
}

// Install the exact bytes into an empty private prefix (a fresh consumer
// install that resolves the published dependency ranges) and run the installed
// executable on each requested Node binary.
//
// `spec` is a tarball path or a registry spec such as gh-glance@1.2.3 (the
// release delivery check). With `expectedFiles` (inspectTarball's fileSha256)
// the installed package must contain exactly those files and bytes.
export async function installPackage(spec) {
  const root = await mkdtemp(join(tmpdir(), "gh-glance-package-check-"));
  const installSpec = /^(\.|\/)|\.tgz$/.test(spec) ? resolve(spec) : spec;
  const install = await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund",
    "--no-package-lock", "--prefix", root, installSpec], { cwd: root });
  return { root, problems: install.code === 0 ? []
    : [`npm install failed (${install.code}): ${install.stderr.trim().slice(-500)}`] };
}

async function probeRuntime(node, bin, root, expectedVersion, problems) {
  const [runtimeRun, version, help, nonTty, unknown, ...imports] = await Promise.all([
    run(node, ["--version"]),
    run(node, [bin, "--version"], { cwd: root }),
    run(node, [bin, "--help"], { cwd: root }),
    run(node, [bin], { cwd: root }),
    run(node, [bin, "--definitely-not-a-flag"], { cwd: root }),
    ...["gh-glance", "gh-glance/index.mjs"].map((specifier) => run(node, ["--input-type=module", "--eval",
      `import.meta.resolve(${JSON.stringify(specifier)})`], { cwd: root })),
  ]);
  const runtime = runtimeRun.stdout.trim();
  if (version.code !== 0 || version.stdout.trim() !== expectedVersion) {
    problems.push(`${runtime}: --version gave ${version.code} ${JSON.stringify(version.stdout.trim())}`);
  }
  if (help.code !== 0 || !help.stdout.includes("gh-glance")) problems.push(`${runtime}: --help failed (${help.code})`);
  if (nonTty.code !== 1 || !/not a terminal/.test(nonTty.stderr)) problems.push(`${runtime}: non-TTY start gave ${nonTty.code}`);
  if (unknown.code !== 2) problems.push(`${runtime}: unknown flag gave ${unknown.code}`);
  for (const [index, probe] of imports.entries()) {
    if (probe.code === 0 || !/ERR_PACKAGE_PATH_NOT_EXPORTED/.test(probe.stderr)) {
      problems.push(`${runtime}: ${["gh-glance", "gh-glance/index.mjs"][index]} is importable`);
    }
  }
  return { node, runtime, version: { code: version.code, stdout: version.stdout.trim() },
    help: { code: help.code, stdout: help.stdout }, nonTty: nonTty.code, unknownFlag: unknown.code };
}

// Checks an existing install (installPackage's root) without changing it, so
// several expectations can be checked against one install.
export async function checkInstalled(root, { expectedVersion, nodes = [process.execPath], expectedFiles = null,
  auditSignatures = false } = {}) {
  const problems = [];
  const report = { installRoot: root, runtimes: [], dependencies: null };
  const installedDir = join(root, "node_modules/gh-glance");
  const bin = join(root, "node_modules/.bin/gh-glance");
  const [tree, installedText, listed, direct, target, entry] = await Promise.all([
    run("npm", ["ls", "--all", "--json", "--prefix", root], { cwd: root }),
    readFile(join(installedDir, "package.json"), "utf8"),
    expectedFiles ? listFiles(installedDir) : null,
    // Once directly, so the shebang and execute bit are exercised too.
    run(bin, ["--version"], { cwd: root }),
    realpath(bin).catch(() => null),
    realpath(join(installedDir, "index.mjs")),
  ]);
  try {
    const deps = JSON.parse(tree.stdout).dependencies?.["gh-glance"]?.dependencies ?? {};
    report.dependencies = Object.fromEntries(Object.entries(deps).map(([name, value]) => [name, value.version]));
  } catch {
    problems.push("npm ls produced no dependency tree");
  }
  if (JSON.stringify(JSON.parse(installedText).exports) !== "{}") problems.push("installed exports are not {}");
  if (listed) {
    if (JSON.stringify(Object.keys(listed).sort()) !== JSON.stringify(Object.keys(expectedFiles).sort())) {
      problems.push(`installed files ${Object.keys(listed).sort().join(", ")} are not the inspected five`);
    }
    for (const [file, digest] of Object.entries(expectedFiles)) {
      if (listed[file] !== undefined && listed[file] !== digest) problems.push(`installed ${file} differs from the tarball`);
    }
  }
  if (direct.code !== 0 || direct.stdout.trim() !== expectedVersion) {
    problems.push(`direct bin --version gave ${direct.code} ${JSON.stringify(direct.stdout.trim())}`);
  }
  if (!target) problems.push("installed bin link is missing");
  else if (target !== entry) problems.push(`installed bin resolves to ${target}`);
  report.runtimes = await Promise.all(nodes.map((node) => probeRuntime(node, bin, root, expectedVersion, problems)));
  if (auditSignatures) {
    // gh-glance's own attestation must verify; a dependency's does not count.
    const audit = await run("npm", ["audit", "signatures", "--json", "--include-attestations", "--prefix", root], { cwd: root });
    let parsed;
    try { parsed = JSON.parse(audit.stdout); } catch { parsed = null; }
    report.signatures = parsed ? { verified: (parsed.verified ?? []).map((item) => item.name),
      invalid: (parsed.invalid ?? []).map((item) => item.name), missing: (parsed.missing ?? []).map((item) => item.name) } : null;
    if (audit.code !== 0 || !parsed) problems.push(`npm audit signatures failed (${audit.code})`);
    else if (!report.signatures.verified.includes("gh-glance")) problems.push("gh-glance has no verified attestation");
    else if (report.signatures.invalid.length > 0) problems.push(`invalid signatures: ${report.signatures.invalid.join(", ")}`);
  }
  return { ok: problems.length === 0, problems, ...report };
}

export async function exerciseInstalled(spec, { keep = false, ...options } = {}) {
  const installed = await installPackage(spec);
  try {
    if (installed.problems.length > 0) {
      return { ok: false, problems: installed.problems, installRoot: installed.root, runtimes: [], dependencies: null };
    }
    return await checkInstalled(installed.root, options);
  } finally {
    if (!keep) await rm(installed.root, { recursive: true, force: true });
  }
}

// npm 11 prints an array of pack manifests; npm 12 keys them by package name.
export function parsePackJson(stdout) {
  const payload = JSON.parse(stdout);
  const manifest = Array.isArray(payload) ? payload[0] : payload?.["gh-glance"];
  if (!manifest?.filename) throw new Error("npm pack did not report a filename");
  return manifest;
}

export async function packCheckout(destination) {
  const pack = await run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", destination], { cwd: ROOT });
  if (pack.code !== 0) throw new Error(`npm pack failed: ${pack.stderr.trim()}`);
  return join(destination, parsePackJson(pack.stdout).filename);
}

function parseArgs(argv) {
  const options = { nodes: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      const next = argv[++index];
      if (next == null) throw new Error(`${flag} needs a value`);
      return next;
    };
    if (flag === "--tarball") options.tarball = value();
    else if (flag === "--installed") options.installed = value();
    else if (flag === "--expected-version") options.expectedVersion = value();
    else if (flag === "--node") options.nodes.push(value());
    else if (flag === "--report") options.report = value();
    else if (flag === "--static-only") options.staticOnly = true;
    else if (flag === "--no-pack") options.noPack = true;
    else throw new Error(`unknown option ${flag}`);
  }
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const nodes = options.nodes.length > 0 ? options.nodes : [process.execPath];
  const expectedVersion = options.expectedVersion ??
    JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")).version;
  const finish = async (result) => {
    const text = `${JSON.stringify(result, null, 2)}\n`;
    if (options.report) await writeFile(options.report, text);
    process.stdout.write(text);
    return result.ok ? 0 : 1;
  };
  // Delivery: a registry spec, installed fresh, with provenance verified.
  if (options.installed) {
    const installed = await exerciseInstalled(options.installed, { expectedVersion, nodes, auditSignatures: true });
    return finish({ installed: options.installed, expectedVersion, ok: installed.ok, result: installed });
  }
  if (!options.tarball && options.noPack) throw new Error("--no-pack requires --tarball: candidate checks never repack");
  let packRoot = null;
  try {
    let tarball = options.tarball;
    if (!tarball) {
      packRoot = await mkdtemp(join(tmpdir(), "gh-glance-pack-"));
      tarball = await packCheckout(packRoot);
    }
    const bytes = await readFile(tarball);
    const result = { tarball: resolve(tarball), packedHere: packRoot !== null, expectedVersion,
      static: inspectTarball(bytes, { expectedVersion }) };
    if (result.static.ok && !options.staticOnly) {
      result.installed = await exerciseInstalled(tarball, { expectedVersion, nodes,
        expectedFiles: result.static.fileSha256 });
    }
    result.ok = result.static.ok && (options.staticOnly || result.installed?.ok === true);
    return finish(result);
  } finally {
    if (packRoot) await rm(packRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    process.stderr.write(`package-check: ${error.message}\n`);
    process.exitCode = 2;
  });
}
