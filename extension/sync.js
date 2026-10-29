import { api } from "./src/compat.js";
import { loadSettings } from "./src/settings.js";
import { scrapeSaved } from "./src/scraper.js";
import { summariseAll } from "./src/summarize.js";
import { REQUIRED_ORIGINS } from "./src/origins.js";
import * as native from "./src/native.js";
import {
  makeCursor, saveCursor, loadCursor, clearCursor, cursorMatches, describeCursor,
} from "./src/resume.js";

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

// --- storage adapter for the resume cursor (src/resume.js is pure) ---------
const store = {
  get: async (key) => (await api.storage.local.get(key))?.[key] ?? null,
  set: (obj) => api.storage.local.set(obj),
  remove: (key) => api.storage.local.remove(key),
};

// --- resume banner ----------------------------------------------------------
let cursor = await loadCursor(store);
let running = false;
function matchingCursor() {
  return cursorMatches(cursor, settings) ? cursor : null;
}
function renderResumeBanner() {
  const el = $("resumeBanner");
  const c = matchingCursor();
  if (!c || running) {
    el.className = "status warn"; // hidden (no .show); children stay intact
    return;
  }
  $("resumeText").textContent =
    `${describeCursor(c)} — Resume continues from the next page with the same sync id and ordering.`;
  el.className = "status show warn";
}

// --- host permission gate (Firefox grants host perms only on request) ---
// Check/request every origin the scrape + sync needs at once.
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

// --- rate-limit countdown ---------------------------------------------------
let countdownTimer = null;
function fmtCountdown(ms) {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
function showCountdown(data) {
  stopCountdown();
  const el = $("rateStatus");
  const endAt = Date.now() + data.waitMs;
  el.className = "status show warn";
  const tick = () => {
    const left = Math.max(0, endAt - Date.now());
    el.textContent = `Rate limited — retrying in ${fmtCountdown(left)} (attempt ${data.attempt}/${data.maxAttempts})`;
    if (left <= 0) stopCountdown();
  };
  tick();
  countdownTimer = setInterval(tick, 250);
}
function stopCountdown() {
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  clearStatus($("rateStatus"));
}

let controller = null;
$("cancel").addEventListener("click", () => {
  controller?.abort(new Error("cancelled by user"));
  log("cancel requested…");
});

function setButtons(isRunning) {
  running = isRunning;
  $("start").disabled = isRunning;
  $("resumeBtn").disabled = isRunning;
  $("restartBtn").disabled = isRunning;
  $("cancel").disabled = !isRunning;
  renderResumeBanner();
}

$("restartBtn").addEventListener("click", async () => {
  await clearCursor(store);
  cursor = null;
  log("resume cursor discarded (Start over).");
  renderResumeBanner();
});

$("start").addEventListener("click", async () => {
  // "Start sync" = start over: discard any resume cursor and run normally.
  if (matchingCursor()) {
    await clearCursor(store);
    cursor = null;
    log("resume cursor discarded (Start over).");
  }
  await startSync(null);
});

$("resumeBtn").addEventListener("click", async () => {
  await startSync(matchingCursor());
});

/**
 * @param {object|null} resumeCursor  saved cursor to continue from (same
 *   syncId/rank, known ids skipped instead of stopping the run), or null for
 *   a fresh run.
 */
async function startSync(resumeCursor) {
  controller = new AbortController();
  setButtons(true);
  clearStatus($("final"));
  logEl.textContent = "";
  $("bar").style.width = "0%";
  t0 = Date.now();

  const syncId = resumeCursor?.syncId || new Date().toISOString();
  // Running totals: items are written to the vault page-by-page (per scraper
  // 'batch' event, same syncId), so a 429/cancel later keeps partial progress.
  let scraped = resumeCursor?.itemsWritten || 0;
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

    log(resumeCursor
      ? `resuming sync ${syncId} at page ${resumeCursor.page + 1} (rank ${resumeCursor.nextRank}, ${scraped} item(s) already written) · u/${settings.username} → ${settings.vaultPath}/${settings.folder}`
      : `sync ${syncId} · u/${settings.username} → ${settings.vaultPath}/${settings.folder}`);
    const v = await native.checkVault(settings.vaultPath);
    if (!v.exists) throw new Error(`Vault path does not exist: ${settings.vaultPath}`);
    if (!v.isVault) log(`warning: ${settings.vaultPath} has no .obsidian/ folder (writing anyway)`);

    const knownIds = await native.getKnownIds(settings.vaultPath, settings.folder);
    log(`host has ${knownIds.length} known item(s)`);

    for await (const ev of scrapeSaved({
      username: settings.username,
      delayMs: settings.delayMs,
      // In resume mode, items already written count against the budget.
      maxItems: Math.max(1, settings.maxItems - (resumeCursor ? scraped : 0)),
      incremental: settings.incremental,
      embedImages: settings.embedImages,
      getKnownIds: () => knownIds,
      // Resume options: continue at the stored URL/rank with the same syncId;
      // known items are skipped (still consuming a rank), never a stop signal.
      startUrl: resumeCursor?.nextUrl || null,
      startRank: resumeCursor?.nextRank || 0,
      startPage: resumeCursor?.page || 0,
      skipKnown: !!resumeCursor && settings.incremental,
      signal: controller?.signal,
      summariseAll: (chunk, ctx) => summariseAll(chunk, {
        settings, signal: ctx.signal,
        onProgress: (m) => log(m),
      }),
      onProgress: (msg, data) => {
        log(msg, data);
        if (data?.type === "rateLimited") showCountdown(data);
        if (data?.type === "summariseProgress") {
          $("bar").style.width = `${10 + Math.round((data.done / Math.max(1, data.total)) * 50)}%`;
        }
      },
    })) {
      stopCountdown(); // any progress past a rate-limit wait means we're moving again
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
        // Persist the resume cursor only after this page is safely in the vault.
        if (ev.nextUrl) {
          cursor = await saveCursor(store, makeCursor({
            username: settings.username,
            vaultPath: settings.vaultPath,
            folder: settings.folder,
            syncId,
            nextUrl: ev.nextUrl,
            nextRank: ev.nextRank,
            page: ev.page,
            itemsWritten: scraped,
          }));
        } else {
          await clearCursor(store);
          cursor = null;
        }
      } else if (ev.type === "done") {
        $("bar").style.width = "95%";
      }
    }
    $("bar").style.width = "100%";

    // Completed normally: the cursor is stale now.
    await clearCursor(store);
    cursor = null;

    const subs = Object.entries(bySub).sort((a, b) => b[1] - a[1]);
    const lines = [
      `Done. ${scraped} item(s): +${added} new, ~${updated} updated.`,
      subs.length ? `Per subreddit: ${subs.map(([s, n]) => `r/${s}: ${n}`).join(" · ")}` : "Nothing new to write.",
    ];
    setStatus($("final"), "ok", lines.join("\n"));
    log(lines.join(" | "));
  } catch (err) {
    stopCountdown();
    const writtenNote = scraped
      ? ` ${scraped} item(s) already written this sync (+${added} new, ~${updated} updated).`
      : " Nothing written yet.";
    const resumeNote = matchingCursor() ? " Use Resume to continue where it stopped." : "";
    const msg = err?.name === "Error" && /cancel/i.test(err.message || "")
      ? `Cancelled.${writtenNote}${resumeNote}`
      : `${err.message}.${writtenNote}${resumeNote}`;
    setStatus($("final"), "err", msg);
    log(`ERROR: ${err.stack || err.message}`);
  } finally {
    stopCountdown();
    setButtons(false);
  }
}

renderResumeBanner();
