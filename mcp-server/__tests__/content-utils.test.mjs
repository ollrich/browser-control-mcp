import assert from "node:assert/strict";
import test from "node:test";

import utils from "../dist/content-utils.js";

const { compactText, slimLinks, slimContent, matchTabs } = utils;

test("compactText collapses blank lines and space runs", () => {
  const input = "Title\r\n\r\n\r\n\r\n  Body   text\t\twith  gaps \n\n\n\nEnd  ";
  assert.equal(compactText(input), "Title\n\nBody text with gaps\n\nEnd");
});

test("slimLinks dedupes by URL ignoring hash and trailing slash, drops self links", () => {
  const links = [
    { url: "https://a.de/page", text: "self" },
    { url: "https://a.de/x", text: "X" },
    { url: "https://a.de/x/", text: "X again" },
    { url: "https://a.de/x#frag", text: "X frag" },
    { url: "https://a.de/y", text: "  Y   spaced " },
  ];
  const { links: out, dropped } = slimLinks(links, 10, "https://a.de/page#top");
  assert.deepEqual(out, [
    { url: "https://a.de/x", text: "X" },
    { url: "https://a.de/y", text: "Y spaced" },
  ]);
  assert.equal(dropped, 3);
});

test("slimLinks respects maxLinks", () => {
  const links = Array.from({ length: 50 }, (_, i) => ({ url: `https://a.de/${i}`, text: `${i}` }));
  const { links: out, dropped } = slimLinks(links, 5);
  assert.equal(out.length, 5);
  assert.equal(dropped, 45);
});

test("slimContent omits links by default flag and applies maxChars", () => {
  const res = slimContent("abcdefghij", [{ url: "https://a.de/1", text: "1" }], {
    includeLinks: false,
    maxLinks: 40,
    maxChars: 4,
  });
  assert.equal(res.text, "abcd");
  assert.equal(res.cutByMaxChars, true);
  assert.deepEqual(res.links, []);
});

test("matchTabs prefers exact URL, else most recent, case insensitive", () => {
  const tabs = [
    { id: 1, url: "https://x.com/rohan/status/1", title: "Post A", lastAccessed: 100 },
    { id: 2, url: "https://x.com/rohan/status/2", title: "Post B", lastAccessed: 300 },
    { id: 3, url: "https://karakeep.app", title: "Karakeep", lastAccessed: 200 },
    { url: "https://no-id.example", title: "no id" },
  ];
  let r = matchTabs(tabs, "X.COM/rohan");
  assert.equal(r.best.id, 2);
  assert.deepEqual(r.others.map((t) => t.id), [1]);

  r = matchTabs(tabs, "https://x.com/rohan/status/1");
  assert.equal(r.best.id, 1);

  r = matchTabs(tabs, "karakeep");
  assert.equal(r.best.id, 3);

  assert.equal(matchTabs(tabs, "nothing").best, undefined);
  assert.equal(matchTabs(tabs, "  ").best, undefined);
});
