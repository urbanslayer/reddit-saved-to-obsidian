// Tiny browser/chrome compat shim: prefer Firefox's `browser` (promise APIs),
// fall back to Chrome's `chrome` wrapped in promises.
const hasBrowser = typeof globalThis.browser !== "undefined" && globalThis.browser?.runtime?.id !== undefined;

function promisify(obj) {
  // Wrap chrome's callback APIs with promises (shallow; sufficient for the APIs we use).
  const out = {};
  for (const [key, val] of Object.entries(obj)) {
    if (typeof val === "function") {
      out[key] = (...args) =>
        new Promise((resolve, reject) => {
          val(...args, (result) => {
            const err = chrome.runtime?.lastError;
            if (err) reject(new Error(err.message || String(err)));
            else resolve(result);
          });
        });
    } else if (val && typeof val === "object" && !Array.isArray(val)) {
      out[key] = promisify(val);
    } else {
      out[key] = val;
    }
  }
  return out;
}

export const api = hasBrowser
  ? globalThis.browser
  : (() => {
      if (typeof globalThis.chrome === "undefined") {
        throw new Error("No extension runtime available (neither browser nor chrome)");
      }
      return promisify(globalThis.chrome);
    })();

export const NATIVE_HOST = "reddit_scraper_obsidian";
