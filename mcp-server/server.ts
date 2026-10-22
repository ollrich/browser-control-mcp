import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BrowserAPI } from "./browser-api";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import type { BrowserTab, TabContentExtensionMessage } from "@browser-control-mcp/common";
import fs from "fs";
import path from "path";
import {
  compactText,
  formatTabLine,
  isConsentTabFor,
  matchTabs,
  normalizeOpenUrl,
  pickActiveTab,
  slimContent,
} from "./content-utils";

dayjs.extend(relativeTime);

function readPackageVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const mcpServer = new McpServer({
  name: "BrowserControl",
  version: readPackageVersion(),
});

// MCP tool annotations, so clients can tell reading tools from ones that change
// the browser. openWorldHint marks tools that load or read web content.
const READS_BROWSER = { readOnlyHint: true, openWorldHint: false };
const READS_WEB = { readOnlyHint: true, openWorldHint: true };
const OPENS_PAGES = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
const CHANGES_TABS = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

mcpServer.tool(
  "open-browser-tab",
  "Open a new tab in the user's browser (useful when the user asks to open a website)",
  { url: z.string() },
  OPENS_PAGES,
  async ({ url: input }) => {
    const { url, note } = normalizeOpenUrl(input);
    const openedTabId = await browserApi.openTab(url);
    if (openedTabId !== undefined) {
      return {
        content: [
          {
            type: "text",
            text: `${url} opened in tab id ${openedTabId}${note ? `. ${note}` : ""}`,
          },
        ],
      };
    } else {
      return {
        content: [{ type: "text", text: "Failed to open tab" }],
        isError: true,
      };
    }
  }
);

mcpServer.tool(
  "close-browser-tabs",
  "Close tabs in the user's browser by tab IDs",
  { tabIds: z.array(z.number()) },
  { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  async ({ tabIds }) => {
    await browserApi.closeTabs(tabIds);
    return {
      content: [{ type: "text", text: "Closed tabs" }],
    };
  }
);

mcpServer.tool(
  "get-list-of-open-tabs",
  "Get the list of open tabs in the user's browser. Use offset and limit parameters for pagination when there are many tabs.",
  {
    offset: z.number().int().min(0).default(0).describe("Starting index for pagination (0-based, must be >= 0)"),
    limit: z.number().default(100).describe("Maximum number of tabs to return (default: 100, max: 500)"),
  },
  READS_BROWSER,
  async ({ offset, limit }) => {
    // Validate and cap the limit
    const effectiveLimit = Math.min(Math.max(1, limit), 500);

    const openTabs = await browserApi.getTabList();
    const totalTabs = openTabs.length;

    // Apply pagination
    const paginatedTabs = openTabs.slice(offset, offset + effectiveLimit);
    const hasMore = offset + effectiveLimit < totalTabs;

    // Add pagination info as the first content item
    const paginationInfo = {
      type: "text" as const,
      text: `Showing tabs ${offset + 1}-${offset + paginatedTabs.length} of ${totalTabs} total tabs${hasMore ? ` (use offset=${offset + effectiveLimit} to see more)` : ''}`,
    };

    const tabContent = paginatedTabs.map((tab) => {
      let lastAccessed = "unknown";
      if (tab.lastAccessed) {
        lastAccessed = dayjs(tab.lastAccessed).fromNow(); // LLM-friendly time ago
      }
      return {
        type: "text" as const,
        text: `tab id=${tab.id}, tab url=${tab.url}, tab title=${tab.title}, last accessed=${lastAccessed}`,
      };
    });

    return {
      content: [paginationInfo, ...tabContent],
    };
  }
);

mcpServer.tool(
  "get-current-tab",
  "Get information about the currently active tab in the browser",
  {},
  READS_BROWSER,
  async () => {
    const currentTab = await browserApi.getCurrentTab();
    return {
      content: [
        {
          type: "text",
          text: `Current tab: id=${currentTab.id}, url=${currentTab.url}, title=${currentTab.title}`,
        },
      ],
    };
  }
);

mcpServer.tool(
  "get-tab-metadata",
  "Get comprehensive metadata about a specific tab, including state, position, window, audio, dimensions, favicon, and last access properties when available.",
  { tabId: z.number() },
  READS_BROWSER,
  async ({ tabId }) => {
    const metadata = await browserApi.getTabMetadata(tabId);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(metadata, null, 2),
        },
      ],
    };
  }
);

