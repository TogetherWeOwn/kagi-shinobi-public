// KagiScrapeClient — session handling and the retry-once-on-401 flow.
//
// Everything the client reaches for is mocked: the raw scrapers, the token
// store, the browser refresh, and the three sibling scrape modules. That keeps
// the subject of each test to the client's own decisions (when to refresh,
// when to serve a stale token, when to fail cold) and cuts the import chain
// before @cloudflare/puppeteer so this suite stays in the fast Node project.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  KagiAuthError,
  KagiNotConfiguredError,
  KagiUpstreamError,
} from "../../src/kagi/errors";
import type { Env } from "../../src/env";

const mocks = vi.hoisted(() => ({
  rawSearch: vi.fn(),
  rawSummarize: vi.fn(),
  loadToken: vi.fn(),
  markStale: vi.fn(),
  refreshTokenViaBrowser: vi.fn(),
  scrapeSmallWeb: vi.fn(),
  scrapeRank: vi.fn(),
  scrapeFastGPT: vi.fn(),
  takeKagiCall: vi.fn(),
}));

vi.mock("../../src/kagi/search.js", () => ({ search: mocks.rawSearch }));
vi.mock("../../src/kagi/summarize.js", () => ({ summarize: mocks.rawSummarize }));
vi.mock("../../src/token/store.js", () => ({
  loadToken: mocks.loadToken,
  markStale: mocks.markStale,
}));
vi.mock("../../src/token/refresh.js", () => ({
  refreshTokenViaBrowser: mocks.refreshTokenViaBrowser,
}));
vi.mock("../../src/kagi/scrape/smallweb.js", () => ({ scrapeSmallWeb: mocks.scrapeSmallWeb }));
vi.mock("../../src/kagi/scrape/rank.js", () => ({ scrapeRank: mocks.scrapeRank }));
vi.mock("../../src/kagi/scrape/fastgpt.js", () => ({ scrapeFastGPT: mocks.scrapeFastGPT }));
// The global call budget (ADR 0013) is pinned in test/kagi/budget.test.ts and
// test/workers/kagi-budget.test.ts; here it only needs to admit, and to be
// counted so each upstream call is shown to pass through it.
vi.mock("../../src/kagi/budget.js", () => ({ takeKagiCall: mocks.takeKagiCall }));

const { KagiScrapeClient } = await import("../../src/kagi/scrape/index");

const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;

const env = { ADMIN_TOKEN: "x" } as Env;

function client() {
  return new KagiScrapeClient(env);
}

/** A live token envelope, as store.ts would return it. */
function fresh(token = "tok-fresh") {
  return { token, updatedAt: Date.now(), source: "test", stale: false };
}

/** A stale envelope that went stale `agoMs` ago. */
function stale(agoMs: number, token = "tok-stale") {
  return {
    token,
    updatedAt: Date.now() - agoMs,
    source: "test",
    stale: true,
    staleAt: Date.now() - agoMs,
  };
}

const RAW_SEARCH = { data: [{ t: 0, url: "https://a.example/", title: "A", snippet: "s" }] };
const RAW_SUMMARY = { data: { output: "a summary" } };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rawSearch.mockResolvedValue(RAW_SEARCH);
  mocks.rawSummarize.mockResolvedValue(RAW_SUMMARY);
  mocks.loadToken.mockResolvedValue(fresh());
  mocks.refreshTokenViaBrowser.mockResolvedValue({ ok: true, token: "tok-refreshed" });
  mocks.scrapeSmallWeb.mockResolvedValue({ query: "", results: [] });
  mocks.scrapeRank.mockResolvedValue({ ranked: [] });
  mocks.scrapeFastGPT.mockResolvedValue({ answer: "42" });
});

