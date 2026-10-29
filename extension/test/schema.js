// schema.js — validator for the Item contract in docs/DESIGN.md.
const Kinds = new Set(["post", "comment"]);
const PostTypes = new Set(["text", "image", "gallery", "video", "link", "comment"]);
const SummarySources = new Set(["selftext", "selftext-ai", "image-ai", "image-fallback", "link", "comment"]);

/**
 * @param {object} item
 * @returns {string[]} list of violations (empty = valid)
 */
export function validateItem(item) {
  const errs = [];
  const e = (m) => errs.push(m);
  if (!item || typeof item !== "object" || Array.isArray(item)) return ["item is not an object"];

  if (typeof item.id !== "string" || !/^t[31]_[a-z0-9]+$/.test(item.id)) e(`bad id: ${item.id}`);
  if (!Kinds.has(item.kind)) e(`bad kind: ${item.kind}`);
  if (item.id && item.kind) {
    const prefix = item.kind === "post" ? "t3_" : "t1_";
    if (!item.id.startsWith(prefix)) e(`id prefix ${item.id.slice(0, 3)} inconsistent with kind ${item.kind}`);
  }
  if (typeof item.subreddit !== "string" || !item.subreddit || item.subreddit.startsWith("r/")) e(`bad subreddit: ${item.subreddit}`);
  if (typeof item.title !== "string" || !item.title) e("title must be a non-empty string");
  if (typeof item.permalink !== "string" || !/^https:\/\/www\.reddit\.com\//.test(item.permalink)) e(`permalink must be absolute www.reddit.com: ${item.permalink}`);
  if (!("url" in item)) e("missing url");
  else if (item.url !== null && (typeof item.url !== "string" || !/^https?:\/\//.test(item.url))) e(`bad url: ${item.url}`);
  if (!("author" in item)) e("missing author");
  else if (item.author !== null && typeof item.author !== "string") e("author must be string|null");
  if (!Number.isInteger(item.createdUtc) || item.createdUtc < 0) e(`createdUtc must be non-negative int seconds: ${item.createdUtc}`);
  if (!PostTypes.has(item.postType)) e(`bad postType: ${item.postType}`);
  if (typeof item.summary !== "string") e("summary must be a string");
  if (!SummarySources.has(item.summarySource)) e(`bad summarySource: ${item.summarySource}`);
  if (!("imageUrl" in item)) e("missing imageUrl");
  else if (item.imageUrl !== null && (typeof item.imageUrl !== "string" || !/^https?:\/\//.test(item.imageUrl))) e(`bad imageUrl: ${item.imageUrl}`);
  if (typeof item.nsfw !== "boolean") e("nsfw must be boolean");
  if (!Number.isInteger(item.rank) || item.rank < 0) e(`rank must be non-negative int: ${item.rank}`);

  // cross-field sanity
  if (item.kind === "comment" && item.postType !== "comment") e("comment kind must have postType comment");
  for (const k of Object.keys(item)) {
    if (k.startsWith("_")) e(`internal field leaked to host payload: ${k}`);
  }
  return errs;
}
