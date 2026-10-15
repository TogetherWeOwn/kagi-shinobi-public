// engine=kagi|searxng|auto dispatch on KagiClient.search.
//
// Same mocking style as dispatcher.test.ts: the scrape/api impls are spied
// prototypes, and SearxngClient is mocked at the module level (its fetch
// would otherwise leave the unit project). What these pin is the facade's
// own decisions — which engine serves, when auto falls over, and what the
// caller sees in each case — not the impls' internals.
//
// The acceptance test for this card lives here as "budget at 0, auto still
// succeeds": api mode with MAX_API_CENTS_PER_MONTH=0 throws
// budget_exceeded out of the real spend guard, and auto must serve SearXNG
// with the same schema anyway. The guard needs the Meter stub from
// test/_helpers.ts, so the api-mode case builds its env with makeEnv().

import { afterEach, describe, expect, it, vi } from "vitest";
import { KagiClient } from "../../src/kagi/client";
import { KagiScrapeClient } from "../../src/kagi/scrape/index";
import { KagiApiImpl } from "../../src/kagi/api/index";
import { SearxngClient } from "../../src/searxng/client";
import {
  KagiAuthError,
  KagiBudgetExceededError,
  KagiNotConfiguredError,
} from "../../src/kagi/errors";
import type { SearchResponse } from "../../src/kagi/types";
import type { Env } from "../../src/env";
import { makeEnv } from "../_helpers";

function env(overrides: Partial<Env> = {}): Env {
  return { ADMIN_TOKEN: "x", ...overrides } as Env;
}

const kagiResponse = (impl: "scrape" | "api", q: string): SearchResponse => ({
  query: q,
  results: [],
  meta: { impl, cache_hit: false, elapsed_ms: 0 },
});

