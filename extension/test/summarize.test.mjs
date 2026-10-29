import { test } from "node:test";
import assert from "node:assert/strict";
import { stripMarkdown, extractiveSummary, applyLocal, summariseAll, aiSummarise } from "../src/summarize.js";

const baseItem = (over) => ({
  id: "t3_x1", kind: "post", subreddit: "Python", title: "A title",
  permalink: "https://www.reddit.com/r/Python/comments/x1/", url: "https://www.reddit.com/r/Python/comments/x1/",
  author: "a", createdUtc: 1, postType: "text", summary: "", summarySource: "selftext",
  imageUrl: null, nsfw: false, rank: 0, _bodyMarkdown: null, ...over,
});

test("stripMarkdown removes md syntax", () => {
  const md = "# Heading\n\nSome **bold** and `code` and [a link](https://x.y) here.\n\n- bullet one\n> quoted";
  const s = stripMarkdown(md);
  assert.ok(!s.includes("**") && !s.includes("`") && !s.includes("](http") && !s.includes("# Heading"));
  assert.match(s, /a link here/);
  assert.match(s, /bullet one/);
});

test("extractiveSummary: first ~3 sentences, ~400 chars, ellipsis on truncation", () => {
  const text = "One full sentence here. Two full sentence here. Three full sentence here. Four should be dropped entirely because we stop at three sentences.";
  const s = extractiveSummary(text);
  assert.ok(s.startsWith("One full sentence here. Two full sentence here. Three full sentence here."));
  assert.ok(!s.includes("Four"));
  assert.ok(s.endsWith("…"));

  const short = "Just one short sentence.";
  assert.equal(extractiveSummary(short), "Just one short sentence.");

  const long = "x".repeat(900);
  const trunc = extractiveSummary(long);
  assert.ok(trunc.length <= 401 && trunc.endsWith("…"));

  assert.equal(extractiveSummary("**```code```**   "), "");
});

test("applyLocal per post type", () => {
  assert.equal(applyLocal(baseItem({ postType: "link", url: "https://example.org/p", summarySource: "link" })).summary, "example.org — A title");
  const img = applyLocal(baseItem({ postType: "image", imageUrl: "https://i.redd.it/a.jpg", _bodyMarkdown: "A caption about cats." }));
  assert.equal(img.summarySource, "image-fallback");
  assert.equal(img.summary, "Image post: A title\nA caption about cats.");
  const imgNoCap = applyLocal(baseItem({ postType: "image", imageUrl: "https://i.redd.it/a.jpg" }));
  assert.equal(imgNoCap.summary, "Image post: A title");
  const com = applyLocal(baseItem({ postType: "comment", kind: "comment", _bodyMarkdown: "Body of comment." }));
  assert.equal(com.summary, "Body of comment.");
  assert.equal(com.summarySource, "comment");
  const txt = applyLocal(baseItem({ _bodyMarkdown: "Self **text** body." }));
  assert.equal(txt.summary, "Self text body.");
  assert.equal(txt.summarySource, "selftext");
  const empty = applyLocal(baseItem({}));
  assert.equal(empty.summary, "A title");
});

test("summariseAll: local by default, no network", async () => {
  const items = [baseItem({ postType: "link", url: "https://a.b/c" })];
  await summariseAll(items, { settings: {}, fetchImpl: () => { throw new Error("must not fetch"); } });
  assert.equal(items[0].summarySource, "link");
});

test("summariseAll: AI image success sets image-ai", async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "A cat on a roof." } }] }) };
  };
  const items = [baseItem({ postType: "image", imageUrl: "https://i.redd.it/a.jpg" })];
  await summariseAll(items, { settings: { aiEnabled: true, aiEndpoint: "http://localhost:11434/v1", aiModel: "llava" }, fetchImpl });
  assert.equal(items[0].summary, "A cat on a roof.");
  assert.equal(items[0].summarySource, "image-ai");
  assert.equal(captured.url, "http://localhost:11434/v1/chat/completions");
  const body = JSON.parse(captured.init.body);
  assert.equal(body.model, "llava");
  assert.ok(Array.isArray(body.messages[0].content)); // multimodal content parts
  assert.ok(body.messages[0].content.some((p) => p.type === "image_url" && p.image_url.url === "https://i.redd.it/a.jpg"));
});

test("summariseAll: AI failure falls back to local summary", async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({}) });
  const notes = [];
  const items = [baseItem({ postType: "image", imageUrl: "https://i.redd.it/a.jpg" })];
  await summariseAll(items, {
    settings: { aiEnabled: true, aiEndpoint: "http://x/v1" },
    fetchImpl, onProgress: (m) => notes.push(m),
  });
  assert.equal(items[0].summarySource, "image-fallback");
  assert.match(items[0].summary, /^Image post: A title/);
  assert.ok(notes.some((n) => /AI summary failed/.test(n)));
});

test("summariseAll: AI text mode off by default, on when aiForText", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "AI text summary." } }] }) }; };
  const mk = () => baseItem({ _bodyMarkdown: "Long selftext body goes here." });
  const off = [mk()];
  await summariseAll(off, { settings: { aiEnabled: true, aiEndpoint: "http://x/v1" }, fetchImpl });
  assert.equal(calls, 0);
  assert.equal(off[0].summarySource, "selftext");
  const on = [mk()];
  await summariseAll(on, { settings: { aiEnabled: true, aiForText: true, aiEndpoint: "http://x/v1" }, fetchImpl });
  assert.equal(calls, 1);
  assert.equal(on[0].summary, "AI text summary.");
  assert.equal(on[0].summarySource, "selftext-ai");
});

test("aiSummarise: sends auth header, throws on empty content", async () => {
  let headers;
  const r = await aiSummarise({
    settings: { aiEndpoint: "http://x/v1/", aiApiKey: "k123" },
    prompt: "hi",
    fetchImpl: async (url, init) => { headers = init.headers; return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "  okay  " } }] }) }; },
  });
  assert.equal(r, "okay");
  assert.equal(headers["Authorization"], "Bearer k123");
  await assert.rejects(aiSummarise({
    settings: { aiEndpoint: "http://x/v1" }, prompt: "hi",
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ choices: [] }) }),
  }), /empty AI response/);
});
