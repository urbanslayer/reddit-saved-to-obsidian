import { api } from "./src/compat.js";
import { loadSettings } from "./src/settings.js";
import { REQUIRED_ORIGINS } from "./src/origins.js";

const s = await loadSettings();
document.getElementById("who").textContent = s.username ? `u/${s.username}` : "(not configured)";
document.getElementById("vault").textContent = s.vaultPath || "(not configured)";
document.getElementById("folder").textContent = s.folder;

try {
  const granted = await api.permissions.contains({ origins: REQUIRED_ORIGINS });
  if (!granted) document.getElementById("permWarn").classList.add("show");
} catch { /* Chrome grants at install; ignore */ }

document.getElementById("openSync").addEventListener("click", () => {
  api.tabs.create({ url: api.runtime.getURL("sync.html") });
  window.close();
});
document.getElementById("openOptions").addEventListener("click", () => {
  api.runtime.openOptionsPage();
  window.close();
});
