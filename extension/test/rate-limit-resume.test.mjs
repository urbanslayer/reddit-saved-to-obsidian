// rate-limit + resume tests: retry/backoff policy, adaptive pacing, and the
// resume cursor. All sleeps are mocked (recorded, never awaited for real).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import {
  scrapeSaved, fetchResilient, parseRetryAfterMs, isRetryableStatus,
  HttpError, RETRY_DEFAULTS,
} from "../src/scraper.js";
import {
  CURSOR_KEY, makeCursor, saveCursor, loadCursor, clearCursor, cursorMatches, describeCursor,
} from "../src/resume.js";
import { applyLocal } from "../src/summarize.js";

const fix = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

const P1 = "https://old.reddit.com/user/testuser/saved";
const P2 = "https://old.reddit.com/user/testuser/saved/?count=27&after=t3_prf007";
const D1 = "https://old.reddit.com/r/LocalLLaMA/comments/txt011/quantization-notes/";
const D2 = "https://old.reddit.com/r/wallpapers/comments/gal012/aurora-set/";
const D3 = "https://old.reddit.com/r/wallpapers/comments/gal003/cozy-set/";

// fixed clock so Retry-After dates / x-ratelimit-reset deltas are deterministic
const NOW = 1_700_000_000_000; // ms
const now = () => NOW;

function makeResponse(r, url) {
  const headers = r.headers || {};
  return {
    ok: r.status >= 200 && r.status < 300,
    status: r.status ?? 200,
    url: r.finalUrl ?? url,
    text: async () => r.body ?? "",
    headers: { get: (n) => headers[String(n).toLowerCase()] ?? null },
  };
}

/** headers-aware mock fetch; routes may hold objects or sequenced() helpers. */
function mockFetch(routes, calls = []) {
  return async (url) => {
    calls.push(url);
    for (const [pattern, resp] of routes) {
      if (typeof pattern === "string" ? url === pattern : pattern.test(url)) {
        const r = typeof resp === "function" ? resp(url) : resp;
        if (r && r.throw) throw new Error(r.throw);
        return makeResponse(r, url);
      }
    }
    return makeResponse({ status: 404 }, url);
  };
}

/** Route value that answers with responses[i] on the i-th call (clamped). */
function sequenced(...responses) {
  let i = 0;
  return () => responses[Math.min(i++, responses.length - 1)];
}

const { window: jsdomWindow } = new JSDOM("");
const DOMParserImpl = jsdomWindow.DOMParser;
const summariseLocal = async (items) => items.forEach(applyLocal);

function baseRoutes(extra = []) {
  return [...extra,
    [P1, { status: 200, body: fix("saved_page1.html") }],
    [P2, { status: 200, body: fix("saved_page2.html") }],
    [D1, { status: 200, body: fix("post_selftext.html") }],
    [D2, { status: 200, body: fix("post_gallery.html") }],
    [D3, { status: 200, body: fix("post_gallery.html") }],
  ];
}

async function runScrape(opts = {}) {
  const calls = [];
  const sleeps = [];
  const events = [];
  const batches = [];
  let done;
  for await (const ev of scrapeSaved({
    username: "testuser",
    fetchImpl: mockFetch(baseRoutes(opts.routes || []), calls),
    DOMParserImpl,
    sleep: async (ms) => { sleeps.push(ms); },
    summariseAll: summariseLocal,
    delayMs: 3000,
    now,
    ...opts,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  })) {
    events.push(ev);
    if (ev.type === "batch") batches.push(ev);
    if (ev.type === "done") done = ev;
  }
  return { items: done?.items, events, calls, batches, sleeps, done };
}

const progressEvents = (events) => events.filter((e) => e.type); // yielded only
// onProgress data payloads are collected separately below via runWithProgress.
async function runWithProgress(opts = {}) {
  const progress = [];
  const res = await runScrape({
    ...opts,
    onProgress: (msg, data) => { if (data) progress.push(data); },
  });
  return { ...res, progress };
}

// --- fetchResilient: the shared retry helper --------------------------------

const ok200 = { status: 200, body: "ok" };

test("fetchResilient: 429 then 200 retries with 60 s backoff and emits rateLimited", async () => {
  const calls = [];
  let n = 0;
  const fetchImpl = async (url) => {
    calls.push(url);
    return makeResponse(n++ === 0 ? { status: 429, body: "slow down" } : ok200, url);
  };
  const sleeps = [];
  const progress = [];
  const res = await fetchResilient(fetchImpl, "https://old.reddit.com/x", {}, {
    retry: RETRY_DEFAULTS, sleep: async (ms) => { sleeps.push(ms); }, now,
    onProgress: (msg, data) => progress.push(data),
  });
  assert.equal(res.status, 200);
  assert.equal(calls.length, 2);
  assert.deepEqual(sleeps, [60000]);
  assert.deepEqual(progress, [
    { type: "rateLimited", status: 429, waitMs: 60000, attempt: 2, maxAttempts: 6, url: "https://old.reddit.com/x" },
  ]);
});

