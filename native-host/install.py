#!/usr/bin/env python3
"""Install/uninstall the reddit_scraper_obsidian native messaging host manifest.

User-level installs only. Python 3 stdlib.

  python3 install.py [--chrome-extension-id ID] [--dry-run] [--uninstall]

Firefox : ~/.mozilla/native-messaging-hosts/reddit_scraper_obsidian.json
Chrome  : ~/.config/google-chrome/NativeMessagingHosts/  and
          ~/.config/chromium/NativeMessagingHosts/
          (skipped with a note unless --chrome-extension-id is given)
macOS   : ~/Library/Application Support/Mozilla/NativeMessagingHosts/
          ~/Library/Application Support/Google/Chrome/NativeMessagingHosts/
          ~/Library/Application Support/Chromium/NativeMessagingHosts/
Windows : registry-based; not handled here (see README).
"""

from __future__ import annotations

import argparse
import json
import os
import stat
import sys

HOST_NAME = "reddit_scraper_obsidian"
FIREFOX_ALLOWED = ["reddit-scraper@lain.local"]
HERE = os.path.dirname(os.path.abspath(__file__))
HOST_SCRIPT = os.path.join(HERE, "reddit_scraper_host.py")


def home() -> str:
    return os.path.expanduser("~")


def manifest(path_is_python: str) -> dict:
    return {
        "name": HOST_NAME,
        "description": "Writes Reddit saved items into an Obsidian vault",
        "path": path_is_python,
        "type": "stdio",
    }


def targets(chrome_extension_id: str | None) -> list[tuple[str, dict]]:
    """Return (manifest_path, manifest_dict) pairs for this platform."""
    out: list[tuple[str, dict]] = []
    plat = sys.platform
    if plat.startswith("linux"):
        m = manifest(HOST_SCRIPT)
        m["allowed_extensions"] = list(FIREFOX_ALLOWED)
        out.append((os.path.join(home(), ".mozilla", "native-messaging-hosts", HOST_NAME + ".json"), m))
        if chrome_extension_id:
            m2 = manifest(HOST_SCRIPT)
            m2["allowed_origins"] = ["chrome-extension://%s/" % chrome_extension_id]
            for browser in ("google-chrome", "chromium"):
                out.append((os.path.join(home(), ".config", browser, "NativeMessagingHosts", HOST_NAME + ".json"), m2))
    elif plat == "darwin":
        m = manifest(HOST_SCRIPT)
        m["allowed_extensions"] = list(FIREFOX_ALLOWED)
        out.append((os.path.join(home(), "Library", "Application Support", "Mozilla", "NativeMessagingHosts", HOST_NAME + ".json"), m))
        if chrome_extension_id:
            m2 = manifest(HOST_SCRIPT)
            m2["allowed_origins"] = ["chrome-extension://%s/" % chrome_extension_id]
            for browser in (("Google", "Chrome"), ("Chromium",)):
                parts = (home(), "Library", "Application Support") + browser + ("NativeMessagingHosts",)
                out.append((os.path.join(*parts, HOST_NAME + ".json"), m2))
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Install the reddit_scraper_obsidian native messaging host")
    ap.add_argument("--chrome-extension-id", help="Chrome extension ID; without it, Chrome/Chromium manifests are skipped")
    ap.add_argument("--dry-run", action="store_true", help="print what would be written/removed; touch nothing")
    ap.add_argument("--uninstall", action="store_true", help="remove installed manifests")
    args = ap.parse_args(argv)

    if sys.platform.startswith("win"):
        print("NOTE: Windows installs host manifests via the registry; this script supports "
              "Linux and macOS only. See README.md for the Windows registry keys.")

    tgts = targets(args.chrome_extension_id)
    if not args.chrome_extension_id and not args.uninstall:
        print("NOTE: --chrome-extension-id not given; skipping Chrome/Chromium manifests.")

    if not os.path.isfile(HOST_SCRIPT):
        print("ERROR: host script not found at %s" % HOST_SCRIPT, file=sys.stderr)
        return 1

    if args.uninstall:
        for path, _ in tgts:
            if args.dry_run:
                print("would remove: %s" % path)
            elif os.path.exists(path):
                os.remove(path)
                print("removed %s" % path)
            else:
                print("not present: %s" % path)
        return 0

    if not args.dry_run:
        st = os.stat(HOST_SCRIPT)
        os.chmod(HOST_SCRIPT, st.st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        print("chmod +x %s" % HOST_SCRIPT)

    for path, man in tgts:
        body = json.dumps(man, indent=2) + "\n"
        if args.dry_run:
            print("would write %s:\n%s" % (path, body))
            continue
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(body)
        os.replace(tmp, path)
        print("wrote %s" % path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
