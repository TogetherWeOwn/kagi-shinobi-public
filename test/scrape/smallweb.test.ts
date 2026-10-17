import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { fetchSmallWebRss, scrapeSmallWeb } from "../../src/kagi/scrape/smallweb";
import {
  KagiAuthError,
  KagiMarkupChangedError,
  KagiParseError,
  KagiUpstreamError,
} from "../../src/kagi/errors";
import { restoreFetch, stubFetch } from "../_helpers";

// String paths rather than `new URL(...)`: the global URL type here is the
// Workers one, which node's readFileSync overloads reject at typecheck.
const SEARCH_FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/search",
);

function searchFixture(name: string): string {
  return readFileSync(join(SEARCH_FIXTURE_DIR, name), "utf8");
}

const RSS_FIXTURE = `<?xml version="1.0"?>
<rss version="2.0">
<channel>
  <title>Kagi Small Web</title>
  <item>
    <title>How I stopped worrying &amp; started blogging</title>
    <link>https://alice.example/post/1</link>
    <pubDate>Fri, 20 Jun 2026 12:00:00 GMT</pubDate>
    <description>A story about writing on the small web.</description>
  </item>
  <item>
    <title><![CDATA[Something with <em>markup</em>]]></title>
    <link>https://bob.example/blog/2</link>
    <pubDate>Thu, 19 Jun 2026 08:00:00 GMT</pubDate>
    <description>Another entry.</description>
  </item>
</channel>
</rss>`;

// The live feed at https://kagi.com/api/v1/smallweb/feed/ is ATOM, not RSS.
// Shape mirrored from a real response: <entry> children, the URL in a
// self-closing <link href="">, <published>/<updated> instead of <pubDate>,
// and <summary type="html"> carrying escaped markup. The original parser only
// matched <item> and was tested only against a hand-written RSS fixture, so it
// returned zero results against production while the suite stayed green.
const ATOM_FIXTURE = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title type="text">Kagi Small Web</title>
  <id>https://kagi.com/api/v1/smallweb/feed</id>
  <updated>2026-08-08T03:00:00+00:00</updated>
  <entry xml:base="https://kagi.com/api/v1/smallweb/feed">
    <title type="text">How I stopped worrying &amp; started blogging</title>
    <id>https://alice.example/post/1</id>
    <updated>2026-08-08T03:00:00+00:00</updated>
    <published>2026-08-08T03:00:00+00:00</published>
    <link rel="self" href="https://kagi.com/feed-self" />
    <link href="https://alice.example/post/1" />
    <summary type="html">A story about &lt;em&gt;writing&lt;/em&gt; on the small web.</summary>
  </entry>
  <entry>
    <title type="text">Another entry</title>
    <published>2026-08-07T00:00:00+00:00</published>
    <link rel="alternate" href="https://bob.example/blog/2?a=1&amp;b=2" />
  </entry>
</feed>`;

afterEach(() => restoreFetch());

describe("fetchSmallWebRss (Atom — the live feed dialect)", () => {
  it("parses Atom entries with title/href link/published/summary", async () => {
    stubFetch(
      async () =>
        new Response(ATOM_FIXTURE, {
          status: 200,
          headers: { "Content-Type": "application/atom+xml" },
        }),
    );
    const feed = await fetchSmallWebRss();
    expect(feed.items).toHaveLength(2);
    expect(feed.items[0].title).toBe("How I stopped worrying & started blogging");
    expect(feed.items[0].pub_date).toBe("2026-08-08T03:00:00+00:00");
    // <summary type="html"> is escaped markup; snippets must come out as text.
    expect(feed.items[0].description).toBe("A story about writing on the small web.");
  });

  it("takes the href attribute, skipping rel=self", async () => {
    stubFetch(async () => new Response(ATOM_FIXTURE, { status: 200 }));
    const feed = await fetchSmallWebRss();
    expect(feed.items[0].link).toBe("https://alice.example/post/1");
    expect(feed.items[1].link).toBe("https://bob.example/blog/2?a=1&b=2");
  });

  it("throws rather than returning an empty list when a valid feed parses to nothing", async () => {
    // The regression that hid the original bug: a well-formed feed whose entry
    // markup the parser cannot read must fail loudly, not report success.
    stubFetch(
      async () =>
        new Response(`<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>`, {
          status: 200,
        }),
    );
    await expect(fetchSmallWebRss()).rejects.toBeInstanceOf(KagiParseError);
  });
});

describe("fetchSmallWebRss", () => {
  it("parses RSS items with title/link/pubDate/description", async () => {
    stubFetch(
      async () =>
        new Response(RSS_FIXTURE, { status: 200, headers: { "Content-Type": "application/xml" } }),
    );
    const feed = await fetchSmallWebRss();
    expect(feed.items).toHaveLength(2);
    expect(feed.items[0].title).toBe("How I stopped worrying & started blogging");
    expect(feed.items[0].link).toBe("https://alice.example/post/1");
    expect(feed.items[0].pub_date).toContain("2026");
    expect(feed.items[1].link).toBe("https://bob.example/blog/2");
  });

  it("respects the limit", async () => {
    stubFetch(
      async () =>
        new Response(RSS_FIXTURE, { status: 200, headers: { "Content-Type": "application/xml" } }),
    );
    const feed = await fetchSmallWebRss(1);
    expect(feed.items).toHaveLength(1);
  });

  it("throws KagiParseError on non-RSS response", async () => {
    stubFetch(async () => new Response("<html>not a feed</html>", { status: 200 }));
    await expect(fetchSmallWebRss()).rejects.toBeInstanceOf(KagiParseError);
  });
});

describe("scrapeSmallWeb (no q → RSS)", () => {
  it("returns SearchResponse with source_impl=scrape", async () => {
    stubFetch(async () => new Response(RSS_FIXTURE, { status: 200 }));
    const resp = await scrapeSmallWeb({}, undefined);
    expect(resp.query).toBe("");
    expect(resp.results).toHaveLength(2);
    expect(resp.results[0].source_impl).toBe("scrape");
    expect(resp.results[0].props?.source).toBe("smallweb_rss");
    expect(resp.meta.impl).toBe("scrape");
  });
});

const TOKEN = "sess-abc";

/** Two ordinary hits, in the markup kagi.com/html/search returns. */
const SEARCH_HTML = `<!doctype html><html><body>
  <div class="search-result">
    <div class="__sri-title">
      <a class="__sri_title_link" href="https://alice.example/post/1">Alice on Linux</a>
    </div>
    <div class="__sri-desc">Alice's take.</div>
  </div>
  <div class="search-result">
    <div class="__sri-title">
      <a class="__sri_title_link" href="https://bob.example/blog/2">Bob on Linux</a>
    </div>
    <div class="__sri-desc">Bob's take.</div>
  </div>
