// Small Web: the differentiating corpus. Two scrape paths:
//   - The public feed (https://kagi.com/api/v1/smallweb/feed/) — free, no
//     auth. Great for `q=undefined` "recent" browsing.
//   - Search with `?l=smallweb` on kagi.com/html/search — session-authed.
//
// The v1 Search API surfaces the same corpus as `interesting_finds`; the
// api-side impl uses that path.
//
// The feed is ATOM, not RSS: <feed> root, <entry> children, <link href="">
// as a self-closing attribute, <published>/<updated> rather than <pubDate>,
// and <summary> rather than <description>. Parsing it as RSS matches zero
// elements. Both dialects are handled below so a switch back to RSS does not
// silently empty the tool.

import { chromeHeaders } from "../headers.js";
import { KagiAuthError, KagiParseError, KagiUpstreamError } from "../errors.js";
import type { SearchResponse, SearchResult } from "../types.js";
import { buildMeta } from "../../mcp/meta.js";
import { domainFromUrl } from "../../util/url.js";

const FEED_URL = "https://kagi.com/api/v1/smallweb/feed/";

export interface SmallWebRssResult {
  items: Array<{
    title: string;
    link: string;
    pub_date?: string;
    description?: string;
  }>;
}

export async function fetchSmallWebRss(limit = 25): Promise<SmallWebRssResult> {
  const res = await fetch(FEED_URL, {
    headers: chromeHeaders({
      kind: "xhr",
      accept:
        "application/atom+xml, application/rss+xml, application/xml, text/xml",
    }),
  });
  if (!res.ok) {
    throw new KagiUpstreamError(res.status, res.statusText);
  }
  const xml = await res.text();
  return { items: parseFeed(xml, limit) };
}

// Atom <entry> and RSS <item> carry the same information under different
// names. Normalise both to one shape rather than branching at every call site.
const DIALECTS = [
  {
    entry: /<entry\b[\s\S]*?<\/entry>/gi,
    dates: ["published", "updated"],
    bodies: ["summary", "content"],
  },
  {
    entry: /<item\b[\s\S]*?<\/item>/gi,
    dates: ["pubDate", "date"],
    bodies: ["description", "content:encoded"],
  },
] as const;

function parseFeed(xml: string, limit: number): SmallWebRssResult["items"] {
  // Regex extraction is stable across whitespace variations and avoids pulling
  // a full XML parser into the Worker bundle.
  if (!/<rss\b|<feed\b/i.test(xml)) {
    // Not a feed at all — bad markup, an error page, or an auth wall.
    throw new KagiParseError("Small Web feed did not return RSS/Atom");
  }

  const dialect =
    DIALECTS.find((d) => new RegExp(d.entry.source, "i").test(xml)) ?? null;
  if (!dialect) {
    throw new KagiParseError(
      "Small Web feed contained no <entry> or <item> elements",
    );
  }

  const blocks = xml.match(new RegExp(dialect.entry.source, "gi")) ?? [];
  const items: SmallWebRssResult["items"] = [];
  for (const raw of blocks.slice(0, limit)) {
    const link = extractLink(raw);
    if (!link) continue;
    items.push({
      title: unescapeXml(extractTag(raw, "title") ?? ""),
      link,
      pub_date: firstTag(raw, dialect.dates),
      description: stripHtml(firstTag(raw, dialect.bodies)),
    });
  }

  if (items.length === 0) {
    // A well-formed feed that yields nothing means the markup moved. Failing
    // loudly here is the whole point: the previous version returned an empty
    // list and reported success, so a broken parser was indistinguishable
    // from a quiet day on the Small Web.
    throw new KagiParseError(
      `Small Web feed parsed 0 of ${blocks.length} entries — feed markup changed`,
    );
  }
  return items;
}

function extractTag(raw: string, tag: string): string | null {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const m = raw.match(re);
  if (!m) return null;
  return m[1]
    .replace(/^\s*<!\[CDATA\[/i, "")
    .replace(/\]\]>\s*$/i, "")
    .trim();
}

function firstTag(raw: string, tags: readonly string[]): string | undefined {
  for (const tag of tags) {
    const value = extractTag(raw, tag);
    if (value) return value;
  }
  return undefined;
}

// Atom links are a self-closing element with the URL in an href attribute;
// RSS puts it in the element body. Try the attribute first, then the body.
// Skip rel values that point at anything other than the entry itself.
function extractLink(raw: string): string | null {
  const linkTags = raw.match(/<link\b[^>]*>/gi) ?? [];
  for (const tag of linkTags) {
    const rel = tag.match(/\brel\s*=\s*["']([^"']+)["']/i)?.[1];
    if (rel && rel.toLowerCase() !== "alternate") continue;
    const href = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
    if (href) return unescapeXml(href.trim());
  }
  const body = extractTag(raw, "link");
  return body ? unescapeXml(body) : null;
}

// Atom marks summaries type="html", so the body is escaped markup. Callers
// render these as plain snippets.
function stripHtml(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const text = unescapeXml(s).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return text || undefined;
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export interface ScrapeSmallWebArgs {
  q?: string;
  limit?: number;
}

export async function scrapeSmallWeb(
  args: ScrapeSmallWebArgs,
  sessionToken: string | undefined,
): Promise<SearchResponse> {
  const start_ms = Date.now();
  const limit = args.limit ?? 25;

  if (!args.q) {
    // Browse-recent path: use the free RSS feed. No session cookie needed.
    const rss = await fetchSmallWebRss(limit);
    const results: SearchResult[] = rss.items.map((it, i) => ({
      rank: i + 1,
      url: it.link,
      title: it.title || "(untitled)",
      snippet: it.description ?? "",
      published_at: it.pub_date,
      source_domain: domainFromUrl(it.link),
      source_impl: "scrape" as const,
      props: { source: "smallweb_rss" },
    }));
    return {
      query: "",
      results,
      meta: buildMeta({ impl: "scrape", start_ms }),
    };
  }

  // Search path: kagi.com/html/search?q=<q>&l=smallweb — needs the session.
  if (!sessionToken) {
    throw new KagiAuthError(
      "Small Web search requires a Kagi session token; browse-recent (no q) works without one.",
    );
  }
  const url = new URL("https://kagi.com/html/search");
  url.searchParams.set("q", args.q);
  url.searchParams.set("l", "smallweb");
  const res = await fetch(url.toString(), {
    headers: chromeHeaders({
      kind: "document",
      cookieHeader: `kagi_session=${sessionToken}`,
    }),
  });
  if (res.status === 401 || res.status === 403) throw new KagiAuthError();
  if (!res.ok) throw new KagiUpstreamError(res.status, res.statusText);
  const html = await res.text();
  // Reuse the general search parser so any markup change is fixed once.
  const { parseSearchResults } = await import("../search.js");
  const items = parseSearchResults(html, limit);
  const results: SearchResult[] = items
    .filter((it) => it.t === 0)
    .map((it, i) => ({
      rank: i + 1,
      url: it.url,
      title: it.title,
      snippet: it.snippet,
      source_domain: domainFromUrl(it.url),
      source_impl: "scrape" as const,
      props: { source: "smallweb_search" },
    }));
  return {
    query: args.q,
    results,
    meta: buildMeta({ impl: "scrape", start_ms }),
  };
}
