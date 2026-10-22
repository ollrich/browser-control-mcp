import { collectPageMeta, collectSelection } from "../page-scripts";

// The extension injects these functions as source text, so run them that way too.
function runInjected<T>(fn: () => T): T {
  return new Function(`return (${fn.toString()})()`)() as T;
}

describe("page scripts", () => {
  beforeEach(() => {
    document.head.innerHTML = "";
    document.body.innerHTML = "";
  });

  it("collects meta tags, JSON-LD and headings from injected source", () => {
    document.documentElement.lang = "de";
    document.head.innerHTML = `
      <meta name="description" content=" A description ">
      <meta name="robots" content="noindex">
      <link rel="canonical" href="https://example.com/page">
      <link rel="alternate" hreflang="en" href="https://example.com/en/page">
      <meta property="og:title" content="OG title">
      <meta property="og:title" content="Second og title is ignored">
      <meta name="twitter:card" content="summary">
      <script type="application/ld+json">{"@type": "Article", "headline": "Hi"}</script>
      <script type="application/ld+json">{ broken</script>`;
    document.body.innerHTML = "<h1>Main  title</h1><h2>Part</h2><h3></h3><h4>Too deep</h4>";
    document.title = "Example page";

    const meta = runInjected(collectPageMeta);

    expect(meta).toEqual({
      title: "Example page",
      lang: "de",
      description: "A description",
      canonical: "https://example.com/page",
      robots: "noindex",
      openGraph: { title: "OG title" },
      twitter: { card: "summary" },
      alternates: [{ hreflang: "en", href: "https://example.com/en/page" }],
      jsonLd: [{ "@type": "Article", headline: "Hi" }, { unparsable: "{ broken" }],
      headings: [
        { level: 1, text: "Main title" },
        { level: 2, text: "Part" },
      ],
    });
  });

  it("reads the page selection, then a selection inside a text field, never a password", () => {
    document.body.innerHTML = `<p id="p">Hello selected world</p><textarea id="t">field text</textarea><input id="pw" type="password" value="secret">`;

    const range = document.createRange();
    range.selectNodeContents(document.getElementById("p") as HTMLElement);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    expect(runInjected(collectSelection)).toBe("Hello selected world");

    window.getSelection()?.removeAllRanges();
    const textarea = document.getElementById("t") as HTMLTextAreaElement;
    textarea.focus();
    textarea.setSelectionRange(0, 5);
    expect(runInjected(collectSelection)).toBe("field");

    const password = document.getElementById("pw") as HTMLInputElement;
    password.focus();
    password.setSelectionRange(0, 6);
    expect(runInjected(collectSelection)).toBe("");
  });
});
