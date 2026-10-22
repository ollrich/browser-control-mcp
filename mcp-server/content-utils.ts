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
  // Characters of the raw input that the returned text covers. Offsets into the
  // page refer to raw innerText, so continuation offsets build on this.
  rawConsumed: number;
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

/**
 * Raw prefix length that covers the first `compactLength` characters of the
 * compacted text, ending right after its last non-whitespace character so that
 * nothing is skipped when reading on from there. Compacting a prefix yields a
 * prefix of the compacted whole (minus trailing whitespace), so the lengths grow
 * monotonically and a binary search finds the boundary.
 */
export function rawLengthForCompactPrefix(raw: string, compactLength: number): number {
  const target = compactText(raw).slice(0, compactLength).trimEnd().length;
  if (target === 0) {
    return 0;
  }
  let low = 0;
  let high = raw.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (compactText(raw.slice(0, mid)).length >= target) {
      high = mid;
    } else {
      low = mid + 1;
    }
  }
  return low;
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
  let rawConsumed = fullText.length;
  if (options.maxChars > 0 && text.length > options.maxChars) {
    text = text.slice(0, options.maxChars);
    cutByMaxChars = true;
    rawConsumed = rawLengthForCompactPrefix(fullText, options.maxChars);
  }

  if (!options.includeLinks) {
    return { text, links: [], droppedLinks: links.length, cutByMaxChars, rawConsumed };
  }

  const slimmed = slimLinks(links, options.maxLinks, options.pageUrl);
  return {
    text,
    links: slimmed.links,
    droppedLinks: slimmed.dropped,
    cutByMaxChars,
    rawConsumed,
  };
}

/** Tabs whose text the extension can read: web pages, not about:, moz-extension: or file:. */
export function isReadableTab(tab: BrowserTab): boolean {
  return tab.id !== undefined && /^https?:\/\//i.test(tab.url ?? "");
}

/**
 * The tab the user is most likely looking at: active tabs first (one per window),
 * then the most recently accessed. lastAccessed alone can point at a background
 * window or at the extension's own consent page.
 */
export function pickActiveTab(tabs: BrowserTab[], readableOnly = false): BrowserTab | undefined {
  return tabs
    .filter((tab) => tab.id !== undefined && (!readableOnly || isReadableTab(tab)))
    .sort(
      (a, b) =>
        Number(Boolean(b.active)) - Number(Boolean(a.active)) ||
        (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0)
    )[0];
}

export interface TabMatchResult {
  best?: BrowserTab;
  others: BrowserTab[];
}

function stripSchemeAndWww(value: string): string {
  return value.toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/^www\./, "");
}

function urlMatchKey(url: string): string {
  return stripSchemeAndWww(normalizeUrlForCompare(url.trim())).replace(/\/$/, "");
}

/**
 * Find readable tabs matching every whitespace separated term of the query in
 * their URL or title (case insensitive, scheme and "www." ignored). An exact URL
 * match wins; otherwise tabs matching more terms in the URL rank first, then the
 * most recently accessed.
 */
export function matchTabs(tabs: BrowserTab[], query: string): TabMatchResult {
  const terms = query
    .trim()
    .split(/\s+/)
    .map((term) => stripSchemeAndWww(term).replace(/\/+$/, ""))
    .filter(Boolean);
  if (!terms.length) {
    return { others: [] };
  }

  const scored: { tab: BrowserTab; urlHits: number }[] = [];
  for (const tab of tabs) {
    if (!isReadableTab(tab)) continue;
    const url = stripSchemeAndWww(tab.url ?? "");
    const title = (tab.title ?? "").toLowerCase();
    let urlHits = 0;
    const matchesAll = terms.every((term) => {
      if (url.includes(term)) {
        urlHits++;
        return true;
      }
      return title.includes(term);
    });
    if (matchesAll) {
      scored.push({ tab, urlHits });
    }
  }

  const exactKey = urlMatchKey(query);
  const exact = scored.find(({ tab }) => urlMatchKey(tab.url ?? "") === exactKey)?.tab;
  const sorted = scored
    .sort(
      (a, b) =>
        b.urlHits - a.urlHits || (b.tab.lastAccessed ?? 0) - (a.tab.lastAccessed ?? 0)
    )
    .map(({ tab }) => tab);
  const best = exact ?? sorted[0];
  return { best, others: sorted.filter((tab) => tab !== best) };
}

export function formatTabLine(tab: BrowserTab): string {
  return `tab id=${tab.id}, url=${tab.url}, title=${tab.title}`;
}

/**
 * Accept what people type: bare domains get https://, http:// is upgraded
 * because the extension only opens https URLs.
 */
export function normalizeOpenUrl(input: string): { url: string; note?: string } {
  const trimmed = input.trim();
  if (/^https:\/\//i.test(trimmed)) {
    return { url: trimmed };
  }
  if (/^http:\/\//i.test(trimmed)) {
    const url = `https://${trimmed.slice("http://".length)}`;
    return { url, note: `Opened ${url} instead of ${trimmed}: the extension only opens https URLs.` };
  }
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed);
  if (!hasScheme && /^[^\s/]+\.[^\s/]+/.test(trimmed)) {
    const url = `https://${trimmed}`;
    return { url, note: `Opened ${url}.` };
  }
  throw new Error(`Only https URLs can be opened, got "${input}".`);
}

/**
 * The extension's consent page for a new domain: options.html?requestUrl=<page>.
 * It closes itself once the user grants access.
 */
export function isConsentTabFor(tab: BrowserTab, pageUrl: string | undefined): boolean {
  if (!pageUrl || !tab.url?.startsWith("moz-extension://")) {
    return false;
  }
  try {
    const requested = new URL(tab.url).searchParams.get("requestUrl");
    return requested !== null && new URL(requested).origin === new URL(pageUrl).origin;
  } catch {
    return false;
  }
}
