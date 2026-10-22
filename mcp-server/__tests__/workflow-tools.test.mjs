// End to end: real MCP server processes over stdio, a fake Firefox extension
// that behaves like the stock AMO add-on (original commands only, unsigned
// errors for everything else, about:blank before navigation, consent dialog
// for new domains, unloaded tabs), plus a second server process acting as
// broker forwarder.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverJs = path.join(here, "..", "dist", "server.js");
const SECRET = "test-secret-" + crypto.randomBytes(4).toString("hex");
const ORIGINAL_COMMANDS = ["close-tabs", "get-tab-content", "get-tab-list", "open-tab"];

async function freePort() {
  return await new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const sign = (payload) => crypto.createHmac("sha256", SECRET).update(JSON.stringify(payload)).digest("hex");

const consentMessage = (origin) =>
  `The user has not yet granted permission to access the domain "${origin}". ` +
  "A dialog is now being opened to request permission. If the user grants permission, you can try the request again.";

// Fields the fake keeps for itself; everything else is sent like a tabs.Tab.
const publicTab = ({ text, reads, pendingUrl, blankPolls, loadingPolls, links, ...tab }) => tab;

function advanceLoading(state, tab) {
  if (tab.pendingUrl) {
    Object.assign(tab, { url: tab.pendingUrl, status: "loading", loadingPolls: 2, title: "Loading" }, state.pages[tab.pendingUrl] ?? { text: "Default page" });
    delete tab.pendingUrl;
  } else if (tab.status === "loading" && --tab.loadingPolls <= 0) {
    tab.status = "complete";
  }
}

function startFakeExtension(port, state) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  ws.on("message", (raw) => {
    const { payload } = JSON.parse(raw.toString());
    state.commands.push(payload.cmd);
    const reply = (body) => {
      const p = { ...body, correlationId: payload.correlationId };
      ws.send(JSON.stringify({ payload: p, signature: sign(p) }));
    };
    // The add-on reports failures as unsigned error messages.
    const fail = (errorMessage) => ws.send(JSON.stringify({ correlationId: payload.correlationId, errorMessage }));

    switch (payload.cmd) {
      case "get-tab-list":
        reply({ resource: "tabs", tabs: state.tabs.map(publicTab) });
        for (const tab of state.tabs) advanceLoading(state, tab);
        break;
      case "open-tab": {
        const id = state.nextId++;
        // Firefox shows the new tab as a finished about:blank before navigating.
        state.tabs.push({ id, url: "about:blank", status: "complete", title: "New Tab", pendingUrl: payload.url, lastAccessed: Date.now(), active: true, reads: 0 });
        reply({ resource: "opened-tab-id", tabId: id });
        break;
      }
      case "close-tabs":
        state.tabs = state.tabs.filter((t) => !payload.tabIds.includes(t.id));
        reply({ resource: "tabs-closed" });
        break;
      case "get-tab-content": {
        const tab = state.tabs.find((t) => t.id === payload.tabId);
        if (!tab) return fail(`Invalid tab ID: ${payload.tabId}`);
        if (tab.url === "about:blank") return fail("Invalid url pattern: null/*");
        if (tab.discarded) return fail("Missing host permission for the tab");
        const origin = new URL(tab.url).origin;
        if (state.deniedOrigins.has(origin)) {
          state.tabs.push({
            id: state.nextId++,
            url: `moz-extension://fake-uuid/options.html?requestUrl=${encodeURIComponent(tab.url)}`,
            title: "Browser Control MCP",
            status: "complete",
            lastAccessed: Date.now(),
          });
          state.onConsentRequested?.(origin);
          return fail(consentMessage(origin));
        }
        tab.reads = (tab.reads ?? 0) + 1;
        const full = typeof tab.text === "function" ? tab.text(tab.reads) : tab.text;
        const rest = full.substring(payload.offset ?? 0);
        const page = rest.substring(0, state.pageCap);
        reply({
          resource: "tab-content",
          tabId: tab.id,
          fullText: page,
          isTruncated: rest.length > page.length,
          totalLength: full.length,
          links: tab.links ?? [],
        });
        break;
      }
      default:
        // The stock add-on rejects commands it does not know.
        fail(`Command '${payload.cmd}' is disabled in extension settings`);
    }
  });
  return new Promise((resolve) => ws.on("open", () => resolve(ws)));
}

