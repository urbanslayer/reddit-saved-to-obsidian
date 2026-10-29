import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { scrapeSaved, finalizeItems, toOldRedditUrl, LoginWallError, UserMismatchError, HttpError } from "../src/scraper.js";
import { REQUIRED_ORIGINS } from "../src/origins.js";
import { applyLocal } from "../src/summarize.js";
import { validateItem } from "./schema.js";

const fix = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

const P1 = "https://old.reddit.com/user/testuser/saved";
const P2 = "https://old.reddit.com/user/testuser/saved/?count=27&after=t3_prf007";

function mockFetch(routes, calls = []) {
  return async (url, init = {}) => {
    calls.push(url);
    for (const [pattern, resp] of routes) {
      if (typeof pattern === "string" ? url === pattern : pattern.test(url)) {
        const r = typeof resp === "function" ? resp(url) : resp;
        return {
          ok: r.status >= 200 && r.status < 300,
          status: r.status ?? 200,
          url: r.finalUrl ?? url,
          text: async () => r.body,
        };
      }
    }
    return { ok: false, status: 404, url, text: async () => "not found" };
  };
}

const { window: jsdomWindow } = new JSDOM("");
const DOMParserImpl = jsdomWindow.DOMParser;
const noSleep = async () => {};
const summariseLocal = async (items) => items.forEach(applyLocal);

const D1 = "https://old.reddit.com/r/LocalLLaMA/comments/txt011/quantization-notes/";
const D2 = "https://old.reddit.com/r/wallpapers/comments/gal012/aurora-set/";
const D3 = "https://old.reddit.com/r/wallpapers/comments/gal003/cozy-set/";

function baseRoutes(extra = []) {
  return [
    [P1, { status: 200, body: fix("saved_page1.html") }],
    [P2, { status: 200, body: fix("saved_page2.html") }],
    // detail pages are served at their old.reddit.com URLs (the scraper must
    // fetch old.reddit.com, not www.reddit.com, for parsePostPage to work).
    [D1, { status: 200, body: fix("post_selftext.html") }],
    [D2, { status: 200, body: fix("post_gallery.html") }],
    [D3, { status: 200, body: fix("post_gallery.html") }],
    ...extra,
  ];
}

async function runScrape(opts = {}) {
  const calls = [];
  const events = [];
  const batches = [];
  const gen = scrapeSaved({
    username: "testuser",
    fetchImpl: mockFetch(baseRoutes(opts.routes || []), calls),
    DOMParserImpl,
    sleep: noSleep,
    summariseAll: summariseLocal,
    delayMs: 0,
    ...opts,
  });
  let done;
  for await (const ev of gen) {
    events.push(ev);
    if (ev.type === "done") done = ev;
    if (ev.type === "batch") batches.push(ev);
  }
  return { items: done.items, events, calls, batches, done };
}

test("scraper: paginates, ranks, enriches detail pages, items validate against DESIGN schema", async () => {
  const { items, calls } = await runScrape();
  assert.equal(items.length, 12);
  assert.deepEqual(items.map((i) => i.rank), [...Array(12).keys()]);
  assert.equal(items[0].id, "t3_txt001");
  assert.equal(items.at(-1).id, "t3_gal012");

  // pagination happened
  assert.ok(calls.includes(P1) && calls.includes(P2));

  // text post without inline selftext got detail-fetched and summarised from it
  const txt011 = items.find((i) => i.id === "t3_txt011");
  assert.equal(txt011.postType, "text");
  assert.match(txt011.summary, /q4_k_m loses coherence/);
  assert.equal(txt011.summarySource, "selftext");
  assert.ok(calls.includes(D1));

  // gallery got first image from detail page
  const gal012 = items.find((i) => i.id === "t3_gal012");
  assert.equal(gal012.imageUrl, "https://i.redd.it/aur1.jpg");

  // image post used data-url directly, no detail fetch needed for it
  const img002 = items.find((i) => i.id === "t3_img002");
  assert.equal(img002.summarySource, "image-fallback");
  assert.match(img002.summary, /^Image post: Sunset over the mountains/);

  // link summary has domain
  assert.match(items.find((i) => i.id === "t3_lnk005").summary, /^example\.com — An HTTP\/2 deep dive/);
  // comment summary from body
  assert.match(items.find((i) => i.id === "t1_com006").summary, /call stack honest/);
  assert.equal(items.find((i) => i.id === "t1_com006").summarySource, "comment");

  // no internal fields leaked; every item matches the DESIGN.md schema
  for (const it of items) {
    assert.deepEqual(validateItem(it), [], `schema violations for ${it.id}`);
  }
});