test("fetchResilient: Retry-After (seconds and HTTP date) and x-ratelimit-reset", async () => {
  const run = async (headers) => {
    const sleeps = [];
    let n = 0;
    const fetchImpl = async (url) => (n++ === 0
      ? makeResponse({ status: 429, headers }, url)
      : makeResponse(ok200, url));
    await fetchResilient(fetchImpl, "u", {}, {
      retry: RETRY_DEFAULTS, sleep: async (ms) => { sleeps.push(ms); }, now,
    });
    return sleeps[0];
  };
  assert.equal(await run({ "retry-after": "120" }), 120000);
  assert.equal(await run({ "retry-after": new Date(NOW + 90_000).toUTCString() }), 90000);
  // no Retry-After -> x-ratelimit-reset (epoch seconds) is honoured
  assert.equal(await run({ "x-ratelimit-reset": String(NOW / 1000 + 45) }), 45000);
  // Retry-After wins over x-ratelimit-reset
  assert.equal(await run({ "retry-after": "10", "x-ratelimit-reset": String(NOW / 1000 + 45) }), 10000);
  // any single wait is capped at 15 min
  assert.equal(await run({ "retry-after": "7200" }), 900000);
  assert.equal(await run({ "x-ratelimit-reset": String(NOW / 1000 + 3600) }), 900000);
});

test("fetchResilient: exponential schedule 60s→10min cap, 6 attempts, then HttpError", async () => {
  const calls = [];
  const sleeps = [];
  const fetchImpl = async (url) => { calls.push(url); return makeResponse({ status: 429, body: "429" }, url); };
  await assert.rejects(
    fetchResilient(fetchImpl, "https://old.reddit.com/paged", {}, {
      retry: RETRY_DEFAULTS, sleep: async (ms) => { sleeps.push(ms); }, now,
    }),
    (err) => err instanceof HttpError && err.status === 429,
  );
  assert.equal(calls.length, 6);
  assert.deepEqual(sleeps, [60000, 120000, 240000, 480000, 600000]);
});

test("fetchResilient: maxAttempts is configurable", async () => {
  const calls = [];
  const fetchImpl = async (url) => { calls.push(url); return makeResponse({ status: 503 }, url); };
  await assert.rejects(
    fetchResilient(fetchImpl, "u", {}, {
      retry: { ...RETRY_DEFAULTS, maxAttempts: 2 }, sleep: async () => {}, now,
    }),
    (err) => err instanceof HttpError && err.status === 503,
  );
  assert.equal(calls.length, 2);
});

test("fetchResilient: 5xx and network errors are retried, 403 is not", async () => {
  // 500 -> 200
  let n = 0;
  let res = await fetchResilient(async (url) => (n++ === 0 ? makeResponse({ status: 500 }, url) : makeResponse(ok200, url)),
    "u", {}, { retry: RETRY_DEFAULTS, sleep: async () => {}, now });
  assert.equal(res.status, 200);
  // network throw -> 200
  n = 0;
  res = await fetchResilient(async (url) => { if (n++ === 0) throw new Error("boom"); return makeResponse(ok200, url); },
    "u", {}, { retry: RETRY_DEFAULTS, sleep: async () => {}, now });
  assert.equal(res.status, 200);
  // 403 -> returned immediately, no retries (caller throws HttpError)
  const calls = [];
  res = await fetchResilient(async (url) => { calls.push(url); return makeResponse({ status: 403 }, url); },
    "u", {}, { retry: RETRY_DEFAULTS, sleep: async () => {}, now });
  assert.equal(res.status, 403);
  assert.equal(calls.length, 1);
  assert.equal(isRetryableStatus(429), true);
  assert.equal(isRetryableStatus(500), true);
  assert.equal(isRetryableStatus(403), false);
  assert.equal(isRetryableStatus(404), false);
});

test("fetchResilient: abort during a backoff wait rejects immediately", async () => {
  const ctrl = new AbortController();
  const calls = [];
  const fetchImpl = async (url) => { calls.push(url); return makeResponse({ status: 429 }, url); };
  const cancellableSleep = (ms, signal) => new Promise((_resolve, reject) => {
    // mirrors defaultSleep: an already-aborted signal rejects immediately
    if (signal?.aborted) { reject(signal.reason ?? new Error("aborted")); return; }
    signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
  });
  await assert.rejects(
    fetchResilient(fetchImpl, "u", {}, {
      retry: RETRY_DEFAULTS, sleep: cancellableSleep, signal: ctrl.signal, now,
      onProgress: (_msg, data) => { if (data?.type === "rateLimited") ctrl.abort(new Error("stop")); },
    }),
    /stop/,
  );
  assert.equal(calls.length, 1, "must not refetch after abort during the wait");
});

