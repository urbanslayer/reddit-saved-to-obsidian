// parser.js — pure functions that turn old.reddit.com HTML (already parsed to a
// Document) into structured data. No extension APIs here; fully unit-testable.
//
// old.reddit saved-listing markup contract (synthetic fixtures mirror it):
//   div.thing[data-fullname=t3_x][data-type=link|comment][data-subreddit]
//          [data-author][data-permalink][data-url][data-domain]
//          [data-timestamp(ms)][data-nsfw=true|false][data-is-gallery]
//     a.title            -> display title (self posts: .thing.link.self)
//     comments: p.parent a.title (parent post title), .usertext-body .md (body)
//   span.next-button a[href]  -> next page
//   #header-bottom-right span.user a -> logged-in username

export const REDDIT_PERMALINK_BASE = "https://www.reddit.com";

export class ParseIssue {
  constructor(message, context = {}) {
    this.message = message;
    this.context = context;
  }
  toString() {
    return `${this.message}${this.context.id ? ` (${this.context.id})` : ""}`;
  }
}

function attr(el, name) {
  const v = el.getAttribute && el.getAttribute(name);
  return v == null ? null : v;
}

function textOf(root, selector) {
  const el = root && root.querySelector(selector);
  return el ? (el.textContent || "").trim() : null;
}

export function absolutize(url, baseUrl) {
  if (!url) return null;
  url = String(url).trim();
  if (!url) return null;
  try {
    return new URL(url, baseUrl || REDDIT_PERMALINK_BASE).toString();
  } catch {
    return null;
  }
}

/** i.redd.it media on old.reddit is often written as a relative "path/id.ext". */
function absolutizeMediaUrl(url, baseUrl) {
  if (!url) return null;
  url = String(url).trim();
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  // keep query strings on absolute-ish media (preview.redd.it needs ?width=…)
  const noQuery = url.split("?")[0];
  // e.g. /r/sub/comments/abc/title/abcdefg.jpg  -> https://i.redd.it/abcdefg.jpg
  const mediaId = noQuery.split("/").filter(Boolean).pop();
  if (mediaId && /\.(jpe?g|png|gif|gifv|webp|mp4|html)([&?].*)?$/i.test(mediaId)) {
    const clean = mediaId.replace(/\?.*$/, "").replace(/&.*$/, "");
    if (/^https:\/\/preview\.redd\.it/i.test(url)) return `https://preview.redd.it/${clean}`;
    return `https://i.redd.it/${clean}`;
  }
  return absolutize(url, baseUrl);
}

function domainIs(domain, ...names) {
  const d = (domain || "").toLowerCase();
  return names.some((n) => d === n || d.endsWith("." + n));
}

function looksLikeSelfPost(thing, url, domain) {
  if (thing.classList && thing.classList.contains("self")) return true;
  if (domainIs(domain, "i.redd.it", "v.redd.it", "preview.redd.it")) return false;
  const d = (domain || "").toLowerCase();
  if (d.startsWith("self.")) return true;
  if (domainIs(d, "reddit.com", "redd.it", "old.reddit.com", "www.reddit.com")) {
    // self posts point data-url at their own permalink (exact path, not a media path)
    const perm = attr(thing, "data-permalink") || "";
    if (perm && url && samePath(url, perm)) return true;
  }
  return false;
}

function samePath(a, b) {
  try {
    const pa = new URL(a, REDDIT_PERMALINK_BASE).pathname.replace(/\/+$/, "");
    const pb = String(b).replace(/\/+$/, "");
    return pa === pb;
  } catch {
    return false;
  }
}

function detectPostType(thing, { isComment, isSelf, url, domain }) {
  if (isComment) return "comment";
  const isGallery =
    attr(thing, "data-is-gallery") === "true" ||
    !!thing.querySelector(".media-gallery, .gallery-element, [data-is-gallery]");
  if (isGallery) return "gallery";
  if (domainIs(domain, "i.redd.it")) return "image";
  if (domainIs(domain, "v.redd.it")) return "video";
  if (isSelf) return "text";
  if (url && domainIs(domain, "imgur.com")) {
    return /\.(png|jpe?g|gif|webp)$/i.test(url) ? "image" : "link";
  }
  return "link";
}

