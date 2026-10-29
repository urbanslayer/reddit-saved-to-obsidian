#!/usr/bin/env python3
"""Native messaging host: writes Reddit saved items into an Obsidian vault.

Contract: docs/DESIGN.md. Python 3 stdlib only.

Framing: 4-byte native-endian uint32 length + UTF-8 JSON, one request ->
one response, loop until EOF. Nothing but framed messages ever touches
stdout; diagnostics go to stderr and ~/.local/state/reddit-scraper/host.log.

Core logic lives in handle_message() / VaultWriter so it is testable without
stdio; main() only does framing.
"""

from __future__ import annotations

import datetime as _dt
import json
import os
import re
import struct
import sys

VERSION = "0.1.0"
HOST_NAME = "reddit_scraper_obsidian"
STATE_DIR_NAME = ".reddit-scraper"
STATE_FILE_NAME = "state.json"
INDEX_NAME = "Reddit Index.md"
NOTES_HEADING = "## My notes"
MAX_MSG_BYTES = 1024 * 1024  # native messaging inbound limit

_ID_RE = re.compile(r"^t[13]_[a-z0-9]+$")
_SUBREDDIT_RE = re.compile(r"^[A-Za-z0-9_]{1,50}$")

CONFIG_DIR = os.path.join(
    os.environ.get("XDG_STATE_HOME", os.path.join(os.path.expanduser("~"), ".local", "state")),
    "reddit-scraper",
)
LOG_PATH = os.path.join(CONFIG_DIR, "host.log")


def log(msg: str) -> None:
    line = "%s %s\n" % (_dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), msg)
    sys.stderr.write(line)
    sys.stderr.flush()
    try:
        os.makedirs(CONFIG_DIR, exist_ok=True)
        with open(LOG_PATH, "a", encoding="utf-8") as fh:
            fh.write(line)
    except OSError:
        pass


class HostError(Exception):
    """Expected, reportable failure -> {ok:false, error:...}."""


# --------------------------------------------------------------------------
# Native messaging framing
# --------------------------------------------------------------------------

def read_message(stream) -> object | None:
    """Read one length-prefixed JSON message. None on clean EOF."""
    raw = _read_exactly(stream, 4)
    if raw is None:
        return None
    (length,) = struct.unpack("=I", raw)
    if length == 0 or length > MAX_MSG_BYTES:
        raise HostError("invalid message length: %d" % length)
    body = _read_exactly(stream, length)
    if body is None:
        raise HostError("stdin closed mid-message")
    return json.loads(body.decode("utf-8"))


def write_message(stream, obj: object) -> None:
    body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    stream.write(struct.pack("=I", len(body)) + body)
    stream.flush()


def _read_exactly(stream, n: int) -> bytes | None:
    buf = bytearray()
    while len(buf) < n:
        chunk = stream.read(n - len(buf))
        if not chunk:
            if not buf:
                return None
            raise HostError("stdin closed mid-message")
        buf += chunk
    return bytes(buf)


# --------------------------------------------------------------------------
# Validation helpers
# --------------------------------------------------------------------------