async function startClient(port, home) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverJs],
    env: { ...process.env, HOME: home, EXTENSION_SECRET: SECRET, EXTENSION_PORT: String(port) },
    stderr: "pipe",
  });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  return client;
}

const textOf = (res) => res.content.map((c) => c.text).join("\n---\n");
const count = (cmd) => state.commands.filter((c) => c === cmd).length;
const grantConsent = (origin) => {
  state.deniedOrigins.delete(origin);
  // The consent page closes itself after the user grants access.
  state.tabs = state.tabs.filter((t) => !t.url.startsWith("moz-extension://"));
};

const longText = "Rohan Nayak post\n\n\n\n\n" + "Pocket FM grew a lot.   ".repeat(30);
const state = {
  commands: [],
  nextId: 100,
  pageCap: 50_000,
  deniedOrigins: new Set(),
  pages: {},
  tabs: [],
};
let port;
let home;
let leader;
let ext;

before(async () => {
  port = await freePort();
  // Deliberately below os.tmpdir(): on macOS that path is long enough to
  // overflow the unix socket limit, which the broker has to cope with.
  home = fs.mkdtempSync(path.join(os.tmpdir(), "bcm-home-"));
  state.tabs = [
    { id: 1, url: "https://x.com/RohanNayak2/status/2098104784264065525", title: "Rohan on X", lastAccessed: 500, status: "complete", windowId: 1, active: false, text: longText,
      links: [
        { url: "https://x.com/RohanNayak2/status/2098104784264065525", text: "self" },
        { url: "https://pocketfm.com/", text: "Pocket FM" },
        { url: "https://pocketfm.com", text: "Pocket FM dup" },
      ] },
    { id: 2, url: "https://karakeep.app/dashboard", title: "Karakeep", lastAccessed: 900, status: "complete", windowId: 1, active: true, text: "Bookmarks list" },
    // Recently used, but not a readable web page.
    { id: 3, url: "about:preferences", title: "Settings", lastAccessed: 950, status: "complete", windowId: 2, active: true, text: "" },
  ];

  leader = await startClient(port, home);
  await new Promise((r) => setTimeout(r, 300));
  ext = await startFakeExtension(port, state);
});

after(async () => {
  await leader?.close();
  ext?.close();
});

test("tool list includes the workflow and screenshot tools", async () => {
  const tools = (await leader.listTools()).tools.map((x) => x.name);
  for (const name of ["read-tab", "open-and-read-tab", "capture-tab-screenshot"]) {
    assert.ok(tools.includes(name), name);
  }
});

test("every tool carries read only and destructive annotations", async () => {
  const tools = Object.fromEntries((await leader.listTools()).tools.map((x) => [x.name, x.annotations]));
  for (const [name, annotations] of Object.entries(tools)) {
    assert.equal(typeof annotations?.readOnlyHint, "boolean", name);
  }
  assert.equal(tools["read-tab"].readOnlyHint, true);
  assert.equal(tools["get-list-of-open-tabs"].readOnlyHint, true);
  assert.equal(tools["open-and-read-tab"].readOnlyHint, false);
  assert.equal(tools["close-browser-tabs"].destructiveHint, true);
});

test("read-tab finds tabs by fragment, compacts text and slims links", async () => {
  let res = await leader.callTool({ name: "read-tab", arguments: { match: "rohannayak2" } });
  let text = textOf(res);
  assert.match(text, /tab id=1/);
  assert.match(text, /Rohan Nayak post\n\nPocket FM/);
  assert.doesNotMatch(text, /Links:/);

  // Several words must all match, in URL or title.
  res = await leader.callTool({ name: "read-tab", arguments: { match: "x.com rohan", includeLinks: true } });
  text = textOf(res);
  assert.match(text, /tab id=1/);
  assert.match(text, /Links:\n- Pocket FM <https:\/\/pocketfm.com\/>/);
  assert.doesNotMatch(text, /Pocket FM dup/);
  assert.doesNotMatch(text, /- self/);
});

