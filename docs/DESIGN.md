# Reddit Saved → Obsidian — Design & Contracts

## Goal
A browser extension (Firefox first, Chrome second) that scrapes the **saved posts/comments** of a
configurable Reddit user — *without the Reddit API* — and writes them into a configurable Obsidian
vault, inside a dedicated folder (default `Reddit`), one note per subreddit, newest-saved first.

## Constraints / decisions
- **No Reddit API / no OAuth app / no `.json` endpoints.** The extension fetches
  `https://old.reddit.com/user/<username>/saved` HTML using the browser's existing logged-in
  session cookies and parses it with `DOMParser`. Pagination via the `next ›` link (`?count=N&after=t3_xxx`).
  Saved items are private: the browser must be logged in as `<username>`; detect and report a mismatch.
- **Polite**: ≥ 1 s between requests (configurable, default 3 s, min 1 s), sequential.
  429/5xx/network errors are retried with backoff (see *Rate limits & retry*);
  403 fails immediately (likely blocked/login).
- **Ordering**: Reddit does not expose save time, but the saved listing is ordered most-recently-saved
  first. Each item carries its `rank` in the listing (0 = newest). The host assigns a persistent
  `order = [firstSeenSyncId, rank]`; notes sort by `firstSeenSyncId` desc, then `rank` asc.
  Items already known keep their original order key. Result: newest-saved on top.
- **Writing files**: extensions cannot write arbitrary paths, so a small **native messaging host**
  (Python 3 stdlib only) writes into the vault. Works in Firefox and Chrome, works with Obsidian closed,
  and lets the vault path be a plain user setting.
- **Summaries**: pluggable. Default = local extractive summary (no network, no AI).
  Optional = any OpenAI-compatible chat endpoint (Ollama, LM Studio, OpenAI…) configured in options;
  used for image description (vision) and optionally text. Without AI, image posts get a fallback
  summary built from title/caption/alt text plus an embedded image.
- **Background context**: Chrome MV3 service workers have no `DOMParser`, so the scraping/sync runs in an
  extension page (`sync.html`, opened in a tab from the popup) for both browsers.

## Repository layout
```
extension/            browser extension source (plain ES modules, no bundler)
  manifest.base.json  shared manifest; build script emits per-browser manifests
  src/                parser, scraper, summariser, native client, options/sync/popup pages
  test/               node --test unit tests (+ fixtures/ of real old.reddit HTML)
native-host/          Python native messaging host + installer
  reddit_scraper_host.py
  install.py          installs host manifests for Firefox and Chrome/Chromium (user-level)
  tests/              python unittest
scripts/build.mjs     produces dist/firefox and dist/chrome
test-vault/           throwaway Obsidian vault for development (has .obsidian/)
```

## Native messaging contract
Host name: `reddit_scraper_obsidian`  
Extension IDs: Firefox `reddit-scraper@lain.local`; Chrome: key-pinned or configured at install time.
Framing: standard native messaging (4-byte native-endian length + UTF-8 JSON). One request → one response.
Every response has `ok: boolean`; on failure `error: string`.

| Request | Response |
|---|---|
| `{"cmd":"ping"}` | `{"ok":true,"version":"0.1.0"}` |
| `{"cmd":"checkVault","vaultPath":P}` | `{"ok":true,"exists":bool,"isVault":bool}` (`isVault` = has `.obsidian/`) |
| `{"cmd":"getKnownIds","vaultPath":P,"folder":F}` | `{"ok":true,"ids":["t3_abc", "t1_def", ...],"lastSyncId":S\|null}` (`lastSyncId` = max `syncId` among stored order keys; `null` when the vault holds nothing) |
| `{"cmd":"writeItems","vaultPath":P,"folder":F,"syncId":S,"items":[Item…]}` | `{"ok":true,"added":n,"updated":n,"subreddits":["Python",…]}` |

- `vaultPath` must be absolute and exist; `folder` is a single relative path segment-safe name
  (may contain `/` for nesting but no `..`, no absolute paths). All writes stay under `vaultPath/folder`.
- `syncId`: ISO-8601 UTC timestamp of when the sync started (same for all batches of one sync).
- Extension sends items in batches (≤ 50 per message). Items are flushed per
  listing page (each page's batch written right after its detail enrichment +
  summaries), so a mid-run 429/cancel keeps partial progress under the same
  `syncId`; `rank` stays the global listing index across pages.

