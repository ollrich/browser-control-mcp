export interface ServerMessageBase {
  cmd: string;
}

export interface OpenTabServerMessage extends ServerMessageBase {
  cmd: "open-tab";
  url: string;
  // false opens the tab in the background. Extension 2.0; older builds ignore it.
  active?: boolean;
}

export interface CloseTabsServerMessage extends ServerMessageBase {
  cmd: "close-tabs";
  tabIds: number[];
}

export interface GetTabListServerMessage extends ServerMessageBase {
  cmd: "get-tab-list";
}

export interface GetTabMetadataServerMessage extends ServerMessageBase {
  cmd: "get-tab-metadata";
  tabId: number;
}

export interface GetBrowserRecentHistoryServerMessage extends ServerMessageBase {
  cmd: "get-browser-recent-history";
  searchQuery?: string;
}

export interface GetTabContentServerMessage extends ServerMessageBase {
  cmd: "get-tab-content";
  tabId: number;
  offset?: number;
  // false skips collecting links. Extension 2.0; older builds ignore it.
  includeLinks?: boolean;
  // Extension 2.0, older builds ignore them and send plain text.
  format?: "text" | "markdown";
  mainContentOnly?: boolean;
}

export interface ReorderTabsServerMessage extends ServerMessageBase {
  cmd: "reorder-tabs";
  tabOrder: number[];
}

export interface FindHighlightServerMessage extends ServerMessageBase {
  cmd: "find-highlight";
  tabId: number;
  queryPhrase: string;
}

export interface GroupTabsServerMessage extends ServerMessageBase {
  cmd: "group-tabs";
  tabIds: number[];
  isCollapsed: boolean;
  groupColor: string;
  groupTitle: string;
}

export interface GetCurrentTabServerMessage extends ServerMessageBase {
  cmd: "get-current-tab";
}

export interface CaptureScreenshotServerMessage extends ServerMessageBase {
  cmd: "capture-screenshot";
  tabId: number;
  format?: "jpeg" | "png";
  quality?: number;
  scale?: number;
}

// Extension 2.0: version and supported commands. Older builds reject it.
export interface GetExtensionInfoServerMessage extends ServerMessageBase {
  cmd: "get-extension-info";
}

// Extension 2.0: meta tags, JSON-LD and headings of a page.
export interface GetPageMetaServerMessage extends ServerMessageBase {
  cmd: "get-page-meta";
  tabId: number;
}

// Extension 2.0: the text the user has selected in a tab.
export interface GetSelectionServerMessage extends ServerMessageBase {
  cmd: "get-selection";
  tabId: number;
}

// Extension 2.0: bookmarks matching a query (needs the optional bookmarks permission).
export interface SearchBookmarksServerMessage extends ServerMessageBase {
  cmd: "search-bookmarks";
  query: string;
  limit?: number;
}

export type ServerMessage =
  | OpenTabServerMessage
  | CloseTabsServerMessage
  | GetTabListServerMessage
  | GetTabMetadataServerMessage
  | GetBrowserRecentHistoryServerMessage
  | GetTabContentServerMessage
  | ReorderTabsServerMessage
  | FindHighlightServerMessage
  | GroupTabsServerMessage
  | GetCurrentTabServerMessage
  | CaptureScreenshotServerMessage
  | GetExtensionInfoServerMessage
  | GetPageMetaServerMessage
  | GetSelectionServerMessage
  | SearchBookmarksServerMessage;

export type ServerMessageRequest = ServerMessage & { correlationId: string };