</body></html>`;

describe("scrapeSmallWeb (q → search)", () => {
  it("requires a session token when q is set", async () => {
    stubFetch(async () => new Response("", { status: 200 }));
    await expect(scrapeSmallWeb({ q: "linux" }, undefined)).rejects.toBeInstanceOf(
      KagiAuthError,
    );
  });

  it("queries /html/search with the smallweb lens and the session cookie", async () => {
    const seen: { url?: string; headers?: Record<string, string> } = {};
    stubFetch(async (input, init) => {
      seen.url = String(input);
      seen.headers = init?.headers as Record<string, string>;
      return new Response(SEARCH_HTML, { status: 200 });
    });

    await scrapeSmallWeb({ q: "linux" }, TOKEN);

    const url = new URL(seen.url as string);
    expect(url.origin + url.pathname).toBe("https://kagi.com/html/search");
    expect(url.searchParams.get("q")).toBe("linux");
    expect(url.searchParams.get("l")).toBe("smallweb");
    expect(seen.headers?.Cookie).toBe(`kagi_session=${TOKEN}`);
  });

  it("normalizes hits into ranked results tagged smallweb_search", async () => {
    stubFetch(async () => new Response(SEARCH_HTML, { status: 200 }));

    const resp = await scrapeSmallWeb({ q: "linux" }, TOKEN);

    expect(resp.query).toBe("linux");
    expect(resp.results).toHaveLength(2);
    expect(resp.results[0]).toMatchObject({
      rank: 1,
      url: "https://alice.example/post/1",
      title: "Alice on Linux",
      source_domain: "alice.example",
      source_impl: "scrape",
      props: { source: "smallweb_search" },
    });
    expect(resp.results[1].rank).toBe(2);
    expect(resp.meta.impl).toBe("scrape");
  });

  it("honors the limit", async () => {
    stubFetch(async () => new Response(SEARCH_HTML, { status: 200 }));

    const resp = await scrapeSmallWeb({ q: "linux", limit: 1 }, TOKEN);

    expect(resp.results).toHaveLength(1);
  });

  it("maps 401 and 403 to KagiAuthError", async () => {
    stubFetch(async () => new Response("denied", { status: 401 }));
    await expect(scrapeSmallWeb({ q: "linux" }, TOKEN)).rejects.toBeInstanceOf(
      KagiAuthError,
    );

    stubFetch(async () => new Response("denied", { status: 403 }));
    await expect(scrapeSmallWeb({ q: "linux" }, TOKEN)).rejects.toBeInstanceOf(
      KagiAuthError,
    );
  });

  it("maps any other non-2xx to KagiUpstreamError", async () => {
    stubFetch(async () => new Response("boom", { status: 500, statusText: "Boom" }));

    await expect(scrapeSmallWeb({ q: "linux" }, TOKEN)).rejects.toBeInstanceOf(
      KagiUpstreamError,
    );
  });

  it("returns an empty result list for a genuine zero-results page", async () => {
    // The zero-results fixture carries an explicit no-results marker, which
    // takes precedence over the results-page chrome — this is what
    // distinguishes "nothing matched" from a renamed selector.
    stubFetch(async () => new Response(searchFixture("zero-results.html"), { status: 200 }));

    const resp = await scrapeSmallWeb({ q: "linux" }, TOKEN);

    expect(resp.results).toEqual([]);
  });

  it("fails loudly when the smallweb search markup moves", async () => {
    // news-heavy carries only top-level hits, so renaming the selector empties
    // the parse while related-searches + load-more chrome trips the guard.
    // (grouped-results would still yield its intact grouped hits — covered in
    // search-parser.test.ts instead.)
    const renamed = searchFixture("news-heavy.html").replaceAll(
      "search-result",
      "renamed-result",
    );
    stubFetch(async () => new Response(renamed, { status: 200 }));

    await expect(scrapeSmallWeb({ q: "linux" }, TOKEN)).rejects.toBeInstanceOf(
      KagiMarkupChangedError,
    );
  });
});

describe("feed parser guard rails", () => {
  it("fails loudly when entries exist but none yield a link", async () => {
    // Distinct from the no-<entry> case above: the dialect matches, blocks are
    // found, and every one of them parses to nothing. Silently returning []
    // here is what made the original bug invisible.
    stubFetch(
      async () =>
        new Response(
          `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
             <entry><title>No link here</title></entry>
             <entry><title>Nor here</title></entry>
           </feed>`,
          { status: 200 },
        ),
    );

    await expect(fetchSmallWebRss()).rejects.toThrow(
      /parsed 0 of 2 entries — feed markup changed/,
    );
  });
});