const searxngResponse = (q: string): SearchResponse => ({
  query: q,
  results: [
    {
      rank: 1,
      url: "https://a.example",
      title: "A",
      snippet: "a",
      source_domain: "a.example",
      source_impl: "searxng",
    },
  ],
  meta: {
    impl: "searxng",
    cache_hit: false,
    elapsed_ms: 1,
    warnings: ["Served by the SearXNG fallback: free and unlimited, but noisier than Kagi."],
  },
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Facade with the Kagi impls stubbed and SearXNG stubbed at the module level. */
function makeClient(mode: "scrape" | "api" | "hybrid", overrides: Partial<Env> = {}) {
  const e = env({
    KAGI_MODE: mode,
    KAGI_SESSION_TOKEN: "s",
    KAGI_API_KEY: "k",
    SEARXNG_BASE_URL: "https://searxng.internal.example",
    ...overrides,
  });
  const client = new KagiClient(e);

  const scrapeSearch = vi
    .spyOn(KagiScrapeClient.prototype, "search")
    .mockImplementation(async ({ q }) => kagiResponse("scrape", q));
  const apiSearch = vi
    .spyOn(KagiApiImpl.prototype, "search")
    .mockImplementation(async ({ q }) => kagiResponse("api", q));
  const searxngSearch = vi
    .spyOn(SearxngClient.prototype, "search")
    .mockImplementation(async ({ q }) => searxngResponse(q));

  return { client, scrapeSearch, apiSearch, searxngSearch };
}

describe("engine dispatch", () => {
  it("defaults to engine=kagi: scrape mode hits the scrape impl, SearXNG untouched", async () => {
    const { client, scrapeSearch, searxngSearch } = makeClient("scrape");

    const r = await client.search({ q: "hi" });

    expect(r.meta.impl).toBe("scrape");
    expect(scrapeSearch).toHaveBeenCalledOnce();
    expect(searxngSearch).not.toHaveBeenCalled();
  });

  it("engine=searxng goes straight to SearXNG with source_impl searxng", async () => {
    const { client, scrapeSearch, apiSearch, searxngSearch } = makeClient("hybrid");

    const r = await client.search({ q: "hi", engine: "searxng" });

    expect(searxngSearch).toHaveBeenCalledOnce();
    expect(searxngSearch).toHaveBeenCalledWith({ q: "hi", limit: undefined });
    expect(scrapeSearch).not.toHaveBeenCalled();
    expect(apiSearch).not.toHaveBeenCalled();
    expect(r.meta.impl).toBe("searxng");
    expect(r.results[0].source_impl).toBe("searxng");
  });

  it("engine=searxng passes limit through", async () => {
    const { client, searxngSearch } = makeClient("scrape");

    await client.search({ q: "hi", limit: 5, engine: "searxng" });

    expect(searxngSearch).toHaveBeenCalledWith({ q: "hi", limit: 5 });
  });

  it("engine=searxng refuses before the network when unconfigured", async () => {
    vi.restoreAllMocks();
    const e = env({ KAGI_MODE: "scrape", KAGI_SESSION_TOKEN: "s", SEARXNG_BASE_URL: "" });
    const client = new KagiClient(e);
    vi.spyOn(KagiScrapeClient.prototype, "search").mockImplementation(async ({ q }) =>
      kagiResponse("scrape", q),
    );

    await expect(client.search({ q: "hi", engine: "searxng" })).rejects.toBeInstanceOf(
      KagiNotConfiguredError,
    );
  });

  it("rejects impl paired with engine=searxng or engine=auto", async () => {
    const { client } = makeClient("hybrid");

    await expect(client.search({ q: "hi", engine: "searxng", impl: "api" })).rejects.toThrow(
      /impl only applies under engine='kagi'/,
    );
    await expect(client.search({ q: "hi", engine: "auto", impl: "scrape" })).rejects.toThrow(
      /impl only applies under engine='kagi'/,
    );
  });
});

describe("engine=auto", () => {
  it("serves Kagi while Kagi answers, without touching SearXNG", async () => {
    const { client, scrapeSearch, searxngSearch } = makeClient("scrape");

    const r = await client.search({ q: "hi", engine: "auto" });

    expect(r.meta.impl).toBe("scrape");
    expect(r.meta.warnings).toBeUndefined();
    expect(scrapeSearch).toHaveBeenCalledOnce();
    expect(searxngSearch).not.toHaveBeenCalled();
  });

  it("falls back to SearXNG on a Kagi auth failure, annotating meta.warnings", async () => {
    const { client, searxngSearch } = makeClient("scrape");
    vi.spyOn(KagiScrapeClient.prototype, "search").mockRejectedValueOnce(
      new KagiAuthError("session dead"),
    );

    const r = await client.search({ q: "hi", engine: "auto" });

    expect(searxngSearch).toHaveBeenCalledOnce();
    expect(r.meta.impl).toBe("searxng");
    expect(r.results[0].source_impl).toBe("searxng");
    expect(r.meta.warnings).toHaveLength(2);
    expect(r.meta.warnings?.[1]).toContain("Kagi unavailable (auth)");
  });

  it("with the Kagi budget at 0, auto still succeeds via SearXNG with the same schema", async () => {
    // Real spend guard (MemMeter from _helpers), cap 0: the api impl throws
    // budget_exceeded before any network call, exactly as production does.
    const e = makeEnv({
      KAGI_MODE: "api",
      KAGI_API_KEY: "k",
      MAX_API_CENTS_PER_MONTH: "0",
      SEARXNG_BASE_URL: "https://searxng.internal.example",
    });
    const client = new KagiClient(e);
    const searxngSearch = vi
      .spyOn(SearxngClient.prototype, "search")
      .mockImplementation(async ({ q }) => searxngResponse(q));

    const r = await client.search({ q: "hi", limit: 10, engine: "auto" });

    expect(searxngSearch).toHaveBeenCalledOnce();
    expect(r.query).toBe("hi");
    expect(r.results[0].source_impl).toBe("searxng");
    expect(r.meta.impl).toBe("searxng");
    expect(r.meta.warnings?.join(" ")).toContain("budget_exceeded");
  });

  it("rethrows the original Kagi error when SearXNG is unconfigured", async () => {
    vi.restoreAllMocks();
    const e = env({
      KAGI_MODE: "scrape",
      KAGI_SESSION_TOKEN: "s",
      SEARXNG_BASE_URL: "",
    });
    const client = new KagiClient(e);
    const cause = new KagiAuthError("session dead");
    vi.spyOn(KagiScrapeClient.prototype, "search").mockRejectedValue(cause);

    await expect(client.search({ q: "hi", engine: "auto" })).rejects.toBe(cause);
  });

  it("rethrows the original Kagi error when SearXNG fails too", async () => {
    const { client } = makeClient("scrape");
    const cause = new KagiAuthError("session dead");
    vi.spyOn(KagiScrapeClient.prototype, "search").mockRejectedValue(cause);
    vi.spyOn(SearxngClient.prototype, "search").mockRejectedValue(
      new KagiNotConfiguredError("searxng down"),
    );

    await expect(client.search({ q: "hi", engine: "auto" })).rejects.toBe(cause);
  });

  it("lets non-KagiError programming bugs propagate without trying the fallback", async () => {
    const { client, searxngSearch } = makeClient("scrape");
    vi.spyOn(KagiScrapeClient.prototype, "search").mockRejectedValueOnce(
      new TypeError("not a Kagi error"),
    );

    await expect(client.search({ q: "hi", engine: "auto" })).rejects.toBeInstanceOf(TypeError);
    expect(searxngSearch).not.toHaveBeenCalled();
  });

  it("budget_exceeded from the facade surfaces the Kagi error when the fallback is down", async () => {
    vi.restoreAllMocks();
    const e = env({
      KAGI_MODE: "api",
      KAGI_API_KEY: "k",
      MAX_API_CENTS_PER_MONTH: "0",
      SEARXNG_BASE_URL: "",
    });
    // No Meter stub on this bare env — the api impl's requireConfigured passes
    // (key present) and guardBillable throws budget_exceeded against... the
    // real env.METER is undefined here, so stub the impl surface instead: the
    // point is auto maps a Kagi-side budget refusal, whatever raised it.
    const client = new KagiClient(e);
    const cause = new KagiBudgetExceededError(0, 0);
    vi.spyOn(KagiApiImpl.prototype, "search").mockRejectedValue(cause);

    await expect(client.search({ q: "hi", engine: "auto" })).rejects.toBe(cause);
  });
});
