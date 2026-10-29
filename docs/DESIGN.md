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
- **Polite**: ≥ 2 s between requests (configurable, min 1 s), sequential, stop on 429/403 with a clear error.
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
| `{"cmd":"getKnownIds","vaultPath":P,"folder":F}` | `{"ok":true,"ids":["t3_abc", "t1_def", ...]}` |
| `{"cmd":"writeItems","vaultPath":P,"folder":F,"syncId":S,"items":[Item…]}` | `{"ok":true,"added":n,"updated":n,"subreddits":["Python",…]}` |

- `vaultPath` must be absolute and exist; `folder` is a single relative path segment-safe name
  (may contain `/` for nesting but no `..`, no absolute paths). All writes stay under `vaultPath/folder`.
- `syncId`: ISO-8601 UTC timestamp of when the sync started (same for all batches of one sync).
- Extension sends items in batches (≤ 50 per message).

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
