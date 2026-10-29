import { api } from "./src/compat.js";
import { loadSettings } from "./src/settings.js";
import { scrapeSaved } from "./src/scraper.js";
import { summariseAll } from "./src/summarize.js";
import { REQUIRED_ORIGINS } from "./src/origins.js";
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
// Check/request every origin the scrape + image embedding needs at once.
async function hasRedditAccess() {
  try {
    return await api.permissions.contains({ origins: REQUIRED_ORIGINS });
  } catch { return true; }
}
async function refreshPerm() {
  if (await hasRedditAccess()) clearStatus($("perm"));
  else $("perm").classList.add("show");
}
$("grantPerm").addEventListener("click", async () => {
  try {
    await api.permissions.request({ origins: REQUIRED_ORIGINS });
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
  // Running totals: items are written to the vault page-by-page (per scraper
  // 'batch' event, same syncId), so a 429/cancel later keeps partial progress.
  let scraped = 0;
  let added = 0;
  let updated = 0;
  const bySub = {};
  try {
    if (!settings.username || !settings.vaultPath) {
      throw new Error(`Configure ${[!settings.username && "username", !settings.vaultPath && "vault path"].filter(Boolean).join(" and ")} in Options first.`);
    }
    if (!(await hasRedditAccess())) {
      throw new Error("Reddit access not granted — click 'Grant access' above.");
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
      embedImages: settings.embedImages,
      getKnownIds: () => knownIds,
      signal: controller?.signal,
      summariseAll: (chunk, ctx) => summariseAll(chunk, {
        settings, signal: ctx.signal,
        onProgress: (m) => log(m),
      }),
      onProgress: (msg, data) => {
        log(msg, data);
        if (data?.type === "summariseProgress") {
          $("bar").style.width = `${10 + Math.round((data.done / Math.max(1, data.total)) * 50)}%`;
        }
      },
    })) {
      if (ev.type === "batch") {
        scraped += ev.items.length;
        for (const it of ev.items) bySub[it.subreddit] = (bySub[it.subreddit] || 0) + 1;
        log(`page ${ev.page} ready: ${ev.items.length} item(s); writing…`);
        const r = await native.writeItems({
          vaultPath: settings.vaultPath,
          folder: settings.folder,
          syncId,
          items: ev.items,
          onBatch: ({ done, total }) => log(`  host batch ack: ${done}/${total}`),
        });
        added += r.added;
        updated += r.updated;
        log(`page ${ev.page} written: +${r.added} new, ~${r.updated} updated (total so far: ${scraped} item(s))`);
        $("bar").style.width = "90%";
      } else if (ev.type === "done") {
        $("bar").style.width = "95%";
      }
    }
    $("bar").style.width = "100%";

    const subs = Object.entries(bySub).sort((a, b) => b[1] - a[1]);
    const lines = [
      `Done. ${scraped} item(s): +${added} new, ~${updated} updated.`,
      subs.length ? `Per subreddit: ${subs.map(([s, n]) => `r/${s}: ${n}`).join(" · ")}` : "Nothing new to write.",
    ];
    setStatus($("final"), "ok", lines.join("\n"));
    log(lines.join(" | "));
  } catch (err) {
    const cls = "err";
    const writtenNote = scraped
      ? ` ${scraped} item(s) already written this sync (+${added} new, ~${updated} updated).`
      : " Nothing written yet.";
    const msg = err?.name === "Error" && /cancel/i.test(err.message || "")
      ? `Cancelled.${writtenNote}`
      : `${err.message}.${writtenNote}`;
    setStatus($("final"), cls, msg);
    log(`ERROR: ${err.stack || err.message}`);
  } finally {
    $("start").disabled = false;
    $("cancel").disabled = true;
  }
});
