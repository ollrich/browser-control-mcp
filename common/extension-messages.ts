export interface ExtensionMessageBase {
  resource: string;
  correlationId: string;
}

export interface TabContentExtensionMessage extends ExtensionMessageBase {
  resource: "tab-content";
  tabId: number;
  fullText: string;
  isTruncated: boolean;
  totalLength: number;
  links: { url: string; text: string }[];
  // Set by extension 2.0; absent means plain innerText.
  format?: "text" | "markdown";
}

export interface BrowserTab {
  id?: number;
  url?: string;
  title?: string;
  lastAccessed?: number;
  // Firefox sends the full tabs.Tab object; status is "loading" or "complete".
  status?: string;
  active?: boolean;
  windowId?: number;
  // Unloaded tab (lazy session restore or memory pressure); scripts cannot run in it.
  discarded?: boolean;
  hidden?: boolean;
  pinned?: boolean;
}

export interface TabsExtensionMessage extends ExtensionMessageBase {
  resource: "tabs";
  tabs: BrowserTab[];
}

export interface TabMetadataExtensionMessage extends ExtensionMessageBase {
  resource: "tab-metadata";
  metadata: Record<string, unknown>;
}

export interface OpenedTabIdExtensionMessage extends ExtensionMessageBase {
  resource: "opened-tab-id";
  tabId: number | undefined;
}

export interface BrowserHistoryItem {
  url?: string;
  title?: string;
  lastVisitTime?: number;
}

export interface BrowserHistoryExtensionMessage extends ExtensionMessageBase {
  resource: "history";

  historyItems: BrowserHistoryItem[];
}

export interface ReorderedTabsExtensionMessage extends ExtensionMessageBase {
  resource: "tabs-reordered";
  tabOrder: number[];
}

export interface FindHighlightExtensionMessage extends ExtensionMessageBase {
  resource: "find-highlight-result";
  noOfResults: number;
}

export interface TabsClosedExtensionMessage extends ExtensionMessageBase {
  resource: "tabs-closed";
}

export interface TabGroupCreatedExtensionMessage extends ExtensionMessageBase {
  resource: "new-tab-group";
  groupId: number;
}

export interface CurrentTabExtensionMessage extends ExtensionMessageBase {
  resource: "current-tab";
  tab: BrowserTab;
}

export interface ScreenshotExtensionMessage extends ExtensionMessageBase {
  resource: "screenshot";
  tabId: number;
  // Base64-encoded image, without the data-URL prefix
  imageData: string;
  mimeType: string;
}

export interface ExtensionInfoExtensionMessage extends ExtensionMessageBase {
  resource: "extension-info";
  version: string;
  commands: string[];
}

export interface PageMeta {
  title: string;
  lang?: string;
  description?: string;
  canonical?: string;
  robots?: string;
  openGraph: Record<string, string>;
  twitter: Record<string, string>;
  alternates: { hreflang: string; href: string }[];
  jsonLd: unknown[];
  headings: { level: number; text: string }[];
}

export interface PageMetaExtensionMessage extends ExtensionMessageBase {
  resource: "page-meta";
  tabId: number;
  meta: PageMeta;
}

export interface SelectionExtensionMessage extends ExtensionMessageBase {
  resource: "selection";
  tabId: number;
  text: string;
}

export interface BookmarkItem {
  title: string;
  url: string;
  // Folder path, e.g. "Bookmarks Menu / Research".
  folder: string;
  dateAdded?: number;
}

export interface BookmarksExtensionMessage extends ExtensionMessageBase {
  resource: "bookmarks";
  items: BookmarkItem[];
}

export type ExtensionMessage =
  | TabContentExtensionMessage
  | TabsExtensionMessage
  | TabMetadataExtensionMessage
  | OpenedTabIdExtensionMessage
  | BrowserHistoryExtensionMessage
  | ReorderedTabsExtensionMessage
  | FindHighlightExtensionMessage
  | TabsClosedExtensionMessage
  | TabGroupCreatedExtensionMessage
  | CurrentTabExtensionMessage
  | ScreenshotExtensionMessage
  | ExtensionInfoExtensionMessage
  | PageMetaExtensionMessage
  | SelectionExtensionMessage
  | BookmarksExtensionMessage;

export interface ExtensionError {
  correlationId: string;
  errorMessage: string;
}