mcpServer.tool(
  "get-recent-browser-history",
  "Get the list of recent browser history (to get all, don't use searchQuery)",
  { searchQuery: z.string().optional() },
  READS_BROWSER,
  async ({ searchQuery }) => {
    const browserHistory = await browserApi.getBrowserRecentHistory(
      searchQuery
    );
    if (browserHistory.length > 0) {
      return {
        content: browserHistory.map((item) => {
          let lastVisited = "unknown";
          if (item.lastVisitTime) {
            lastVisited = dayjs(item.lastVisitTime).fromNow(); // LLM-friendly time ago
          }
          return {
            type: "text",
            text: `url=${item.url}, title="${item.title}", lastVisitTime=${lastVisited}`,
          };
        }),
      };
    } else {
      // If nothing was found for the search query, hint the AI to list
      // all the recent history items instead.
      const hint = searchQuery ? "Try without a searchQuery" : "";
      return { content: [{ type: "text", text: `No history found. ${hint}` }] };
    }
  }
);

mcpServer.tool(
  "get-tab-web-content",
  `
    Get the full text content of the webpage and the list of links in the webpage, by tab ID. 
    Use "offset" only for larger documents when the first call was truncated and if you require more content in order to assist the user.
  `,
  {
    tabId: z.number(),
    offset: z.number().default(0),
    includeLinks: z.boolean().default(true).describe("Set false to skip the link list"),
  },
  READS_WEB,
  async ({ tabId, offset, includeLinks }) => {
    const content = await browserApi.getTabContent(tabId, offset);
    let links: { type: "text"; text: string }[] = [];
    if (offset === 0 && includeLinks) {
      // Only include the links if offset is 0 (default value). Otherwise, we can
      // assume this is not the first call. Adding the links again would be redundant.
      links = content.links.map((link: { text: string; url: string }) => {
        return {
          type: "text",

          text: `Link text: ${link.text}, Link URL: ${link.url}`,
        };
      });
    }

    let text = content.fullText;
    let hint: { type: "text"; text: string }[] = [];
    if (content.isTruncated || offset > 0) {
      // If the content is truncated, add a "tip" suggesting
      // that another tool, search in page, can be used to
      // discover additional data.
      const rangeString = `${offset}-${offset + text.length}`;
      hint = [
        {
          type: "text",
          text:
            `The following text content is truncated due to size (includes character range ${rangeString} out of ${content.totalLength}). ` +
            "If you want to read characters beyond this range, please use the 'get-tab-web-content' tool with an offset. ",
        },
      ];
    }

    return {
      content: [...hint, { type: "text", text }, ...links],
    };
  }
);

mcpServer.tool(
  "reorder-browser-tabs",
  "Change the order of open browser tabs",
  { tabOrder: z.array(z.number()) },
  { ...CHANGES_TABS, idempotentHint: true },
  async ({ tabOrder }) => {
    const newOrder = await browserApi.reorderTabs(tabOrder);
    return {
      content: [
        { type: "text", text: `Tabs reordered: ${newOrder.join(", ")}` },
      ],
    };
  }
);

mcpServer.tool(
  "find-highlight-in-browser-tab",
  "Find and highlight text in a browser tab (use a query phrase that exists in the web content)",
  { tabId: z.number(), queryPhrase: z.string() },
  CHANGES_TABS,
  async ({ tabId, queryPhrase }) => {
    const noOfResults = await browserApi.findHighlight(tabId, queryPhrase);
    return {
      content: [
        {
          type: "text",
          text: `Number of results found and highlighted in the tab: ${noOfResults}`,
        },
      ],
    };
  }
);

mcpServer.tool(
  "group-browser-tabs",
  "Organize opened browser tabs in a new tab group",
  {
    tabIds: z.array(z.number()),
    isCollapsed: z.boolean().default(false),
    groupColor: z
      .enum([
        "grey",
        "blue",
        "red",
        "yellow",
        "green",
        "pink",
        "purple",
        "cyan",
        "orange",
      ])
      .default("grey"),
    groupTitle: z.string().default("New Group"),
  },
  CHANGES_TABS,
  async ({ tabIds, isCollapsed, groupColor, groupTitle }) => {
    const groupId = await browserApi.groupTabs(
      tabIds,
      isCollapsed,
      groupColor,
      groupTitle
    );
    return {
      content: [
        {
          type: "text",
          text: `Created tab group "${groupTitle}" with ${tabIds.length} tabs (group ID: ${groupId})`,
        },
      ],
    };
  }
);

