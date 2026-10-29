import { test } from "node:test";
import assert from "node:assert/strict";

// Mock the browser runtime BEFORE importing modules that capture it.
const sent = [];
let handler = null;
globalThis.browser = {
  runtime: {
    id: "test@ext",
    sendNativeMessage: async (host, msg) => {
      sent.push({ host, msg });
      if (handler) return handler(host, msg);
      return { ok: true };
    },
  },
  storage: { local: { async get() { return {}; }, async set() {} } },
  permissions: { async contains() { return true; }, async request() { return true; } },
};

const native = await import("../src/native.js");

function respond(fn) { handler = fn; }

test.afterEach(() => { sent.length = 0; respond(null); });

test("ping / checkVault / getKnownIds wire the contract exactly", async () => {
  respond((host, msg) => {
    if (msg.cmd === "ping") return { ok: true, version: "0.1.0" };
    if (msg.cmd === "checkVault") return { ok: true, exists: true, isVault: msg.vaultPath === "/v" };
    if (msg.cmd === "getKnownIds") return { ok: true, ids: ["t3_a", "t1_b"] };
    throw new Error("unexpected " + msg.cmd);
  });
  assert.deepEqual(await native.ping(), { version: "0.1.0" });
  assert.deepEqual(await native.checkVault("/v"), { exists: true, isVault: true });
  assert.deepEqual(await native.getKnownIds("/v", "Reddit"), ["t3_a", "t1_b"]);
  assert.deepEqual(sent.map((s) => [s.host, s.msg.cmd]), [
    ["reddit_scraper_obsidian", "ping"],
    ["reddit_scraper_obsidian", "checkVault"],
    ["reddit_scraper_obsidian", "getKnownIds"],
  ]);
});

test("writeItems batches in chunks of <=50 sharing syncId", async () => {
  respond((host, msg) => ({
    ok: true, added: msg.items.length, updated: 0,
    subreddits: [...new Set(msg.items.map((i) => i.subreddit))],
  }));
  const items = Array.from({ length: 123 }, (_, i) => ({ id: `t3_${i}`, subreddit: `sub${i % 7}` }));
  const r = await native.writeItems({ vaultPath: "/v", folder: "Reddit", syncId: "S1", items });
  assert.equal(r.added, 123);
  assert.equal(r.batches, 3);
  const sizes = sent.map((s) => s.msg.items.length);
  assert.deepEqual(sizes, [50, 50, 23]);
  for (const s of sent) {
    assert.equal(s.msg.cmd, "writeItems");
    assert.equal(s.msg.syncId, "S1");
    assert.equal(s.msg.vaultPath, "/v");
    assert.equal(s.msg.folder, "Reddit");
  }
  assert.equal(r.subreddits.length, 7);
});

test("writeItems with zero items sends nothing", async () => {
  const r = await native.writeItems({ vaultPath: "/v", folder: "Reddit", syncId: "S", items: [] });
  assert.deepEqual(r, { added: 0, updated: 0, subreddits: [], batches: 0 });
  assert.equal(sent.length, 0);
});

test("ok:false responses surface host error text", async () => {
  respond(() => ({ ok: false, error: "vaultPath must be absolute" }));
  await assert.rejects(native.checkVault("relative"), /vaultPath must be absolute/);
});

test("missing host produces friendly install hint", async () => {
  respond(() => { throw new Error("Access to the requested native application is forbidden"); });
  await assert.rejects(native.ping(), /reddit_scraper_obsidian.*not installed/is);
});

test("null response (host died) is an error, not a silent success", async () => {
  respond(() => null);
  await assert.rejects(native.ping(), /no\/bad response/);
});
