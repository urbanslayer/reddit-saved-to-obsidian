# Reddit Saved → Obsidian (Reddit Scraper)

Scrapes a Reddit user's **saved** posts/comments from `old.reddit.com` HTML
(no Reddit API, no OAuth) and writes them into an Obsidian vault folder through
a native messaging host. Firefox-first MV3 extension, Chrome also builds.

- [`extension/README.md`](extension/README.md) — the browser extension: build,
  load for testing, sync flow, and **permanent install in Firefox** (unlisted
  AMO signing).
- [`native-host/README.md`](native-host/README.md) — the Python native
  messaging host: install, vault layout, troubleshooting.
- [`docs/DESIGN.md`](docs/DESIGN.md) — architecture and data-format decisions.

## Quick start

```sh
cd extension && npm install
npm test                       # unit tests
node ../scripts/build.mjs      # emits dist/firefox and dist/chrome
```

Load `dist/firefox/manifest.json` as a temporary add-on in
`about:debugging`, install the native host (`python3 ../native-host/install.py
--firefox`), then follow the extension README. To install permanently in
release Firefox, sign it: `npm run sign:firefox` (see the extension README).
