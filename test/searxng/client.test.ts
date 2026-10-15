// SearxngClient — wire fetch and canonical normalization.
//
// fetch is stubbed globally (see test/_helpers.ts): no test here reaches a
// real SearXNG instance. The normalizer is pinned separately from the fetch
// so a shape drift in SearXNG's format=json fails in the normalize block
// with a readable diff, not as an opaque network-level mismatch.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isSearxngConfigured,
  normalizeSearxngResponse,
  SearxngClient,
} from "../../src/searxng/client";
import { KagiNotConfiguredError } from "../../src/kagi/errors";
import type { Env } from "../../src/env";
import { restoreFetch, stubFetch } from "../_helpers";

function env(overrides: Partial<Env> = {}): Env {
  return {
    ADMIN_TOKEN: "x",
    SEARXNG_BASE_URL: "https://searxng.internal.example",
    ...overrides,
  } as Env;
}

const WIRE = {
  query: "rust",
  number_of_results: 2,
  results: [
    {
      url: "https://www.rust-lang.org/",
      title: "Rust",
      content: "A language empowering everyone",
      engine: "brave",
      publishedDate: "2026-01-01T00:00:00Z",
      thumbnail: "https://img.example/t.png",
    },
    {
      url: "https://doc.rust-lang.org/book/",
      title: "The Book",
      content: "Learn Rust",
      engine: "duckduckgo",
    },
  ],
  answers: ["Rust is a language"],
  suggestions: ["rust book"],
};

function jsonFetch(body: unknown, status = 200) {
  return async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  restoreFetch();
});

describe("isSearxngConfigured", () => {
  it("is false when the var is missing, empty, or blank", () => {
    expect(isSearxngConfigured(env({ SEARXNG_BASE_URL: undefined }))).toBe(false);
    expect(isSearxngConfigured(env({ SEARXNG_BASE_URL: "" }))).toBe(false);
    expect(isSearxngConfigured(env({ SEARXNG_BASE_URL: "   " }))).toBe(false);
  });

  it("is true when a base URL is set", () => {
    expect(isSearxngConfigured(env())).toBe(true);
  });
});

describe("SearxngClient.search — transport", () => {
  it("refuses before the network when unconfigured", async () => {
    const client = new SearxngClient(env({ SEARXNG_BASE_URL: "" }));
    await expect(client.search({ q: "x" })).rejects.toBeInstanceOf(KagiNotConfiguredError);
  });

  it("requests format=json with q, and normalizes the envelope", async () => {
    let seenUrl = "";
    let seenHeaders: Record<string, string> = {};
    stubFetch(async (input, init) => {
      seenUrl = String(input);
      seenHeaders = { ...((init?.headers as Record<string, string>) ?? {}) };
      return jsonFetch(WIRE)();
    });

    const res = await new SearxngClient(env()).search({ q: "rust", limit: 5 });

    // SearXNG format=json has no limit param (paging is via pageno) — the
    // limit is enforced client-side in normalize, so no inert param goes on
    // the wire.
    expect(seenUrl).toBe("https://searxng.internal.example/search?q=rust&format=json");
    expect(seenHeaders.Accept).toBe("application/json");
    // No Access headers without the secrets — a VPC-adjacent binding needs none.
    expect(seenHeaders["CF-Access-Client-Id"]).toBeUndefined();
    expect(res.query).toBe("rust");
    expect(res.results).toHaveLength(2);
    expect(res.meta.impl).toBe("searxng");
  });

  it("caps results at the requested limit, keeping ranks continuous", async () => {
    stubFetch(
      jsonFetch({
        results: [
          { url: "https://a.example", title: "A" },
          { title: "no url" },
          { url: "https://b.example", title: "B" },
          { url: "https://c.example", title: "C" },
        ],
      }),
    );

    const res = await new SearxngClient(env()).search({ q: "x", limit: 2 });

    // Url-less entries are skipped without consuming the limit.
    expect(res.results).toHaveLength(2);
    expect(res.results.map((r) => r.rank)).toEqual([1, 2]);
    expect(res.results[1].url).toBe("https://b.example");
  });

  it("strips trailing slashes from the base URL", async () => {
    let seenUrl = "";
    stubFetch(async (input) => {
      seenUrl = String(input);
      return jsonFetch({ ...WIRE, results: [] })();
    });

    await new SearxngClient(env({ SEARXNG_BASE_URL: "https://s.example///" })).search({ q: "x" });

    expect(seenUrl.startsWith("https://s.example/search?")).toBe(true);
  });

  it("sends the Access service token when both secrets are set", async () => {
    let seenHeaders: Record<string, string> = {};
    stubFetch(async (_input, init) => {
      seenHeaders = { ...((init?.headers as Record<string, string>) ?? {}) };
      return jsonFetch({ ...WIRE, results: [] })();
    });

    await new SearxngClient(
      env({ SEARXNG_ACCESS_CLIENT_ID: "id", SEARXNG_ACCESS_CLIENT_SECRET: "secret" }),
    ).search({ q: "x" });

    expect(seenHeaders["CF-Access-Client-Id"]).toBe("id");
    expect(seenHeaders["CF-Access-Client-Secret"]).toBe("secret");
  });

  it("maps a non-2xx into kind=upstream", async () => {
    stubFetch(jsonFetch("denied", 403));

    const err = await new SearxngClient(env())
      .search({ q: "x" })
      .catch((e) => e);
    expect(err.kind).toBe("upstream");
    expect(String(err.message)).toContain("403");
  });

  it("maps an abort into kind=timeout", async () => {
    stubFetch(async () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    });

    const err = await new SearxngClient(env())
      .search({ q: "x" })
      .catch((e) => e);
    expect(err.kind).toBe("timeout");
  });

  it("lets non-KagiError fetch failures propagate unwrapped", async () => {
    stubFetch(async () => {
      throw new TypeError("fetch exploded");
    });

    await expect(new SearxngClient(env()).search({ q: "x" })).rejects.toBeInstanceOf(TypeError);
  });

  it("defaults the limit to 10 results", async () => {
    stubFetch(
      jsonFetch({ results: Array.from({ length: 12 }, (_, i) => ({ url: `https://x${i}.example` })) }),
    );

    const res = await new SearxngClient(env()).search({ q: "x" });

    expect(res.results).toHaveLength(10);
  });
});

