"""Unit tests for reddit_scraper_host.

Run from repo root:
    python3 -m unittest discover -s native-host/tests -v
"""

from __future__ import annotations

import json
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest

TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
NATIVE_HOST_DIR = os.path.dirname(TESTS_DIR)
REPO_ROOT = os.path.dirname(NATIVE_HOST_DIR)
HOST_SCRIPT = os.path.join(NATIVE_HOST_DIR, "reddit_scraper_host.py")

sys.path.insert(0, NATIVE_HOST_DIR)
import reddit_scraper_host as host  # noqa: E402


def make_item(**over):
    item = {
        "id": "t3_abc123",
        "kind": "post",
        "subreddit": "Python",
        "title": "Post title",
        "permalink": "https://www.reddit.com/r/Python/comments/abc123/slug/",
        "url": "https://www.reddit.com/r/Python/comments/abc123/slug/",
        "author": "someone",
        "createdUtc": 1714560000,  # 2024-05-01
        "postType": "text",
        "summary": "A plain summary.",
        "summarySource": "selftext",
        "imageUrl": None,
        "nsfw": False,
        "rank": 0,
    }
    item.update(over)
    return item


class HostTestCase(unittest.TestCase):
    def setUp(self):
        self.vault = tempfile.mkdtemp(prefix="rs-test-vault-")
        self.addCleanup(shutil.rmtree, self.vault, True)
        os.makedirs(os.path.join(self.vault, ".obsidian"), exist_ok=True)

    def handle(self, msg):
        return host.handle_message(msg)

    def write(self, items, sync_id="2026-10-29T12:00:00Z", folder="Reddit", **over):
        msg = {"cmd": "writeItems", "vaultPath": self.vault, "folder": folder,
               "syncId": sync_id, "items": items}
        msg.update(over)
        return self.handle(msg)

    def note(self, name, folder="Reddit"):
        with open(os.path.join(self.vault, folder, name), encoding="utf-8") as fh:
            return fh.read()

    def index(self, folder="Reddit"):
        return self.note("Reddit Index.md", folder)

    def all_markers(self):
        """Every `<!-- rs:ID -->` marker across all subreddit notes."""
        folder = os.path.join(self.vault, "Reddit")
        markers = []
        for name in sorted(os.listdir(folder)):
            if name.endswith(".md") and name != "Reddit Index.md":
                with open(os.path.join(folder, name), encoding="utf-8") as fh:
                    markers += re.findall(r"<!-- rs:(\S+) -->", fh.read())
        return markers


class TestFraming(HostTestCase):
    def test_read_write_roundtrip(self):
        import io
        buf = io.BytesIO()
        host.write_message(buf, {"cmd": "ping"})
        buf.seek(0)
        self.assertEqual(host.read_message(buf), {"cmd": "ping"})

    def test_subprocess_ping_and_write(self):
        """Spawn the host binary and speak real framed protocol to it."""
        payload = [
            {"cmd": "ping"},
            {"cmd": "writeItems", "vaultPath": self.vault, "folder": "Reddit",
             "syncId": "2026-10-29T12:00:00Z", "items": [make_item()]},
        ]
        stdin = b"".join(
            struct.pack("=I", len(b := json.dumps(m).encode())) + b for m in payload
        )
        proc = subprocess.run([sys.executable, HOST_SCRIPT], input=stdin,
                              capture_output=True, timeout=30)
        self.assertEqual(proc.returncode, 0, proc.stderr.decode())
        out = proc.stdout
        responses = []
        pos = 0
        while pos < len(out):
            (n,) = struct.unpack("=I", out[pos:pos + 4])
            responses.append(json.loads(out[pos + 4:pos + 4 + n]))
            pos += 4 + n
        self.assertEqual(len(responses), 2)
        self.assertEqual(responses[0], {"ok": True, "version": host.VERSION})
        self.assertEqual(responses[1]["ok"], True)
        self.assertEqual(responses[1]["added"], 1)
        self.assertTrue(os.path.isfile(os.path.join(self.vault, "Reddit", "r-Python.md")))


