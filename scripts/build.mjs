#!/usr/bin/env node
// build.mjs — emits dist/firefox and dist/chrome from extension/.
// - firefox: MV3 with background.scripts (event page) + gecko id
// - chrome:  MV3 with background.service_worker + stable pinned 'key'
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, generateKeyPairSync } from "node:crypto";
import { deflateSync } from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SRC = join(ROOT, "extension");
const DIST = join(ROOT, "dist");
const KEYS = join(ROOT, "keys");

const GECKO_ID = "reddit-scraper@lain.local";

function ensureKey() {
  // Stable Chrome extension id: keep the generated public key under keys/.
  mkdirSync(KEYS, { recursive: true });
  const pub = join(KEYS, "chrome-extension.key");
  if (!existsSync(pub)) {
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    writeFileSync(pub, publicKey.export({ type: "spki", format: "der" }).toString("base64"));
    console.log(`generated new Chrome key -> ${pub}`);
  }
  const key = readFileSync(pub, "utf8").trim();
  // Chrome id = first 16 bytes of SHA256(SPKI DER), hex nibbles mapped a-p.
  const der = Buffer.from(key, "base64");
  const hash = createHash("sha256").update(der).digest("hex").slice(0, 32);
  const id = [...hash].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
  return { key, id };
}

function copyTree(srcDir, dstDir, skip = []) {
  mkdirSync(dstDir, { recursive: true });
  for (const name of readdirSync(srcDir)) {
    if (skip.includes(name)) continue;
    const s = join(srcDir, name);
    const d = join(dstDir, name);
    if (statSync(s).isDirectory()) copyTree(s, d, skip);
    else copyFileSync(s, d);
  }
}

const base = JSON.parse(readFileSync(join(SRC, "manifest.base.json"), "utf8"));
const { key, id } = ensureKey();

// minimal but valid PNG icons (solid rounded-ish disc drawn pixel-by-pixel)
function makePng(size) {
  // PNG: signature + IHDR + IDAT (zlib of raw RGBA scanlines) + IEND
  const raw = Buffer.alloc(size * (1 + size * 4));
  const c = (size - 1) / 2;
  const r = size / 2 - 0.5;
  let p = 0;
  for (let y = 0; y < size; y++) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const inside = (x - c) ** 2 + (y - c) ** 2 <= r * r;
      const inner = (x - c) ** 2 + (y - c) ** 2 <= (r - Math.max(2, size / 16)) ** 2;
      // dark navy disc with a lighter ring + "R"-ish center block
      let rgba = inside ? (inner ? [22, 23, 29, 255] : [79, 131, 232, 255]) : [0, 0, 0, 0];
      const bx = Math.abs(x - c), by = Math.abs(y - c);
      if (inside && inner && bx < size / 8 && by < size / 3) rgba = [232, 232, 238, 255];
      if (inside && inner && by < size / 8 && bx < size / 3 && y < c) rgba = [232, 232, 238, 255];
      raw[p++] = rgba[0]; raw[p++] = rgba[1]; raw[p++] = rgba[2]; raw[p++] = rgba[3];
    }
  }
  const idat = deflateSync(raw);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const t = Buffer.from(type, "ascii");
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0)),
  ]);
}
function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = ~0;
  for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
  return ~c;
}

function ensureIcons(dir) {
  const iconsDir = join(dir, "icons");
  mkdirSync(iconsDir, { recursive: true });
  for (const n of [48, 96]) writeFileSync(join(iconsDir, `icon${n}.png`), makePng(n));
}

const FILES = ["popup.html", "popup.js", "options.html", "options.js", "sync.html", "sync.js", "background.js", "src"];

for (const browser of ["firefox", "chrome"]) {
  const out = join(DIST, browser);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  copyTree(SRC, out, ["manifest.base.json", "package.json", "package-lock.json", "README.md", "test", "node_modules", "dist"]);
  ensureIcons(out);

  const m = structuredClone(base);
  if (browser === "firefox") {
    m.background = { scripts: ["background.js"] };
    m.browser_specific_settings = {
      gecko: {
        id: GECKO_ID,
        strict_min_version: "128.0",
        data_collection_permissions: { required: ["none"] },
      },
    };
  } else {
    m.background = { service_worker: "background.js", type: "module" };
    m.key = key;
    // Chrome rejects unknown firefox-only keys
    delete m.browser_specific_settings;
  }
  writeFileSync(join(out, "manifest.json"), JSON.stringify(m, null, 2) + "\n");
  console.log(`built dist/${browser}${browser === "chrome" ? ` (pinned id: ${id})` : ` (gecko id: ${GECKO_ID})`}`);
}
