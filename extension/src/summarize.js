// summarize.js — default local extractive summariser + optional OpenAI-compatible
// AI summariser (text + vision) with graceful fallback to the local one.

const MAX_CHARS = 400;
const MAX_SENTENCES = 3;
const AI_TIMEOUT_MS = 45000;

/** Strip lightweight markdown to readable plain text. */
export function stripMarkdown(md) {
  if (!md) return "";
  let s = String(md);
  s = s.replace(/```[\s\S]*?```/g, " ");           // fenced code blocks
  s = s.replace(/`([^`]*)`/g, "$1");               // inline code
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1"); // images -> alt
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");  // links -> text
  s = s.replace(/^\s{0,3}#{1,6}\s+.*$/gm, (m) => m.replace(/^\s{0,3}#{1,6}\s+/, "")); // headings
  s = s.replace(/^\s{0,3}>\s?/gm, "");             // blockquotes
  s = s.replace(/^\s*[-*+]\s+/gm, "");             // bullets
  s = s.replace(/^\s*\d+\.\s+/gm, "");             // ordered lists
  s = s.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2"); // strong
  s = s.replace(/(?:\*|_)(?=\S)(?!\s)([^*_]+?)(?<!\s)(?:\*|_)/g, (m, inner, off, str) => {
    // single-star/underscore emphasis, but never inside a word (q4_k_m stays)
    const before = str[off - 1] ?? "";
    const after = str[off + m.length] ?? "";
    if (/[\w]/.test(before) || /[\w]/.test(after)) return m;
    return inner;
  });
  s = s.replace(/\|/g, " ");                       // table pipes
  s = s.replace(/^\s*[-:| ]+$/gm, "");
  s = s.replace(/&(amp|#x200C|#39|quot|gt|lt|#x27);/g, " ");
  s = s.replace(/&amp;/g, "&");
  s = s.replace(/^[*_~]+|[*_~]+$/g, "");           // dangling emphasis markers
  s = s.replace(/(?:^|\s)[*_~]+(?=\s|$)/g, " ");   // orphan markers between words
  return s;
}

function collapseWhitespace(s) {
  return String(s || "").replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n+/g, " ").trim();
}

const SENTENCE_SPLIT = /(?<=[.!?。！？])\s+(?=[A-Z0-9'"“(\u4e00-\u9fff])|[\n]+/;

/** First ~3 sentences up to ~400 chars, '…' when truncated. */
export function extractiveSummary(text, { maxChars = MAX_CHARS, maxSentences = MAX_SENTENCES } = {}) {
  const clean = collapseWhitespace(stripMarkdown(text));
  if (!clean) return "";
  const sentences = clean.split(SENTENCE_SPLIT).map((s) => s.trim()).filter(Boolean);
  if (sentences.length === 0) return "";
  let out = "";
  let used = 0;
  let truncated = false;
  for (const s of sentences) {
    const candidate = out ? `${out} ${s}` : s;
    if (candidate.length <= maxChars) {
      out = candidate;
      used++;
      if (used >= maxSentences && used < sentences.length) { truncated = true; break; }
    } else {
      truncated = true;
      break;
    }
  }
  if (!out) {
    out = clean.slice(0, maxChars).replace(/\s+\S*$/, "");
    truncated = true;
  }
  if (truncated) out += "…";
  return out;
}

function hostFromUrl(u) {
  try { return new URL(u).host; } catch { return "reddit"; }
}

/**
 * Fill in summary/summarySource (and keep imageUrl) for a batch of scraped items.
 * @param {object[]} items mutated in place
 * @param {{settings: object, fetchImpl?: Function, signal?: AbortSignal, onProgress?: Function}} ctx
 */
export async function summariseAll(items, { settings = {}, fetchImpl, signal, onProgress = () => {} } = {}) {
  const aiEnabled = !!settings.aiEnabled && !!settings.aiEndpoint;
  const aiForText = !!settings.aiForText;
  let aiDone = 0;
  for (const item of items) {
    // local baseline first so AI failure can fall back
    applyLocal(item);
    if (!aiEnabled) continue;
    const wantsImage = (item.postType === "image" || item.postType === "gallery") && item.imageUrl;
    const wantsText = aiForText && (item.postType === "text" || item.postType === "comment") && item._bodyMarkdown;
    if (!wantsImage && !wantsText) continue;
    try {
      if (wantsImage) {
        const text = await aiSummarise({
          settings, fetchImpl, signal,
          prompt: `Describe this Reddit image post and its context briefly (2-3 sentences). Title: ${JSON.stringify(item.title)}${item.subreddit ? `, subreddit: r/${item.subreddit}` : ""}. Return only the description.`,
          imageUrl: item.imageUrl,
        });
        if (text) { item.summary = text; item.summarySource = "image-ai"; }
      } else if (wantsText) {
        const text = await aiSummarise({
          settings, fetchImpl, signal,
          prompt: `Summarise this Reddit ${item.postType} in 2-3 sentences of plain text. Title: ${JSON.stringify(item.title)}. Content:\n${String(item._bodyMarkdown).slice(0, 6000)}\nReturn only the summary.`,
        });
        if (text) { item.summary = text; item.summarySource = item.postType === "comment" ? "selftext-ai" : "selftext-ai"; }
      }
    } catch (err) {
      if (signal?.aborted) throw err;
      onProgress(`AI summary failed for ${item.id} (${err.message}); using local summary`);
      applyLocal(item); // ensure local baseline intact
    }
    aiDone++;
  }
}

/** Deterministic local summary for one parser item (mutates and returns it). */
export function applyLocal(item) {
  switch (item.postType) {
    case "comment": {
      const body = item._bodyMarkdown || item.title;
      const s = extractiveSummary(body);
      item.summary = s || `Comment: ${(item.title || "").trim()}`;
      item.summarySource = "comment";
      break;
    }
    case "text": {
      if (item._bodyMarkdown && item._bodyMarkdown.trim()) {
        item.summary = extractiveSummary(item._bodyMarkdown) || item.title;
        item.summarySource = "selftext";
      } else {
        item.summary = item.title || "(untitled post)";
        item.summarySource = "selftext";
      }
      break;
    }
    case "image":
    case "gallery": {
      const caption = extractiveSummary(item._bodyMarkdown || "");
      item.summary = caption
        ? `Image post: ${item.title}\n${caption}`
        : `Image post: ${item.title}`;
      item.summarySource = "image-fallback";
      break;
    }
    default: { // link
      const host = item.url ? hostFromUrl(item.url) : null;
      item.summary = host ? `${host} — ${item.title}` : item.title;
      item.summarySource = "link";
    }
  }
  return item;
}

/** POST {endpoint}/chat/completions; returns trimmed text content. Throws on any failure. */
export async function aiSummarise({ settings, fetchImpl, prompt, imageUrl, signal }) {
  const endpoint = String(settings.aiEndpoint || "").replace(/\/+$/, "");
  if (!endpoint) throw new Error("no AI endpoint configured");
  const url = `${endpoint}/chat/completions`;
  const content = imageUrl
    ? [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: imageUrl } }]
    : prompt;
  const body = {
    model: settings.aiModel || undefined,
    messages: [{ role: "user", content }],
    temperature: 0.3,
  };
  const headers = { "Content-Type": "application/json" };
  if (settings.aiApiKey) headers["Authorization"] = `Bearer ${settings.aiApiKey}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), AI_TIMEOUT_MS);
  const onOuterAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) { clearTimeout(timer); throw new Error("aborted"); }
    signal.addEventListener("abort", onOuterAbort, { once: true });
  }
  const doFetch = fetchImpl || ((...a) => globalThis.fetch(...a));
  try {
    const res = await doFetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} from AI endpoint`);
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    if (!text || !String(text).trim()) throw new Error("empty AI response");
    return collapseWhitespace(String(text));
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onOuterAbort);
  }
}