class TestPingAndVault(HostTestCase):
    def test_ping(self):
        self.assertEqual(self.handle({"cmd": "ping"}), {"ok": True, "version": "0.1.0"})

    def test_checkvault_true_vault(self):
        r = self.handle({"cmd": "checkVault", "vaultPath": self.vault})
        self.assertEqual(r, {"ok": True, "exists": True, "isVault": True})

    def test_checkvault_plain_dir(self):
        plain = tempfile.mkdtemp(prefix="rs-test-plain-")
        self.addCleanup(shutil.rmtree, plain, True)
        r = self.handle({"cmd": "checkVault", "vaultPath": plain})
        self.assertEqual(r, {"ok": True, "exists": True, "isVault": False})

    def test_checkvault_missing(self):
        r = self.handle({"cmd": "checkVault", "vaultPath": os.path.join(self.vault, "nope")})
        self.assertEqual(r, {"ok": True, "exists": False, "isVault": False})

    def test_unknown_cmd(self):
        r = self.handle({"cmd": "bogus"})
        self.assertFalse(r["ok"])
        self.assertIn("unknown cmd", r["error"])


class TestPathSafety(HostTestCase):
    def test_relative_vaultpath_rejected(self):
        r = self.write([make_item()], vaultPath="relative/vault")
        self.assertFalse(r["ok"])
        self.assertIn("absolute", r["error"])

    def test_missing_vaultpath_rejected(self):
        r = self.write([make_item()], vaultPath=os.path.join(self.vault, "does-not-exist"))
        self.assertFalse(r["ok"])

    def test_traversal_folder_rejected(self):
        for bad in ("../x", "a/../../b", "/abs", "C:\\evil", "back\\slash", "a//b", "."):
            r = self.write([make_item()], folder=bad)
            self.assertFalse(r["ok"], "folder %r should be rejected: %r" % (bad, r))

    def test_nested_folder_ok(self):
        r = self.write([make_item()], folder="Notes/Reddit")
        self.assertTrue(r["ok"], r)
        self.assertTrue(os.path.isfile(os.path.join(self.vault, "Notes", "Reddit", "r-Python.md")))


class TestItemValidation(HostTestCase):
    def test_invalid_items_skipped_counted(self):
        bad_id = make_item()
        bad_id["id"] = "t9_XYZ"
        bad_sub = make_item(id="t3_def456", subreddit="not valid!")
        bad_link = make_item(id="t3_ghi789", permalink="http://insecure/")
        r = self.write([make_item(), bad_id, bad_sub, bad_link])
        self.assertEqual(r, {"ok": True, "added": 1, "updated": 0, "skipped": 3,
                             "subreddits": ["Python"]})

    def test_non_dict_item_skipped(self):
        r = self.write([make_item(), "just a string", 42])
        self.assertEqual((r["added"], r["skipped"]), (1, 2))

    def test_empty_batch_ok(self):
        r = self.write([])
        self.assertEqual(r["added"], 0)


