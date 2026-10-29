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
  delayMs: 2000,
  minDelayMs: 1000,
  maxItems: 1000,
  incremental: true,
};

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
 * @param {AbortSignal} [opts.signal]
 * @param {(msg: string, data?: object) => void} [opts.onProgress]
 * @yields {object} progress events. Completion events:
 *   {type:'batch', page, items}  — one per listing page, emitted after that
 *     page's detail fetches + summaries, so callers can persist partial
 *     progress (same syncId across batches). Ranks are global listing indices.
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
    signal,
    onProgress = () => {},
  } = opts;

  if (!username) throw new Error("No Reddit username configured (set it in the extension options).");
  const delay = Math.max(DEFAULTS.minDelayMs, Number(delayMs) || DEFAULTS.delayMs);

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

  let url = savedUrl(username);
  let page = 0;
  let rank = 0; // global listing index across pages (0 = newest)
  const allItems = [];
  let stopEarly = false;
  let first = true;
  let lastFetchAt = 0; // polite pacing across ALL detail fetches

  while (url && !stopEarly && allItems.length < maxItems) {
    throwIfAborted();
    if (!first) await sleep(delay, signal);
    first = false;

    page += 1;
    onProgress(`fetching page ${page}: ${url}`, { type: "fetchStart", page, url });
    let res;
    try {
      res = await fetchImpl(url, { credentials: "include", redirect: "follow", signal });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new Error(`Network error fetching ${url}: ${err.message}`);
    }
    if (res.status === 429 || res.status === 403 || res.status >= 500 || !res.ok) {
      throw new HttpError(res.status, url);
    }

    const finalUrl = res.url || url;
    const html = await res.text();
    const doc = parseHtml(html);
    const parsed = parseListing(doc, finalUrl);

    if (parsed.isLoginWall) throw new LoginWallError(username, finalUrl);
    if (parsed.loggedInUser && parsed.loggedInUser.toLowerCase() !== username.toLowerCase()) {
      throw new UserMismatchError(username, parsed.loggedInUser);
    }
    if (!parsed.loggedInUser && page === 1) {
      onProgress("warning: could not confirm logged-in user on first page");
    }

    onProgress(`page ${page}: found ${parsed.items.length} items`, {
      type: "pageParsed", page, url: finalUrl, items: parsed.items.length,
      loggedInUser: parsed.loggedInUser, issues: parsed.issues.map(String),
    });
    for (const iss of parsed.issues) onProgress(`parser notice: ${iss}`);

    const pageItems = [];
    for (const item of parsed.items) {
      if (allItems.length + pageItems.length >= maxItems) {
        onProgress(`reached maxItems=${maxItems}, stopping`);
        stopEarly = true;
        break;
      }
      if (incremental && known.has(item.id)) {
        onProgress(`reached already-known item ${item.id}; stopping (incremental)`);
        stopEarly = true;
        break;
      }
      item.rank = rank++;
      pageItems.push(item);
    }

    // --- per-page enrichment pass ----------------------------------------
    // Detail pages: text posts without inline selftext; galleries (first image).
    // Fetched from old.reddit.com (parsePostPage parses OLD reddit markup;
    // www.reddit.com serves the shreddit UI). item.permalink stays www.reddit.com.
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
      const wait = lastFetchAt ? delay - (Date.now() - lastFetchAt) : 0;
      if (wait > 0) await sleep(wait, signal);
      try {
        const res = await fetchImpl(detailUrl, { credentials: "include", redirect: "follow", signal });
        lastFetchAt = Date.now();
        if (res.ok) {
          const doc = parseHtml(await res.text());
          const detail = parsePostPage(doc, res.url || detailUrl);
          if (it.postType === "text" && !it._bodyMarkdown && detail.selftextMarkdown) {
            it._bodyMarkdown = detail.selftextMarkdown;
          }
          if (it.postType === "gallery" && !it.imageUrl && detail.imageUrls.length) {
            it.imageUrl = detail.imageUrls[0];
          }
        } else if (res.status === 429 || res.status === 403) {
          onProgress(`detail fetch for ${it.id} got HTTP ${res.status}; continuing without it`);
        }
      } catch (err) {
        if (signal?.aborted) throw err;
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
    // persisted even if a later page hits 429 / a cancel.
    const batch = finalizeItems(pageItems, { embedImages });
    allItems.push(...batch);
    if (batch.length) yield { type: "batch", page, items: batch };

    url = parsed.nextUrl;
  }

  yield { type: "done", items: allItems, pages: page };
}