test("parseRetryAfterMs: seconds, HTTP date, junk", () => {
  assert.equal(parseRetryAfterMs("120", NOW), 120000);
  assert.equal(parseRetryAfterMs(new Date(NOW + 5000).toUTCString(), NOW), 5000);
  assert.equal(parseRetryAfterMs("not a date", NOW), null);
  assert.equal(parseRetryAfterMs(null, NOW), null);
  assert.equal(parseRetryAfterMs("", NOW), null);
  // past dates clamp to 0 (retry immediately, don't go negative)
  assert.equal(parseRetryAfterMs(new Date(NOW - 60000).toUTCString(), NOW), 0);
});

// --- scrapeSaved integration -------------------------------------------------

test("scrapeSaved: listing 429 then success retries and still yields all items", async () => {
  const routes = [[P1, sequenced(
    { status: 429, body: "too many" },
    { status: 200, body: fix("saved_page1.html") },
  )], ...baseRoutes()];
  const { items, sleeps, calls, progress } = await runWithProgress({ routes });
  assert.equal(items.length, 12);
  assert.equal(calls.filter((u) => u === P1).length, 2);
  assert.equal(sleeps[0], 60000, "first sleep is the backoff");
  assert.ok(progress.some((d) => d.type === "rateLimited" && d.status === 429 && d.url === P1));
});

test("scrapeSaved: inter-request delay doubles after any 429 (capped 30 s)", async () => {
  const routes = [[P1, sequenced(
    { status: 429, body: "too many" },
    { status: 200, body: fix("saved_page1.html") },
  )], ...baseRoutes()];
  const { sleeps, items } = await runWithProgress({ routes, delayMs: 3000 });
  assert.equal(items.length, 12);
  assert.equal(sleeps[0], 60000); // the retry wait itself
  // every pacing sleep AFTER the 429 uses the doubled delay (fake clock never
  // advances, so each wait equals the full delay: 3000 * 2 = 6000)
  const pacing = sleeps.slice(1);
  assert.ok(pacing.length >= 3, "expected several pacing sleeps");
  for (const ms of pacing) assert.equal(ms, 6000);
});

test("scrapeSaved: detail-page 429 backs off then succeeds (not silently skipped)", async () => {
  const routes = [[D1, sequenced(
    { status: 429, body: "too many" },
    { status: 200, body: fix("post_selftext.html") },
  )], ...baseRoutes()];
  const { items, sleeps, progress } = await runWithProgress({ routes });
  assert.ok(sleeps.includes(60000), "detail 429 must wait, not skip");
  const rl = progress.find((d) => d.type === "rateLimited");
  assert.equal(rl.url, D1);
  const txt011 = items.find((i) => i.id === "t3_txt011");
  assert.match(txt011.summary, /q4_k_m loses coherence/, "selftext enrichment survived the retry");
});

test("scrapeSaved: exhausted detail-page 429 retries fail the run with HttpError", async () => {
  const routes = [[D1, { status: 429, body: "always" }], ...baseRoutes()];
  let err;
  const batchPages = [];
  try {
    for await (const ev of scrapeSaved({
      username: "testuser",
      fetchImpl: mockFetch(routes),
      DOMParserImpl, sleep: async () => {}, summariseAll: summariseLocal,
      delayMs: 3000, now,
    })) if (ev.type === "batch") batchPages.push(ev.page);
  } catch (e) { err = e; }
  assert.ok(err instanceof HttpError && /429/.test(err.message) && err.url.includes("/comments/txt011"), `got ${err}`);
  // t3_txt011 lives on page 2: page 1's batch survived, the run dies instead of
  // silently skipping the rate-limited detail and hammering on to page 3+.
  assert.deepEqual(batchPages, [1]);
});

test("scrapeSaved: x-ratelimit-remaining < 2 sleeps until reset before next request", async () => {
  const routes = [[P1, {
    status: 200, body: fix("saved_page1.html"),
    headers: { "x-ratelimit-remaining": "1", "x-ratelimit-reset": String(NOW / 1000 + 45) },
  }], ...baseRoutes()];
  const { sleeps, items } = await runWithProgress({ routes });
  assert.equal(items.length, 12);
  assert.equal(sleeps[0], 45000, "must wait for the quota reset window");
});

test("scrapeSaved: batch events carry nextUrl/nextRank for the resume cursor", async () => {
  const { batches } = await runScrape();
  assert.equal(batches[0].nextUrl, P2);
  assert.equal(batches[0].nextRank, 7);
  assert.equal(batches[1].nextUrl, null);
  assert.equal(batches[1].nextRank, 12);
});