class TestKnownIds(HostTestCase):
    def test_empty_when_no_state(self):
        r = self.handle({"cmd": "getKnownIds", "vaultPath": self.vault, "folder": "Reddit"})
        self.assertEqual(r, {"ok": True, "ids": [], "lastSyncId": None})

    def test_ids_after_write(self):
        self.write([make_item(), make_item(id="t1_def", kind="comment", postType="comment")])
        r = self.handle({"cmd": "getKnownIds", "vaultPath": self.vault, "folder": "Reddit"})
        self.assertEqual(sorted(r["ids"]), ["t1_def", "t3_abc123"])
        self.assertEqual(r["lastSyncId"], "2026-10-29T12:00:00Z")

    def test_last_sync_id_is_max_across_syncs(self):
        self.write([make_item(id="t3_aaaa")], sync_id="2026-10-01T10:00:00Z")
        self.write([make_item(id="t3_bbbb")], sync_id="2026-10-15T10:00:00Z")
        r = self.handle({"cmd": "getKnownIds", "vaultPath": self.vault, "folder": "Reddit"})
        self.assertEqual(r["lastSyncId"], "2026-10-15T10:00:00Z")

    def test_last_sync_id_ignores_order_keys_of_known_items(self):
        # Re-sending a known item under a NEWER syncId must not bump
        # lastSyncId: known items keep their original order key.
        self.write([make_item(id="t3_aaaa")], sync_id="2026-10-01T10:00:00Z")
        self.write([make_item(id="t3_bbbb")], sync_id="2026-10-15T10:00:00Z")
        self.write([make_item(id="t3_aaaa", summary="refreshed")], sync_id="2026-10-20T10:00:00Z")
        r = self.handle({"cmd": "getKnownIds", "vaultPath": self.vault, "folder": "Reddit"})
        self.assertEqual(r["lastSyncId"], "2026-10-15T10:00:00Z")


class TestOrdering(HostTestCase):
    def test_second_sync_on_top_known_keeps_position(self):
        s1 = "2026-10-01T10:00:00Z"
        s2 = "2026-10-29T10:00:00Z"
        # sync 1: items A (rank0), B (rank1) in r/Python
        r1 = self.write([
            make_item(id="t3_aaaa", title="Old Top", rank=0),
            make_item(id="t3_bbbb", title="Old Second", rank=1),
        ], sync_id=s1)
        self.assertEqual(r1["added"], 2)
        # sync 2: new item C (rank0), plus re-send of A with new summary
        r2 = self.write([
            make_item(id="t3_cccc", title="Newest", rank=0),
            make_item(id="t3_aaaa", title="Old Top Renamed", rank=5, summary="UPDATED SUMMARY"),
        ], sync_id=s2)
        self.assertEqual((r2["added"], r2["updated"]), (1, 1))

        note = self.note("r-Python.md")
        pos_new = note.index("Newest")
        pos_a = note.index("Old Top Renamed")
        pos_b = note.index("Old Second")
        # sync-2 new item on top; known A keeps its sync-1 position (above B); B last
        self.assertLess(pos_new, pos_a)
        self.assertLess(pos_a, pos_b)
        self.assertIn("UPDATED SUMMARY", note)
        self.assertIn("**First synced:** 2026-10-01", note)  # A keeps old order key
        self.assertIn("count: 3", note)

    def test_state_order_key_preserved(self):
        self.write([make_item(id="t3_aaaa")], sync_id="2026-10-01T00:00:00Z")
        self.write([make_item(id="t3_aaaa", rank=99)], sync_id="2026-10-02T00:00:00Z")
        with open(os.path.join(self.vault, "Reddit", ".reddit-scraper", "state.json"), encoding="utf-8") as fh:
            state = json.loads(fh.read())
        self.assertEqual(state["items"]["t3_aaaa"]["order"],
                         {"syncId": "2026-10-01T00:00:00Z", "rank": 0})


