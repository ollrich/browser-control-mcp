import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BrowserAPI } from "./browser-api";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import type { BrowserTab } from "@browser-control-mcp/common";
import { compactText, formatTabLine, matchTabs, slimContent } from "./content-utils";

dayjs.extend(relativeTime);

const mcpServer = new McpServer({
  name: "BrowserControl",
  version: "1.6.1-ollie.1",
});

mcpServer.tool(
  "open-browser-tab",
  "Open a new tab in the user's browser (useful when the user asks to open a website)",
  { url: z.string() },
  async ({ url }) => {
    const openedTabId = await browserApi.openTab(url);
    if (openedTabId !== undefined) {
      return {
        content: [
          {
            type: "text",
            text: `${url} opened in tab id ${openedTabId}`,
          },
        ],
      };
    } else {
      return {
        content: [{ type: "text", text: "Failed to open tab", isError: true }],
      };
    }
  }
);

mcpServer.tool(
  "close-browser-tabs",
  "Close tabs in the user's browser by tab IDs",
  { tabIds: z.array(z.number()) },
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

// ---------------------------------------------------------------------------
// Workflow tools (fork additions). They only combine the original extension
// commands open-tab, get-tab-list and get-tab-content, so they work with the
// stock Firefox add-on from addons.mozilla.org and through broker forwarding.
// ---------------------------------------------------------------------------

type TextContent = { type: "text"; text: string };

const slimParams = {
  includeLinks: z
    .boolean()
    .default(false)
    .describe("Include the page's links (deduplicated). Off by default to save context."),
  maxLinks: z.number().int().min(0).max(500).default(40),
  maxChars: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe("Optional extra cap on returned characters (0 = only the extension's 50k page cap)."),
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForTabComplete(tabId: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tabs = await browserApi.getTabList();
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab) {
      throw new Error(`Tab ${tabId} disappeared while loading`);
    }
    // Older extension builds may omit status; treat that as ready.
    if (tab.status === undefined || tab.status === "complete") {
      return true;
    }
    await sleep(300);
  }
  return false;
}

async function readTabSlim(
  tab: BrowserTab,
  offset: number,
  opts: { includeLinks: boolean; maxLinks: number; maxChars: number },
  retryShortAfterMs = 0
): Promise<TextContent[]> {
  const tabId = tab.id as number;
  let content = await browserApi.getTabContent(tabId, offset);

  // Script heavy pages (X, Bluesky, SPAs) often render after "complete".
  if (retryShortAfterMs > 0 && compactText(content.fullText).length < 300) {
    await sleep(retryShortAfterMs);
    content = await browserApi.getTabContent(tabId, offset);
  }

  const slim = slimContent(content.fullText, content.links, {
    ...opts,
    pageUrl: tab.url,
  });

  const header: TextContent = {
    type: "text",
    text: `${formatTabLine(tab)}, characters ${offset}-${offset + content.fullText.length} of ${content.totalLength}`,
  };
  const notes: string[] = [];
  if (content.isTruncated) {
    notes.push(
      `Page text is truncated. Call read-tab with tabId=${tabId} and offset=${offset + content.fullText.length} for more.`
    );
  }
  if (slim.cutByMaxChars) {
    notes.push(`Output was cut at maxChars=${opts.maxChars}.`);
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

mcpServer.tool(
  "read-tab",
  `Read the text of an open tab in one step, found by URL or title fragment (or by tabId).
   Without match and tabId it reads the most recently used tab. Prefer this over
   get-list-of-open-tabs followed by get-tab-web-content.`,
  {
    match: z
      .string()
      .optional()
      .describe("Case insensitive fragment of the tab URL or title, e.g. 'x.com/rohan' or 'Karakeep'"),
    tabId: z.number().optional(),
    offset: z.number().int().min(0).default(0),
    ...slimParams,
  },
  async ({ match, tabId, offset, includeLinks, maxLinks, maxChars }) => {
    const tabs = await browserApi.getTabList();
    let tab: BrowserTab | undefined;
    let others: BrowserTab[] = [];

    if (tabId !== undefined) {
      tab = tabs.find((t) => t.id === tabId);
    } else if (match) {
      ({ best: tab, others } = matchTabs(tabs, match));
    } else {
      tab = [...tabs]
        .filter((t) => t.id !== undefined)
        .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
    }

    if (!tab) {
      return {
        content: [
          {
            type: "text",
            text: `No open tab matches ${tabId !== undefined ? `id ${tabId}` : `"${match}"`}. Use open-and-read-tab to open the URL.`,
          },
        ],
        isError: true,
      };
    }

    const result = await readTabSlim(tab, offset, { includeLinks, maxLinks, maxChars });
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
   in one call. Use for live pages where a plain web fetch returns stale or empty content.`,
  {
    url: z.string(),
    settleMs: z
      .number()
      .int()
      .min(0)
      .max(15_000)
      .default(1500)
      .describe("Extra wait after load for script rendered content"),
    timeoutMs: z.number().int().min(1000).max(60_000).default(20_000),
    closeAfter: z.boolean().default(false).describe("Close the tab again after reading"),
    ...slimParams,
  },
  async ({ url, settleMs, timeoutMs, closeAfter, includeLinks, maxLinks, maxChars }) => {
    const tabId = await browserApi.openTab(url);
    if (tabId === undefined) {
      return { content: [{ type: "text", text: "Failed to open tab" }], isError: true };
    }

    try {
      const loaded = await waitForTabComplete(tabId, timeoutMs);
      if (settleMs > 0) await sleep(settleMs);

      const tabs = await browserApi.getTabList();
      const tab = tabs.find((t) => t.id === tabId) ?? { id: tabId, url };
      const result = await readTabSlim(
        tab,
        0,
        { includeLinks, maxLinks, maxChars },
        Math.max(settleMs, 1000)
      );
      if (!loaded) {
        result.splice(1, 0, {
          type: "text",
          text: `Page had not finished loading after ${timeoutMs} ms; content may be incomplete.`,
        });
      }
      if (!closeAfter) {
        result.splice(1, 0, { type: "text", text: `Tab stays open as tab id ${tabId}.` });
      }
      return { content: result };
    } finally {
      if (closeAfter) {
        await browserApi.closeTabs([tabId]).catch(() => undefined);
      }
    }
  }
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
