#!/usr/bin/env node
// sign-firefox.mjs — build, lint, and AMO-sign dist/firefox as an UNLISTED
// add-on (self-distribution .xpi that survives restarts in release Firefox).
//
// Credentials: repo-root `.env` (see .env.example) or real environment
// variables (real env wins). The secret is never printed.
//
// Usage (from extension/):  npm run sign:firefox [-- --no-bump|--bump=minor|...]
// or (from repo root):      node scripts/sign-firefox.mjs [options]
//
// Options:
//   --bump patch|minor|major   bump version first (default: patch)
//   --no-bump                  skip the version bump
//   --dry-run                  everything except the actual `web-ext sign`
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseDotEnv, bumpFiles, maskIssuer } from "./lib/sign-helpers.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const EXT = join(ROOT, "extension");
const ENV_FILE = join(ROOT, ".env");
const ARTIFACTS = join(ROOT, "web-ext-artifacts");
const AMO_KEY_URL = "https://addons.mozilla.org/developers/addon/api/key/";
const APPROVAL_TIMEOUT_MS = 15 * 60 * 1000; // web-ext --approval-timeout
const SIGN_TIMEOUT_MS = 20 * 60 * 1000; // our own child-process ceiling

function fail(msg, hint) {
  console.error(`sign-firefox: ${msg}`);
  if (hint) console.error(`  ${hint}`);
  process.exit(1);
}

// ---- args -----------------------------------------------------------------
const argv = process.argv.slice(2);
let bumpLevel = "patch";
let dryRun = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--no-bump") bumpLevel = null;
  else if (a === "--dry-run") dryRun = true;
  else if (a === "--bump") {
    bumpLevel = argv[++i];
    if (!["patch", "minor", "major"].includes(bumpLevel)) {
      fail(`--bump requires patch|minor|major (got "${bumpLevel ?? "nothing"}")`);
    }
  } else if (a.startsWith("--bump=")) {
    bumpLevel = a.slice("--bump=".length);
    if (!["patch", "minor", "major"].includes(bumpLevel)) {
      fail(`--bump requires patch|minor|major (got "${bumpLevel}")`);
    }
  } else fail(`unknown option "${a}" (valid: --bump patch|minor|major, --no-bump, --dry-run)`);
}

// ---- credentials ----------------------------------------------------------
const dotenv = existsSync(ENV_FILE) ? parseDotEnv(readFileSync(ENV_FILE, "utf8")) : {};
const creds = {};
for (const key of ["WEB_EXT_API_KEY", "WEB_EXT_API_SECRET"]) {
  creds[key] = process.env[key]?.trim() || dotenv[key]?.trim() || "";
}
const missing = Object.entries(creds).filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  fail(
    `missing AMO credentials: ${missing.join(", ")}`,
    existsSync(ENV_FILE)
      ? `fill them in ${ENV_FILE} (copy .env.example) or export them; get keys at ${AMO_KEY_URL}`
      : `copy ${join(ROOT, ".env.example")} to ${ENV_FILE} and fill it in, or export the vars; get keys at ${AMO_KEY_URL}`,
  );
}
const source = process.env.WEB_EXT_API_KEY?.trim() ? "environment" : ENV_FILE;
console.log(`credentials: issuer ${maskIssuer(creds.WEB_EXT_API_KEY)}, secret set (from ${source})`);

// ---- version bump ---------------------------------------------------------
if (bumpLevel) {
  const targets = [join(EXT, "manifest.base.json"), join(EXT, "package.json")];
  const changed = bumpFiles(targets, bumpLevel);
  if (!changed.length) {
    console.log(`bump ${bumpLevel}: no version fields found, nothing to bump`);
  } else {
    for (const c of changed) {
      console.log(`bump ${bumpLevel}: ${c.from} -> ${c.to} (${c.path.slice(ROOT.length + 1)})`);
    }
  }
} else {
  console.log("bump: skipped (--no-bump)");
}

// ---- build ----------------------------------------------------------------
console.log("\n$ node scripts/build.mjs");
let r = spawnSync(process.execPath, [join(ROOT, "scripts", "build.mjs")], {
  cwd: ROOT, stdio: "inherit",
});
if (r.status !== 0) fail("build failed");

// ---- lint (abort on errors) -------------------------------------------------
console.log("\n$ npx web-ext lint --source-dir ../dist/firefox");
r = spawnSync("npx", ["web-ext", "lint", "--source-dir", "../dist/firefox"], {
  cwd: EXT, stdio: "inherit",
});
if (r.status !== 0) fail("web-ext lint reported errors; fix them before signing");

// ---- sign -------------------------------------------------------------------
const signArgs = [
  "web-ext", "sign",
  "--channel=unlisted",
  "--source-dir", "../dist/firefox",
  "--artifacts-dir", "../web-ext-artifacts",
  "--approval-timeout", String(APPROVAL_TIMEOUT_MS),
];
if (dryRun) {
  console.log(`\n[dry-run] would run (cwd ${EXT}):`);
  console.log(`  npx ${signArgs.join(" ")}`);
  console.log(
    `  with WEB_EXT_API_KEY=${maskIssuer(creds.WEB_EXT_API_KEY)} and WEB_EXT_API_SECRET=<hidden> ` +
      `passed via environment (never on the command line)`,
  );
  console.log(`[dry-run] output .xpi would land in ${ARTIFACTS}`);
  console.log("[dry-run] skipped web-ext sign; done.");
  process.exit(0);
}

console.log(`\n$ npx ${signArgs.join(" ")}`);
r = spawnSync("npx", signArgs, {
  cwd: EXT,
  stdio: ["ignore", "pipe", "pipe"],
  encoding: "utf8",
  timeout: SIGN_TIMEOUT_MS,
  // secrets travel via env only: web-ext reads WEB_EXT_API_KEY/WEB_EXT_API_SECRET
  env: { ...process.env, ...creds },
});
const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
process.stdout.write(out);
if (r.error) fail(`failed to run web-ext sign: ${r.error.message}`);
if (r.status !== 0) {
  if (/already exists|version.*?(exists|must be greater)|duplicate/i.test(out)) {
    console.error(
      "sign-firefox: AMO rejected the version (it likely already exists for this add-on).\n" +
        "  Re-run with a bump, e.g.: node scripts/sign-firefox.mjs --bump patch",
    );
  }
  fail(`web-ext sign failed (exit ${r.status ?? "signal"})`);
}

// print newest .xpi in artifacts
const { readdirSync, statSync } = await import("node:fs");
const xpis = existsSync(ARTIFACTS)
  ? readdirSync(ARTIFACTS)
      .filter((f) => f.endsWith(".xpi"))
      .map((f) => ({ f, m: statSync(join(ARTIFACTS, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)
  : [];
if (!xpis.length) fail("web-ext sign reported success but no .xpi was found", `check ${ARTIFACTS}`);
console.log(`\nSigned .xpi: ${join(ARTIFACTS, xpis[0].f)}`);
console.log("Install: Firefox -> about:addons -> gear -> Install Add-on From File (or drag the .xpi into the window).");
