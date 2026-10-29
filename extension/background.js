// background.js — intentionally minimal, self-contained (no imports: MV3
// background contexts load classic scripts). All DOM parsing and syncing runs
// in sync.html (service workers/event pages lack a reliable DOMParser there);
// this only wires shortcuts.
(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  if (!api?.runtime) return;

  function openTab(path) {
    return api.tabs.create({ url: api.runtime.getURL(path) });
  }

  // Other extension pages can ask the background to open a page.
  if (api.runtime.onMessage) {
    api.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === "openPage" && typeof msg.path === "string") {
        openTab(msg.path);
      }
      return false;
    });
  }

  if (api.runtime.onInstalled) {
    api.runtime.onInstalled.addListener((details) => {
      if (details.reason === "install") {
        api.runtime.openOptionsPage();
      }
    });
  }
})();