class TestRendering(HostTestCase):
    def test_post_kinds_and_nsfw(self):
        self.write([
            make_item(id="t3_link1", postType="link", url="https://example.com/thing", rank=0),
            make_item(id="t3_img01", postType="image", imageUrl="https://i.redd.it/x.jpg",
                      nsfw=True, rank=1, title="An [odd] (title) [here]"),
            make_item(id="t1_cmt01", kind="comment", postType="comment", rank=2,
                      summary=""),
        ])
        note = self.note("r-Python.md")
        self.assertIn("- **Link:** https://example.com/thing", note)
        self.assertIn("![](https://i.redd.it/x.jpg)", note)
        self.assertIn("NSFW", note)
        self.assertIn("### 💬 Comment on: [Post title](", note)
        self.assertIn("> _(no summary)_", note)
        self.assertIn(r"An \[odd\] (title) \[here\]", note)  # brackets escaped in link text
        self.assertIn("### [Post title](https://www.reddit.com/r/Python/comments/abc123/slug/)", note)
        self.assertIn("<!-- rs:t3_link1 -->", note)
        # DESIGN.md format: heading, marker and metadata bullet on consecutive lines
        self.assertIn("<!-- rs:t3_link1 -->\n- **Type:** link", note)
        self.assertIn("**Posted:** 2024-05-01", note)
        self.assertIn("**First synced:** 2026-10-29", note)
        # no **Link:** line for non-link posts
        img_block = note[note.index("An \\[odd\\]"):note.index("t1_cmt01")]
        self.assertNotIn("**Link:**", img_block)

    def test_summary_blockquote_every_line(self):
        self.write([make_item(summary="line one\n\nline two")])
        note = self.note("r-Python.md")
        self.assertIn("> line one\n>\n> line two", note)

    def test_user_profile_note(self):
        self.write([make_item(id="t3_uuser", subreddit="u_someone", title="My post")])
        note = self.note("u-someone.md")
        self.assertIn("# u/someone", note)
        self.assertIn("subreddit: u_someone", note)

    def test_user_notes_preserved(self):
        self.write([make_item(id="t3_aaaa")])
        path = os.path.join(self.vault, "Reddit", "r-Python.md")
        with open(path, "a", encoding="utf-8") as fh:
            fh.write("\nMy precious thought.\n[[some link]]\n")
        self.write([make_item(id="t3_bbbb", rank=1)], sync_id="2026-10-30T00:00:00Z")
        note = self.note("r-Python.md")
        self.assertIn("## My notes", note)
        self.assertIn("My precious thought.\n[[some link]]", note)
        # notes section stays at the end
        self.assertGreater(note.index("## My notes"), note.index("t3_aaaa"))
        self.assertGreater(note.index("My precious thought"), note.index("t3_bbbb"))

    def test_fresh_notes_section_created(self):
        self.write([make_item()])
        note = self.note("r-Python.md")
        self.assertTrue(note.endswith("## My notes\n"))

    def test_frontmatter(self):
        self.write([make_item()])
        note = self.note("r-Python.md")
        head = note.split("---")[1]
        self.assertIn("subreddit: Python", head)
        self.assertIn("source: reddit-saved", head)
        self.assertIn("count: 1", head)
        self.assertIn("tags: [reddit, reddit/Python]", head)
        self.assertIn("updated: ", head)


class TestIndex(HostTestCase):
    def test_index_sorted_counts(self):
        self.write([
            make_item(id="t3_a1", subreddit="Python", rank=0),
            make_item(id="t3_a2", subreddit="Python", rank=1),
            make_item(id="t3_a3", subreddit="Python", rank=2),
            make_item(id="t3_b1", subreddit="rust", rank=3),
            make_item(id="t3_c1", subreddit="all", rank=4),
        ])
        idx = self.index()
        self.assertIn("source: reddit-saved", idx)
        lines = [l for l in idx.splitlines() if l.startswith("- [[")]
        self.assertEqual(lines[0], "- [[r-Python|r/Python]] — 3 saved")
        # tie at 1: alphabetical (all before rust)
        self.assertEqual(lines[1], "- [[r-all|r/all]] — 1 saved")
        self.assertEqual(lines[2], "- [[r-rust|r/rust]] — 1 saved")
        self.assertEqual(idx.count(" saved"), 3)

    def test_index_counts_survive_updates(self):
        self.write([make_item(id="t3_a1")])
        self.write([make_item(id="t3_a1", summary="again")], sync_id="2026-10-30T00:00:00Z")
        self.assertIn("— 1 saved", self.index())

    def test_index_user_profile(self):
        self.write([make_item(id="t3_u1", subreddit="u_someone")])
        self.assertIn("- [[u-someone|u/someone]] — 1 saved", self.index())


class TestStateAtomicity(HostTestCase):
    def test_state_written_atomically_no_tmp_leftover(self):
        self.write([make_item()])
        d = os.path.join(self.vault, "Reddit", ".reddit-scraper")
        # 'lock' is the concurrency lock file; only state.json (+lock) may exist.
        self.assertEqual(sorted(os.listdir(d)), ["lock", "state.json"])


