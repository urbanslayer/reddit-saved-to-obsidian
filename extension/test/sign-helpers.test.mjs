// Unit tests for the Firefox signing helpers (scripts/lib/sign-helpers.mjs)
// and the credentials fail-path of scripts/sign-firefox.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseDotEnv,
  bumpVersion,
  bumpFiles,
  maskIssuer,
} from "../../scripts/lib/sign-helpers.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "..", "scripts", "sign-firefox.mjs");

test("parseDotEnv: basic pairs, comments, blanks, quotes, export", () => {
  const env = parseDotEnv(
    [
      "# comment",
      "",
      "A=1",
      "  B = spaced value  ",
      "export C=3",
      'D="quoted double"',
      "E='quoted single'",
      "#F=no",
      "G=pas" + "sword=with=equals",
      "EMPTY=",
      "novalue line",
    ].join("\n"),
  );
  assert.equal(env.A, "1");
  assert.equal(env.B, "spaced value");
  assert.equal(env.C, "3");
  assert.equal(env.D, "quoted double");
  assert.equal(env.E, "quoted single");
  assert.equal(env.F, undefined);
  assert.equal(env.G, "pas" + "sword=with=equals"); // split on FIRST '='
  assert.equal(env.EMPTY, "");
  assert.equal(env["novalue line"], undefined);
});

test("parseDotEnv: does not strip mismatched quotes", () => {
  const env = parseDotEnv(`X="mismatched'\nY="full"`);
  assert.equal(env.X, `"mismatched'`);
  assert.equal(env.Y, "full");
});

test("bumpVersion: patch/minor/major", () => {
  assert.equal(bumpVersion("0.1.0", "patch"), "0.1.1");
  assert.equal(bumpVersion("1.2.9", "patch"), "1.2.10");
  assert.equal(bumpVersion("0.1.0", "minor"), "0.2.0");
  assert.equal(bumpVersion("0.9.9", "minor"), "0.10.0");
  assert.equal(bumpVersion("1.4.7", "major"), "2.0.0");
});

test("bumpVersion: rejects junk versions and levels", () => {
  assert.throws(() => bumpVersion("1.0", "patch"), /expected a plain numeric x\.y\.z/);
  assert.throws(() => bumpVersion("1.0.0-beta", "patch"), /expected a plain numeric x\.y\.z/);
  assert.throws(() => bumpVersion("1.0.0", "huge"), /unknown bump level/);
});

test("bumpFiles: bumps files with version, skips files without", () => {
  const dir = mkdtempSync(join(tmpdir(), "signbump-"));
  const withV = join(dir, "manifest.base.json");
  const pkg = join(dir, "package.json");
  const noV = join(dir, "other.json");
  writeFileSync(withV, JSON.stringify({ name: "m", version: "0.1.0" }, null, 2) + "\n");
  writeFileSync(pkg, JSON.stringify({ name: "p", version: "0.1.0" }, null, 2) + "\n");
  writeFileSync(noV, JSON.stringify({ name: "x" }, null, 2) + "\n");

  const changed = bumpFiles([withV, pkg, noV], "minor");
  assert.equal(changed.length, 2);
  assert.deepEqual(changed[0], { path: withV, from: "0.1.0", to: "0.2.0" });
  assert.equal(JSON.parse(readFileSync(withV, "utf8")).version, "0.2.0");
  assert.equal(JSON.parse(readFileSync(pkg, "utf8")).version, "0.2.0");
  assert.equal(JSON.parse(readFileSync(noV, "utf8")).version, undefined);
});

test("maskIssuer: keeps user: prefix + last 3 chars only", () => {
  const masked = maskIssuer("user:12345678:123");
  assert.ok(masked.startsWith("user:"));
  assert.ok(masked.endsWith("123"));
  assert.ok(!masked.includes("12345678"));
  assert.ok(masked.includes("*"));
  assert.equal(maskIssuer(""), "***");
});

// ---- script fail-path (no .env, no exported credentials) --------------------

function sandboxRepo() {
  // minimal fake repo so the script's ROOT-relative layout resolves
  const root = mkdtempSync(join(tmpdir(), "signrepo-"));
  mkdirSync(join(root, "scripts", "lib"), { recursive: true });
  mkdirSync(join(root, "extension"), { recursive: true });
  const script = readFileSync(SCRIPT, "utf8");
  writeFileSync(join(root, "scripts", "sign-firefox.mjs"), script);
  writeFileSync(
    join(root, "scripts", "lib", "sign-helpers.mjs"),
    readFileSync(join(HERE, "..", "..", "scripts", "lib", "sign-helpers.mjs"), "utf8"),
  );
  writeFileSync(join(root, "extension", "manifest.base.json"), JSON.stringify({ version: "0.1.0" }, null, 2) + "\n");
  writeFileSync(join(root, "extension", "package.json"), JSON.stringify({ version: "0.1.0" }, null, 2) + "\n");
  return root;
}

test("sign-firefox.mjs: fails clearly when credentials are missing", () => {
  const root = sandboxRepo();
  const r = spawnSync(process.execPath, [join(root, "scripts", "sign-firefox.mjs"), "--dry-run"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, WEB_EXT_API_KEY: "", WEB_EXT_API_SECRET: "sentinel-secret-do-not-print" },
  });
  assert.equal(r.status, 1);
  const combined = r.stdout + r.stderr;
  assert.match(combined, /missing AMO credentials/);
  assert.match(combined, /WEB_EXT_API_KEY/);
  assert.match(combined, /addons\.mozilla\.org\/developers\/addon\/api\/key/);
  assert.ok(!combined.includes("sentinel-secret-do-not-print"), "secret must never be printed");
});