describe("token acquisition", () => {
  it("uses a live token without triggering a refresh", async () => {
    const resp = await client().search({ q: "hi" });

    expect(mocks.rawSearch).toHaveBeenCalledWith("hi", "tok-fresh", 10);
    expect(mocks.refreshTokenViaBrowser).not.toHaveBeenCalled();
    expect(resp.meta.refresh_triggered).toBe(false);
    expect(resp.meta.session_stale).toBe(false);
  });

  it("bootstraps via Browser Rendering when no token exists at all", async () => {
    mocks.loadToken.mockResolvedValue(null);

    const resp = await client().search({ q: "hi" });

    expect(mocks.rawSearch).toHaveBeenCalledWith("hi", "tok-refreshed", 10);
    expect(resp.meta.refresh_triggered).toBe(true);
  });

  it("fails cold when there is no token and the refresh cannot run", async () => {
    mocks.loadToken.mockResolvedValue(null);
    mocks.refreshTokenViaBrowser.mockResolvedValue({
      ok: false,
      reason: "BROWSER binding missing",
    });

    await expect(client().search({ q: "hi" })).rejects.toThrow(
      /No Kagi session token available: BROWSER binding missing/,
    );
  });

  it("reports 'unknown' when the refresh gives no reason", async () => {
    mocks.loadToken.mockResolvedValue(null);
    mocks.refreshTokenViaBrowser.mockResolvedValue({ ok: false });

    await expect(client().search({ q: "hi" })).rejects.toThrow(
      /No Kagi session token available: unknown/,
    );
  });

  it("refreshes a stale token and reports the refresh", async () => {
    mocks.loadToken.mockResolvedValue(stale(60_000));

    const resp = await client().search({ q: "hi" });

    expect(mocks.rawSearch).toHaveBeenCalledWith("hi", "tok-refreshed", 10);
    expect(resp.meta.refresh_triggered).toBe(true);
    expect(resp.meta.session_stale).toBe(false);
  });

  it("serves a recently-stale token when the refresh fails, flagged as stale", async () => {
    mocks.loadToken.mockResolvedValue(stale(60_000));
    mocks.refreshTokenViaBrowser.mockResolvedValue({ ok: false, reason: "captcha" });

    const resp = await client().search({ q: "hi" });

    expect(mocks.rawSearch).toHaveBeenCalledWith("hi", "tok-stale", 10);
    expect(resp.meta.session_stale).toBe(true);
    expect(resp.meta.refresh_triggered).toBe(false);
  });

  it("fails cold once a token has been stale beyond twelve hours", async () => {
    mocks.loadToken.mockResolvedValue(stale(TWELVE_HOURS_MS + 60_000));
    mocks.refreshTokenViaBrowser.mockResolvedValue({ ok: false, reason: "captcha" });

    await expect(client().search({ q: "hi" })).rejects.toBeInstanceOf(KagiNotConfiguredError);
    await expect(client().search({ q: "hi" })).rejects.toThrow(
      /stale for 12h and refresh keeps failing \(captcha\)/,
    );
  });

  it("treats a stale envelope with no staleAt as freshly stale, not expired", async () => {
    mocks.loadToken.mockResolvedValue({
      token: "tok-nostaleat",
      updatedAt: Date.now(),
      source: "test",
      stale: true,
    });
    mocks.refreshTokenViaBrowser.mockResolvedValue({ ok: false, reason: "captcha" });

    const resp = await client().search({ q: "hi" });

    expect(resp.meta.session_stale).toBe(true);
  });

  it("does not fail cold when the refresh succeeds on a long-stale token", async () => {
    mocks.loadToken.mockResolvedValue(stale(TWELVE_HOURS_MS * 2));

    const resp = await client().search({ q: "hi" });

    expect(resp.meta.refresh_triggered).toBe(true);
  });
});

describe("search", () => {
  it("passes the caller's limit through and defaults it to 10", async () => {
    await client().search({ q: "hi", limit: 3 });
    await client().search({ q: "hi" });

    expect(mocks.rawSearch).toHaveBeenNthCalledWith(1, "hi", "tok-fresh", 3);
    expect(mocks.rawSearch).toHaveBeenNthCalledWith(2, "hi", "tok-fresh", 10);
  });

  it("normalizes into the canonical response", async () => {
    const resp = await client().search({ q: "hi" });

    expect(resp.query).toBe("hi");
    expect(resp.results[0]).toMatchObject({
      url: "https://a.example/",
      source_impl: "scrape",
    });
  });

  it("marks the session stale, refreshes, and retries once on a 401", async () => {
    mocks.rawSearch.mockRejectedValueOnce(new KagiAuthError()).mockResolvedValueOnce(RAW_SEARCH);

    const resp = await client().search({ q: "hi" });

    expect(mocks.markStale).toHaveBeenCalledWith(env, "search 401/403");
    expect(mocks.rawSearch).toHaveBeenNthCalledWith(2, "hi", "tok-refreshed", 10);
    expect(resp.meta.refresh_triggered).toBe(true);
    expect(resp.meta.session_stale).toBe(false);
  });

  it("surfaces KagiAuthError when the post-401 refresh cannot produce a token", async () => {
    mocks.rawSearch.mockRejectedValue(new KagiAuthError());
    mocks.refreshTokenViaBrowser.mockResolvedValue({ ok: false, reason: "captcha" });

    await expect(client().search({ q: "hi" })).rejects.toThrow(
      /token stale and refresh unavailable: captcha/,
    );
  });

  it("does not retry a non-auth failure", async () => {
    mocks.rawSearch.mockRejectedValue(new KagiUpstreamError(502, "Bad Gateway"));

    await expect(client().search({ q: "hi" })).rejects.toBeInstanceOf(KagiUpstreamError);
    expect(mocks.rawSearch).toHaveBeenCalledTimes(1);
    expect(mocks.markStale).not.toHaveBeenCalled();
  });
});

