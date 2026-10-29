// origins.js — single source of truth for the host origins the extension
// needs at runtime. Keep in sync with manifest.base.json "host_permissions".
//
// Firefox (MV3) only grants host permissions after an explicit
// permissions.request() from a user gesture, so every gate (sync page,
// popup warning) must check/request ALL of these, not just old.reddit.com:
//   - old.reddit.com  : saved listing + detail pages (HTML scraping)
//   - www.reddit.com  : permalinks / absolutizing relative URLs
//   - i.redd.it       : full-size images embedded in notes / AI vision
//   - preview.redd.it : sized previews / gallery thumbs
export const REQUIRED_ORIGINS = [
  "https://old.reddit.com/*",
  "https://www.reddit.com/*",
  "https://i.redd.it/*",
  "https://preview.redd.it/*",
];
