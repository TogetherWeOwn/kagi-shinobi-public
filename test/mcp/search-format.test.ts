// Concise search output: URL normalization, stable refs, truncation, dedupe,
// and the concise/detailed formatters. Pure logic — runs in the Node project.
//
// See ADR 0013. The eval that proves the ≥40% size win lives in
// search-format-eval.test.ts; this file pins the behavior.

import { describe, expect, it } from "vitest";
import type { SearchResponse } from "../../src/kagi/types";
import {
  CONCISE_SNIPPET_MAX,
  dedupeResponses,
  formatSearchConcise,
  formatSearchDetailed,
  normalizeUrl,
  sha1Hex,
  stableRef,
  truncateSnippet,
} from "../../src/mcp/search-format";

function response(
  query: string,
  items: Array<{
    url: string;
    title?: string;
    snippet?: string;
    published_at?: string;
  }>,
): SearchResponse {
  return {
    query,
    results: items.map((r, i) => ({
      rank: i + 1,
      url: r.url,
      title: r.title ?? `Title ${i + 1}`,
      snippet: r.snippet ?? `Snippet ${i + 1}`,
      ...(r.published_at ? { published_at: r.published_at } : {}),
      source_domain: "example.test",
      source_impl: "scrape" as const,
    })),
    meta: { impl: "scrape" as const, cache_hit: false, elapsed_ms: 1 },
  };
}

describe("sha1Hex", () => {
  // RFC 3179 vectors — the implementation is hand-rolled (formatting must stay
  // synchronous in both runtimes), so it is pinned against the standard.
  it("matches the RFC 3179 vectors", () => {
    expect(sha1Hex("abc")).toBe("a9993e364706816aba3e25717850c26c9cd0d89d");
    expect(sha1Hex("")).toBe("da39a3ee5e6b4b0d3255bfef95601890afd80709");
    expect(sha1Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
      "84983e441c3bd26ebaae4aa1f95129e5e54670f1",
    );
  });
});

describe("normalizeUrl", () => {
  it("strips tracking params, fragments, and default ports", () => {
    expect(
      normalizeUrl("https://example.test:443/a?utm_source=x&fbclid=y&q=1#frag"),
    ).toBe("https://example.test/a?q=1");
    expect(normalizeUrl("http://example.test:80/a")).toBe("http://example.test/a");
  });

  it("treats differently-cased tracking params as tracking", () => {
    expect(normalizeUrl("https://example.test/a?UTM_SOURCE=x&HsCtaTracking=y&q=1")).toBe(
      "https://example.test/a?q=1",
    );
  });

  it("lowercases scheme and host but keeps the path", () => {
    expect(normalizeUrl("HTTPS://Example.TEST/Path")).toBe("https://example.test/Path");
  });

  it("sorts surviving params so order does not matter", () => {
    expect(normalizeUrl("https://example.test/?b=2&a=1")).toBe(
      normalizeUrl("https://example.test/?a=1&b=2"),
    );
  });

  it("drops a trailing slash on a bare root", () => {
    expect(normalizeUrl("https://example.test/")).toBe("https://example.test");
  });

  it("keeps non-root paths and non-default ports", () => {
    expect(normalizeUrl("http://example.test:8080/a/")).toBe("http://example.test:8080/a/");
  });

  it("returns unparseable input as-is so the ref stays stable", () => {
    expect(normalizeUrl("not a url")).toBe("not a url");
  });
});

describe("stableRef", () => {
  it("is the sha1 of the normalized url, truncated to 10 hex chars", () => {
    expect(stableRef("https://example.test/a?utm_source=x")).toBe(
      sha1Hex("https://example.test/a").slice(0, 10),
    );
    expect(stableRef("https://example.test/a")).toHaveLength(10);
  });

  it("collapses tracking-param and fragment variants to one ref", () => {
    expect(stableRef("https://example.test/a?utm_source=x#top")).toBe(
      stableRef("https://example.test/a"),
    );
  });
});

describe("truncateSnippet", () => {
  it("passes short snippets through, collapsing whitespace", () => {
    expect(truncateSnippet("a  b\nc")).toBe("a b c");
  });

  it("cuts at a word boundary with an ellipsis within the budget", () => {
    const long = "word ".repeat(100).trim();
    const out = truncateSnippet(long);
    expect(out.length).toBeLessThanOrEqual(CONCISE_SNIPPET_MAX);
    expect(out).toMatch(/…$/);
    // The stem is a prefix of the original and the cut lands on a space —
    // i.e. no word was split in half.
    const stem = out.replace(/…$/, "");
    expect(long.startsWith(stem)).toBe(true);
    expect(long[stem.length]).toBe(" ");
  });

  it("hard-cuts a spaceless run", () => {
    const out = truncateSnippet("x".repeat(500));
    expect(out.length).toBeLessThanOrEqual(CONCISE_SNIPPET_MAX);
    expect(out).toMatch(/…$/);
  });
});