mcpServer.tool(
  "capture-tab-screenshot",
  `
    Capture a screenshot of the visible area of a browser tab, by tab ID (default: the active tab).
    The user must authorize each tab by clicking the extension's toolbar button while that tab is open.
    If the tab is not authorized, this tool returns an error explaining what to ask the user to do; relay that
    request to the user and retry afterwards. Authorization ends when the tab navigates or closes.
    Capturing brings the tab to the foreground momentarily.
  `,
  {
    tabId: z.number().optional(),
    format: z
      .enum(["jpeg", "png"])
      .default("jpeg")
      .describe("Use png only when exact pixel fidelity matters, as it is much larger"),
    quality: z
      .number()
      .int()
      .min(10)
      .max(100)
      .default(70)
      .describe("JPEG quality, ignored for png"),
    scale: z
      .number()
      .min(0.1)
      .max(2)
      .default(1)
      .describe("Image scale relative to CSS pixels, lower values produce smaller images"),
  },
  READS_WEB,
  async ({ tabId, format, quality, scale }) => {
    const targetId = tabId ?? pickActiveTab(await browserApi.getTabList(), true)?.id;
    if (targetId === undefined) {
      return { content: [{ type: "text", text: "No open web page tab to capture." }], isError: true };
    }
    const screenshot = await browserApi.captureScreenshot(targetId, format, quality, scale);
    return {
      content: [
        {
          type: "image",
          data: screenshot.imageData,
          mimeType: screenshot.mimeType,
        },
      ],
    };
  }
);

// ---------------------------------------------------------------------------
// Workflow tools (fork additions). They only combine the original extension
// commands open-tab, get-tab-list, get-tab-content and close-tabs, so they work
// with the stock Firefox add-on from addons.mozilla.org and through broker
// forwarding.
// ---------------------------------------------------------------------------

type TextContent = { type: "text"; text: string };

const DEFAULT_SETTLE_MS = 1000;
const DEFAULT_MAX_SETTLE_MS = 8000;
const DEFAULT_LOAD_TIMEOUT_MS = 20_000;
const DEFAULT_CONSENT_WAIT_MS = 30_000;
// Below this many characters a page probably is an unrendered script shell.
const MIN_RENDERED_CHARS = 300;
const CONSENT_POLL_MS = 1500;
// Never seeing the consent tab means the extension works differently; stop waiting.
const CONSENT_TAB_GRACE_MS = 4000;
const CONSENT_ERROR = /not yet granted permission to access the domain/i;
// The extension returns one chunk of about 50k raw characters per call; with a
// larger maxChars further chunks are fetched, up to this many.
const MAX_CHUNKS_PER_READ = 10;
// MCP clients offload or cut tool replies from about 50 KB on (Claude Code
// saves them to a file), so a reply stays below that unless asked otherwise.
const DEFAULT_MAX_CHARS = 40_000;

const slimParams = {
  includeLinks: z
    .boolean()
    .default(false)
    .describe("Include the page's links (deduplicated). Off by default to save context."),
  maxLinks: z.number().int().min(0).max(500).default(40),
  maxChars: z
    .number()
    .int()
    .min(1)
    .max(MAX_CHUNKS_PER_READ * 50_000)
    .default(DEFAULT_MAX_CHARS)
    .describe(
      `Cap on returned characters (default ${DEFAULT_MAX_CHARS}; MCP clients offload or cut much larger replies). The reply names the offset to continue from. Values above one extension chunk (about 50k raw characters) fetch the following chunks.`
    ),
  consentWaitMs: z
    .number()
    .int()
    .min(0)
    .max(120_000)
    .default(DEFAULT_CONSENT_WAIT_MS)
    .describe("How long to wait for the user to grant access when a domain is read for the first time (0 = fail right away)"),
};

interface SlimReadOptions {
  includeLinks: boolean;
  maxLinks: number;
  maxChars: number;
  consentWaitMs: number;
}

interface OpenReadOptions extends SlimReadOptions {
  offset: number;
  settleMs: number;
  maxSettleMs: number;
  timeoutMs: number;
  closeAfter: boolean;
  waitForText?: string;
}

