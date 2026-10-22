import type { BrowserTab } from "@browser-control-mcp/common";

export interface PageLink {
  url: string;
  text: string;
}

export interface SlimOptions {
  includeLinks: boolean;
  maxLinks: number;
  maxChars: number;
  pageUrl?: string;
}

export interface SlimResult {
  text: string;
  links: PageLink[];
  droppedLinks: number;
  cutByMaxChars: boolean;
}

/**
 * Collapse the whitespace noise that document.body.innerText produces
 * (runs of blank lines, trailing spaces, tab soup from layout tables).
 */
export function compactText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeUrlForCompare(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return url;
  }
}

/**
 * Deduplicate links by URL, drop self links and cap the number of links.
 * Keeps the first (usually most prominent) occurrence of each URL.
 */
export function slimLinks(
  links: PageLink[],
  maxLinks: number,
  pageUrl?: string
): { links: PageLink[]; dropped: number } {
  const self = pageUrl ? normalizeUrlForCompare(pageUrl) : undefined;
  const seen = new Set<string>();
  const unique: PageLink[] = [];
  for (const link of links) {
    const key = normalizeUrlForCompare(link.url);
    if (key === self || seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push({ url: link.url, text: compactText(link.text).slice(0, 120) });
  }
  const kept = unique.slice(0, Math.max(0, maxLinks));
  return { links: kept, dropped: links.length - kept.length };
}

export function slimContent(
  fullText: string,
  links: PageLink[],
  options: SlimOptions
): SlimResult {
  let text = compactText(fullText);
  let cutByMaxChars = false;
  if (options.maxChars > 0 && text.length > options.maxChars) {
    text = text.slice(0, options.maxChars);
    cutByMaxChars = true;
  }

  if (!options.includeLinks) {
    return { text, links: [], droppedLinks: links.length, cutByMaxChars };
  }

  const slimmed = slimLinks(links, options.maxLinks, options.pageUrl);
  return {
    text,
    links: slimmed.links,
    droppedLinks: slimmed.dropped,
    cutByMaxChars,
  };
}

export interface TabMatchResult {
  best?: BrowserTab;
  others: BrowserTab[];
}

/**
 * Find tabs whose URL or title contains the query (case insensitive).
 * An exact URL match wins, otherwise the most recently accessed tab.
 */
export function matchTabs(tabs: BrowserTab[], query: string): TabMatchResult {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return { others: [] };
  }

  const candidates = tabs.filter((tab) => {
    if (tab.id === undefined) return false;
    const url = (tab.url ?? "").toLowerCase();
    const title = (tab.title ?? "").toLowerCase();
    return url.includes(needle) || title.includes(needle);
  });

  const exact = candidates.find(
    (tab) =>
      tab.url !== undefined &&
      normalizeUrlForCompare(tab.url).toLowerCase() ===
        normalizeUrlForCompare(query.trim()).toLowerCase()
  );

  const sorted = [...candidates].sort(
    (a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0)
  );
  const best = exact ?? sorted[0];
  return { best, others: sorted.filter((tab) => tab !== best) };
}

export function formatTabLine(tab: BrowserTab): string {
  return `tab id=${tab.id}, url=${tab.url}, title=${tab.title}`;
}
