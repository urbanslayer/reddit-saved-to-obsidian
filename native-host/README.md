# native-host

Python 3 (stdlib only) native messaging host that writes Reddit saved items
into an Obsidian vault. Contract: [`../docs/DESIGN.md`](../docs/DESIGN.md).

## Install (per user)

```bash
python3 native-host/install.py                       # Firefox manifest only
python3 native-host/install.py --chrome-extension-id <ID>   # + Chrome/Chromium
python3 native-host/install.py --dry-run             # print manifests, write nothing
python3 native-host/install.py --uninstall [--chrome-extension-id ID]
```

Manifests (host name `reddit_scraper_obsidian`):

- Firefox: `~/.mozilla/native-messaging-hosts/reddit_scraper_obsidian.json`
  (allowed: `reddit-scraper@lain.local`)
- Chrome/Chromium: `~/.config/google-chrome/NativeMessagingHosts/` and
  `~/.config/chromium/NativeMessagingHosts/` (allowed origin: the extension ID
  you pass — get it from `about:chrome/extensions` or the build output)
- macOS equivalents under `~/Library/Application Support/...` are handled;
  Windows needs registry keys (not automated here):
  `HKCU\Software\Mozilla\NativeMessagingHosts\reddit_scraper_obsidian` and
  `HKCU\Software\Google\Chrome\NativeMessagingHosts\reddit_scraper_obsidian`
  pointing at a manifest JSON.

Re-run `install.py` after moving the repo (the manifest embeds the absolute
path of `reddit_scraper_host.py`).

## Usage

The extension sends length-prefixed JSON messages (`ping`, `checkVault`,
`getKnownIds`, `writeItems` — see DESIGN.md). State lives in
`<vault>/<folder>/.reddit-scraper/state.json` (source of truth); notes are
regenerated from it on every write, preserving any `## My notes` tail.
Host logs go to `~/.local/state/reddit-scraper/host.log` (stderr too);
stdout carries only framed messages.

## Tests

From the repo root:

```bash
python3 -m unittest discover -s native-host/tests -v
```
