import type { PageMeta } from "@browser-control-mcp/common";

// Functions that run inside a page via tabs.executeScript. Only their source
// text is sent (`(${fn.toString()})()`), so each must be self contained: no
// imports, no outer variables, only types from outside.

export function collectPageMeta(): PageMeta {
  const attribute = (selector: string, name: string) =>
    document.querySelector(selector)?.getAttribute(name)?.trim() || undefined;
  const metaByPrefix = (prefix: string) => {
    const found: Record<string, string> = {};
    document.querySelectorAll(`meta[property^="${prefix}"], meta[name^="${prefix}"]`).forEach((element) => {
      const key = (element.getAttribute("property") || element.getAttribute("name") || "").slice(prefix.length);
      const value = element.getAttribute("content");
      if (key && value && !(key in found)) {
        found[key] = value.trim();
      }
    });
    return found;
  };

  const jsonLd: unknown[] = [];
  document.querySelectorAll('script[type="application/ld+json"]').forEach((element) => {
    const source = element.textContent || "";
    try {
      jsonLd.push(JSON.parse(source));
    } catch {
      jsonLd.push({ unparsable: source.slice(0, 500) });
    }
  });

  return {
    title: document.title,
    lang: document.documentElement.lang || undefined,
    description: attribute('meta[name="description"]', "content"),
    canonical: attribute('link[rel="canonical"]', "href"),
    robots: attribute('meta[name="robots"]', "content"),
    openGraph: metaByPrefix("og:"),
    twitter: metaByPrefix("twitter:"),
    alternates: Array.from(document.querySelectorAll('link[rel="alternate"][hreflang]')).map((element) => ({
      hreflang: element.getAttribute("hreflang") || "",
      href: (element as HTMLLinkElement).href,
    })),
    jsonLd,
    headings: Array.from(document.querySelectorAll("h1, h2, h3"))
      .map((element) => ({
        level: Number(element.tagName.slice(1)),
        text: (element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 200),
      }))
      .filter((heading) => heading.text)
      .slice(0, 60),
  };
}

export function collectSelection(): string {
  const selected = window.getSelection()?.toString() ?? "";
  if (selected.trim()) {
    return selected;
  }
  // Text selected inside a form field is not part of window.getSelection().
  const field = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
  if (
    field &&
    (field.tagName === "TEXTAREA" || (field.tagName === "INPUT" && field.type !== "password")) &&
    typeof field.selectionStart === "number" &&
    typeof field.selectionEnd === "number" &&
    field.selectionEnd > field.selectionStart
  ) {
    return field.value.slice(field.selectionStart, field.selectionEnd);
  }
  return "";
}
