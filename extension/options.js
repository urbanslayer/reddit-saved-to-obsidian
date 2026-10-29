import { api } from "./src/compat.js";
import { loadSettings, saveSettings, aiOriginPattern, DEFAULTS } from "./src/settings.js";
import * as native from "./src/native.js";

const $ = (id) => document.getElementById(id);
const FIELDS = ["username", "vaultPath", "folder", "delayMs", "maxItems", "incremental",
  "aiEnabled", "aiEndpoint", "aiModel", "aiApiKey", "aiForText", "embedImages"];

const statusEl = (el, cls, msg) => {
  el.textContent = msg;
  el.className = `status show ${cls}`;
};

const current = await loadSettings();
for (const f of FIELDS) {
  const el = $(f);
  if (el.type === "checkbox") el.checked = !!current[f];
  else el.value = current[f] ?? DEFAULTS[f];
}

function collect() {
  const out = {};
  for (const f of FIELDS) {
    const el = $(f);
    out[f] = el.type === "checkbox" ? el.checked : el.value;
  }
  return out;
}

$("save").addEventListener("click", async () => {
  const draft = collect();
  try {
    // grant AI endpoint origin before saving (user gesture context)
    const draftSettings = { ...current, ...draft };
    const origin = aiOriginPattern(draftSettings);
    if (origin) {
      let has = false;
      try { has = await api.permissions.contains({ origins: [origin] }); } catch { has = true; }
      if (!has) {
        let granted = false;
        try { granted = await api.permissions.request({ origins: [origin] }); }
        catch { granted = true; /* Chrome auto-grants optional host perms on request */ }
        if (!granted) {
          statusEl($("saveStatus"), "warn", "Saved, but the AI endpoint origin was NOT granted — AI calls will fall back to local summaries.");
        }
      }
    }
    await saveSettings(draft);
    statusEl($("saveStatus"), "ok", "Saved.");
  } catch (err) {
    statusEl($("saveStatus"), "err", `Save failed: ${err.message}`);
  }
});

$("testHost").addEventListener("click", async () => {
  try {
    const { version } = await native.ping();
    statusEl($("hostStatus"), "ok", `Native host OK (version ${version}).`);
  } catch (err) {
    statusEl($("hostStatus"), "err", err.message);
  }
});

$("testVault").addEventListener("click", async () => {
  const vaultPath = $("vaultPath").value.trim();
  if (!vaultPath) { statusEl($("hostStatus"), "warn", "Enter a vault path first."); return; }
  try {
    const r = await native.checkVault(vaultPath);
    if (!r.exists) statusEl($("hostStatus"), "err", `Path does not exist: ${vaultPath}`);
    else if (!r.isVault) statusEl($("hostStatus"), "warn", `${vaultPath} exists but has no .obsidian/ folder — looks like a plain directory.`);
    else statusEl($("hostStatus"), "ok", `${vaultPath} is an Obsidian vault.`);
  } catch (err) {
    statusEl($("hostStatus"), "err", err.message);
  }
});
