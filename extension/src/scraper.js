// scraper.js — walks the saved listing page-by-page and produces finished Items.
// Pure-ish: fetch / DOMParser / sleep / summariser are injectable for tests.

import { parseListing, parsePostPage, toItem } from "./parser.js";

export class LoginWallError extends Error {
  constructor(username, destUrl) {
    super(`Please log in to old.reddit.com as ${username}${destUrl ? ` (redirected to ${destUrl})` : ""}`);
    this.name = "LoginWallError";
  }
}
export class UserMismatchError extends Error {
  constructor(configured, actual) {
    super(`Logged in to old.reddit.com as u/${actual}, but the configured user is u/${configured}. Reddit only shows saved items to their owner.`);
    this.name = "UserMismatchError";
    this.configured = configured;
    this.actual = actual;
  }
}
export class HttpError extends Error {
  constructor(status, url) {
    const why =
      status === 429 ? "rate limited (HTTP 429) — wait a bit and retry"
      : status === 403 ? "forbidden (HTTP 403) — possibly blocked; try again later or from a logged-in browser"
      : status >= 500 ? `Reddit server error (HTTP ${status})`
      : `HTTP ${status}`;
    super(`${why} fetching ${url}`);
    this.name = "HttpError";
    this.status = status;
    this.url = url;
  }
}

export const DEFAULTS = {
  delayMs: 3000,
  minDelayMs: 1000,
  maxItems: 1000,
  incremental: true,
};

// Retry/pacing policy for Reddit rate limiting (all times in ms).
export const RETRY_DEFAULTS = {
  maxAttempts: 6,        // total attempts per request (fetch + retries)
  baseBackoffMs: 60000,  // first backoff: 60 s, doubling each attempt
  maxBackoffMs: 600000,  // exponential backoff cap: 10 min
  maxWaitMs: 900000,     // cap for ANY single wait (incl. Retry-After): 15 min
  maxDelayMs: 30000,     // adaptive inter-request delay cap
};

function headerValue(res, name) {
  try {
    const v = res?.headers?.get?.(name);
    return v == null ? null : String(v);
  } catch {
    return null;
  }
}

/** Retry-After header (delta-seconds or HTTP date) -> ms to wait, or null. */
export function parseRetryAfterMs(value, nowMs = Date.now()) {
  if (value == null || String(value).trim() === "") return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - nowMs);
  return null;
}

function backoffFor(attempt, retry) {
  return Math.min(retry.baseBackoffMs * 2 ** (attempt - 1), retry.maxBackoffMs);
}

/** Is this HTTP status worth retrying? (429 rate limit, 5xx server errors.
 *  403 is NOT retried — it usually means blocked/login, waiting won't help.) */
export function isRetryableStatus(status) {
  return status === 429 || status >= 500;
}

/**
 * One shared fetch helper for ALL Reddit requests (listing + detail pages).
 * Retries 429 / 5xx / network errors with backoff; honours `Retry-After`
 * (seconds or HTTP date) and `x-ratelimit-reset` (epoch seconds) when present.
 * Waits are AbortSignal-cancellable and emit {type:'rateLimited', ...} events
 * through onProgress so the UI can show a live countdown.
 *
 * Returns the response for `ok` and for non-retryable failures (403, 4xx…) —
 * the caller decides what those mean. Throws HttpError when retryable attempts
 * are exhausted, a plain Error when network errors are exhausted, and
 * rethrows the abort reason immediately when the signal fires.
 */