test("read-tab without arguments reads the active web page", async () => {
  const res = await leader.callTool({ name: "read-tab", arguments: {} });
  assert.match(textOf(res), /Bookmarks list/);
});

test("read-tab reports a missing tab as an error", async () => {
  let res = await leader.callTool({ name: "read-tab", arguments: { match: "does-not-exist" } });
  assert.equal(res.isError, true);
  res = await leader.callTool({ name: "read-tab", arguments: { match: "preferences" } });
  assert.equal(res.isError, true, "about: pages are not readable");
});

test("maxChars names an offset that continues exactly after the shown text", async () => {
  const first = await leader.callTool({ name: "read-tab", arguments: { tabId: 1, maxChars: 40 } });
  const next = textOf(first).match(/offset=(\d+)/);
  assert.ok(next, "continuation offset given");
  const second = await leader.callTool({ name: "read-tab", arguments: { tabId: 1, maxChars: 40, offset: Number(next[1]) } });

  const shown = (res) => res.content[res.content.length - 1].text;
  const squash = (s) => s.replace(/\s+/g, "");
  assert.ok(squash(longText).startsWith(squash(shown(first) + shown(second))));
});

test("open-and-read-tab skips about:blank and waits for script rendered text", async () => {
  state.commands.length = 0;
  state.pages["https://bsky.app/profile/test"] = {
    text: (reads) => (reads === 1 ? "Loading..." : "Real rendered profile content"),
  };
  const res = await leader.callTool({
    name: "open-and-read-tab",
    arguments: { url: "https://bsky.app/profile/test", settleMs: 100, closeAfter: true },
  });
  const text = textOf(res);
  assert.equal(res.isError, undefined, text);
  assert.match(text, /Real rendered profile content/);
  assert.doesNotMatch(text, /Loading\.\.\./);
  assert.ok(count("get-tab-list") >= 3, "polled until complete");
  assert.ok(count("get-tab-content") >= 2 && count("get-tab-content") <= 5, "re-read until stable");
  assert.ok(!state.tabs.some((t) => t.url === "https://bsky.app/profile/test"), "tab closed after reading");
  assert.deepEqual([...new Set(state.commands)].sort(), ORIGINAL_COMMANDS);
});

test("open-and-read-tab waits for domain consent, then reads", async () => {
  state.deniedOrigins.add("https://newsite.example");
  state.pages["https://newsite.example"] = { text: "Freshly allowed page" };
  // The user clicks "allow" shortly after the dialog shows up.
  state.onConsentRequested = (origin) => setTimeout(() => grantConsent(origin), 800);

  const res = await leader.callTool({
    name: "open-and-read-tab",
    arguments: { url: "newsite.example", settleMs: 0, consentWaitMs: 15_000 },
  });
  delete state.onConsentRequested;
  const text = textOf(res);
  assert.equal(res.isError, undefined, text);
  assert.match(text, /Freshly allowed page/);
  assert.match(text, /Opened https:\/\/newsite\.example\./);
  assert.match(text, /Tab stays open as tab id \d+/);
});

test("without waiting, a consent error names the tab to read later", async () => {
  state.deniedOrigins.add("https://karakeep.app");
  const res = await leader.callTool({ name: "read-tab", arguments: { tabId: 2, consentWaitMs: 0 } });
  grantConsent("https://karakeep.app");
  assert.equal(res.isError, true);
  assert.match(textOf(res), /not yet granted permission.*call read-tab with tabId=2/s);
});

test("read-tab reads an unloaded tab through a temporary tab", async () => {
  state.tabs.push({ id: 7, url: "https://old.example/article", title: "Old article", lastAccessed: 10, status: "complete", discarded: true, text: "stale" });
  state.pages["https://old.example/article"] = { text: "Fresh article text" };
  const tabCount = state.tabs.length;

  const res = await leader.callTool({ name: "read-tab", arguments: { match: "old.example" } });
  const text = textOf(res);
  assert.match(text, /Fresh article text/);
  assert.match(text, /Tab 7 is unloaded \(discarded\)/);
  assert.equal(state.tabs.length, tabCount, "temporary tab closed again");
});

