// Deterministic npm-shaped tarballs for package and release tests. A minimal
// ustar writer lets each case control exact entry names and types, including
// ones a platform tar refuses to create (traversal, links, duplicates, PAX).

import { gzipSync } from "node:zlib";

// Rewrite the checksum of the 512-byte header at `offset` after editing it.
export function rechecksum(buffer, offset = 0) {
  buffer.write("        ", offset + 148);
  let sum = 0;
  for (const byte of buffer.subarray(offset, offset + 512)) sum += byte;
  buffer.write(`${sum.toString(8).padStart(6, "0")}\0 `, offset + 148);
  return buffer;
}

function tarHeader(name, size, type = "0", linkname = "") {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
  header.write("00000000000\0", 136);
  header.write(type, 156);
  header.write(linkname, 157, 100, "utf8");
  header.write("ustar\0", 257);
  header.write("00", 263);
  return rechecksum(header);
}

export function tarball(entries) {
  const blocks = [];
  for (const { name, body = "", type = "0", linkname = "" } of entries) {
    const data = Buffer.from(body);
    const hasData = type === "0" || type === "x";
    blocks.push(tarHeader(name, hasData ? data.length : 0, type, linkname));
    if (hasData) blocks.push(data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

// A runnable stand-in for the gh-glance executable: exact --version, --help,
// non-TTY refusal (exit 1) and unknown-flag refusal (exit 2).
function entryScript(version) {
  return `#!/usr/bin/env node
const argv = process.argv.slice(2);
if (argv[0] === "--version") { console.log(${JSON.stringify(version)}); process.exit(0); }
if (argv[0] === "--help") { console.log("gh-glance fixture help"); process.exit(0); }
if (argv.length > 0) process.exit(2);
if (!process.stdout.isTTY) { console.error("stdout is not a terminal"); process.exit(1); }
`;
}

// The five package files. `manifest` merges into package.json; `files`
// replaces (or with null removes) entries by tar path, or adds new ones.
export function packageEntries({ version = "9.9.9", manifest = {}, files = {} } = {}) {
  const all = {
    "package/package.json": JSON.stringify({ name: "gh-glance", version, type: "module",
      bin: { "gh-glance": "./index.mjs" }, exports: {}, ...manifest }),
    "package/index.mjs": entryScript(version),
    "package/README.md": "# fixture\n",
    "package/CHANGELOG.md": "# changes\n",
    "package/LICENSE": "MIT\n",
    ...files,
  };
  return Object.entries(all).filter(([, body]) => body !== null).map(([path, body]) => ({ name: path, body }));
}

export function packageTarball(options = {}) {
  return tarball(packageEntries(options));
}
