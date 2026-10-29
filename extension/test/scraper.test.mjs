import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { scrapeSaved, LoginWallError, UserMismatchError, HttpError } from "../src/scraper.js";
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

function baseRoutes(extra = []) {
  return [
    [P1, { status: 200, body: fix("saved_page1.html") }],
    [P2, { status: 200, body: fix("saved_page2.html") }],
    ["https://www.reddit.com/r/LocalLLaMA/comments/txt011/quantization-notes/", { status: 200, body: fix("post_selftext.html") }],
    ["https://www.reddit.com/r/wallpapers/comments/gal012/aurora-set/", { status: 200, body: fix("post_gallery.html") }],
    ["https://www.reddit.com/r/wallpapers/comments/gal003/cozy-set/", { status: 200, body: fix("post_gallery.html") }],
    ...extra,
  ];
}

async function runScrape(opts = {}) {
  const calls = [];
  const events = [];
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
  }
  return { items: done.items, events, calls };
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
  assert.ok(calls.includes("https://www.reddit.com/r/LocalLLaMA/comments/txt011/quantization-notes/"));

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
