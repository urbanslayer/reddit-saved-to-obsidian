import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { parseListing, parsePostPage } from "../src/parser.js";

const fix = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const doc = (html) => new JSDOM(html).window.document;

test("parseListing: page 1 items, types, attributes", () => {
  const r = parseListing(doc(fix("saved_page1.html")), "https://old.reddit.com/user/testuser/saved");
  assert.equal(r.isLoginWall, false);
  assert.equal(r.loggedInUser, "testuser");

  const ids = r.items.map((i) => i.id);
  assert.deepEqual(ids, ["t3_txt001", "t3_img002", "t3_gal003", "t3_vid004", "t3_lnk005", "t1_com006", "t3_prf007"]);

  const byId = Object.fromEntries(r.items.map((i) => [i.id, i]));

  // text post: self url = permalink, body captured
  const txt = byId.t3_txt001;
  assert.equal(txt.postType, "text");
  assert.equal(txt.kind, "post");
  assert.equal(txt.subreddit, "Python");
  assert.equal(txt.title, "Asyncio tips for large crawlers");
  assert.equal(txt.permalink, "https://www.reddit.com/r/Python/comments/txt001/asyncio-tips/");
  assert.equal(txt.url, txt.permalink);
  assert.equal(txt.author, "alice");
  assert.equal(txt.createdUtc, 1714560000);
  assert.equal(txt.nsfw, false);
  assert.match(txt._bodyMarkdown, /TaskGroup/);

  // i.redd.it image: relative old.reddit media path -> i.redd.it absolute
  const img = byId.t3_img002;
  assert.equal(img.postType, "image");
  assert.equal(img.imageUrl, "https://i.redd.it/abcdef123.jpg");
  assert.equal(img.url, "https://i.redd.it/abcdef123.jpg");

  // gallery
  const gal = byId.t3_gal003;
  assert.equal(gal.postType, "gallery");
  assert.equal(gal.subreddit, "wallpapers");

  // video
  assert.equal(byId.t3_vid004.postType, "video");
  assert.equal(byId.t3_vid004.url, "https://v.redd.it/k9k3abc123");

  // external link + nsfw
  const lnk = byId.t3_lnk005;
  assert.equal(lnk.postType, "link");
  assert.equal(lnk.url, "https://example.com/http2-deep-dive");
  assert.equal(lnk.nsfw, true);

  // comment: parent title + body + permalink contains comment id
  const com = byId.t1_com006;
  assert.equal(com.kind, "comment");
  assert.equal(com.postType, "comment");
  assert.equal(com.title, "Why generators beat callbacks here");
  assert.match(com._bodyMarkdown, /call stack honest/);
  assert.match(com.permalink, /e123abc/);
  assert.equal(com.url, com.permalink);

  // profile post keeps u_ subreddit
  assert.equal(byId.t3_prf007.subreddit, "u_testuser");

  // next link + no unparseable things except maybe none
  assert.equal(r.nextUrl, "https://old.reddit.com/user/testuser/saved/?count=27&after=t3_prf007");
});

test("parseListing: page 2 (text without inline body, gallery, comments)", () => {
  const r = parseListing(doc(fix("saved_page2.html")), "https://old.reddit.com/user/testuser/saved?count=27&after=t3_prf007");
  const byId = Object.fromEntries(r.items.map((i) => [i.id, i]));
  assert.equal(r.items.length, 5);
  assert.equal(byId.t3_txt011.postType, "text");
  assert.equal(byId.t3_txt011._bodyMarkdown, null); // needs detail fetch
  assert.equal(byId.t3_gal012.postType, "gallery");
  assert.equal(byId.t1_com009.title, "ELI5: how does TCP know a packet is lost?");
  assert.equal(byId.t3_ext010.url, "https://github.com/example/awesome-db");
  assert.equal(r.nextUrl, null);
});

test("parseListing: real login-wall fixture detected", () => {
  const r = parseListing(doc(fix("login_wall.html")), "https://old.reddit.com/user/testuser/saved");
  assert.equal(r.isLoginWall, true);
  assert.equal(r.items.length, 0);
  assert.notEqual(r.loggedInUser, "testuser");
});

test("parseListing: login wall via redirect URL even with odd content", () => {
  const r = parseListing(doc("<html><body>whatever</body></html>"), "https://old.reddit.com/login/?reason=lor2&dest=%2Fuser%2Ftestuser%2Fsaved");
  assert.equal(r.isLoginWall, true);
});

test("parseListing: tolerant of garbage (no crash, issues collected)", () => {
  const r = parseListing(doc("<html><body><div class='thing'>no attrs</div><div class='thing' data-fullname='junk'></div></body></html>"), "https://old.reddit.com/user/x/saved");
  assert.equal(r.items.length, 0);
  assert.ok(r.issues.length >= 1);
});

test("parsePostPage: selftext extraction", () => {
  const r = parsePostPage(doc(fix("post_selftext.html")), "https://www.reddit.com/r/LocalLLaMA/comments/txt011/quantization-notes/");
  assert.match(r.selftextMarkdown, /q4_k_m loses coherence/);
  assert.match(r.selftextMarkdown, /perplexity delta/);
  assert.equal(r.title, "Quantization notes: q4 vs q6 on long context");
});

test("parsePostPage: gallery image URLs", () => {
  const r = parsePostPage(doc(fix("post_gallery.html")), "https://www.reddit.com/r/wallpapers/comments/gal012/aurora-set/");
  assert.deepEqual(r.imageUrls, ["https://i.redd.it/aur1.jpg", "https://i.redd.it/aur2.jpg"]);
});

test("parsePostPage: og:image fallback", () => {
  const r = parsePostPage(doc(fix("post_selftext.html")).querySelector ? doc(
    `<html><head><meta property="og:image" content="https://preview.redd.it/fb.jpg?width=1080"></head>
     <body><div class="thing link"></div></body></html>`
  ) : null, "https://www.reddit.com/r/x/comments/1/");
  assert.deepEqual(r.imageUrls, ["https://preview.redd.it/fb.jpg?width=1080"]);
});