export async function fetchResilient(fetchImpl, url, init, ctx) {
  const {
    retry = RETRY_DEFAULTS,
    sleep,
    signal,
    now = () => Date.now(),
    onProgress = () => {},
    onRateLimited = () => {},
  } = ctx;
  for (let attempt = 1; attempt <= retry.maxAttempts; attempt++) {
    if (signal?.aborted) throw signal.reason ?? new Error("aborted");
    let res = null;
    let netErr = null;
    try {
      res = await fetchImpl(url, { ...init, signal });
    } catch (err) {
      if (signal?.aborted) throw err;
      netErr = err;
    }
    if (!netErr && !isRetryableStatus(res.status)) return res;
    if (attempt >= retry.maxAttempts) {
      if (netErr) throw new Error(`Network error fetching ${url}: ${netErr.message}`);
      throw new HttpError(res.status, url);
    }
    let waitMs = null;
    if (!netErr) {
      waitMs = parseRetryAfterMs(headerValue(res, "retry-after"), now());
      if (waitMs == null) {
        const reset = Number(headerValue(res, "x-ratelimit-reset"));
        if (Number.isFinite(reset) && reset > 0) waitMs = Math.max(0, reset * 1000 - now());
      }
    }
    if (waitMs == null || !Number.isFinite(waitMs)) waitMs = backoffFor(attempt, retry);
    waitMs = Math.min(waitMs, retry.maxWaitMs);
    const status = netErr ? 0 : res.status;
    onProgress(
      `${status ? `HTTP ${status}` : "network error"} fetching ${url} — retrying in ${Math.round(waitMs / 1000)} s ` +
      `(attempt ${attempt + 1}/${retry.maxAttempts})`,
      { type: "rateLimited", status, waitMs, attempt: attempt + 1, maxAttempts: retry.maxAttempts, url },
    );
    onRateLimited({ status, waitMs, attempt: attempt + 1, url });
    await sleep(waitMs, signal);
  }
}

const savedUrl = (username) =>
  `https://old.reddit.com/user/${encodeURIComponent(username)}/saved`;

/**
 * Detail pages must be fetched from old.reddit.com: parsePostPage() parses
 * OLD reddit markup (.expando .usertext-body .md, .media-gallery, …), while
 * the new 'shreddit' UI served at www.reddit.com does not contain it.
 * item.permalink itself stays www.reddit.com in the output.
 */
export function toOldRedditUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname === "www.reddit.com" || u.hostname === "reddit.com") {
      u.hostname = "old.reddit.com";
    }
    return u.toString();
  } catch {
    return url;
  }
}

function defaultSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      if (signal.aborted) { clearTimeout(t); reject(signal.reason ?? new Error("aborted")); return; }
      signal.addEventListener("abort", () => { clearTimeout(t); reject(signal.reason ?? new Error("aborted")); }, { once: true });
    }
  });
}

/**
 * Finalise raw parser items into host Items (strips internal fields).
 * When embedImages === false, EVERY item's imageUrl is cleared — the host
 * only embeds an image when imageUrl is set, so this turns embedding off
 * for image posts too, not just non-image posts.
 */
export function finalizeItems(items, { embedImages = true } = {}) {
  return items.map((it) =>
    embedImages === false ? toItem(it, { imageUrl: null }) : toItem(it)
  );
}