function parseOneThing(thing, baseUrl, issues) {
  const id = attr(thing, "data-fullname");
  if (!id || !/^t[31]_[a-z0-9]+$/i.test(id)) {
    issues.push(new ParseIssue("thing without usable data-fullname", { tag: thing.tagName }));
    return null;
  }
  const kindAttr = (attr(thing, "data-type") || "").toLowerCase();
  const isComment = kindAttr === "comment" || id.startsWith("t1_");

  let subreddit = (attr(thing, "data-subreddit") || "").trim();
  const author = (attr(thing, "data-author") || "").trim() || null;
  if (!subreddit) {
    // profile / user posts surface as u_<name>
    subreddit = author ? `u_${author}` : null;
  }

  const permalinkRel = attr(thing, "data-permalink");
  let permalink = null;
  if (permalinkRel) {
    permalink = absolutize(permalinkRel, REDDIT_PERMALINK_BASE);
  } else {
    // fallback: title link href or comment .bylink
    const a = thing.querySelector("a.title, a.bylink, a[href*='/comments/']");
    if (a && a.getAttribute("href")) {
      permalink = absolutize(a.getAttribute("href"), REDDIT_PERMALINK_BASE);
      issues.push(new ParseIssue("missing data-permalink, used link href", { id }));
    }
  }
  if (isComment && permalink) {
    // comment permalink must end with the comment id
    if (!permalink.includes(id)) {
      const trimmed = permalink.replace(/\/+$/, "");
      permalink = `${trimmed}/${id.split("_")[1]}/`;
    }
  }
  if (!permalink) issues.push(new ParseIssue("could not determine permalink", { id }));

  const rawUrl = attr(thing, "data-url");
  const domain = attr(thing, "data-domain");
  const isSelf = looksLikeSelfPost(thing, rawUrl, domain);
  let url;
  if (isComment) {
    url = permalink;
  } else if (isSelf) {
    url = permalink;
  } else if (rawUrl) {
    url =
      domainIs(domain, "i.redd.it", "v.redd.it", "preview.redd.it") ||
      attr(thing, "data-is-gallery") === "true"
        ? absolutizeMediaUrl(rawUrl, baseUrl)
        : absolutize(rawUrl, baseUrl);
  } else {
    url = permalink;
  }

  let title = textOf(thing, "a.title");
  if (!title && isComment) {
    // comment: parent post title lives in p.parent a.title
    title = textOf(thing, "p.parent a.title") || textOf(thing, "p.title a") || null;
    if (!title) issues.push(new ParseIssue("comment without parent post title", { id }));
  }
  if (!title) title = (attr(thing, "data-title") || "").trim() || null;

  const ts = Number(attr(thing, "data-timestamp"));
  const createdUtc = Number.isFinite(ts) && ts > 1e11 ? Math.round(ts / 1000) : null;
  if (createdUtc == null) issues.push(new ParseIssue("missing/odd data-timestamp", { id }));

  let nsfw = attr(thing, "data-nsfw");
  if (nsfw == null) {
    nsfw = !!(thing.classList && thing.classList.contains("over18"));
  } else {
    nsfw = nsfw === "true";
  }

  // body text: comments (.usertext-body .md) and self posts' inline expando
  let bodyMarkdown = textOf(
    thing,
    isComment ? ".usertext-body .md" : ".expando .usertext-body .md, .selfText .md"
  );

  let postType = detectPostType(thing, { isComment, isSelf, url, domain });

  // image URL (i.redd.it direct; gallery picked up later from detail page)
  let imageUrl = null;
  if (postType === "image") {
    imageUrl = url && /^https?:\/\/i\.redd\.it\//i.test(url) ? url : null;
    if (!imageUrl) {
      // thumbnail href points at the full media; src is a sized preview
      const a = thing.querySelector("a.thumbnail[href]");
      const img = thing.querySelector(".thumbnail img[src], .expando img[src]");
      imageUrl =
        (a && absolutizeMediaUrl(a.getAttribute("href"), baseUrl)) ||
        (img && absolutizeMediaUrl(img.getAttribute("src"), baseUrl)) ||
        null;
    }
  }

  if (postType === "link" && !url) {
    issues.push(new ParseIssue("link post without url", { id }));
  }

  return {
    id,
    kind: isComment ? "comment" : "post",
    subreddit: subreddit || `u_${author || "unknown"}`,
    title: title || "(untitled)",
    permalink: permalink || REDDIT_PERMALINK_BASE + "/",
    url: url || permalink || null,
    author,
    createdUtc: createdUtc ?? 0,
    postType,
    // provisional summary; scraper/summariser finalises it
    summary: "",
    summarySource: isComment ? "comment" : isSelf ? "selftext" : postType === "image" || postType === "gallery" ? "image-fallback" : "link",
    imageUrl,
    nsfw,
    rank: -1,
    // internal extras (stripped before sending to host):
    _bodyMarkdown: bodyMarkdown || null,
    _domain: domain || null,
  };
}

/**
 * Parse a saved-listing page.
 * @returns {{items: object[], nextUrl: string|null, loggedInUser: string|null,
 *            isLoginWall: boolean, issues: ParseIssue[]}}
 */
