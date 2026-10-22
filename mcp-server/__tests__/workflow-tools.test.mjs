// End to end: real MCP server processes over stdio, a fake Firefox extension
// that only speaks the original (AMO 1.5.0) commands, plus a second server
// process acting as broker forwarder.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverJs = path.join(here, "..", "dist", "server.js");
const SECRET = "test-secret-" + crypto.randomBytes(4).toString("hex");

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

function startFakeExtension(port, state) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  ws.on("message", (raw) => {
    const { payload } = JSON.parse(raw.toString());
    state.commands.push(payload.cmd);
    const reply = (body) => {
      const p = { ...body, correlationId: payload.correlationId };
      ws.send(JSON.stringify({ payload: p, signature: sign(p) }));
    };
    switch (payload.cmd) {
      case "get-tab-list":
        for (const t of state.tabs) {
          if (t.status === "loading" && --t.loadingPolls <= 0) t.status = "complete";
        }
        reply({ resource: "tabs", tabs: state.tabs.map(({ loadingPolls, reads, ...t }) => t) });
        break;
      case "open-tab": {
        const id = state.nextId++;
        state.tabs.push({ id, url: payload.url, title: "Opened", lastAccessed: Date.now(), status: "loading", loadingPolls: 3, reads: 0 });
        reply({ resource: "opened-tab-id", tabId: id });
        break;
      }
      case "close-tabs":
        state.tabs = state.tabs.filter((t) => !payload.tabIds.includes(t.id));
        reply({ resource: "tabs-closed" });
        break;
      case "get-tab-content": {
        const tab = state.tabs.find((t) => t.id === payload.tabId);
        tab.reads = (tab.reads ?? 0) + 1;
        // Simulate a script rendered page: empty shell on the first read.
        const fullText = tab.spa && tab.reads === 1 ? "Loading..." : tab.text;
        reply({
          resource: "tab-content",
          tabId: tab.id,
          fullText,
          isTruncated: false,
          totalLength: fullText.length,
          links: tab.links ?? [],
        });
        break;
      }
      default:
        // Stock add-on does not know newer commands; it stays silent.
        break;
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

test("workflow tools work against the stock extension, directly and via forwarder", async (t) => {
  const port = await freePort();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bcm-home-"));
  const longText = "Rohan Nayak post\n\n\n\n\n" + "Pocket FM grew a lot.   ".repeat(30);
  const state = {
    commands: [],
    nextId: 100,
    tabs: [
      { id: 1, url: "https://x.com/RohanNayak2/status/2098104784264065525", title: "Rohan on X", lastAccessed: 500, status: "complete", text: longText,
        links: [
          { url: "https://x.com/RohanNayak2/status/2098104784264065525", text: "self" },
          { url: "https://pocketfm.com/", text: "Pocket FM" },
          { url: "https://pocketfm.com", text: "Pocket FM dup" },
        ] },
      { id: 2, url: "https://karakeep.app/dashboard", title: "Karakeep", lastAccessed: 900, status: "complete", text: "Bookmarks list" },
    ],
  };

  const leader = await startClient(port, home);
  t.after(() => leader.close());
  await new Promise((r) => setTimeout(r, 300));
  const ext = await startFakeExtension(port, state);
  t.after(() => ext.close());

  const tools = (await leader.listTools()).tools.map((x) => x.name);
  assert.ok(tools.includes("read-tab"));
  assert.ok(tools.includes("open-and-read-tab"));

  // 1. read-tab by fragment: one call, links off, whitespace compacted.
  let res = await leader.callTool({ name: "read-tab", arguments: { match: "rohannayak2" } });
  let text = textOf(res);
  assert.match(text, /tab id=1/);
  assert.match(text, /Rohan Nayak post\n\nPocket FM/);
  assert.doesNotMatch(text, /Links:/);

  // 2. read-tab with links: deduped, self link dropped.
  res = await leader.callTool({ name: "read-tab", arguments: { match: "rohan", includeLinks: true } });
  text = textOf(res);
  assert.match(text, /Links:\n- Pocket FM <https:\/\/pocketfm.com\/>/);
  assert.doesNotMatch(text, /Pocket FM dup/);
  assert.doesNotMatch(text, /- self/);

  // 3. read-tab without arguments picks the most recently used tab.
  res = await leader.callTool({ name: "read-tab", arguments: {} });
  assert.match(textOf(res), /Bookmarks list/);

  // 4. no match gives a clear error.
  res = await leader.callTool({ name: "read-tab", arguments: { match: "does-not-exist" } });
  assert.equal(res.isError, true);

  // 5. open-and-read-tab waits for load and retries the empty SPA shell.
  state.commands.length = 0;
  const openPromise = leader.callTool({
    name: "open-and-read-tab",
    arguments: { url: "https://bsky.app/profile/test", settleMs: 200, closeAfter: true },
  });
  // Mark the new tab as a script rendered page once it exists.
  const markSpa = setInterval(() => {
    const tab = state.tabs.find((x) => x.id === 100);
    if (tab && !tab.spa) { tab.spa = true; tab.text = "Real rendered profile content"; }
  }, 5);
  res = await openPromise;
  clearInterval(markSpa);
  text = textOf(res);
  assert.match(text, /Real rendered profile content/);
  assert.doesNotMatch(text, /Loading\.\.\./);
  assert.ok(state.commands.filter((c) => c === "get-tab-list").length >= 3, "polled until complete");
  assert.equal(state.commands.filter((c) => c === "get-tab-content").length, 2, "retried once");
  assert.ok(!state.tabs.some((x) => x.id === 100), "tab closed after reading");

  // 6. Only original extension commands were used.
  assert.deepEqual([...new Set(state.commands)].sort(), ["close-tabs", "get-tab-content", "get-tab-list", "open-tab"]);

  // 7. A second session forwards through the broker and gets the same tools.
  const forwarder = await startClient(port, home);
  t.after(() => forwarder.close());
  await new Promise((r) => setTimeout(r, 500));
  res = await forwarder.callTool({ name: "read-tab", arguments: { match: "karakeep" } });
  assert.match(textOf(res), /Bookmarks list/);
});