test("scraper: incremental mode stops at first known id", async () => {
  const { items, calls } = await runScrape({
    getKnownIds: () => new Set(["t3_vid004"]),
  });
  // stops before t3_vid004 -> page1 gives txt001, img002, gal003
  assert.deepEqual(items.map((i) => i.id), ["t3_txt001", "t3_img002", "t3_gal003"]);
  assert.ok(!calls.includes(P2), "must not fetch page 2");
});

test("scraper: incremental off with getKnownIds still walks everything", async () => {
  const { items } = await runScrape({
    incremental: false,
    getKnownIds: () => new Set(["t3_txt001"]),
  });
  assert.equal(items.length, 12);
});

test("scraper: maxItems cap respected", async () => {
  const { items } = await runScrape({ maxItems: 4 });
  assert.equal(items.length, 4);
  assert.deepEqual(items.map((i) => i.id), ["t3_txt001", "t3_img002", "t3_gal003", "t3_vid004"]);
});

test("scraper: login wall raises LoginWallError (fixture + redirect url)", async () => {
  await assert.rejects(
    (async () => { for await (const _ of scrapeSaved({
      username: "testuser",
      fetchImpl: mockFetch([[P1, { status: 200, body: fix("login_wall.html") }]]),
      DOMParserImpl, sleep: noSleep, delayMs: 0,
    })) void _; })(),
    (err) => err instanceof LoginWallError && /log in to old\.reddit\.com as testuser/.test(err.message),
  );
  await assert.rejects(
    (async () => { for await (const _ of scrapeSaved({
      username: "testuser",
      fetchImpl: mockFetch([[P1, { status: 200, body: "<html></html>", finalUrl: "https://old.reddit.com/login/?reason=lor2&dest=%2Fuser%2Ftestuser%2Fsaved" }]]),
      DOMParserImpl, sleep: noSleep, delayMs: 0,
    })) void _; })(),
    LoginWallError,
  );
});

test("scraper: user mismatch raises UserMismatchError", async () => {
  const otherUser = fix("saved_page2.html").replace(
    '<span class="user"><a href="/user/testuser/">testuser</a></span>',
    '<span class="user"><a href="/user/someoneelse/">someoneelse</a></span>');
  await assert.rejects(
    (async () => { for await (const _ of scrapeSaved({
      username: "testuser",
      fetchImpl: mockFetch([[P1, { status: 200, body: otherUser }]]),
      DOMParserImpl, sleep: noSleep, delayMs: 0,
    })) void _; })(),
    (err) => err instanceof UserMismatchError && /u\/someoneelse/.test(err.message) && /u\/testuser/.test(err.message),
  );
});

test("scraper: 429 -> HttpError with clear message", async () => {
  await assert.rejects(
    (async () => { for await (const _ of scrapeSaved({
      username: "testuser",
      fetchImpl: mockFetch([[P1, { status: 429, body: "too many" }]]),
      DOMParserImpl, sleep: noSleep, delayMs: 0,
    })) void _; })(),
    (err) => err instanceof HttpError && /429/.test(err.message),
  );
});

test("scraper: abort signal cancels mid-run", async () => {
  const ctrl = new AbortController();
  const seen = [];
  await assert.rejects((async () => {
    for await (const ev of scrapeSaved({
      username: "testuser",
      fetchImpl: mockFetch(baseRoutes()),
      DOMParserImpl, sleep: noSleep, delayMs: 0, summariseAll: summariseLocal,
      signal: ctrl.signal,
    })) {
      seen.push(ev.type);
      ctrl.abort(new Error("stop"));
    }
  })(), /stop/);
  assert.ok(seen.length >= 1);
});

test("scraper: missing username errors clearly", async () => {
  await assert.rejects((async () => {
    for await (const _ of scrapeSaved({ username: "", fetchImpl: mockFetch([]), DOMParserImpl, sleep: noSleep })) void _;
  })(), /username/);
});

// --- review fixes ---------------------------------------------------------

