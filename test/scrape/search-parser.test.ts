// Parser correctness against recorded fixtures. Runs hermetic — no network.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseSearchResults } from "../../src/kagi/search";
import { KagiMarkupChangedError, KagiParseError } from "../../src/kagi/errors";
import { scrapeSearchToCanonical } from "../../src/kagi/normalize";

// String paths rather than `new URL(...)`: the global URL type here is the
// Workers one, which node's readFileSync overloads reject at typecheck.
const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/search");

function fixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), "utf8");
}

const FIXTURE = `<!doctype html>
<html>
<body>
  <div class="search-result">
    <div class="__sri-title">
      <a class="__sri_title_link" href="https://example.com/one">First Result Title</a>
    </div>
    <div class="__sri-desc">This is the snippet for the first result. It describes what you'd find.</div>
  </div>
  <div class="search-result">
    <div class="__sri-title">
      <a class="__sri_title_link" href="https://another.example.org/page">Second Result Title</a>
    </div>
    <div class="__sri-desc">A second snippet from a second domain.</div>
  </div>
  <div class="sr-group">
    <div class="__srgi">
      <div class="__srgi-title">
        <a href="https://grouped.example.net/x">Grouped Result</a>
      </div>
      <div class="__sri-desc">Snippet under a grouped result.</div>
    </div>
  </div>
  <div class="related-searches">
    <a><span>related term one</span></a>
    <a><span>related term two</span></a>
  </div>
</body>
</html>`;

describe("parseSearchResults", () => {
  it("extracts top-level search results in order", () => {
    const items = parseSearchResults(FIXTURE, 10);
    const results = items.filter((i) => i.t === 0);
    expect(results.length).toBe(3);
    expect(results[0]).toMatchObject({
      t: 0,
      title: "First Result Title",
      url: "https://example.com/one",
    });
    expect(results[1].url).toBe("https://another.example.org/page");
    expect(results[2].url).toBe("https://grouped.example.net/x");
  });

  it("respects the limit param", () => {
    const items = parseSearchResults(FIXTURE, 2);
    const results = items.filter((i) => i.t === 0);
    expect(results.length).toBe(2);
  });

  it("emits related searches when present", () => {
    const items = parseSearchResults(FIXTURE, 10);
    const related = items.find((i) => i.t === 1);
    expect(related).toBeDefined();
    if (related && related.t === 1) {
      expect(related.list).toEqual(["related term one", "related term two"]);
    }
  });

  it("returns empty results on markup with no matches", () => {
    const items = parseSearchResults(`<html><body>nothing</body></html>`, 10);
    expect(items.length).toBe(0);
  });
});

describe("parseSearchResults recorded fixtures", () => {
  it("parses all six hits from the news-heavy fixture", () => {
    const items = parseSearchResults(fixture("news-heavy.html"), 10);
    const results = items.filter((i) => i.t === 0);
    expect(results.length).toBe(6);
    expect(results[0]).toMatchObject({
      t: 0,
      url: "https://news.example.com/2026/10/01/launch",
    });
  });

  it("parses grouped hits alongside top-level ones", () => {
    const items = parseSearchResults(fixture("grouped-results.html"), 10);
    const results = items.filter((i) => i.t === 0);
    expect(results.length).toBe(5);
    expect(results.map((r) => r.t === 0 && r.url)).toContain(
      "https://forum.example.io/t/11",
    );
  });

  it("returns [] for a genuine zero-results page", () => {
    const items = parseSearchResults(fixture("zero-results.html"), 10);
    expect(items).toEqual([]);
  });

  it("throws markup_changed when selectors are stripped from a results page", () => {
    // The acceptance case: Kagi renames every selector, but the results-page
    // chrome (container, load-more button) survives. That is breakage, not an
    // empty search — it must fail loudly.
    const renamed = fixture("news-heavy.html")
      .replaceAll("search-result", "renamed-result")
      .replaceAll("_0_main-search-results", "_0_renamed-container")
      .replaceAll("__sri_title_link", "__renamed-link")
      .replaceAll("__sri-desc", "__renamed-desc")
      .replaceAll("related-searches", "renamed-related");

    expect(() => parseSearchResults(renamed, 10)).toThrowError(KagiMarkupChangedError);
    try {
      parseSearchResults(renamed, 10);
    } catch (e) {
      expect(e).toBeInstanceOf(KagiParseError);
      expect((e as KagiMarkupChangedError).kind).toBe("markup_changed");
    }
  });

  // A positive result count anywhere in the body text ("10 results",
  // "2,340 results", ...) contains the substring "0 results" — it must not
  // be mistaken for the genuine zero-results marker and silence the guard.
  it.each([
    "The top 10 results for laptops",
    "100 results ranked by relevance",
    "About 2,340 results",
    "50 results near you",
  ])("throws markup_changed when renamed selectors leave only %j", (snippet) => {
    const page = `<!doctype html>
<html><body>
  <div class="_0_main-search-results">
    <div class="renamed-result">
      <div class="renamed-title"><a href="https://example.com/one">A result</a></div>
      <div class="renamed-desc">${snippet}</div>
    </div>
  </div>
  <button id="load_more_results">More</button>
</body></html>`;

    expect(() => parseSearchResults(page, 10)).toThrowError(KagiMarkupChangedError);
    try {
      parseSearchResults(page, 10);
    } catch (e) {
      expect((e as KagiMarkupChangedError).kind).toBe("markup_changed");
    }
  });

  it("throws markup_changed when blocks survive but yield no title+url", () => {
    // Only the inner selectors renamed: `.search-result` and `.sr-group`
    // blocks exist but produce nothing. The block markers trip the guard.
    // (Both renames matter — the fixture's grouped hit would otherwise still
    // parse and the count would be 1, not 0.)
    const renamed = fixture("basic-results.html")
      .replaceAll("__sri_title_link", "__renamed-link")
      .replaceAll("__srgi-title", "__renamed-gtitle");

    expect(() => parseSearchResults(renamed, 10)).toThrowError(KagiMarkupChangedError);
  });
});

describe("scrapeSearchToCanonical", () => {
  it("normalizes into the canonical SearchResponse shape", () => {
    const items = parseSearchResults(FIXTURE, 10);
    const canonical = scrapeSearchToCanonical("hello world", items, {
      impl: "scrape",
      start_ms: Date.now() - 42,
    });
    expect(canonical.query).toBe("hello world");
    expect(canonical.results.length).toBe(3);
    expect(canonical.results[0]).toMatchObject({
      rank: 1,
      source_impl: "scrape",
      source_domain: "example.com",
    });
    expect(canonical.results[1].source_domain).toBe("another.example.org");
    expect(canonical.meta.impl).toBe("scrape");
    expect(canonical.meta.cache_hit).toBe(false);
    expect(canonical.meta.elapsed_ms).toBeGreaterThanOrEqual(0);
    expect(canonical.buckets?.related_search).toEqual([
      "related term one",
      "related term two",
    ]);
  });

  it("assigns increasing rank numbers", () => {
    const items = parseSearchResults(FIXTURE, 10);
    const canonical = scrapeSearchToCanonical("q", items, {
      impl: "scrape",
      start_ms: Date.now(),
    });
    for (let i = 0; i < canonical.results.length; i++) {
      expect(canonical.results[i].rank).toBe(i + 1);
    }
  });
});