def _require_abs_path(value, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise HostError("%s must be a non-empty string" % label)
    if not os.path.isabs(value):
        raise HostError("%s must be an absolute path: %r" % (label, value))
    return value


def validate_vault_path(value) -> str:
    path = _require_abs_path(value, "vaultPath")
    if not os.path.isdir(path):
        raise HostError("vaultPath is not an existing directory: %s" % path)
    return path


def validate_folder(value) -> str:
    if not isinstance(value, str) or not value:
        raise HostError("folder must be a non-empty string")
    if value.startswith("/") or value.startswith("\\"):
        raise HostError("folder must be relative (no leading '/')")
    if "\\" in value or ":" in value:
        raise HostError("folder must not contain backslashes or drive letters")
    for seg in value.split("/"):
        if not seg or seg in (".", ".."):
            raise HostError("folder must not contain empty, '.' or '..' segments: %r" % value)
    return value


def validate_item(item) -> str | None:
    """Return None if item is valid, else a reason string."""
    if not isinstance(item, dict):
        return "item is not an object"
    id_ = item.get("id")
    if not isinstance(id_, str) or not _ID_RE.match(id_):
        return "bad id: %r" % (item.get("id"),)
    sub = item.get("subreddit")
    if not isinstance(sub, str) or not _SUBREDDIT_RE.match(sub):
        return "bad subreddit: %r" % (item.get("subreddit"),)
    link = item.get("permalink")
    if not isinstance(link, str) or not link.startswith("https://"):
        return "permalink must start with https://"
    if item.get("kind") not in ("post", "comment"):
        return "bad kind: %r" % (item.get("kind"),)
    if not isinstance(item.get("title"), str):
        return "title must be a string"
    if not isinstance(item.get("createdUtc"), (int, float)) or isinstance(item.get("createdUtc"), bool):
        return "createdUtc must be a number"
    return None


def _containment_check(base_dir: str, target: str, label: str) -> None:
    base = os.path.realpath(base_dir)
    real = os.path.realpath(target)
    if real != base and not real.startswith(base + os.sep):
        raise HostError("%s escapes vault folder: %s" % (label, target))


# --------------------------------------------------------------------------
# Vault writing
# --------------------------------------------------------------------------

def _note_basename(subreddit: str) -> str:
    if subreddit.startswith("u_"):
        return "u-%s.md" % subreddit[2:]
    return "r-%s.md" % subreddit


def _display_name(subreddit: str) -> str:
    if subreddit.startswith("u_"):
        return "u/%s" % subreddit[2:]
    return "r/%s" % subreddit


def _iso_utc_now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _date_from_epoch(secs) -> str:
    try:
        return _dt.datetime.fromtimestamp(int(secs), _dt.timezone.utc).strftime("%Y-%m-%d")
    except (OverflowError, OSError, ValueError):
        return "unknown"


def _date_from_sync_id(sync_id: str) -> str:
    m = re.match(r"^(\d{4}-\d{2}-\d{2})", str(sync_id))
    return m.group(1) if m else str(sync_id)


def _escape_link_text(title: str) -> str:
    cleaned = " ".join(str(title).split())
    if not cleaned:
        cleaned = "(untitled)"
    return cleaned.replace("\\", "\\\\").replace("[", "\\[").replace("]", "\\]")


def _blockquoted(summary: str) -> str:
    text = str(summary).replace("\r\n", "\n").strip("\n")
    if not text.strip():
        return "> _(no summary)_"
    lines = []
    for line in text.split("\n"):
        line = line.rstrip()
        lines.append("> %s" % line if line else ">")
    return "\n".join(lines)


class VaultWriter:
    """Owns <vault>/<folder>: .reddit-scraper/state.json (truth) + regenerated notes."""

    def __init__(self, vault_path: str, folder: str):
        self.vault_path = validate_vault_path(vault_path)
        self.folder = validate_folder(folder)
        self.folder_path = os.path.join(self.vault_path, self.folder)
        _containment_check(self.vault_path, self.folder_path, "folder")
        self.state_dir = os.path.join(self.folder_path, STATE_DIR_NAME)
        self.state_path = os.path.join(self.state_dir, STATE_FILE_NAME)

    # -- state ------------------------------------------------------------

    def load_state(self) -> dict:
        try:
            with open(self.state_path, encoding="utf-8") as fh:
                state = json.load(fh)
        except FileNotFoundError:
            return {"items": {}}
        except (json.JSONDecodeError, OSError) as exc:
            raise HostError("corrupt state.json (%s): %s" % (self.state_path, exc))
        if not isinstance(state, dict) or not isinstance(state.get("items"), dict):
            raise HostError("malformed state.json: %s" % self.state_path)
        return state

    def save_state(self, state: dict) -> None:
        self._makedirs(self.state_dir)
        tmp = self.state_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(state, fh, ensure_ascii=False, indent=1)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, self.state_path)

    def known_ids(self) -> list:
        return sorted(self.load_state()["items"].keys())

    # -- write ------------------------------------------------------------

    def write_items(self, msg: dict) -> dict:
        sync_id = msg.get("syncId")
        if not isinstance(sync_id, str) or not sync_id:
            raise HostError("syncId must be a non-empty string")
        items = msg.get("items")
        if not isinstance(items, list):
            raise HostError("items must be a list")
        self._makedirs(self.folder_path)
        state = self.load_state()
        stored = state["items"]
        added = updated = skipped = 0
        touched: set = set()
        for item in items:
            reason = validate_item(item)
            if reason:
                skipped += 1
                log("skipping invalid item (%s): %r" % (reason, item.get("id") if isinstance(item, dict) else item))
                continue
            record = dict(item)
            known = stored.get(record["id"])
            if known is not None:
                record["order"] = known.get("order") or {
                    "syncId": sync_id,
                    "rank": record.get("rank", 0),
                }
                updated += 1
            else:
                rank = record.get("rank")
                record["order"] = {
                    "syncId": sync_id,
                    "rank": rank if isinstance(rank, int) and not isinstance(rank, bool) else 0,
                }
                added += 1
            stored[record["id"]] = record
            touched.add(record["subreddit"])
        self.save_state(state)
        for sub in touched:
            self.write_subreddit_note(sub, state)
        self.write_index(state)
        return {
            "ok": True,
            "added": added,
            "updated": updated,
            "skipped": skipped,
            "subreddits": sorted(touched),
        }

    # -- notes ------------------------------------------------------------

    def note_path(self, subreddit: str) -> str:
        path = os.path.join(self.folder_path, _note_basename(subreddit))
        _containment_check(self.folder_path, path, "note file")
        return path

    def _sorted_entries(self, state: dict, subreddit: str) -> list:
        entries = [it for it in state["items"].values() if it.get("subreddit") == subreddit]
        entries.sort(key=lambda it: (
            str(it.get("order", {}).get("syncId", "")),
            -int(it.get("order", {}).get("rank", 0) or 0),
        ))
        entries.reverse()
        return entries

    def write_subreddit_note(self, subreddit: str, state: dict) -> str:
        entries = self._sorted_entries(state, subreddit)
        path = self.note_path(subreddit)
        try:
            with open(path, encoding="utf-8") as fh:
                existing = fh.read()
        except FileNotFoundError:
            existing = ""
        preserved = self._extract_user_notes(existing)
        display = _display_name(subreddit)
        parts = [
            "\n".join([
                "---",
                "subreddit: %s" % subreddit,
                "source: reddit-saved",
                "count: %d" % len(entries),
                "updated: %s" % _iso_utc_now(),
                "tags: [reddit, reddit/%s]" % subreddit,
                "---",
                "# %s" % display,
            ])
        ]
        for entry in entries:
            parts.append(self._render_entry(entry))
        if preserved is not None:
            parts.append(preserved.strip("\n"))
        else:
            parts.append("%s\n" % NOTES_HEADING)
        content = "\n\n".join(parts).rstrip("\n") + "\n"
        self._atomic_write(path, content)
        return path

    @staticmethod
    def _extract_user_notes(existing: str) -> str | None:
        """Everything from an exact '## My notes' line to EOF, or None."""
        if not existing:
            return None
        lines = existing.split("\n")
        for i, line in enumerate(lines):
            if line.rstrip("\r") == NOTES_HEADING:
                return "\n".join(lines[i:])
        return None

    @staticmethod
    def _render_entry(item: dict) -> str:
        link_text = _escape_link_text(item.get("title"))
        permalink = item.get("permalink")
        order = item.get("order", {})
        meta = [
            "**Type:** %s" % item.get("postType", "text"),
            "**Author:** u/%s" % (item.get("author") or "unknown"),
            "**Posted:** %s" % _date_from_epoch(item.get("createdUtc", 0)),
            "**First synced:** %s" % _date_from_sync_id(order.get("syncId", "unknown")),
        ]
        if item.get("nsfw"):
            meta.append("NSFW")
        if item.get("kind") == "comment":
            heading = "### 💬 Comment on: [%s](%s)" % (link_text, permalink)
        else:
            heading = "### [%s](%s)" % (link_text, permalink)
        top_lines = [
            heading,
            "<!-- rs:%s -->" % item.get("id"),
            "- " + " · ".join(meta),
        ]
        if item.get("postType") == "link" and item.get("url"):
            top_lines.append("- **Link:** %s" % item["url"])
        blocks = ["\n".join(top_lines)]
        blocks.append(_blockquoted(item.get("summary") or ""))
        if item.get("imageUrl"):
            blocks.append("![](%s)" % item["imageUrl"])
        blocks.append("---")
        return "\n\n".join(blocks)

    def write_index(self, state: dict) -> str:
        counts: dict = {}
        for it in state["items"].values():
            sub = it.get("subreddit")
            if isinstance(sub, str):
                counts[sub] = counts.get(sub, 0) + 1
        ordered = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0].lower()))
        path = os.path.join(self.folder_path, INDEX_NAME)
        _containment_check(self.folder_path, path, "index file")
        lines = [
            "---",
            "source: reddit-saved",
            "updated: %s" % _iso_utc_now(),
            "---",
        ]
        for sub, count in ordered:
            lines.append("- [[%s|%s]] — %d saved" % (_note_basename(sub)[:-3], _display_name(sub), count))
        content = "\n".join(lines) + "\n"
        self._atomic_write(path, content)
        return path

    # -- io helpers ---------------------------------------------------------

    @staticmethod
    def _makedirs(path: str) -> None:
        try:
            os.makedirs(path, exist_ok=True)
        except OSError as exc:
            raise HostError("cannot create directory %s: %s" % (path, exc))

    def _atomic_write(self, path: str, content: str) -> None:
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(content)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)