test("scraper: detail fetches use old.reddit.com; item.permalink stays www.reddit.com", async () => {
  const { items, calls } = await runScrape();
  const detailCalls = calls.filter((u) => u.includes("/comments/"));
  assert.ok(detailCalls.length >= 3, `expected several detail fetches, got ${detailCalls.length}`);
  for (const u of detailCalls) {
    assert.ok(u.startsWith("https://old.reddit.com/"), `detail fetch must use old.reddit.com: ${u}`);
    assert.ok(!u.includes("www.reddit.com"), `detail fetch hit www.reddit.com (shreddit UI): ${u}`);
  }
  // permalinks in the output remain www.reddit.com
  for (const it of items) {
    assert.match(it.permalink, /^https:\/\/www\.reddit\.com\//);
  }
  // selftext really came from the old-reddit detail fixture
  const txt011 = items.find((i) => i.id === "t3_txt011");
  assert.match(txt011.summary, /q4_k_m loses coherence/);
  // toOldRedditUrl keeps path/query intact
  assert.equal(
    toOldRedditUrl("https://www.reddit.com/r/x/comments/abc/slug/?context=3"),
    "https://old.reddit.com/r/x/comments/abc/slug/?context=3",
  );
});

test("scraper: yields one batch per listing page with globally continuous ranks", async () => {
  const { batches, items } = await runScrape();
  assert.equal(batches.length, 2, "one batch per listing page");
  assert.deepEqual(batches.map((b) => b.page), [1, 2]);
  const page1Ids = ["t3_txt001", "t3_img002", "t3_gal003", "t3_vid004", "t3_lnk005", "t1_com006", "t3_prf007"];
  assert.deepEqual(batches[0].items.map((i) => i.id), page1Ids);
  assert.deepEqual(batches[0].items.map((i) => i.rank), [0, 1, 2, 3, 4, 5, 6]);
  // ranks continue across pages (7..11), they do not restart at 0
  assert.deepEqual(batches[1].items.map((i) => i.rank), [7, 8, 9, 10, 11]);
  assert.deepEqual(items, batches[0].items.concat(batches[1].items));
  for (const b of batches) for (const it of b.items) {
    assert.deepEqual(validateItem(it), [], `schema violations for ${it.id}`);
  }
});

test("scraper: HTTP error on page 2 still yields page 1 batch (partial progress survives)", async () => {
  const calls = [];
  const events = [];
  const routes = baseRoutes([[P2, { status: 429, body: "too many requests" }]]);
  // put the failing route first so it wins over the healthy base route
  routes.unshift([P2, { status: 429, body: "too many requests" }]);
  let err;
  let page1Batch;
  try {
    for await (const ev of scrapeSaved({
      username: "testuser",
      fetchImpl: mockFetch(routes, calls),
      DOMParserImpl, sleep: noSleep, summariseAll: summariseLocal, delayMs: 0,
    })) {
      events.push(ev.type);
      if (ev.type === "batch" && ev.page === 1) page1Batch = ev;
    }
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof HttpError && /429/.test(err.message), `expected HttpError, got ${err}`);
  assert.ok(page1Batch, "page 1 batch must be yielded before page 2 fails");
  assert.equal(page1Batch.items.length, 7);
  // enrichment for page 1 happened (gal003 gallery image came from its detail page)
  assert.equal(page1Batch.items.find((i) => i.id === "t3_gal003").imageUrl, "https://i.redd.it/aur1.jpg");
});

test("scraper: embedImages=false sets imageUrl null on ALL items (incl. image posts)", async () => {
  const { items, batches } = await runScrape({ embedImages: false });
  const img = items.find((i) => i.id === "t3_img002");
  assert.equal(img.postType, "image");
  assert.equal(img.imageUrl, null, "image posts must also be null when embedding is off");
  const gal = items.find((i) => i.id === "t3_gal012");
  assert.equal(gal.imageUrl, null);
  for (const it of items) assert.equal(it.imageUrl, null);
  assert.ok(batches.length === 2, "batching unaffected");
  // summaries still work
  assert.match(img.summary, /^Image post: Sunset over the mountains/);
});

test("finalizeItems: pure helper — embedImages default keeps imageUrl, false clears it", () => {
  const raw = [
    { id: "t3_a", kind: "post", subreddit: "x", title: "a", permalink: "https://www.reddit.com/x/", url: null, author: null, createdUtc: 1, postType: "image", summary: "", summarySource: "image-fallback", imageUrl: "https://i.redd.it/a.jpg", nsfw: false, rank: 0, _bodyMarkdown: "hidden" },
  ];
  const on = finalizeItems(raw);
  assert.equal(on[0].imageUrl, "https://i.redd.it/a.jpg");
  assert.equal("_bodyMarkdown" in on[0], false, "internal fields stripped");
  const off = finalizeItems(raw, { embedImages: false });
  assert.equal(off[0].imageUrl, null);
  // input untouched (pure)
  assert.equal(raw[0].imageUrl, "https://i.redd.it/a.jpg");
});

test("origins: REQUIRED_ORIGINS covers every host the sync needs", () => {
  for (const o of [
    "https://old.reddit.com/*",
    "https://www.reddit.com/*",
    "https://i.redd.it/*",
    "https://preview.redd.it/*",
  ]) {
    assert.ok(REQUIRED_ORIGINS.includes(o), `missing origin ${o}`);
  }
});