### Item
```json
{
  "id": "t3_abc123",              // Reddit fullname; t3_ = post, t1_ = comment
  "kind": "post" | "comment",
  "subreddit": "Python",          // without r/ ; user-profile posts are "u_name"
  "title": "Post title",          // for comments: title of the parent post
  "permalink": "https://www.reddit.com/r/Python/comments/abc123/slug/",
  "url": "https://example.com/…", // link target / media url (may equal permalink for self posts)
  "author": "someone",
  "createdUtc": 1714560000,       // seconds
  "postType": "text" | "image" | "gallery" | "video" | "link" | "comment",
  "summary": "Plain text / light markdown summary",
  "summarySource": "selftext" | "selftext-ai" | "image-ai" | "image-fallback" | "link" | "comment",
  "imageUrl": "https://i.redd.it/…" | null,
  "nsfw": false,
  "rank": 0                      // position in this sync's saved listing, 0 = most recently saved
}
```

## Vault output
```
<vault>/<folder>/
  Reddit Index.md          # table/list of [[r-Sub]] links with counts, sorted by count desc
  r-Python.md              # one note per subreddit ("u-name.md" for u_name profile posts)
  .reddit-scraper/state.json   # host-owned state: every item + order key (source of truth)
```
Subreddit note:
```markdown
---
subreddit: Python
source: reddit-saved
count: 12
updated: 2026-10-29T12:00:00Z
tags: [reddit, reddit/Python]
---
# r/Python

### [Post title](https://www.reddit.com/r/Python/comments/abc123/slug/)
<!-- rs:t3_abc123 -->
- **Type:** text · **Author:** u/someone · **Posted:** 2024-05-01 · **First synced:** 2026-10-29
- **Link:** https://example.com/…        (only for link posts)

> Summary paragraph(s), each line prefixed with "> ".

![](https://i.redd.it/…)                  (image posts, when an image URL exists)

---

## My notes
(anything from this heading to end of file is preserved verbatim across syncs)
```
Notes are regenerated from `state.json` on each write; only the `## My notes` tail is preserved.
Re-sending a known id updates its fields (summary etc.) but keeps its order key.

## Rate limits & retry (`src/scraper.js`)

Every Reddit request — listing pages *and* detail pages — goes through one
shared helper, `fetchResilient(fetchImpl, url, init, ctx)`:

