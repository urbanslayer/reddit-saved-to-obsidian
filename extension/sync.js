import { api } from "./src/compat.js";
import { loadSettings } from "./src/settings.js";
import { scrapeSaved, LoginWallError, UserMismatchError, HttpError } from "./src/scraper.js";
import { summariseAll } from "./src/summarize.js";
import * as native from "./src/native.js";

const $ = (id) => document.getElementById(id);
const logEl = $("log");
let t0 = Date.now();

function log(msg, data) {
  const dt = ((Date.now() - t0) / 1000).toFixed(1).padStart(5);
  logEl.textContent += `[${dt}s] ${msg}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}
function setStatus(el, cls, msg) {
  el.textContent = msg;
  el.className = `status show ${cls}`;
}
function clearStatus(el) { el.className = "status"; el.textContent = ""; }

const settings = await loadSettings();
$("who").textContent = settings.username ? `u/${settings.username}` : "(not configured)";
$("vault").textContent = settings.vaultPath ? `${settings.vaultPath}/${settings.folder}` : "(not configured)";

const missing = [];
if (!settings.username) missing.push("username");
if (!settings.vaultPath) missing.push("vault path");
if (missing.length) setStatus($("cfgWarn"), "warn", `Missing setting(s): ${missing.join(", ")} — open Options first.`);

// --- host permission gate (Firefox grants host perms only on request) ---
async function hasRedditAccess() {
  try {
    return await api.permissions.contains({ origins: ["https://old.reddit.com/*"] });
  } catch { return true; }
}
async function refreshPerm() {
  if (await hasRedditAccess()) clearStatus($("perm"));
  else $("perm").classList.add("show");
}
$("grantPerm").addEventListener("click", async () => {
  try {
    await api.permissions.request({ origins: ["https://old.reddit.com/*"] });
  } catch (err) {
    log(`permission request failed: ${err.message}`);
  }
  await refreshPerm();
});
await refreshPerm();

let controller = null;
$("cancel").addEventListener("click", () => {
  controller?.abort(new Error("cancelled by user"));
  log("cancel requested…");
});

$("start").addEventListener("click", async () => {
  controller = new AbortController();
  $("start").disabled = true;
  $("cancel").disabled = false;
  clearStatus($("final"));
  logEl.textContent = "";
  $("bar").style.width = "0%";
  t0 = Date.now();

  const syncId = new Date().toISOString();
  let items = [];
  try {
    if (!settings.username || !settings.vaultPath) {
      throw new Error(`Configure ${[!settings.username && "username", !settings.vaultPath && "vault path"].filter(Boolean).join(" and ")} in Options first.`);
    }
    if (!(await hasRedditAccess())) {
      throw new Error("old.reddit.com access not granted — click 'Grant access' above.");
    }

    log(`sync ${syncId} · u/${settings.username} → ${settings.vaultPath}/${settings.folder}`);
    const v = await native.checkVault(settings.vaultPath);
    if (!v.exists) throw new Error(`Vault path does not exist: ${settings.vaultPath}`);
    if (!v.isVault) log(`warning: ${settings.vaultPath} has no .obsidian/ folder (writing anyway)`);

    const knownIds = await native.getKnownIds(settings.vaultPath, settings.folder);
    log(`host has ${knownIds.length} known item(s)`);

    for await (const ev of scrapeSaved({
      username: settings.username,
      delayMs: settings.delayMs,
      maxItems: settings.maxItems,
      incremental: settings.incremental,
      getKnownIds: () => knownIds,
      signal: controller?.signal,
      summariseAll: (chunk, ctx) => summariseAll(chunk, {
        settings, signal: ctx.signal,
        onProgress: (m) => log(m),
      }),
      onProgress: (msg, data) => {
        log(msg, data);
        if (data?.type === "summariseProgress") {
          $("bar").style.width = `${Math.round((data.done / Math.max(1, data.total)) * 80) + 10}%`;
        }
      },
    })) {
      if (ev.type === "done") items = ev.items;
    }

    if (!settings.embedImages) items = items.map((it) => ({ ...it, imageUrl: it.postType === "image" ? it.imageUrl : null }));
    log(`scrape complete: ${items.length} item(s). writing…`);
    $("bar").style.width = "90%";

    const report = await native.writeItems({
      vaultPath: settings.vaultPath,
      folder: settings.folder,
      syncId,
      items,
      onBatch: ({ done, total, added, updated }) => {
        log(`written batch: ${done}/${total} items (added ${added}, updated ${updated})`);
        $("bar").style.width = `${90 + Math.round((done / Math.max(1, total)) * 10)}%`;
      },
    });
    $("bar").style.width = "100%";

    const bySub = {};
    for (const it of items) bySub[it.subreddit] = (bySub[it.subreddit] || 0) + 1;
    const subs = Object.entries(bySub).sort((a, b) => b[1] - a[1]);
    const lines = [
      `Done. ${items.length} item(s): +${report.added} new, ~${report.updated} updated.`,
      subs.length ? `Per subreddit: ${subs.map(([s, n]) => `r/${s}: ${n}`).join(" · ")}` : "Nothing new to write.",
    ];
    setStatus($("final"), "ok", lines.join("\n"));
    log(lines.join(" | "));
  } catch (err) {
    const cls = err instanceof LoginWallError || err instanceof UserMismatchError ? "err"
      : err instanceof HttpError ? "err" : "err";
    const msg = err?.name === "Error" && /cancel/i.test(err.message || "")
      ? `Cancelled after ${items.length} scraped item(s) (nothing written).`
      : `${err.message}`;
    setStatus($("final"), cls, msg);
    log(`ERROR: ${err.stack || err.message}`);
  } finally {
    $("start").disabled = false;
    $("cancel").disabled = true;
  }
});