// The page still waits for the user's domain consent; the tab is worth keeping.
class ConsentPendingError extends Error {}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function waitForTabComplete(
  tabId: number,
  timeoutMs: number
): Promise<{ loaded: boolean; tab: BrowserTab }> {
  const deadline = Date.now() + timeoutMs;
  let delay = 250;
  for (;;) {
    const tab = (await browserApi.getTabList()).find((t) => t.id === tabId);
    if (!tab) {
      throw new Error(`Tab ${tabId} disappeared while loading`);
    }
    // Right after tabs.create Firefox can report about:blank as complete before the
    // navigation starts. Older extension builds may omit status; treat that as ready.
    if (tab.url !== "about:blank" && (tab.status === undefined || tab.status === "complete")) {
      return { loaded: true, tab };
    }
    if (Date.now() + delay > deadline) {
      return { loaded: false, tab };
    }
    await sleep(delay);
    // Back off: every poll is a full tab list and an audit log entry in the extension.
    delay = Math.min(Math.round(delay * 1.5), 1000);
  }
}

// The extension answers the first read of a domain with an error and opens its
// consent page in a new tab, which closes itself once the user grants access.
async function waitForConsent(pageUrl: string | undefined, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  let seenConsentTab = false;
  // Look right away: the consent tab exists before the error arrives, and a quick
  // click could close it before a delayed first look.
  for (;;) {
    const pending = (await browserApi.getTabList()).some((t) => isConsentTabFor(t, pageUrl));
    const elapsed = Date.now() - start;
    if (pending) {
      seenConsentTab = true;
    } else if (seenConsentTab) {
      return true;
    } else if (elapsed > CONSENT_TAB_GRACE_MS) {
      return false;
    }
    if (elapsed + CONSENT_POLL_MS > timeoutMs) {
      return false;
    }
    await sleep(CONSENT_POLL_MS);
  }
}

async function fetchTabContent(
  tab: BrowserTab,
  offset: number,
  consentWaitMs: number
): Promise<TabContentExtensionMessage> {
  const tabId = tab.id as number;
  const pendingConsent = (error: unknown) =>
    new ConsentPendingError(
      `${errorText(error)} Once the user has granted access, call read-tab with tabId=${tabId}.`
    );

  try {
    return await browserApi.getTabContent(tabId, offset);
  } catch (error) {
    if (!CONSENT_ERROR.test(errorText(error))) {
      throw error;
    }
    // Every failed read opens another consent tab, so only retry after the
    // consent tab has closed.
    if (consentWaitMs <= 0 || !(await waitForConsent(tab.url, consentWaitMs))) {
      throw pendingConsent(error);
    }
    try {
      return await browserApi.getTabContent(tabId, offset);
    } catch (retryError) {
      throw CONSENT_ERROR.test(errorText(retryError)) ? pendingConsent(retryError) : retryError;
    }
  }
}

function lengthsSettled(previous: number, current: number): boolean {
  return Math.abs(previous - current) <= Math.floor(Math.max(previous, current) * 0.005);
}