describe("summarize", () => {
  it("refuses raw text — the session flow has no text endpoint", async () => {
    await expect(
      client().summarize({ kind: "text", ref: "words", language: "EN", style: "summary" }),
    ).rejects.toBeInstanceOf(KagiNotConfiguredError);

    expect(mocks.rawSummarize).not.toHaveBeenCalled();
  });

  it("summarizes a URL and reports the scrape engine", async () => {
    const resp = await client().summarize({
      kind: "url",
      ref: "https://x.example",
      language: "DE",
      style: "takeaway",
    });

    expect(mocks.rawSummarize).toHaveBeenCalledWith("https://x.example", "tok-fresh", {
      type: "takeaway",
      language: "DE",
      isUrl: true,
    });
    expect(resp.engine_used).toBe("scrape-default");
    expect(resp.summary).toBe("a summary");
    expect(resp.meta.impl).toBe("scrape");
  });

  it("retries once on a 401 with a refreshed token", async () => {
    mocks.rawSummarize
      .mockRejectedValueOnce(new KagiAuthError())
      .mockResolvedValueOnce(RAW_SUMMARY);

    const resp = await client().summarize({
      kind: "url",
      ref: "https://x.example",
      language: "EN",
      style: "summary",
    });

    expect(mocks.markStale).toHaveBeenCalledWith(env, "summarize 401/403");
    expect(mocks.rawSummarize).toHaveBeenNthCalledWith(2, "https://x.example", "tok-refreshed", {
      type: "summary",
      language: "EN",
      isUrl: true,
    });
    expect(resp.meta.refresh_triggered).toBe(true);
  });

  it("does not retry a non-auth failure", async () => {
    mocks.rawSummarize.mockRejectedValue(new KagiUpstreamError(500, "Boom"));

    await expect(
      client().summarize({ kind: "url", ref: "https://x", language: "EN", style: "summary" }),
    ).rejects.toBeInstanceOf(KagiUpstreamError);
    expect(mocks.rawSummarize).toHaveBeenCalledTimes(1);
  });
});

describe("smallWeb", () => {
  it("browses the free RSS feed without a session when q is absent", async () => {
    await client().smallWeb({ limit: 5 });

    expect(mocks.scrapeSmallWeb).toHaveBeenCalledWith({ limit: 5 }, undefined);
    expect(mocks.loadToken).not.toHaveBeenCalled();
  });

  it("attaches the session cookie when searching within Small Web", async () => {
    await client().smallWeb({ q: "handmade" });

    expect(mocks.scrapeSmallWeb).toHaveBeenCalledWith({ q: "handmade" }, "tok-fresh");
  });
});

describe("rank", () => {
  it("always passes the session token through", async () => {
    await client().rank({ urls: ["https://a"], q: "widgets" });

    expect(mocks.scrapeRank).toHaveBeenCalledWith(
      { urls: ["https://a"], q: "widgets" },
      "tok-fresh",
      expect.any(Function),
    );
  });

  it("hands rank a per-probe hook that takes from the call budget", async () => {
    await client().rank({ urls: ["https://a"], q: "widgets" });
    const hook = mocks.scrapeRank.mock.calls[0][2] as () => Promise<void>;
    mocks.takeKagiCall.mockClear();
    await hook();
    expect(mocks.takeKagiCall).toHaveBeenCalledTimes(1);
  });
});

describe("call budget (ADR 0013)", () => {
  it("takes one call per upstream request", async () => {
    await client().search({ q: "x" });
    expect(mocks.takeKagiCall).toHaveBeenCalledTimes(1);
  });

  it("a refused budget stops the upstream call", async () => {
    mocks.takeKagiCall.mockRejectedValueOnce(new Error("budget"));
    await expect(client().search({ q: "x" })).rejects.toThrow("budget");
    expect(mocks.rawSearch).not.toHaveBeenCalled();
  });
});

describe("fastGPT", () => {
  it("passes the session token through", async () => {
    const resp = await client().fastGPT({ query: "why" });

    expect(mocks.scrapeFastGPT).toHaveBeenCalledWith({ query: "why" }, "tok-fresh");
    expect(resp.answer).toBe("42");
  });

  it("retries once on a 401 with a refreshed token", async () => {
    mocks.scrapeFastGPT
      .mockRejectedValueOnce(new KagiAuthError())
      .mockResolvedValueOnce({ answer: "42" });

    await client().fastGPT({ query: "why" });

    expect(mocks.markStale).toHaveBeenCalledWith(env, "fastgpt 401/403");
    expect(mocks.scrapeFastGPT).toHaveBeenNthCalledWith(2, { query: "why" }, "tok-refreshed");
  });

  it("does not retry a non-auth failure", async () => {
    mocks.scrapeFastGPT.mockRejectedValue(new KagiUpstreamError(503, "Down"));

    await expect(client().fastGPT({ query: "why" })).rejects.toBeInstanceOf(KagiUpstreamError);
    expect(mocks.scrapeFastGPT).toHaveBeenCalledTimes(1);
  });
});