- **Retryable**: HTTP 429, HTTP 5xx, network errors. **Not retried**: 403
  (blocked/login — waiting doesn't help) and other 4xx; the caller turns those
  into `HttpError` (listing) or logs and continues (detail page).
- **Wait computation** (first match wins): `Retry-After` response header
  (delta-seconds or HTTP date), else `x-ratelimit-reset` (epoch seconds,
  wait until then), else exponential backoff 60 s, doubling per attempt,
  capped at 10 min. Any *single* wait is capped at 15 min.
  Default policy: `maxAttempts: 6` (configurable via `opts.retry`).
- After the final failed attempt: throw `HttpError` (or a network `Error`),
  failing the run — but every already-written page stays in the vault.
- Waits use the injectable `sleep(ms, signal)`, so they are
  AbortSignal-cancellable (Cancel works mid-wait) and mockable in tests.
- Before each wait the scraper emits a progress event
  `{type:'rateLimited', status, waitMs, attempt, maxAttempts, url}`; the sync
  page renders it as a live countdown (*Rate limited — retrying in 1:23
  (attempt 2/6)*).
- **Adaptive pacing**: any 429 doubles the inter-request delay for the rest of
  the run (cap 30 s). Additionally, when a response carries
  `x-ratelimit-remaining` < 2 together with `x-ratelimit-reset`, the scraper
  sleeps until the reset window before issuing its next request.
  Default inter-request delay raised from 2000 ms to 3000 ms.
- Detail-page 429s back off through the same helper; exhausted retries fail
  the run rather than silently skipping (silently skipping made later pages
  keep hammering Reddit while rate-limited).

## Resumable syncs (`src/resume.js` + sync page)

Batches are written per listing page; after each *successful* write the sync
page persists a cursor in `storage.local` (key `resumeCursor`):
`{username, vaultPath, folder, syncId, nextUrl, nextRank, page, itemsWritten, skipKnown, updatedAt}`.

- On sync-page load, a cursor matching the current username/vaultPath/folder
  shows: *Previous sync stopped at page N (X items written) — [Resume] [Start over]*.
- **Resume** calls `scrapeSaved` with `startUrl = nextUrl`, `startRank =
  nextRank`, `startPage = page`, the **same syncId**, and `skipKnown` from the
  cursor (older cursors without the field fall back to the incremental
  setting): known ids are skipped (not fetched/summarised/written) but still
  consume a rank — keeping ordering consistent with the host's `order` key —
  and never stop the run (the incremental stop-at-first-known rule is disabled).
- **Start over** clears the cursor and runs normally.
- A normal completion (no pending `nextUrl`) clears the cursor.
- In a normal incremental run, the first item already being known stops
  immediately — correct behaviour for an up-to-date vault.
- `maxItems` bounds only the items **newly collected** by the run: skipped
  known items never count against it, so a vault holding 200 items with
  `maxItems 1000` can still gain up to 1000 new items in resume/fill-gaps runs.
- `src/resume.js` is pure (storage adapter injected) and unit-tested.

## Fill gaps (cursor-less recovery)

A sync interrupted **before the resume-cursor feature existed** (or whose
cursor was lost) cannot Resume: pressing Start would stop at the first known
item, so the never-fetched tail stays unreachable forever. The sync page's
**Fill gaps** button fixes that:

- Walks the saved listing **from the first page** with `skipKnown = true`
  (known items cost no detail fetches, no summaries, no writes — they only
  consume a rank) and `rank` starting at 0 (global listing index).
- Uses `syncId = lastSyncId` from `getKnownIds` when the host reports one, so
  newly found older items land in the **same order bucket** as the existing
  entries and sort **below** them within that sync — save-order is preserved.
  With no `lastSyncId` (empty/recovered vault) it falls back to a fresh ISO
  timestamp.
- Saves/clears the resume cursor exactly like a normal run, with `skipKnown:
  true` recorded — a 429 during Fill gaps is resumable **in the same mode**
  (Resume will not stop at known items).
- `maxItems` counts only newly collected items (see above).

## No-duplicates guarantee

Running the scrape any number of times, in any mode (full, incremental,
resume, fill gaps), possibly from two tabs at once, never duplicates an entry
in the vault:

- **Host keying**: items are keyed by Reddit fullname id; ids are stripped
  (validated lowercase `t1_`/`t3_` prefix). Duplicate ids **within one
  `writeItems` batch** collapse (last copy wins, counted once). A known id is
  always **updated in place**, keeping its original `order` key — never a
  second entry. Notes are regenerated from `state.json`, so every
  `<!-- rs:ID -->` marker appears exactly once.
- **State recovery**: if `.reddit-scraper/state.json` is missing, state is
  rebuilt from the rendered notes before applying the write; if it is corrupt,
  it is moved aside to `state.json.corrupt-<timestamp>` and rebuilt. Parsing
  uses the `<!-- rs:ID -->` blocks (heading/permalink/kind, meta line, Link
  line, blockquoted summary, image) and assigns order keys from the
  *First synced* date + display position, reproducing the previous sort.
  `getKnownIds` uses the same recovery, so the extension still skips those
  ids instead of re-syncing (and potentially forking) them.
- **Concurrency**: every read-modify-write of state + notes runs under an
  exclusive `fcntl.flock` on `.reddit-scraper/lock` (no-op fallback where
  `fcntl` is unavailable), serialising two sync tabs / two browsers.
- **Scraper**: each id is emitted at most once per run — an item reappearing
  on a later page (listing shift during pagination) keeps its first rank and
  the duplicate is dropped, so an id is never sent to the host twice in one
  sync. The host additionally collapses it (above).
- **Sync tabs**: while a run is active the sync page keeps a
  `storage.local` flag (`syncRunning`, `{tabId, startedAt, updatedAt}`) with
  a 30 s heartbeat; a second tab refuses to start while the flag is fresh
  (stale after 2 min — a crashed tab stops blocking). Start / Resume / Fill
  gaps buttons are disabled while a run is active in this tab.