test("get-current-tab and get-tab-metadata work with the stock add-on", async () => {
  state.commands.length = 0;
  let res = await leader.callTool({ name: "get-current-tab", arguments: {} });
  assert.match(textOf(res), /id=\d+/);
  res = await leader.callTool({ name: "get-tab-metadata", arguments: { tabId: 1 } });
  assert.equal(JSON.parse(res.content[0].text).url, state.tabs.find((t) => t.id === 1).url);
  assert.deepEqual([...new Set(state.commands)], ["get-tab-list"]);
});

test("open-browser-tab reports bad URLs as tool errors", async () => {
  const res = await leader.callTool({ name: "open-browser-tab", arguments: { url: "ftp://example.com" } });
  assert.equal(res.isError, true);
});

test("waitForText keeps reading until the text shows up", async () => {
  state.commands.length = 0;
  // Stable page chrome first; the wanted post renders a little later.
  const chrome = "Navigation and sidebar text. ".repeat(20);
  state.pages["https://slow.example/feed"] = {
    text: (reads) => (reads < 3 ? chrome : `${chrome}\nThe Target   Phrase is here`),
  };
  let res = await leader.callTool({
    name: "open-and-read-tab",
    arguments: { url: "https://slow.example/feed", settleMs: 0, closeAfter: true, waitForText: "target phrase" },
  });
  assert.match(textOf(res), /The Target Phrase is here/);
  assert.ok(count("get-tab-content") >= 3, "did not stop at the stable chrome");

  state.pages["https://slow.example/empty"] = { text: chrome };
  res = await leader.callTool({
    name: "open-and-read-tab",
    arguments: { url: "https://slow.example/empty", settleMs: 0, closeAfter: true, waitForText: "never there", maxSettleMs: 1200 },
  });
  assert.match(textOf(res), /"never there" did not appear within maxSettleMs=1200 ms/);
});

test("maxChars beyond one extension chunk fetches the following chunks", async () => {
  state.pageCap = 100;
  try {
    let res = await leader.callTool({ name: "read-tab", arguments: { tabId: 1, maxChars: 5000 } });
    let text = textOf(res);
    assert.match(text, new RegExp(`characters 0-${longText.length} of ${longText.length}`));
    assert.doesNotMatch(text, /offset=/, "whole page in one call");
    assert.equal((text.match(/Pocket FM grew a lot\./g) ?? []).length, 30);

    // The default cap is far above this small page, so it arrives whole as well.
    res = await leader.callTool({ name: "read-tab", arguments: { tabId: 1 } });
    assert.doesNotMatch(textOf(res), /offset=/);

    res = await leader.callTool({ name: "read-tab", arguments: { tabId: 1, maxChars: 50 } });
    assert.match(textOf(res), /Output was cut at maxChars=50\. Call read-tab with tabId=1 and offset=\d+/);
  } finally {
    state.pageCap = 50_000;
  }
});

test("without maxChars a reply stays at 40000 characters and names the offset", async () => {
  state.tabs.push({ id: 8, url: "https://long.example/book", title: "Long book", lastAccessed: 5, status: "complete", text: "word ".repeat(12_000) });
  const res = await leader.callTool({ name: "read-tab", arguments: { tabId: 8 } });
  const text = textOf(res);
  // The cut lands on a space, so reading on starts right after the last word.
  assert.match(text, /characters 0-39999 of 60000/);
  assert.match(text, /Output was cut at maxChars=40000\. Call read-tab with tabId=8 and offset=39999/);
  assert.equal(res.content[res.content.length - 1].text.length, 40_000);
});

test("a second session forwards through the broker", async () => {
  const forwarder = await startClient(port, home);
  try {
    await new Promise((r) => setTimeout(r, 500));
    const res = await forwarder.callTool({ name: "read-tab", arguments: { match: "karakeep" } });
    assert.match(textOf(res), /Bookmarks list/);
  } finally {
    await forwarder.close();
  }
});