describe("normalizeSearxngResponse — canonical mapping", () => {
  it("maps url/title/content/engine into canonical results with source_impl searxng", () => {
    const res = normalizeSearxngResponse("rust", WIRE, Date.now());

    expect(res.query).toBe("rust");
    expect(res.results[0]).toMatchObject({
      rank: 1,
      url: "https://www.rust-lang.org/",
      title: "Rust",
      snippet: "A language empowering everyone",
      source_domain: "rust-lang.org",
      published_at: "2026-01-01T00:00:00Z",
      thumbnail_url: "https://img.example/t.png",
      source_impl: "searxng",
      props: { engine: "brave" },
    });
    expect(res.results[1].rank).toBe(2);
    expect(res.results[1].props).toEqual({ engine: "duckduckgo" });
  });

  it("maps answers/suggestions into buckets, omitting empties", () => {
    const res = normalizeSearxngResponse("rust", WIRE, Date.now());

    expect(res.buckets?.direct_answer).toBe("Rust is a language");
    expect(res.buckets?.related_search).toEqual(["rust book"]);
  });

  it("omits buckets entirely when answers and suggestions are absent", () => {
    const res = normalizeSearxngResponse("x", { results: [] }, Date.now());

    expect(res.buckets).toBeUndefined();
  });

  it("skips entries without a url and keeps ranks continuous", () => {
    const res = normalizeSearxngResponse(
      "x",
      { results: [{ title: "no url" }, { url: "https://a.example", title: "A" }] },
      Date.now(),
    );

    expect(res.results).toHaveLength(1);
    expect(res.results[0].rank).toBe(1);
  });

  it("tolerates a missing or non-array results field", () => {
    expect(normalizeSearxngResponse("x", {}, Date.now()).results).toEqual([]);
    expect(normalizeSearxngResponse("x", { results: null }, Date.now()).results).toEqual([]);
  });

  it("caps results at the passed limit, keeping ranks continuous", () => {
    const wire = {
      results: [
        { url: "https://a.example", title: "A" },
        { title: "no url" },
        { url: "https://b.example", title: "B" },
        { url: "https://c.example", title: "C" },
      ],
    };

    const res = normalizeSearxngResponse("x", wire, Date.now(), 2);

    expect(res.results).toHaveLength(2);
    expect(res.results.map((r) => r.rank)).toEqual([1, 2]);
    expect(res.results[1].url).toBe("https://b.example");
  });

  it("returns everything when no limit is passed", () => {
    const res = normalizeSearxngResponse("rust", WIRE, Date.now());

    expect(res.results).toHaveLength(2);
  });

  it("always annotates meta.warnings with the fallback notice", () => {
    const res = normalizeSearxngResponse("x", { results: [] }, Date.now());

    expect(res.meta.impl).toBe("searxng");
    expect(res.meta.warnings).toHaveLength(1);
    expect(res.meta.warnings?.[0]).toContain("SearXNG fallback");
  });
});