class TestDuplicateSafety(HostTestCase):
    """(a) Repeated syncs and in-batch duplicates never create second entries."""

    def test_same_items_three_times_plus_in_batch_duplicates(self):
        items = [make_item(id="t3_i%02d" % i, title="Item %02d" % i, rank=i)
                 for i in range(30)]
        first_sync = "2026-10-01T00:00:00Z"
        for n, sync in enumerate((first_sync, "2026-10-02T00:00:00Z", "2026-10-03T00:00:00Z")):
            batch = list(items) + [items[0], items[5]]  # duplicated ids INSIDE the batch
            r = self.write(batch, sync_id=sync)
            self.assertTrue(r["ok"], r)
            if n == 0:
                # 32 incoming rows, 30 unique ids: in-batch duplicates collapsed,
                # each id counted once.
                self.assertEqual((r["added"], r["updated"], r["skipped"]), (30, 0, 0), r)
            else:
                # re-sends update in place: never a second entry.
                self.assertEqual((r["added"], r["updated"], r["skipped"]), (0, 30, 0), r)
        markers = self.all_markers()
        self.assertEqual(len(markers), 30, "every item must appear exactly once across all notes")
        self.assertEqual(len(set(markers)), 30)
        for i in range(30):
            self.assertEqual(markers.count("t3_i%02d" % i), 1)
        note = self.note("r-Python.md")
        self.assertIn("count: 30", note)  # frontmatter unchanged by repeats
        idx = self.index()
        self.assertIn("- [[r-Python|r/Python]] — 30 saved", idx)  # index unchanged
        # order keys unchanged: still the FIRST sync's, with original ranks
        with open(os.path.join(self.vault, "Reddit", ".reddit-scraper", "state.json"), encoding="utf-8") as fh:
            state = json.loads(fh.read())
        for i in range(30):
            self.assertEqual(state["items"]["t3_i%02d" % i]["order"],
                             {"syncId": first_sync, "rank": i})

    def test_ids_normalised_and_dedupe_across_pages_of_one_batch(self):
        # Whitespace around the id must not fork a second entry.
        r = self.write([make_item(id="  t3_ws  ", title="Spaced")])
        self.assertEqual(r["added"], 1)
        ids = self.handle({"cmd": "getKnownIds", "vaultPath": self.vault, "folder": "Reddit"})["ids"]
        self.assertEqual(ids, ["t3_ws"])
        r2 = self.write([make_item(id="t3_ws", title="Spaced v2", summary="again")],
                        sync_id="2026-10-30T00:00:00Z")
        self.assertEqual((r2["added"], r2["updated"]), (0, 1))
        self.assertEqual(self.all_markers(), ["t3_ws"])