describe("dedupeResponses", () => {
  it("collapses tracking-param variants across queries, keeping the first", () => {
    const perQuery = [
      response("q1", [{ url: "https://example.test/a", title: "First" }]),
      response("q2", [
        { url: "https://example.test/a?utm_source=x", title: "Second" },
        { url: "https://example.test/b", title: "Third" },
      ]),
    ];

    const { deduped, dropped } = dedupeResponses(perQuery);

    expect(dropped).toBe(1);
    expect(deduped[1]?.results).toHaveLength(1);
    expect(deduped[1]?.results[0]?.title).toBe("Third");
  });

  it("reports zero drops when everything is distinct", () => {
    const { dropped } = dedupeResponses([response("q", [{ url: "https://a.test/" }]), null]);

    expect(dropped).toBe(0);
  });
});

describe("formatSearchConcise", () => {
  it("renders one citation line per result with domain and date", () => {
    const { structured, text } = formatSearchConcise(["q"], [
      response("q", [
        {
          url: "https://example.test/a",
          title: "A title",
          snippet: "a snippet",
          published_at: "2025-01-01",
        },
      ]),
    ], { mode: "scrape", errors: [] });

    expect(text).toContain("[S1] A title — example.test (2025-01-01)");
    expect(text).toContain("a snippet");
    // The stable ref lives in the structured channel, not the text.
    expect(structured.queries[0].results[0].ref).toBe(stableRef("https://example.test/a"));
  });

  it("omits the date group and the filler when published_at is absent", () => {
    const { text } = formatSearchConcise(["q"], [response("q", [{ url: "https://a.test/" }])], {
      mode: "scrape",
      errors: [],
    });

    expect(text).not.toContain("Not Available");
    expect(text).not.toMatch(/\(\d{4}-/);
  });

  it("omits the snippet line when the snippet is empty", () => {
    const { text } = formatSearchConcise(
      ["q"],
      [response("q", [{ url: "https://a.test/", snippet: "" }])],
      { mode: "scrape", errors: [] },
    );

    // 3-line header + citation line, and nothing else.
    expect(text.trim().split("\n")).toHaveLength(4);
    expect(text.trim().split("\n")[3]).toMatch(/^\[S1\]/);
  });

  it("numbers continuously across queries and dedupes", () => {
    const perQuery = [
      response("q1", [{ url: "https://example.test/a" }]),
      response("q2", [
        { url: "https://example.test/a?utm_source=x" },
        { url: "https://example.test/b" },
      ]),
    ];

    const { text, structured } = formatSearchConcise(["q1", "q2"], perQuery, {
      mode: "scrape",
      errors: [],
    });

    expect(text).toContain("[S1]");
    expect(text).toContain("[S2]");
    expect(text).not.toContain("[S3]");
    expect(structured.dedup_dropped).toBe(1);
  });

  it("emits a slim structured channel: ids, urls, ranks, meta — no snippets", () => {
    const { structured } = formatSearchConcise(["q"], [
      response("q", [
        { url: "https://example.test/a", snippet: "x".repeat(500) },
      ]),
    ], { mode: "hybrid", errors: [] });

    expect(structured).toMatchObject({
      response_format: "concise",
      mode: "hybrid",
      dedup_dropped: 0,
    });
    expect(structured.queries).toHaveLength(1);
    expect(structured.queries[0].results[0]).toMatchObject({
      id: "S1",
      url: "https://example.test/a",
      rank: 1,
    });
    expect(structured.queries[0].results[0].ref).toHaveLength(10);
    expect(structured.queries[0].meta).toBeDefined();
    expect(JSON.stringify(structured)).not.toContain("x".repeat(500));
  });

  it("keeps the error entries of failed queries in the slim channel", () => {
    const { structured } = formatSearchConcise(["good", "bad"], [response("good", []), null], {
      mode: "scrape",
      errors: [{ query: "bad", error: "boom" }],
    });

    expect(structured.queries).toHaveLength(1);
    expect(structured.errors).toEqual([{ query: "bad", error: "boom" }]);
  });

  it("says so plainly when a query has no results", () => {
    const { text } = formatSearchConcise(["q"], [response("q", [])], {
      mode: "scrape",
      errors: [],
    });

    expect(text).toContain("(no results)");
  });
});

describe("formatSearchDetailed", () => {
  it("preserves the legacy text byte-for-byte when nothing dedupes", () => {
    const perQuery = [response("first", [{ url: "https://example.test/one", title: "One", snippet: "S1" }])];
    const { text, structured } = formatSearchDetailed(["first"], perQuery, {
      mode: "scrape",
      errors: [],
    });

    expect(text).toBe(
      `-----\nResults for search query "first":\n-----\n1: One\nhttps://example.test/one\nPublished Date: Not Available\nS1`,
    );
    expect(structured.response_format).toBe("detailed");
    expect(structured.dedup_dropped).toBe(0);
  });

  it("carries the full canonical responses in structured alongside the new fields", () => {
    const perQuery = [response("q", [{ url: "https://example.test/a" }])];
    const { structured } = formatSearchDetailed(["q"], perQuery, {
      mode: "scrape",
      errors: [],
    });

    expect(structured.queries[0].results[0].snippet).toBeDefined();
    expect(structured.mode).toBe("scrape");
  });
});