# --------------------------------------------------------------------------
# Dispatch
# --------------------------------------------------------------------------

def _writer_for(msg: dict) -> VaultWriter:
    return VaultWriter(msg.get("vaultPath"), msg.get("folder"))


def handle_message(msg) -> dict:
    try:
        if not isinstance(msg, dict):
            raise HostError("request must be a JSON object")
        cmd = msg.get("cmd")
        if cmd == "ping":
            return {"ok": True, "version": VERSION}
        if cmd == "checkVault":
            path = _require_abs_path(msg.get("vaultPath"), "vaultPath")
            exists = os.path.isdir(path)
            return {"ok": True, "exists": exists, "isVault": exists and os.path.isdir(os.path.join(path, ".obsidian"))}
        if cmd == "getKnownIds":
            return {"ok": True, "ids": _writer_for(msg).known_ids()}
        if cmd == "writeItems":
            return _writer_for(msg).write_items(msg)
        raise HostError("unknown cmd: %r" % (cmd,))
    except HostError as exc:
        return {"ok": False, "error": str(exc)}
    except Exception as exc:  # noqa: BLE001 — contract: exceptions -> ok:false
        log("unhandled error for %r: %r" % (msg, exc))
        return {"ok": False, "error": "%s: %s" % (type(exc).__name__, exc)}


# --------------------------------------------------------------------------
# stdio loop
# --------------------------------------------------------------------------

def main() -> int:
    stdin = sys.stdin.buffer
    stdout = sys.stdout.buffer
    log("host started (pid=%d)" % os.getpid())
    while True:
        try:
            msg = read_message(stdin)
        except EOFError:
            break
        if msg is None:
            break
        response = handle_message(msg)
        write_message(stdout, response)
    log("host exiting (stdin EOF)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