test("scrapeSaved: resume from startUrl/startRank keeps ranks and skips known ids without stopping", async () => {
  const calls = [];
  const events = [];
  let done;
  // NOTE: only page 2 + its detail pages are routed; fetching page 1 would 404.
  const routes = [
    [P2, { status: 200, body: fix("saved_page2.html") }],
    [D1, { status: 200, body: fix("post_selftext.html") }],
    [D2, { status: 200, body: fix("post_gallery.html") }],
  ];
  for await (const ev of scrapeSaved({
    username: "testuser",
    fetchImpl: mockFetch(routes, calls),
    DOMParserImpl,
    sleep: async () => {},
    summariseAll: summariseLocal,
    delayMs: 3000, now,
    getKnownIds: () => new Set(["t3_txt008"]), // first item of page 2 is known
    startUrl: P2, startRank: 7, startPage: 1, skipKnown: true, incremental: true,
  })) {
    events.push(ev);
    if (ev.type === "done") done = ev;
  }
  assert.ok(!calls.includes(P1), "resume must not refetch page 1");
  const batch = events.find((e) => e.type === "batch");
  assert.equal(batch.page, 2, "page numbering continues from startPage");
  // t3_txt008 consumed rank 7 but was skipped (not fetched/summarised/written)
  assert.deepEqual(batch.items.map((i) => i.id), ["t3_txt011", "t1_com009", "t3_ext010", "t3_gal012"]);
  assert.deepEqual(batch.items.map((i) => i.rank), [8, 9, 10, 11]);
  assert.ok(done, "a known id in the middle must NOT stop a resumed run");
  assert.equal(done.pages, 2);
});

test("scrapeSaved: normal incremental stops immediately when the FIRST item is known", async () => {
  const calls = [];
  const { items } = await runScrape({
    fetchImpl: mockFetch(baseRoutes(), calls),
    getKnownIds: () => new Set(["t3_txt001"]), // very first item of page 1
    incremental: true,
  });
  assert.deepEqual(items, [], "up-to-date vault: nothing to write");
  assert.ok(!calls.includes(P2), "must not fetch further pages");
});

// --- resume.js (pure cursor helpers + storage adapter) -----------------------

function memoryStore() {
  const data = {};
  return {
    data,
    get: async (k) => data[k],
    set: async (obj) => Object.assign(data, obj),
    remove: async (k) => { delete data[k]; },
  };
}

test("resume: save/load/clear round-trip through the storage adapter", async () => {
  const store = memoryStore();
  assert.equal(await loadCursor(store), null);
  const c = makeCursor({
    username: "alice", vaultPath: "/vault", folder: "Reddit",
    syncId: "2026-10-29T00:00:00.000Z", nextUrl: P2, nextRank: 200, page: 8, itemsWritten: 200,
  });
  await saveCursor(store, c);
  assert.ok(CURSOR_KEY in store.data);
  const loaded = await loadCursor(store);
  assert.deepEqual(loaded, c);
  await clearCursor(store);
  assert.equal(await loadCursor(store), null);
});

test("resume: malformed cursors are ignored", async () => {
  const store = memoryStore();
  store.data[CURSOR_KEY] = { username: "alice" }; // missing fields
  assert.equal(await loadCursor(store), null);
  store.data[CURSOR_KEY] = "garbage";
  assert.equal(await loadCursor(store), null);
});

test("resume: cursorMatches keys on username + vaultPath + folder", async () => {
  const c = makeCursor({
    username: "alice", vaultPath: "/vault", folder: "Reddit",
    syncId: "s", nextUrl: P2, nextRank: 7, page: 1, itemsWritten: 7,
  });
  assert.equal(cursorMatches(c, { username: "alice", vaultPath: "/vault", folder: "Reddit" }), true);
  assert.equal(cursorMatches(c, { username: "bob", vaultPath: "/vault", folder: "Reddit" }), false);
  assert.equal(cursorMatches(c, { username: "alice", vaultPath: "/other", folder: "Reddit" }), false);
  assert.equal(cursorMatches(c, { username: "alice", vaultPath: "/vault", folder: "Saved" }), false);
  assert.equal(cursorMatches(null, { username: "alice", vaultPath: "/vault", folder: "Reddit" }), false);
});

test("resume: describeCursor wording for the sync page banner", () => {
  const c = makeCursor({
    username: "a", vaultPath: "/v", folder: "Reddit", syncId: "s",
    nextUrl: P2, nextRank: 200, page: 8, itemsWritten: 200,
  });
  assert.equal(describeCursor(c), "Previous sync stopped at page 8 (200 items written)");
  const one = { ...c, page: 1, itemsWritten: 1 };
  assert.equal(describeCursor(one), "Previous sync stopped at page 1 (1 item written)");
});
