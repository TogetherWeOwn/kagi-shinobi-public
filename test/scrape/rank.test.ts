// scrapeRank — personalized ranking by probing `site:<domain>` queries through
// the user's own Kagi session. The raw search module is mocked so each test
// controls exactly what a probe returns; that is the only input the scoring
// maths has.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { KagiAuthError, KagiUpstreamError } from "../../src/kagi/errors";

const { search } = vi.hoisted(() => ({ search: vi.fn() }));
vi.mock("../../src/kagi/search.js", () => ({ search }));

const { scrapeRank } = await import("../../src/kagi/scrape/rank");

const TOKEN = "sess-abc";

/** A probe response listing the given URLs as ordinary results. */
function probe(urls: string[]) {
  return {
    data: [
      ...urls.map((url, i) => ({ t: 0, url, title: `T${i}`, snippet: "s" })),
      { t: 1, list: ["a related search"] },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("authentication", () => {
  it("refuses without a session token — the account IS the ruleset", async () => {
    await expect(
      scrapeRank({ urls: ["https://a.example/x"] }, undefined),
    ).rejects.toBeInstanceOf(KagiAuthError);

    expect(search).not.toHaveBeenCalled();
  });

  it("propagates an auth failure from a probe rather than scoring around it", async () => {
    search.mockRejectedValue(new KagiAuthError());

    await expect(scrapeRank({ urls: ["https://a.example/x"] }, TOKEN)).rejects.toBeInstanceOf(
      KagiAuthError,
    );
  });
});

describe("probe query construction", () => {
  it("probes site:<domain> when no query is supplied", async () => {
    search.mockResolvedValue(probe([]));

    await scrapeRank({ urls: ["https://a.example/page"] }, TOKEN);

    expect(search).toHaveBeenCalledWith("site:a.example", TOKEN, 10);
  });

  it("prefixes the caller's query when one is supplied", async () => {
    search.mockResolvedValue(probe([]));

    await scrapeRank({ urls: ["https://a.example/page"], q: "widgets" }, TOKEN);

    expect(search).toHaveBeenCalledWith("widgets site:a.example", TOKEN, 10);
  });

  it("honors a probe_limit override", async () => {
    search.mockResolvedValue(probe([]));

    await scrapeRank({ urls: ["https://a.example/page"], probe_limit: 3 }, TOKEN);

    expect(search).toHaveBeenCalledWith("site:a.example", TOKEN, 3);
  });

  it("runs one probe per URL", async () => {
    search.mockResolvedValue(probe([]));

    await scrapeRank(
      { urls: ["https://a.example/1", "https://b.example/2", "https://c.example/3"] },
      TOKEN,
    );

    expect(search).toHaveBeenCalledTimes(3);
  });
});

describe("scoring", () => {
  it("pins a URL that comes back first", async () => {
    search.mockResolvedValue(probe(["https://a.example/page", "https://a.example/other"]));

    const resp = await scrapeRank({ urls: ["https://a.example/page"] }, TOKEN);

    expect(resp.ranked[0]).toEqual({
      url: "https://a.example/page",
      score: 1,
      action: "pin",
      rationale: "probe position 1/10",
    });
  });

  it("raises a URL in the middle of the probe window", async () => {
    // position 5 of a 10-deep probe → 1 - 5/10 = 0.5 → raise
    const urls = Array.from({ length: 8 }, (_, i) => `https://a.example/${i}`);
    search.mockResolvedValue(probe(urls));

    const resp = await scrapeRank({ urls: [urls[5]] }, TOKEN);

    expect(resp.ranked[0].score).toBeCloseTo(0.5);
    expect(resp.ranked[0].action).toBe("raise");
    expect(resp.ranked[0].rationale).toBe("probe position 6/10");
  });

  it("marks a deep result neutral", async () => {
    // position 7 → 1 - 7/10 = 0.3 → neutral
    const urls = Array.from({ length: 8 }, (_, i) => `https://a.example/${i}`);
    search.mockResolvedValue(probe(urls));

    const resp = await scrapeRank({ urls: [urls[7]] }, TOKEN);

    expect(resp.ranked[0].score).toBeCloseTo(0.3);
    expect(resp.ranked[0].action).toBe("neutral");
  });

  it("blocks a URL that never surfaces", async () => {
    search.mockResolvedValue(probe(["https://a.example/somethingelse"]));

    const resp = await scrapeRank({ urls: ["https://a.example/missing"] }, TOKEN);

    expect(resp.ranked[0]).toEqual({
      url: "https://a.example/missing",
      score: 0,
      action: "block",
      rationale: "no appearance in probe results — may be blocked or de-ranked",
    });
  });

  it("matches on host+path, ignoring query strings and fragments", async () => {
    search.mockResolvedValue(probe(["https://a.example/page?utm_source=kagi#top"]));

    const resp = await scrapeRank({ urls: ["https://a.example/page"] }, TOKEN);

    expect(resp.ranked[0].action).toBe("pin");
  });

  it("does not match a different path on the same host", async () => {
    search.mockResolvedValue(probe(["https://a.example/other"]));

    const resp = await scrapeRank({ urls: ["https://a.example/page"] }, TOKEN);

    expect(resp.ranked[0].action).toBe("block");
  });

  it("ignores related-search entries when counting positions", async () => {
    // The t:1 related-search item must not occupy a rank slot.
    search.mockResolvedValue({
      data: [
        { t: 1, list: ["related"] },
        { t: 0, url: "https://a.example/page", title: "T", snippet: "s" },
      ],
    });

    const resp = await scrapeRank({ urls: ["https://a.example/page"] }, TOKEN);

    expect(resp.ranked[0].rationale).toBe("probe position 1/10");
  });
});

describe("resilience", () => {
  it("treats a non-auth probe failure as 'did not surface' instead of failing the call", async () => {
    search
      .mockRejectedValueOnce(new KagiUpstreamError(502, "Bad Gateway"))
      .mockResolvedValueOnce(probe(["https://b.example/ok"]));

    const resp = await scrapeRank(
      { urls: ["https://a.example/boom", "https://b.example/ok"] },
      TOKEN,
    );

    expect(resp.ranked[0].action).toBe("block");
    expect(resp.ranked[1].action).toBe("pin");
  });

  it("scores an unparseable URL as not-surfaced rather than throwing", async () => {
    search.mockResolvedValue(probe(["https://a.example/page"]));

    const resp = await scrapeRank({ urls: ["not-a-url"] }, TOKEN);

    expect(resp.ranked[0].action).toBe("block");
  });
});

describe("envelope", () => {
  it("echoes the query and stamps scrape meta", async () => {
    search.mockResolvedValue(probe([]));

    const resp = await scrapeRank({ urls: ["https://a.example/x"], q: "widgets" }, TOKEN);

    expect(resp.query).toBe("widgets");
    expect(resp.meta.impl).toBe("scrape");
    expect(resp.meta.elapsed_ms).toBeGreaterThanOrEqual(0);
  });

  it("returns an empty ranking for an empty url list without probing", async () => {
    const resp = await scrapeRank({ urls: [] }, TOKEN);

    expect(resp.ranked).toEqual([]);
    expect(search).not.toHaveBeenCalled();
  });
});
