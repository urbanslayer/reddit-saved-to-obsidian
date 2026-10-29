// settings.js — storage.local-backed settings with defaults.
import { api } from "./compat.js";

export const DEFAULTS = {
  username: "",
  vaultPath: "",
  folder: "Reddit",
  delayMs: 3000,
  maxItems: 1000,
  incremental: true,
  aiEnabled: false,
  aiEndpoint: "http://localhost:11434/v1",
  aiModel: "",
  aiApiKey: "",
  aiForText: false,
  embedImages: true,
};

const KEY = "settings";

export async function loadSettings() {
  let stored = {};
  try {
    stored = (await api.storage.local.get(KEY))?.[KEY] || {};
  } catch {
    stored = {};
  }
  return sanitize({ ...DEFAULTS, ...stored });
}

export async function saveSettings(partial) {
  const merged = sanitize({ ...(await loadSettings()), ...partial });
  await api.storage.local.set({ [KEY]: merged });
  return merged;
}

export function sanitize(s) {
  const out = { ...DEFAULTS, ...s };
  out.username = String(out.username || "").trim().replace(/^u\//, "").replace(/^\/+|\/+$/g, "");
  out.vaultPath = String(out.vaultPath || "").trim();
  out.folder = String(out.folder || "Reddit").trim().replace(/^\/+|\/+$/g, "") || "Reddit";
  out.delayMs = Math.max(1000, Math.min(60000, Number(out.delayMs) || 3000));
  out.maxItems = Math.max(1, Math.min(10000, Math.floor(Number(out.maxItems) || 1000)));
  out.incremental = !!out.incremental;
  out.aiEnabled = !!out.aiEnabled;
  out.aiForText = !!out.aiForText;
  out.embedImages = !!out.embedImages;
  out.aiEndpoint = String(out.aiEndpoint || "").trim().replace(/\/+$/, "");
  out.aiModel = String(out.aiModel || "").trim();
  out.aiApiKey = String(out.aiApiKey || "");
  return out;
}

/** Origin pattern (match-pattern form) for the configured AI endpoint, if any. */
export function aiOriginPattern(settings) {
  if (!settings.aiEnabled || !settings.aiEndpoint) return null;
  try {
    const u = new URL(settings.aiEndpoint);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return `${u.protocol}//${u.host}/*`;
  } catch {
    return null;
  }
}
