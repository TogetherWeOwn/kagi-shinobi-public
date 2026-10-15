// Mode-dispatcher round-trip: prove the KagiClient facade routes correctly
// in every mode and surfaces the right structured errors when the target
// impl is unavailable.
//
// We stub both impls with a mock so we can watch which one the facade
// reaches for on each call, without needing real Kagi access.

import { afterEach, describe, expect, it, vi } from "vitest";
import { KagiClient } from "../../src/kagi/client";
import { KagiScrapeClient } from "../../src/kagi/scrape/index";
import { KagiApiImpl } from "../../src/kagi/api/index";
import { KagiNotConfiguredError } from "../../src/kagi/errors";
import type { SearchResponse, SummarizeResponse } from "../../src/kagi/types";
import type { Env } from "../../src/env";

function env(overrides: Partial<Env> = {}): Env {
  return { ADMIN_TOKEN: "x", ...overrides } as Env;
}

const fakeSearchResponse = (impl: "scrape" | "api", q: string): SearchResponse => ({
  query: q,
  results: [],
  meta: { impl, cache_hit: false, elapsed_ms: 0 },
});

const fakeSummarizeResponse = (impl: "scrape" | "api"): SummarizeResponse => ({
  source: { kind: "url", ref: "https://example.com" },
  summary: "ok",
  engine_used: impl === "scrape" ? "scrape-default" : "cecil",
  target_language: "EN",
  meta: { impl, cache_hit: false, elapsed_ms: 0 },
});

// makeClient() spies on shared prototype methods, so without teardown the
// spies survive into the next test. vi.spyOn returns the *existing* spy when
// a method is already spied, which means call counts accumulate rather than
// reset — each test must start from a clean prototype.
afterEach(() => {
  vi.restoreAllMocks();
});

/** Build a KagiClient with both impls stubbed so we can watch dispatch. */
function makeClient(mode: "scrape" | "api" | "hybrid", overrides: Partial<Env> = {}) {
  const e = env({
    KAGI_MODE: mode,
    KAGI_SESSION_TOKEN: "s",
    KAGI_API_KEY: "k",
    ...overrides,
  });
  const client = new KagiClient(e);

  const scrapeSearch = vi
    .spyOn(KagiScrapeClient.prototype, "search")
    .mockImplementation(async ({ q }) => fakeSearchResponse("scrape", q));
  const scrapeSummarize = vi
    .spyOn(KagiScrapeClient.prototype, "summarize")
    .mockImplementation(async () => fakeSummarizeResponse("scrape"));
  const apiSearch = vi
    .spyOn(KagiApiImpl.prototype, "search")
    .mockImplementation(async ({ q }) => fakeSearchResponse("api", q));
  const apiSummarize = vi
    .spyOn(KagiApiImpl.prototype, "summarize")
    .mockImplementation(async () => fakeSummarizeResponse("api"));

  return { client, scrapeSearch, scrapeSummarize, apiSearch, apiSummarize };
}

describe("KagiClient facade routing", () => {
  it("scrape mode always hits the scrape impl", async () => {
    const { client, scrapeSearch, apiSearch } = makeClient("scrape");
    const r = await client.search({ q: "hi" });
    expect(r.meta.impl).toBe("scrape");
    expect(scrapeSearch).toHaveBeenCalledOnce();
    expect(apiSearch).not.toHaveBeenCalled();
  });

  it("api mode always hits the api impl", async () => {
    const { client, scrapeSearch, apiSearch } = makeClient("api");
    const r = await client.search({ q: "hi" });
    expect(r.meta.impl).toBe("api");
    expect(apiSearch).toHaveBeenCalledOnce();
    expect(scrapeSearch).not.toHaveBeenCalled();
  });

  it("hybrid defaults to scrape for kagi_search_fetch", async () => {
    const { client, scrapeSearch, apiSearch } = makeClient("hybrid");
    await client.search({ q: "hi" });
    expect(scrapeSearch).toHaveBeenCalledOnce();
    expect(apiSearch).not.toHaveBeenCalled();
  });

  it("hybrid honors impl=api override on the caller", async () => {
    const { client, scrapeSearch, apiSearch } = makeClient("hybrid");
    await client.search({ q: "hi", impl: "api" });
    expect(apiSearch).toHaveBeenCalledOnce();
    expect(scrapeSearch).not.toHaveBeenCalled();
  });

  it("scrape mode refuses impl=api override", async () => {
    const { client } = makeClient("scrape");
    await expect(client.search({ q: "hi", impl: "api" })).rejects.toThrow(
      /Cannot force impl='api' in mode='scrape'/,
    );
  });

  it("summarize follows the same dispatch rules", async () => {
    const { client: hybridClient, scrapeSummarize, apiSummarize } = makeClient("hybrid");
    await hybridClient.summarize({
      kind: "url",
      ref: "https://example.com",
      language: "EN",
      style: "summary",
    });
    expect(scrapeSummarize).toHaveBeenCalledOnce();
    expect(apiSummarize).not.toHaveBeenCalled();
  });
});

describe("api impl configuration errors", () => {
  it("api-mode search without KAGI_API_KEY throws KagiNotConfiguredError", async () => {
    vi.restoreAllMocks();
    const client = new KagiClient(env({ KAGI_MODE: "api", KAGI_API_KEY: "" }));
    // resolveMode succeeds because KAGI_MODE=api is explicit, but the client
    // itself refuses when it's not actually configured.
    // (Empty-string API key resolves to KAGI_MODE=api since it was explicit.)
    await expect(client.search({ q: "hi" })).rejects.toBeInstanceOf(
      KagiNotConfiguredError,
    );
  });
});