export function parseListing(doc, baseUrl = "https://old.reddit.com/") {
  const issues = [];
  if (!doc || !doc.querySelector) {
    return { items: [], nextUrl: null, loggedInUser: null, isLoginWall: true, issues: [new ParseIssue("empty document")] };
  }

  // Logged-in identity: #header-bottom-right span.user a (fall back to .user rel=author)
  let loggedInUser =
    textOf(doc, "#header-bottom-right span.user a") ||
    textOf(doc, "#header-bottom-right .user a") ||
    textOf(doc, ".user[data-event-action='author'][rel='author']");
  if (loggedInUser) loggedInUser = loggedInUser.replace(/^\/?u\//, "").replace(/^\/+/, "");

  const things = [...doc.querySelectorAll("div.thing, .thing")];
  const items = [];
  for (const thing of things) {
    // skip ad/promo slots
    if (thing.classList && (thing.classList.contains("ad-slot") || thing.classList.contains("promo"))) continue;
    try {
      const item = parseOneThing(thing, baseUrl, issues);
      if (item) items.push(item);
    } catch (err) {
      issues.push(new ParseIssue(`thing parse crashed: ${err && err.message}`, { id: attr(thing, "data-fullname") }));
    }
  }

  let nextUrl = null;
  const nextA = doc.querySelector("span.next-button a[href], .next-button a[href], a[next]");
  if (nextA) {
    const href = nextA.getAttribute("href");
    if (href && !/javascript:/i.test(href)) nextUrl = absolutize(href, baseUrl);
  }

  // Login wall: redirected to /login, or logged-out page (no user chip, no listing).
  const onLoginPage = baseUrl && /\/login(\?|$|\/)/i.test(baseUrl);
  const hasHeader = !!doc.querySelector("#header-bottom-right");
  const hasLoginForm = !!doc.querySelector("form#login-form, #siteTable .infobar, #noresults");
  const isLoginWall = onLoginPage || (!loggedInUser && items.length === 0 && (!hasHeader || hasLoginForm || hasBlockNotice(doc)));

  return { items, nextUrl, loggedInUser, isLoginWall, issues };
}

function hasBlockNotice(doc) {
  const t = (doc.body && doc.body.textContent) || "";
  return /blocked by network security|please log in|log in to (old\.)?reddit/i.test(t.slice(0, 5000));
}

/**
 * Parse a detail (post) page: selftext markdown, gallery/preview image URLs.
 * @returns {{selftextMarkdown: string|null, imageUrls: string[], title: string|null, issues: ParseIssue[]}}
 */
export function parsePostPage(doc, baseUrl = REDDIT_PERMALINK_BASE) {
  const issues = [];
  const out = { selftextMarkdown: null, imageUrls: [], title: null, issues };
  if (!doc || !doc.querySelector) {
    issues.push(new ParseIssue("empty document"));
    return out;
  }

  const post = doc.querySelector("div.thing.link, .thing.self") || doc;
  out.title = textOf(post, "a.title") || textOf(doc, "title");

  out.selftextMarkdown =
    textOf(post, ".expando .usertext-body .md") ||
    textOf(post, ".usertext-body .md") ||
    null;

  // gallery images
  const seen = new Set();
  const push = (u) => {
    const abs = absolutizeMediaUrl(u, baseUrl);
    if (abs && /\.(jpe?g|png|gif|webp)$/i.test(abs.split("?")[0]) && !seen.has(abs)) {
      seen.add(abs);
      out.imageUrls.push(abs);
    }
  };
  for (const img of doc.querySelectorAll(".media-gallery img[src], .gallery-element img[src], .media-gal img[src]")) {
    push(img.getAttribute("src"));
  }
  if (out.imageUrls.length === 0) {
    for (const a of doc.querySelectorAll(".media-gallery a[href], .gallery-element-link a[href], a.thumbnail[href]")) {
      push(a.getAttribute("href"));
    }
  }
  if (out.imageUrls.length === 0) {
    for (const img of doc.querySelectorAll(".expando .preview img[src], #preview img[src], .thumbnail.img-preview img[src]")) {
      push(img.getAttribute("src"));
    }
  }

  // og:image fallback (single image posts / galleries without parsed markup)
  if (out.imageUrls.length === 0) {
    const og = doc.querySelector("meta[property='og:image'], meta[name='og:image']");
    if (og && og.getAttribute("content")) push(og.getAttribute("content"));
  }
  if (out.imageUrls.length === 0 && !out.selftextMarkdown) {
    issues.push(new ParseIssue("post page yielded neither selftext nor images", { url: baseUrl }));
  }
  return out;
}

/** Strip internal underscore-prefixed helper fields before sending to the host. */
export function toItem(item, { rank, summary, summarySource, imageUrl } = {}) {
  const { _bodyMarkdown, _domain, ...rest } = item;
  return {
    ...rest,
    ...(rank !== undefined ? { rank } : {}),
    ...(summary !== undefined ? { summary } : {}),
    ...(summarySource !== undefined ? { summarySource } : {}),
    ...(imageUrl !== undefined ? { imageUrl } : {}),
  };
}