/**
 * Scrape a user's saved listing.
 *
 * @param {object} opts
 * @param {string} opts.username
 * @param {(url: string, init: object) => Promise<{ok:boolean,status:number,url:string,text():Promise<string>}>} [opts.fetchImpl]
 * @param {typeof DOMParser} [opts.DOMParserImpl]
 * @param {(ms:number, signal?:AbortSignal)=>Promise<void>} [opts.sleep]
 * @param {(items: object[], ctx: object) => Promise<void>} [opts.summariseAll] mutate items in place (attach summary/summarySource/imageUrl)
 * @param {() => Promise<Set<string>>|Set<string>} [opts.getKnownIds]
 * @param {number} [opts.delayMs] [opts.maxItems] [opts.incremental]
 * @param {boolean} [opts.embedImages] when false, every finished item's
 *   imageUrl is set to null (the host only embeds images when imageUrl is set)
 * @param {string} [opts.startUrl] resume: first listing URL to fetch
 *   (default: the saved page). Pair with startRank/startPage.
 * @param {number} [opts.startRank] resume: global rank to start assigning (keeps ordering consistent)
 * @param {number} [opts.startPage] resume: number of pages already written (batch page numbers continue from it)
 * @param {boolean} [opts.skipKnown] resume/fill-gaps mode: known ids are
 *   skipped (not re-fetched/summarised/written) but still consume a rank, and
 *   never stop the run. Without it, `incremental` means stop at the FIRST
 *   known id.
 *   Independent of mode, every id is emitted at most once per run: an item
 *   that reappears on a later page (listing shift during pagination) keeps
 *   its first rank and is never sent to the host twice.
 * @param {object} [opts.retry] overrides for RETRY_DEFAULTS (maxAttempts, baseBackoffMs, …)
 * @param {() => number} [opts.now] clock (tests)
 * @param {(data: object) => void} [opts.onRateLimited] called for every retryable failure before its wait
 * @param {AbortSignal} [opts.signal]
 * @param {(msg: string, data?: object) => void} [opts.onProgress]
 * @yields {object} progress events. Completion events:
 *   {type:'rateLimited', status, waitMs, attempt, maxAttempts, url}
 *     — emitted before every backoff wait so the UI can show a countdown.
 *   {type:'batch', page, items, nextUrl, nextRank}  — one per listing page,
 *     emitted after that page's detail fetches + summaries, so callers can
 *     persist partial progress (same syncId across batches). Ranks are global
 *     listing indices; nextUrl/nextRank describe where page+1 would resume.
 *   {type:'done', items, pages}  — all items of the run (concatenated batches).
 */