function normalizeForSearch(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

// Script heavy pages (X, Bluesky, SPAs) keep rendering after "complete". Read
// until the text length stops changing (two matching reads, three while the page
// still looks like an empty shell), or with waitForText until that text shows
// up, at most until maxSettleMs runs out.
async function readWhenStable(
  tab: BrowserTab,
  offset: number,
  maxSettleMs: number,
  consentWaitMs: number,
  waitForText?: string
): Promise<{ content: TabContentExtensionMessage; textFound?: boolean }> {
  const needle = waitForText ? normalizeForSearch(waitForText) : "";
  const containsNeedle = (c: TabContentExtensionMessage) =>
    normalizeForSearch(c.fullText).includes(needle);

  let content = await fetchTabContent(tab, offset, consentWaitMs);
  let length = compactText(content.fullText).length;
  let matchingReads = 1;
  let delay = 600;
  const deadline = Date.now() + maxSettleMs;
  const settled = () =>
    needle
      ? containsNeedle(content)
      : matchingReads >= (length >= MIN_RENDERED_CHARS ? 2 : 3);
  while (!settled() && Date.now() + delay <= deadline) {
    await sleep(delay);
    delay = Math.min(Math.round(delay * 1.5), needle ? 1000 : 2000);
    const next = await fetchTabContent(tab, offset, 0);
    const nextLength = compactText(next.fullText).length;
    matchingReads = lengthsSettled(length, nextLength) ? matchingReads + 1 : 1;
    content = next;
    length = nextLength;
  }
  return { content, textFound: needle ? containsNeedle(content) : undefined };
}

// The extension returns one chunk per call. With maxChars beyond that, append
// the following chunks until the cap is reached or the page ends.
async function extendToMaxChars(
  tab: BrowserTab,
  offset: number,
  content: TabContentExtensionMessage,
  maxChars: number
): Promise<TabContentExtensionMessage> {
  let chunks = 1;
  while (
    maxChars > 0 &&
    content.isTruncated &&
    chunks < MAX_CHUNKS_PER_READ &&
    compactText(content.fullText).length < maxChars
  ) {
    const next = await fetchTabContent(tab, offset + content.fullText.length, 0);
    if (!next.fullText) break;
    content = {
      ...content,
      fullText: content.fullText + next.fullText,
      isTruncated: next.isTruncated,
      totalLength: next.totalLength,
    };
    chunks++;
  }
  return content;
}

function formatTabContent(
  tab: BrowserTab,
  offset: number,
  content: TabContentExtensionMessage,
  opts: SlimReadOptions,
  tabWillClose = false
): TextContent[] {
  const tabId = tab.id as number;
  const slim = slimContent(content.fullText, content.links, {
    ...opts,
    pageUrl: tab.url,
  });
  // Offsets count raw page characters, so continue after the raw text shown.
  const end = offset + slim.rawConsumed;

  const header: TextContent = {
    type: "text",
    text: `${formatTabLine(tab)}, characters ${offset}-${end} of ${content.totalLength}`,
  };
  const notes: string[] = [];
  if (slim.cutByMaxChars || content.isTruncated) {
    const reason = slim.cutByMaxChars
      ? `Output was cut at maxChars=${opts.maxChars}.`
      : "Page text is truncated.";
    notes.push(
      tabWillClose
        ? `${reason} The tab was closed again; to read on, call open-and-read-tab with closeAfter=false, then read-tab with its tabId and offset=${end}.`
        : `${reason} Call read-tab with tabId=${tabId} and offset=${end} for more.`
    );
  }
  if (opts.includeLinks && slim.droppedLinks > 0) {
    notes.push(`${slim.droppedLinks} duplicate or surplus links omitted.`);
  }

  const result: TextContent[] = [header];
  if (notes.length) result.push({ type: "text", text: notes.join(" ") });
  result.push({ type: "text", text: slim.text });
  if (slim.links.length) {
    result.push({
      type: "text",
      text: "Links:\n" + slim.links.map((l) => `- ${l.text} <${l.url}>`).join("\n"),
    });
  }
  return result;
}

async function openAndRead(
  input: string,
  opts: OpenReadOptions
): Promise<{ content: TextContent[]; isError?: boolean }> {
  const { url, note } = normalizeOpenUrl(input);
  const tabId = await browserApi.openTab(url);
  if (tabId === undefined) {
    return { content: [{ type: "text", text: "Failed to open tab" }], isError: true };
  }

  let keepOpen = !opts.closeAfter;
  try {
    const { loaded, tab: loadedTab } = await waitForTabComplete(tabId, opts.timeoutMs);
    if (opts.settleMs > 0) await sleep(opts.settleMs);

    let read: { content: TabContentExtensionMessage; textFound?: boolean };
    try {
      read = await readWhenStable(
        loadedTab,
        opts.offset,
        opts.maxSettleMs,
        opts.consentWaitMs,
        opts.waitForText
      );
    } catch (error) {
      // Keep the tab, so read-tab can pick it up once the user has granted access.
      if (error instanceof ConsentPendingError) keepOpen = true;
      throw error;
    }
    const content = await extendToMaxChars(loadedTab, opts.offset, read.content, opts.maxChars);

    // Title and final URL (after redirects) are often only known after rendering.
    const tab = (await browserApi.getTabList()).find((t) => t.id === tabId) ?? loadedTab;
    const result = formatTabContent(tab, opts.offset, content, opts, !keepOpen);
    const notes = [
      note,
      loaded ? undefined : `Page had not finished loading after ${opts.timeoutMs} ms; content may be incomplete.`,
      read.textFound === false
        ? `"${opts.waitForText}" did not appear within maxSettleMs=${opts.maxSettleMs} ms; returning what the page shows.`
        : undefined,
      keepOpen ? `Tab stays open as tab id ${tabId}.` : undefined,
    ].filter(Boolean);
    if (notes.length) {
      result.splice(1, 0, { type: "text", text: notes.join(" ") });
    }
    return { content: result };
  } finally {
    if (!keepOpen) {
      await browserApi.closeTabs([tabId]).catch(() => undefined);
    }
  }
}

mcpServer.tool(
  "read-tab",
  `Read the text of an open tab in one step, found by URL or title fragment (or by tabId).
   Without match and tabId it reads the active tab. Prefer this over
   get-list-of-open-tabs followed by get-tab-web-content. Long pages come in parts of
   up to maxChars characters; continue with the offset named in the reply.`,
  {
    match: z
      .string()
      .optional()
      .describe("Case insensitive fragment(s) of the tab URL or title, e.g. 'x.com/rohan' or 'Karakeep'. Several words must all match."),
    tabId: z.number().optional(),
    offset: z.number().int().min(0).default(0),
    ...slimParams,
  },
  READS_WEB,
  async ({ match, tabId, offset, ...opts }) => {
    const tabs = await browserApi.getTabList();
    let tab: BrowserTab | undefined;
    let others: BrowserTab[] = [];

    if (tabId !== undefined) {
      tab = tabs.find((t) => t.id === tabId);
    } else if (match) {
      ({ best: tab, others } = matchTabs(tabs, match));
    } else {
      tab = pickActiveTab(tabs, true);
    }

    if (!tab) {
      const wanted = tabId !== undefined ? `id ${tabId}` : match ? `"${match}"` : "a web page";
      return {
        content: [
          {
            type: "text",
            text: `No open tab matches ${wanted}. Use open-and-read-tab to open the URL.`,
          },
        ],
        isError: true,
      };
    }

    let result: TextContent[];
    if (tab.discarded && tab.url) {
      // Scripts cannot run in an unloaded tab. Read a fresh copy in a temporary
      // tab instead of waking the original.
      const fresh = await openAndRead(tab.url, {
        ...opts,
        offset,
        settleMs: DEFAULT_SETTLE_MS,
        maxSettleMs: DEFAULT_MAX_SETTLE_MS,
        timeoutMs: DEFAULT_LOAD_TIMEOUT_MS,
        closeAfter: true,
      });
      if (fresh.isError) return fresh;
      result = fresh.content;
      result.splice(1, 0, {
        type: "text",
        text: `Tab ${tab.id} is unloaded (discarded), so a fresh copy was read in a temporary tab.`,
      });
    } else {
      const first = await fetchTabContent(tab, offset, opts.consentWaitMs);
      const content = await extendToMaxChars(tab, offset, first, opts.maxChars);
      result = formatTabContent(tab, offset, content, opts);
    }

    if (others.length) {
      result.splice(1, 0, {
        type: "text",
        text:
          `${others.length} other matching tab(s), picked the best match. Others:\n` +
          others.slice(0, 10).map(formatTabLine).join("\n"),
      });
    }
    return { content: result };
  }
);

mcpServer.tool(
  "open-and-read-tab",
  `Open an https URL in a new tab, wait until it has loaded and rendered, and return its text
   in one call. Use for live pages where a plain web fetch returns stale or empty content.
   Long pages come in parts of up to maxChars characters; keep the tab open (closeAfter=false)
   to read on with read-tab and the offset named in the reply.`,
  {
    url: z.string().describe("https URL; bare domains get https:// and http:// is upgraded"),
    settleMs: z
      .number()
      .int()
      .min(0)
      .max(15_000)
      .default(DEFAULT_SETTLE_MS)
      .describe("Wait after load before the first read"),
    maxSettleMs: z
      .number()
      .int()
      .min(0)
      .max(30_000)
      .default(DEFAULT_MAX_SETTLE_MS)
      .describe("Upper bound for re-reading until the text stops changing (script rendered pages)"),
    timeoutMs: z.number().int().min(1000).max(60_000).default(DEFAULT_LOAD_TIMEOUT_MS),
    closeAfter: z.boolean().default(false).describe("Close the tab again after reading"),
    waitForText: z
      .string()
      .optional()
      .describe("Read as soon as this text appears on the page (case insensitive) instead of waiting for the text to stop changing. Bounded by maxSettleMs."),
    ...slimParams,
  },
  OPENS_PAGES,
  async ({ url, ...opts }) => openAndRead(url, { ...opts, offset: 0 })
);

const browserApi = new BrowserAPI();
browserApi.init().catch((err) => {
  console.error("Browser API init error", err);
  process.exit(1);
});

const transport = new StdioServerTransport();
mcpServer.connect(transport).catch((err) => {
  console.error("MCP Server connection error", err);
  process.exit(1);
});

process.stdin.on("close", async () => {
  await browserApi.close();
  mcpServer.close();
  process.exit(0);
});
