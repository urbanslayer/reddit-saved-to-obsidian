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
pagination, ≥ 1 s (default 3 s) between requests, assigns `rank` (0 = newest
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

## Rate limits (429) and retries

Every Reddit request (listing **and** detail pages) goes through one shared
fetch helper (`src/scraper.js → fetchResilient`):

- **429 / 5xx / network errors are retried**: it honours `Retry-After`
  (delta-seconds or HTTP date) and `x-ratelimit-reset` (epoch seconds) when
  present; otherwise exponential backoff starting at 60 s, doubling, capped at
  10 min, **6 attempts total** (configurable). Any single wait is capped at
  15 min. After the final failed attempt the run fails with `HttpError`.
- **403 is never retried** (usually blocked/logged-out — waiting won't help).
- Waits are `AbortSignal`-cancellable (Cancel works mid-wait) and show a live
  countdown on the sync page: *Rate limited — retrying in 1:23 (attempt 2/6)*.
- **Adaptive pacing**: after any 429 the inter-request delay is doubled for
  the rest of the run (cap 30 s). If a response reports
  `x-ratelimit-remaining < 2` with `x-ratelimit-reset`, the sync sleeps until
  the reset window before its next request.

## Resume

After **each page's batch is written** to the vault, the sync page stores a
resume cursor in `storage.local` (`src/resume.js`): username, vaultPath,
folder, syncId, `nextUrl`, `nextRank`, page, items written. If a run later
dies (429 retries exhausted, cancel, closed tab), reopening the sync page
shows *Previous sync stopped at page N (X items written) — [Resume] [Start
over]*:

- **Resume** continues at the stored URL with the **same syncId and rank**, so
  vault ordering stays consistent. Already-known items are *skipped* (not
  re-fetched/summarised/written) but still consume a rank; the incremental
  "stop at first known" rule is disabled during a resumed run.
- **Start over** discards the cursor and runs a normal (incremental) sync.
- A sync that completes normally clears the cursor.

Note: in a normal incremental sync an already-known *first* item still stops
the run immediately — correct for an up-to-date vault.

## Fill gaps

If a sync was interrupted **before the resume cursor existed** (or the cursor
was lost), Resume is not offered and Start stops at the first known item —
the missing tail would be unreachable. Click **Fill gaps** on the sync page:
it walks the whole saved listing from the top, skipping posts already in the
vault (no detail fetch, no summary, no write for them), and adds any that are
missing. It reuses the vault's `lastSyncId` (reported by the host's
`getKnownIds`) as its sync id, so found items slot **below** the existing
entries and your saved-order is preserved; with nothing known it starts a
fresh id. The run is itself resumable: a 429 during Fill gaps stores a cursor
with `skipKnown: true`, so Resume continues in the same mode. `maxItems`
counts only newly collected items, so a vault already holding 200 entries
with `maxItems 1000` can still gain 1000 new ones.

## No duplicates

Running the sync repeatedly — any mode, any number of times, even from two
tabs — never writes the same saved item twice:

- The host keys everything by Reddit fullname id (stripped/normalised);
  duplicate ids inside one batch collapse, and a known id is updated in place
  keeping its order key. Every `<!-- rs:ID -->` marker appears exactly once
  per item across the notes.
- If `.reddit-scraper/state.json` is lost or corrupt, the host **rebuilds it
  from the rendered notes** before applying a write (corrupt files are backed
  up as `state.json.corrupt-<timestamp>`); `getKnownIds` benefits too, so
  existing entries are still recognised and not re-added.
- Concurrent writers (two sync tabs / two browsers) serialise on an exclusive
  `flock` file inside the folder (stdlib `fcntl`, safe no-op without it).
- The scraper emits each id at most once per run, even if the listing shifts
  during pagination and an item reappears on a later page (first rank kept).
- Only one sync tab can run at a time: the running tab holds a heartbeat
  flag in `storage.local` (stale after 2 min), and a second tab refuses to
  start; the Start/Resume/Fill gaps buttons are disabled during a run.

## Layout

- `manifest.base.json` → per-browser manifests via `scripts/build.mjs`
- `src/parser.js` old.reddit HTML → items (tolerant; collects unparseable things as issues)
- `src/scraper.js` async generator: pagination, politeness, incremental stop, enrichment, 429/5xx retry+backoff (shared `fetchResilient`), adaptive pacing, resume (`startUrl`/`startRank`/`skipKnown`), per-run id dedupe
- `src/summarize.js` local extractive summariser + optional AI with fallback
- `src/native.js` native-messaging contract wrapper (ping/checkVault/getKnownIds+lastSyncId/writeItems)
- `src/resume.js` pure resume-cursor helpers (save/load/clear/match, fill-gaps syncId) over a storage adapter
- `src/synclock.js` cross-tab single-run guard (heartbeat flag, stale after 2 min)
- `src/settings.js` storage-backed settings with defaults
- `test/` `node --test` + jsdom fixtures (synthetic old.reddit pages + a real login-wall capture); `rate-limit-resume.test.mjs` covers retry/backoff/pacing/resume/fill-gaps/dedupe with mocked fetch+sleep, `synclock.test.mjs` the concurrency flag

## Known limitations

- Fixtures are synthetic old.reddit markup (a real logged-in saved page could
  not be captured); parser assumptions are listed in `docs/DESIGN.md` notes and
  may need small selector tweaks against the live site.
- Reddit exposes no save *timestamp* — ordering uses listing rank + first-seen
  sync id (see DESIGN.md).
- Comments' parent titles come from `p.parent a.title`; if Reddit omits it the
  title falls back to `(untitled)`.
