// GET /search — the SearXNG json_engine view (ADR 0013).
//
// Same mocking approach as test/rest.test.ts: the KagiClient facade is a
// factory mock, so this pins rest.ts's validation and the response *shape*
// SearXNG keys off (results[].url/title/content), not scraping.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { KagiUpstreamError } from "../src/kagi/errors";
import { makeEnv } from "./_helpers";

const { createKagiClient } = vi.hoisted(() => ({ createKagiClient: vi.fn() }));
vi.mock("../src/kagi/client.js", () => ({ createKagiClient }));

const { handleSearchGet } = await import("../src/rest");

const RESPONSE = {
  query: "rust",
  results: [
    {
      rank: 1,
      url: "https://www.rust-lang.org/",
      title: "Rust",
      snippet: "A language empowering everyone",
      source_domain: "rust-lang.org",
      source_impl: "scrape",
      published_at: "2026-01-01T00:00:00Z",
      thumbnail_url: "https://img.example/t.png",
    },
    {
      rank: 2,
      url: "https://doc.rust-lang.org/book/",
      title: "The Book",
      snippet: "Learn Rust",
      source_domain: "doc.rust-lang.org",
      source_impl: "scrape",
    },
  ],
  buckets: { direct_answer: "Rust is a language", related_search: ["rust book"] },
  meta: { impl: "scrape", cache_hit: false, elapsed_ms: 1 },
};

function get(qs: string): Request {
  return new Request(`https://worker.test/search${qs}`);
}

async function json(res: Response): Promise<Record<string, any>> {
  return (await res.json()) as Record<string, any>;
}

beforeEach(() => {
  createKagiClient.mockReset();
});

describe("GET /search — validation", () => {
  it.each([
    ["", "missing-query"],
    ["?q=%20%20", "missing-query"],
    [`?q=${"a".repeat(501)}`, "invalid-query"],
    ["?q=x&format=html", "invalid-format"],
    ["?q=x&limit=0", "invalid-limit"],
    ["?q=x&limit=51", "invalid-limit"],
    ["?q=x&limit=2.5", "invalid-limit"],
    ["?q=x&max_age_s=-1", "invalid-max-age"],
    ["?q=x&max_age_s=abc", "invalid-max-age"],
    ["?q=x&max_age_s=", "invalid-max-age"],
  ])("%s -> 400 %s", async (qs, code) => {
    const res = await handleSearchGet(get(qs), makeEnv());
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe(code);
    expect(createKagiClient).not.toHaveBeenCalled();
  });
});

describe("GET /search — SearXNG shape", () => {
  it("maps results to url/title/content and passes q + limit", async () => {
    const search = vi.fn().mockResolvedValue(RESPONSE);
    createKagiClient.mockReturnValue({ mode: "scrape", search });

    const res = await handleSearchGet(get("?q=%20rust%20&format=json&limit=5"), makeEnv());
    const body = await json(res);

    expect(res.status).toBe(200);
    expect(search).toHaveBeenCalledWith({ q: "rust", limit: 5 });
    expect(body.query).toBe("rust");
    expect(body.number_of_results).toBe(2);
    expect(body.results[0]).toEqual({
      url: "https://www.rust-lang.org/",
      title: "Rust",
      content: "A language empowering everyone",
      engine: "kagi",
      publishedDate: "2026-01-01T00:00:00Z",
      thumbnail: "https://img.example/t.png",
    });
    expect(body.results[1]).toEqual({
      url: "https://doc.rust-lang.org/book/",
      title: "The Book",
      content: "Learn Rust",
      engine: "kagi",
    });
    expect(body.answers).toEqual(["Rust is a language"]);
    expect(body.suggestions).toEqual(["rust book"]);
  });

  it("defaults format to json and limit to 10, with empty answers/suggestions", async () => {
    const search = vi.fn().mockResolvedValue({ ...RESPONSE, buckets: undefined, results: [] });
    createKagiClient.mockReturnValue({ mode: "scrape", search });

    const res = await handleSearchGet(get("?q=x"), makeEnv());
    const body = await json(res);

    expect(res.status).toBe(200);
    expect(search).toHaveBeenCalledWith({ q: "x", limit: 10 });
    expect(body.results).toEqual([]);
    expect(body.answers).toEqual([]);
    expect(body.suggestions).toEqual([]);
  });

  it("passes max_age_s through, so ?max_age_s=0 skips the result cache", async () => {
    const search = vi.fn().mockResolvedValue(RESPONSE);
    createKagiClient.mockReturnValue({ mode: "scrape", search });

    const res = await handleSearchGet(get("?q=x&max_age_s=0"), makeEnv(), {
      waitUntil: vi.fn(),
    } as never);

    expect(res.status).toBe(200);
    expect(search).toHaveBeenCalledWith({ q: "x", limit: 10, max_age_s: 0 });
  });

  it("maps an upstream failure through the shared error vocabulary", async () => {
    const search = vi.fn().mockRejectedValue(new KagiUpstreamError(503, "boom"));
    createKagiClient.mockReturnValue({ mode: "scrape", search });

    const res = await handleSearchGet(get("?q=x"), makeEnv());
    expect(res.status).toBe(502);
  });

  it("maps a client construction failure", async () => {
    createKagiClient.mockImplementation(() => {
      throw new KagiUpstreamError(503, "no client");
    });
    const res = await handleSearchGet(get("?q=x"), makeEnv());
    expect(res.status).toBe(502);
  });
});