class TestStateRecovery(HostTestCase):
    """(b) Missing/corrupt state.json is rebuilt from the notes, not lost."""

    def _seed(self):
        self.write([
            make_item(id="t3_keep1", title="Kept [bracket] post", summary="line one\n\nline two", rank=0),
            make_item(id="t3_link", title="Linky", postType="link",
                      url="https://example.com/thing", rank=1),
            make_item(id="t3_img", title="Pic", postType="image",
                      imageUrl="https://i.redd.it/x.jpg", nsfw=True, rank=2),
            make_item(id="t1_cmt", kind="comment", postType="comment",
                      title="Parent", summary="a thought", rank=3),
        ], sync_id="2026-10-01T00:00:00Z")

    def _state_dir(self):
        return os.path.join(self.vault, "Reddit", ".reddit-scraper")

    def test_get_known_ids_recovers_from_notes_when_state_missing(self):
        self._seed()
        shutil.rmtree(self._state_dir())
        r = self.handle({"cmd": "getKnownIds", "vaultPath": self.vault, "folder": "Reddit"})
        self.assertEqual(sorted(r["ids"]), ["t1_cmt", "t3_img", "t3_keep1", "t3_link"])
        # recovery also restores a usable lastSyncId (First synced date)
        self.assertTrue(r["lastSyncId"].startswith("2026-10-01"))

    def test_rewrite_after_state_loss_keeps_single_entries(self):
        self._seed()
        os.remove(os.path.join(self._state_dir(), "state.json"))
        # Same ids re-sent (as an interrupted sync would) + one genuinely new.
        r = self.write([
            make_item(id="t3_keep1", title="Kept [bracket] post", summary="line one\n\nline two", rank=0),
            make_item(id="t1_cmt", kind="comment", postType="comment", title="Parent", rank=1),
            make_item(id="t3_new", title="Brand new", rank=2),
        ], sync_id="2026-10-05T00:00:00Z")
        self.assertEqual((r["added"], r["updated"]), (1, 2), r)
        markers = self.all_markers()
        self.assertEqual(len(markers), len(set(markers)), "no duplicate markers")
        self.assertEqual(set(markers), {"t3_keep1", "t3_link", "t3_img", "t1_cmt", "t3_new"})
        note = self.note("r-Python.md")
        # old entries kept, with their content round-tripped
        self.assertIn(r"Kept \[bracket\] post", note)
        self.assertIn("> line one", note)
        self.assertIn("> line two", note)
        self.assertIn("- **Link:** https://example.com/thing", note)
        self.assertIn("![](https://i.redd.it/x.jpg)", note)
        self.assertIn("NSFW", note)
        self.assertIn("### 💬 Comment on: [Parent](", note)
        self.assertIn("count: 5", note)

    def test_corrupt_state_backed_up_and_rebuilt(self):
        self._seed()
        state_path = os.path.join(self._state_dir(), "state.json")
        with open(state_path, "w", encoding="utf-8") as fh:
            fh.write("{ not json at all")
        r = self.write([make_item(id="t3_new", title="Brand new")], sync_id="2026-10-05T00:00:00Z")
        self.assertTrue(r["ok"], r)
        backups = [n for n in os.listdir(self._state_dir()) if n.startswith("state.json.corrupt-")]
        self.assertEqual(len(backups), 1, os.listdir(self._state_dir()))
        with open(os.path.join(self._state_dir(), backups[0]), encoding="utf-8") as fh:
            self.assertEqual(fh.read(), "{ not json at all")
        markers = self.all_markers()
        self.assertEqual(len(markers), len(set(markers)))
        self.assertIn("t3_keep1", markers)
        self.assertIn("t3_new", markers)


class TestConcurrentWriters(HostTestCase):
    """(c) Two writers (tabs/browsers) serialise on the folder lock."""

    def test_two_threads_overlapping_items_no_duplicates(self):
        import threading

        def batch(ids):
            return [make_item(id=i, title="T " + i, rank=n) for n, i in enumerate(ids)]

        overlap_a = ["t3_x%d" % i for i in range(6)]
        overlap_b = ["t3_x%d" % i for i in range(4, 10)]
        barrier = threading.Barrier(2)
        results = []

        def run(ids):
            barrier.wait()
            results.append(self.write(batch(ids), sync_id="2026-10-05T00:00:00Z"))

        threads = [threading.Thread(target=run, args=(ids,)) for ids in (overlap_a, overlap_b)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=30)
        self.assertEqual(len(results), 2)
        for r in results:
            self.assertTrue(r["ok"], r)
        markers = self.all_markers()
        self.assertEqual(sorted(markers), ["t3_x%d" % i for i in range(10)])
        self.assertEqual(len(markers), len(set(markers)))
        with open(os.path.join(self.vault, "Reddit", ".reddit-scraper", "state.json"), encoding="utf-8") as fh:
            state = json.loads(fh.read())
        self.assertEqual(len(state["items"]), 10)
        self.assertIn("count: 10", self.note("r-Python.md"))


if __name__ == "__main__":
    unittest.main()
