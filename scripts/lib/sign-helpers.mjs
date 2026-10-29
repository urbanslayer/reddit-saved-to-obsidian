#!/usr/bin/env node
// sign-helpers.mjs — pure helpers for scripts/sign-firefox.mjs (unit-tested in
// extension/test/sign-helpers.test.mjs). No secrets are ever returned masked:
// masking is display-only.
import { readFileSync, writeFileSync } from "node:fs";

/**
 * Parse `.env`-style text into an object.
 * - ignores blank lines and `#` comments
 * - accepts an optional leading `export `
 * - splits on the FIRST `=` only
 * - strips one layer of matching surrounding single/double quotes
 * Values are NOT shell-expanded; this is intentionally minimal.
 */
export function parseDotEnv(text) {
  const out = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue; // no '=' or empty key -> ignore
    let key = line.slice(0, eq).trim();
    if (key.startsWith("export ")) key = key.slice("export ".length).trim();
    if (!key) continue;
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Bump a strict `x.y.z` semantic version. `level` is patch|minor|major.
 */
export function bumpVersion(version, level) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version).trim());
  if (!m) {
    throw new Error(
      `cannot bump version "${version}": expected a plain numeric x.y.z version`,
    );
  }
  let [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (level === "major") { maj++; min = 0; pat = 0; }
  else if (level === "minor") { min++; pat = 0; }
  else if (level === "patch") { pat++; }
  else throw new Error(`unknown bump level "${level}" (expected patch|minor|major)`);
  return `${maj}.${min}.${pat}`;
}

/**
 * Bump the "version" field of each given JSON file path in place (2-space
 * indent, trailing newline — matches repo style). Files without a "version"
 * string are skipped. Returns [{ path, from, to }] for files actually changed.
 */
export function bumpFiles(paths, level) {
  const changed = [];
  for (const path of paths) {
    const text = readFileSync(path, "utf8");
    const json = JSON.parse(text);
    if (typeof json.version !== "string") continue;
    const prev = json.version;
    const next = bumpVersion(json.version, level);
    json.version = next;
    writeFileSync(path, JSON.stringify(json, null, 2) + "\n");
    changed.push({ path, from: prev, to: next });
  }
  return changed;
}

/**
 * Mask an AMO JWT issuer for display: keep the leading `user:` and the last 3
 * characters, hide the middle. e.g. user:12345678:123 -> user:...:123
 */
export function maskIssuer(issuer) {
  const s = String(issuer ?? "");
  const prefix = /^user:/i.test(s) ? "user:" : "";
  const rest = prefix ? s.slice(prefix.length) : s;
  const tail = s.slice(-3);
  if (rest.length <= 4) return `${prefix}***`;
  return `${prefix}***${tail}`;
}