export async function* scrapeSaved(opts) {
  const {
    username,
    fetchImpl = (...a) => globalThis.fetch(...a),
    DOMParserImpl = globalThis.DOMParser,
    sleep = defaultSleep,
    summariseAll = async () => {},
    getKnownIds,
    delayMs = DEFAULTS.delayMs,
    maxItems = DEFAULTS.maxItems,
    incremental = DEFAULTS.incremental,
    embedImages = true,
    startUrl = null,
    startRank = 0,
    startPage = 0,
    skipKnown = false,
    retry = RETRY_DEFAULTS,
    now = () => Date.now(),
    onRateLimited = () => {},
    signal,
    onProgress = () => {},
  } = opts;

  if (!username) throw new Error("No Reddit username configured (set it in the extension options).");
  let currentDelay = Math.max(DEFAULTS.minDelayMs, Number(delayMs) || DEFAULTS.delayMs);
  const stopAtKnown = incremental && !skipKnown; // resume mode: skip known, never stop

  const parser = new DOMParserImpl();
  const parseHtml = (html) => parser.parseFromString(html, "text/html");

  let known = new Set();
  if (getKnownIds) {
    try {
      known = new Set(await getKnownIds());
    } catch (err) {
      onProgress(`could not load known ids (${err.message}); falling back to full scan`);
      known = new Set();
    }
  }

  const throwIfAborted = () => {
    if (signal?.aborted) throw signal.reason ?? new Error("aborted");
  };

  // Adaptive pacing: any 429 doubles the inter-request delay for the rest of
  // the run (capped); the retry wait itself also flows to the caller.
  const noteRateLimited = ({ status }) => {
    if (status === 429) currentDelay = Math.min(currentDelay * 2, retry.maxDelayMs ?? RETRY_DEFAULTS.maxDelayMs);
  };
  const resilient = (url, init) =>
    fetchResilient(fetchImpl, url, init, {
      retry: { ...RETRY_DEFAULTS, ...retry }, sleep, signal, now, onProgress,
      onRateLimited: (d) => { noteRateLimited(d); onRateLimited(d); },
    });

  // Polite throttle: if Reddit reports the quota is nearly spent, sleep until
  // the reset window before issuing the next request.
  const throttleForRateHeaders = async (res, moreRequestsPending) => {
    if (!moreRequestsPending) return;
    const remaining = Number(headerValue(res, "x-ratelimit-remaining"));
    const reset = Number(headerValue(res, "x-ratelimit-reset"));
    if (!Number.isFinite(remaining) || !Number.isFinite(reset) || remaining >= 2) return;
    const waitMs = Math.min(Math.max(0, reset * 1000 - now()), retry.maxWaitMs ?? RETRY_DEFAULTS.maxWaitMs);
    if (waitMs <= 0) return;
    onProgress(`rate limit nearly exhausted (${remaining} request(s) left); waiting ${Math.round(waitMs / 1000)} s until reset`, {
      type: "rateLimitThrottle", waitMs, remaining, url: res.url,
    });
    await sleep(waitMs, signal);
  };

  let url = startUrl || savedUrl(username);
  let page = Math.max(0, Math.floor(Number(startPage) || 0));
  let rank = Math.max(0, Math.floor(Number(startRank) || 0)); // global listing index (0 = newest)
  const allItems = [];
  const collected = new Set(); // ids emitted by THIS run (never send one twice)
  let stopEarly = false;
  let first = true;
  let lastFetchAt = 0; // polite pacing across ALL detail fetches

  while (url && !stopEarly && allItems.length < maxItems) {
    throwIfAborted();
    if (!first) await sleep(currentDelay, signal);
    first = false;

    page += 1;
    onProgress(`fetching page ${page}: ${url}`, { type: "fetchStart", page, url });
    let res;
    try {
      res = await resilient(url, { credentials: "include", redirect: "follow" });
    } catch (err) {
      if (signal?.aborted) throw err;
      if (err?.name === "HttpError") throw err; // exhausted retries: fail the run
      throw new Error(`Network error fetching ${url}: ${err.message}`);
    }
    if (!res.ok) throw new HttpError(res.status, url); // 403/4xx: not retried

    const finalUrl = res.url || url;
    const html = await res.text();
    const doc = parseHtml(html);
    const parsed = parseListing(doc, finalUrl);
    const nextUrl = parsed.nextUrl;

    if (parsed.isLoginWall) throw new LoginWallError(username, finalUrl);
    if (parsed.loggedInUser && parsed.loggedInUser.toLowerCase() !== username.toLowerCase()) {
      throw new UserMismatchError(username, parsed.loggedInUser);
    }
    if (!parsed.loggedInUser && page === Math.max(0, Math.floor(Number(startPage) || 0)) + 1) {
      onProgress("warning: could not confirm logged-in user on first page");
    }

    onProgress(`page ${page}: found ${parsed.items.length} items`, {
      type: "pageParsed", page, url: finalUrl, items: parsed.items.length,
      loggedInUser: parsed.loggedInUser, issues: parsed.issues.map(String),
    });
    for (const iss of parsed.issues) onProgress(`parser notice: ${iss}`);

    await throttleForRateHeaders(res, !!nextUrl);

    const pageItems = [];
    for (const item of parsed.items) {
      if (allItems.length + pageItems.length >= maxItems) {
        onProgress(`reached maxItems=${maxItems}, stopping`);
        stopEarly = true;
        break;
      }
      if (known.has(item.id)) {
        if (stopAtKnown) {
          // Correct for an up-to-date vault: even if this is the very first
          // item of the run, everything below it is known too -> stop now.
          onProgress(`reached already-known item ${item.id}; stopping (incremental)`);
          stopEarly = true;
          break;
        }
        if (skipKnown) {
          onProgress(`skipping already-known item ${item.id} (resume; still consumes rank ${rank})`, {
            type: "skipKnown", id: item.id, rank,
          });
          rank += 1;
          continue;
        }
      }
      if (collected.has(item.id)) {
        // The listing shifted during pagination and this item reappeared at
        // a new position. It was already emitted earlier this run with its
        // first (lower) rank — emit it once, keep the first rank; the
        // duplicate still consumes its new listing slot so later ranks stay
        // aligned with the listing index.
        onProgress(`skipping duplicate ${item.id} (reappeared at rank ${rank} after a listing shift); keeping its first rank`, {
          type: "duplicate", id: item.id, rank,
        });
        rank += 1;
        continue;
      }
      item.rank = rank++;
      collected.add(item.id);
      pageItems.push(item);
    }

    // --- per-page enrichment pass ----------------------------------------
    // Detail pages: text posts without inline selftext; galleries (first image).
    // Fetched from old.reddit.com (parsePostPage parses OLD reddit markup;
    // www.reddit.com serves the shreddit UI). item.permalink stays www.reddit.com.
    // Detail 429/5xx/network failures go through the SAME retry/backoff helper
    // so a rate-limited detail page pauses the run instead of hammering Reddit;
    // exhausted retries fail the run (HttpError) rather than being skipped.
    const needDetail = pageItems.filter(
      (it) =>
        (it.postType === "text" && !it._bodyMarkdown) ||
        (it.postType === "gallery" && !it.imageUrl)
    );
    onProgress(`page ${page}: fetching ${needDetail.length} detail page(s)`, {
      type: "detailStart", page, count: needDetail.length,
    });

    let detailDone = 0;
    for (const it of needDetail) {
      throwIfAborted();
      if (!it.permalink || !/^https:\/\/(www\.)?reddit\.com\//.test(it.permalink)) continue;
      const detailUrl = toOldRedditUrl(it.permalink);
      const wait = lastFetchAt ? currentDelay - (now() - lastFetchAt) : 0;
      if (wait > 0) await sleep(wait, signal);
      try {
        const res = await resilient(detailUrl, { credentials: "include", redirect: "follow" });
        lastFetchAt = now();
        if (res.ok) {
          const doc = parseHtml(await res.text());
          const detail = parsePostPage(doc, res.url || detailUrl);
          if (it.postType === "text" && !it._bodyMarkdown && detail.selftextMarkdown) {
            it._bodyMarkdown = detail.selftextMarkdown;
          }
          if (it.postType === "gallery" && !it.imageUrl && detail.imageUrls.length) {
            it.imageUrl = detail.imageUrls[0];
          }
          await throttleForRateHeaders(res, detailDone + 1 < needDetail.length || !!nextUrl);
        } else {
          onProgress(`detail fetch for ${it.id} got HTTP ${res.status}; continuing without it`);
        }
      } catch (err) {
        if (signal?.aborted) throw err;
        if (err?.name === "HttpError") throw err; // exhausted 429/5xx retries: fail the run
        onProgress(`detail fetch failed for ${it.id}: ${err.message}`);
      }
      detailDone += 1;
      onProgress(`detail pages (page ${page}): ${detailDone}/${needDetail.length}`, { type: "detailProgress", page, done: detailDone, total: needDetail.length });
    }

    // --- per-page summarise pass ------------------------------------------
    if (pageItems.length) {
      onProgress(`page ${page}: summarising ${pageItems.length} item(s)`, {
        type: "summariseStart", page, total: pageItems.length,
      });
      let sumDone = 0;
      const CHUNK = 25;
      for (let i = 0; i < pageItems.length; i += CHUNK) {
        throwIfAborted();
        const chunk = pageItems.slice(i, i + CHUNK);
        await summariseAll(chunk, { username, signal, onProgress });
        sumDone += chunk.length;
        onProgress(`page ${page}: summarising ${sumDone}/${pageItems.length}`, { type: "summariseProgress", page, done: sumDone, total: pageItems.length });
      }
    }

    // Finalise this page and hand it to the caller so partial progress is
    // persisted even if a later page hits 429 / a cancel. nextUrl/nextRank
    // let the caller persist a resume cursor after each successful write.
    const batch = finalizeItems(pageItems, { embedImages });
    allItems.push(...batch);
    if (batch.length) yield { type: "batch", page, items: batch, nextUrl, nextRank: rank };

    url = nextUrl;
  }

  yield { type: "done", items: allItems, pages: page };
}
