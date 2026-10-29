# Reddit Saved → Obsidian — browser extension

MV3 extension (Firefox-first, Chrome supported) that scrapes a Reddit user's
**saved** posts/comments by fetching `https://old.reddit.com/user/<username>/saved`
HTML with the browser's login cookies — **no Reddit API, no OAuth, no `.json`
endpoints** — and hands the items to the `reddit_scraper_obsidian` native
messaging host, which writes them into an Obsidian vault folder.

## Build

```sh
cd extension && npm install     # jsdom + web-ext dev deps
npm test                        # node --test unit tests
node ../scripts/build.mjs       # emits dist/firefox and dist/chrome
npx web-ext lint --source-dir dist/firefox   # 0 errors expected
```

## Load in Firefox (preferred)

1. Build (`node scripts/build.mjs`).
2. Open `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** →
   pick `dist/firefox/manifest.json`.
   (For a permanent install use `web-ext run --source-dir dist/firefox`, or
   sign it; temporary add-ons disappear on restart.)
3. Log in to **old.reddit.com** as the configured user (saved items are private —
   the extension detects and reports a login wall or a wrong-user mismatch).
4. Options → set username, vault path (e.g. the repo's `test-vault/`), folder →
   *Test native host* and *Check vault* should go green once
   `native-host/install.py --firefox` has been run.
5. Open the **sync page** (popup → "Open sync page"). On Firefox MV3, host
   permissions are not granted at install: click **Grant access** when prompted
   (same for the optional AI endpoint origin when saving options).

## Load in Chrome / Chromium

1. Build, then `chrome://extensions` → enable Developer mode → **Load unpacked**
   → pick `dist/chrome/`.
2. The build pins a stable extension id via a `key` in the manifest (the RSA
   public key lives in `keys/chrome-extension.key`, committed — keep it stable
   or the id changes and native messaging breaks). The current pinned id is
   printed by the build; currently:

   `fkagcbnkjfelochihhillkjillkfcjlm`

   Pass it to the host installer: `native-host/install.py --chrome
   --chrome-extension-id fkagcbnkjfelochihhillkjillkfcjlm`.
3. Host permissions are granted at install; the sync page's *Grant access*
   banner just never appears there.

## How a sync runs

`sync.html` (an extension page, so `DOMParser` and a long-lived context are
available in both browsers) walks the saved listing via `span.next-button`
pagination, ≥ 1 s (default 2 s) between requests, assigns `rank` (0 = newest
saved, continuous across pages), stop-early on the first already-known id in
incremental mode, fetches each page's detail pages (from **old.reddit.com** —
`parsePostPage` parses old-reddit markup; permalinks stay www.reddit.com) only
for text posts lacking inline selftext and galleries (first image), and
summarises locally (or via an optional OpenAI-compatible endpoint incl.
vision). Each listing page is then sent to the native host as `writeItems`
batches of ≤ 50 **immediately** (one shared `syncId` for the whole run), so a
429 or a Cancel on a later page keeps everything already written; the final
report (counts, per-subreddit totals, added/updated) is accumulated per page.
Errors (429/403/5xx, login wall, user mismatch) and how many items were
already written are shown in the page log; Cancel aborts via `AbortSignal`.

## Layout

- `manifest.base.json` → per-browser manifests via `scripts/build.mjs`
- `src/parser.js` old.reddit HTML → items (tolerant; collects unparseable things as issues)
- `src/scraper.js` async generator: pagination, politeness, incremental stop, enrichment
- `src/summarize.js` local extractive summariser + optional AI with fallback
- `src/native.js` native-messaging contract wrapper (ping/checkVault/getKnownIds/writeItems)
- `src/settings.js` storage-backed settings with defaults
- `test/` `node --test` + jsdom fixtures (synthetic old.reddit pages + a real login-wall capture)

## Known limitations

- Fixtures are synthetic old.reddit markup (a real logged-in saved page could
  not be captured); parser assumptions are listed in `docs/DESIGN.md` notes and
  may need small selector tweaks against the live site.
- Reddit exposes no save *timestamp* — ordering uses listing rank + first-seen
  sync id (see DESIGN.md).
- Comments' parent titles come from `p.parent a.title`; if Reddit omits it the
  title falls back to `(untitled)`.
