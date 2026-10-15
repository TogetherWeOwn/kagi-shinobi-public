// Read-through result cache (ADR 0017): the ResultCache Durable Object, the
// ReadThroughCache in front of it, and the KagiClient facade wired through it.
//
// Runs in workerd against the real DO and the real caches.default. DO SQL
// storage is NOT rolled back between tests (see vitest.config.ts), and L1 is
// keyed by the same digest as L2, so every test uses its own DO instance name
// and its own query text — nothing here may depend on another test's rows.

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import { CLAIM_LEASE_MS, TTL_SECONDS, cacheKey, type CacheDomain } from "../../src/cache/key";
import { MAX_STORED_BYTES, ReadThroughCache, type CacheStub } from "../../src/cache/read-through";
import type { AcquireResult } from "../../src/cache/store";
import { KagiClient } from "../../src/kagi/client";
import { KagiScrapeClient } from "../../src/kagi/scrape/index";
import { SearxngClient } from "../../src/searxng/client";
import { KagiUpstreamError } from "../../src/kagi/errors";
import type { MetaBlock, SearchResponse } from "../../src/kagi/types";

const T0 = Date.UTC(2026, 9, 2, 12, 0, 0);
const HOUR_MS = 3_600_000;

function cache(name: string) {
  return env.RESULT_CACHE.get(env.RESULT_CACHE.idFromName(name));
}

/** A unique query, so neither L1 nor the shared "result-cache" DO has seen it. */
function uniq(label: string): string {
  return `${label} ${crypto.randomUUID()}`;
}

interface Fake {
  q: string;
  n: number;
  meta: MetaBlock;
}

/** A fetcher that counts its calls and returns a distinguishable value. */
function counter(q: string, meta: Partial<MetaBlock> = {}) {
  let n = 0;
  const fetcher = vi.fn(async (): Promise<Fake> => {
    n += 1;
    return { q, n, meta: { impl: "scrape", cache_hit: false, elapsed_ms: 7, ...meta } };
  });
  return fetcher;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ResultCache.acquire", () => {
  it("claims a cold key once, then reports pending to everyone else", async () => {
    const c = cache("acq-claim");
    expect(await c.acquire("k", "search", T0)).toEqual({ status: "claimed" });
    expect(await c.acquire("k", "search", T0 + 10)).toEqual({ status: "pending" });
    expect(await c.acquire("k", "search", T0 + 20)).toEqual({ status: "pending" });
    expect((await c.stats()).misses).toBe(1);
  });

  it("serves a stored entry as a hit with its age", async () => {
    const c = cache("acq-hit");
    await c.acquire("k", "search", T0);
    await c.store("k", "search", '{"x":1}', T0);

    expect(await c.acquire("k", "search", T0 + 90_500)).toEqual({
      status: "hit",
      body: '{"x":1}',
      age_s: 90,
      fetched_at: T0,
    });
  });

  it("lets the next caller take over a claim whose lease ran out", async () => {
    const c = cache("acq-lease");
    expect((await c.acquire("k", "search", T0)).status).toBe("claimed");
    expect((await c.acquire("k", "search", T0 + CLAIM_LEASE_MS - 1)).status).toBe("pending");
    expect((await c.acquire("k", "search", T0 + CLAIM_LEASE_MS)).status).toBe("claimed");
    expect((await c.stats()).misses).toBe(2);
  });

  it("lets the next caller claim at once after a release", async () => {
    const c = cache("acq-release");
    await c.acquire("k", "fastgpt", T0);
    await c.release("k");
    expect((await c.acquire("k", "fastgpt", T0 + 1)).status).toBe("claimed");
  });

  it("expires an entry at its domain's TTL and deletes it on the way past", async () => {
    const c = cache("acq-ttl");
    await c.store("k", "fastgpt", "{}", T0);
    const ttlMs = TTL_SECONDS.fastgpt * 1000;

    expect((await c.acquire("k", "fastgpt", T0 + ttlMs - 1000)).status).toBe("hit");
    expect((await c.acquire("k", "fastgpt", T0 + ttlMs)).status).toBe("claimed");
    expect((await c.stats()).entries).toBe(0);
  });

  it("treats an entry older than max_age_s as absent but keeps it for looser callers", async () => {
    const c = cache("acq-maxage");
    await c.store("k", "search", "{}", T0);

    expect((await c.acquire("k", "search", T0 + 100_000, 50)).status).toBe("claimed");
    expect((await c.acquire("k", "search", T0 + 100_000, 200)).status).toBe("hit");
    expect((await c.acquire("k", "search", T0 + 100_000, 0)).status).toBe("pending");
  });
});

describe("ResultCache.purge and stats", () => {
  it("deletes only entries past their own domain's TTL, and reports how many", async () => {
    const c = cache("purge-ttl");
    await c.store("s", "search", "{}", T0);
    await c.store("f", "fastgpt", "{}", T0);
    await c.store("m", "summarize", "{}", T0);

    expect(await c.purge(T0 + 6 * HOUR_MS)).toBe(1);
    expect((await c.stats()).entries).toBe(2);
    expect(await c.purge(T0 + 24 * HOUR_MS)).toBe(1);
    expect(await c.purge(T0 + 7 * 24 * HOUR_MS)).toBe(1);
    expect((await c.stats()).entries).toBe(0);
  });

  it("drops claims past their lease", async () => {
    const c = cache("purge-claims");
    await c.acquire("k", "search", T0);
    await c.purge(T0 + CLAIM_LEASE_MS);
    // Earlier clock on purpose: only a deleted claim answers "claimed" here.
    expect((await c.acquire("k", "search", T0 + 1)).status).toBe("claimed");
  });

  it("keeps cumulative counters across a purge and derives the hit rate", async () => {
    const c = cache("stats");
    expect((await c.stats()).hit_rate).toBe(0);

    await c.acquire("k", "search", T0);
    await c.store("k", "search", "{}", T0);
    await c.acquire("k", "search", T0 + 1000);
    await c.recordHit("summarize");
    await c.purge(T0 + 25 * HOUR_MS);

    const stats = await c.stats();
    expect(stats).toMatchObject({ hits: 2, misses: 1, stores: 1, entries: 0 });
    expect(stats.hit_rate).toBeCloseTo(2 / 3);
    expect(stats.by_domain.search).toEqual({ hits: 1, misses: 1, stores: 1 });
    expect(stats.by_domain.summarize).toEqual({ hits: 1, misses: 0, stores: 0 });
    expect(stats.by_domain.fastgpt).toEqual({ hits: 0, misses: 0, stores: 0 });
  });
});

describe("ReadThroughCache", () => {
  function rt(name: string, opts: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {}) {
    const stub = cache(name) as unknown as CacheStub;
    return { stub, rtc: new ReadThroughCache(stub, undefined, opts.now, opts.sleep) };
  }

  it("fetches directly every time when the cache is off", async () => {
    const rtc = new ReadThroughCache(null);
    const fetcher = counter("off");
    await rtc.readThrough("search", "kagi", { q: "off" }, fetcher);
    await rtc.readThrough("search", "kagi", { q: "off" }, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("makes zero upstream calls for a repeat within TTL, and marks the hit", async () => {
    const { stub, rtc } = rt("rt-repeat");
    const q = uniq("repeat");
    const fetcher = counter(q, { cost_cents: 2, refresh_triggered: true, session_stale: true });

    const first = await rtc.readThrough("search", "kagi", { q }, fetcher);
    const second = await rtc.readThrough("search", "kagi", { q }, fetcher);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(first.meta.cache_hit).toBe(false);
    expect(second.n).toBe(1);
    expect(second.meta).toMatchObject({ cache_hit: true, cost_cents: 0 });
    expect(second.meta.cache_age_s).toBeGreaterThanOrEqual(0);
    expect(second.meta).not.toHaveProperty("refresh_triggered");
    expect(second.meta).not.toHaveProperty("session_stale");
    // Second call was an L1 hit; it still counts toward the hit rate.
    expect(await (stub as unknown as ReturnType<typeof cache>).stats()).toMatchObject({
      hits: 1,
      misses: 1,
      stores: 1,
    });
  });

  it("serves from L2 when L1 misses, then refills L1", async () => {
    const { stub, rtc } = rt("rt-l2");
    const q = uniq("l2");
    const key = await cacheKey("fastgpt", "kagi", { q });
    const body = JSON.stringify({ q, n: 41, meta: { impl: "scrape", cache_hit: false, elapsed_ms: 1 } });
    await stub.store(key, "fastgpt", body, Date.now() - 5_000);
    const fetcher = counter(q);

    const viaL2 = await rtc.readThrough("fastgpt", "kagi", { q }, fetcher);
    const viaL1 = await rtc.readThrough("fastgpt", "kagi", { q }, fetcher);

    expect(fetcher).not.toHaveBeenCalled();
    expect(viaL2).toMatchObject({ n: 41, meta: { cache_hit: true } });
    expect(viaL2.meta.cache_age_s).toBeGreaterThanOrEqual(5);
    expect(viaL1.n).toBe(41);
    expect(await caches.default.match(`https://result-cache.kagi-shinobi.internal/${key}`)).toBeTruthy();
  });

  it("coalesces 10 identical concurrent queries into 1 upstream call", async () => {
    const { rtc } = rt("rt-single-flight");
    const q = uniq("flight");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetcher = vi.fn(async (): Promise<Fake> => {
      await gate;
      return { q, n: 1, meta: { impl: "scrape", cache_hit: false, elapsed_ms: 0 } };
    });

    const all = Promise.all(
      Array.from({ length: 10 }, () => rtc.readThrough("search", "kagi", { q }, fetcher)),
    );
    await new Promise((r) => setTimeout(r, 50));
    release();
    const results = await all;

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r.n === 1)).toBe(true);
    expect(results.filter((r) => r.meta.cache_hit)).toHaveLength(9);
  });

  it("max_age_s=0 skips the read, fetches fresh, and still stores", async () => {
    const { stub, rtc } = rt("rt-bypass");
    const q = uniq("bypass");
    const fetcher = counter(q);

    await rtc.readThrough("search", "kagi", { q }, fetcher);
    const fresh = await rtc.readThrough("search", "kagi", { q }, fetcher, { maxAgeS: 0 });
    const after = await rtc.readThrough("search", "kagi", { q }, fetcher);

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fresh).toMatchObject({ n: 2, meta: { cache_hit: false } });
    expect(after).toMatchObject({ n: 2, meta: { cache_hit: true } });
    expect((await (stub as unknown as ReturnType<typeof cache>).stats()).stores).toBe(2);
  });

  it("re-fetches when the cached entry is older than max_age_s", async () => {
    let now = Date.now();
    const { rtc } = rt("rt-maxage", { now: () => now });
    const q = uniq("maxage");
    const fetcher = counter(q);

    await rtc.readThrough("search", "kagi", { q }, fetcher);
    now += 120_000;
    const within = await rtc.readThrough("search", "kagi", { q }, fetcher, { maxAgeS: 600 });
    const tooOld = await rtc.readThrough("search", "kagi", { q }, fetcher, { maxAgeS: 60 });

    expect(within).toMatchObject({ n: 1, meta: { cache_hit: true, cache_age_s: 120 } });
    expect(tooOld).toMatchObject({ n: 2, meta: { cache_hit: false } });
  });

  it("re-fetches past the TTL even when L1 still holds the entry", async () => {
    let now = Date.now();
    const { rtc } = rt("rt-l1-ttl", { now: () => now });
    const q = uniq("l1ttl");
    const fetcher = counter(q);

    await rtc.readThrough("fastgpt", "kagi", { q }, fetcher);
    now += TTL_SECONDS.fastgpt * 1000;
    const again = await rtc.readThrough("fastgpt", "kagi", { q }, fetcher);

    expect(again.n).toBe(2);
  });

  it("releases the claim when the fetch fails, so the next caller fetches at once", async () => {
    const { rtc } = rt("rt-error");
    const q = uniq("error");
    const fetcher = vi
      .fn<() => Promise<Fake>>()
      .mockRejectedValueOnce(new Error("upstream down"))
      .mockResolvedValueOnce({ q, n: 2, meta: { impl: "scrape", cache_hit: false, elapsed_ms: 0 } });

    await expect(rtc.readThrough("search", "kagi", { q }, fetcher)).rejects.toThrow("upstream down");
    const retry = await rtc.readThrough("search", "kagi", { q }, fetcher);

    expect(retry.n).toBe(2);
  });

  it("returns but does not store a response the caller marks unstorable", async () => {
    const { rtc } = rt("rt-unstorable");
    const q = uniq("unstorable");
    const fetcher = counter(q);
    const storable = () => false;

    await rtc.readThrough("search", "auto", { q }, fetcher, { storable });
    const again = await rtc.readThrough("search", "auto", { q }, fetcher, { storable });

    expect(again).toMatchObject({ n: 2, meta: { cache_hit: false } });
  });

  it(`does not store a body over ${MAX_STORED_BYTES} bytes`, async () => {
    const { rtc } = rt("rt-oversize");
    const q = uniq("oversize");
    const big = "x".repeat(MAX_STORED_BYTES);
    const fetcher = vi.fn(async () => ({ big, meta: { impl: "api", cache_hit: false, elapsed_ms: 0 } as MetaBlock }));

    await rtc.readThrough("summarize", "kagi", { q }, fetcher);
    await rtc.readThrough("summarize", "kagi", { q }, fetcher, { maxAgeS: 0 });
    await rtc.readThrough("summarize", "kagi", { q }, fetcher);

    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("fails open to a direct fetch when the store is unreachable", async () => {
    const broken: CacheStub = {
      acquire: async () => {
        throw new Error("Durable Object unreachable");
      },
      recordHit: async () => {},
      release: async () => {},
      store: async () => {
        throw new Error("Durable Object unreachable");
      },
    };
    const rtc = new ReadThroughCache(broken);
    const q = uniq("broken");
    const fetcher = counter(q);

    const a = await rtc.readThrough("search", "kagi", { q }, fetcher);
    const b = await rtc.readThrough("search", "kagi", { q }, fetcher, { maxAgeS: 0 });

    expect([a.n, b.n]).toEqual([1, 2]);
  });

  it("stops polling a key that never settles and fetches itself", async () => {
    let now = T0;
    const pending: CacheStub = {
      acquire: async (): Promise<AcquireResult> => ({ status: "pending" }),
      recordHit: async () => {},
      release: async () => {},
      store: async () => {},
    };
    const sleeps: number[] = [];
    const rtc = new ReadThroughCache(pending, undefined, () => now, async (ms) => {
      sleeps.push(ms);
      now += ms * 20;
    });
    const fetcher = counter(uniq("stuck"));

    const value = await rtc.readThrough("search", "kagi", { q: "stuck" }, fetcher);

    expect(value.n).toBe(1);
    expect(sleeps.slice(0, 6)).toEqual([25, 50, 100, 200, 400, 500]);
  });

  it("skips the L1 write for an L2 hit with no TTL left", async () => {
    const domain: CacheDomain = "fastgpt";
    const q = uniq("edge");
    const fetchedAt = Date.now() - TTL_SECONDS[domain] * 1000;
    const body = JSON.stringify({ q, n: 9, meta: { impl: "scrape", cache_hit: false, elapsed_ms: 0 } });
    const edge: CacheStub = {
      acquire: async (): Promise<AcquireResult> => ({ status: "hit", body, age_s: 0, fetched_at: fetchedAt }),
      recordHit: async () => {},
      release: async () => {},
      store: async () => {},
    };

    const value = await new ReadThroughCache(edge).readThrough(domain, "kagi", { q }, counter(q));

    expect(value.n).toBe(9);
    const key = await cacheKey(domain, "kagi", { q });
    expect(await caches.default.match(`https://result-cache.kagi-shinobi.internal/${key}`)).toBeUndefined();
  });

  it("ignores an L1 entry without a fetched-at stamp", async () => {
    const { rtc } = rt("rt-l1-junk");
    const q = uniq("junk");
    const key = await cacheKey("search", "kagi", { q });
    await caches.default.put(
      `https://result-cache.kagi-shinobi.internal/${key}`,
      new Response('{"n":0}', { headers: { "Cache-Control": "max-age=600" } }),
    );
    const fetcher = counter(q);

    expect((await rtc.readThrough("search", "kagi", { q }, fetcher)).n).toBe(1);
  });

  it("hands background work to waitUntil instead of awaiting it", async () => {
    const pendingWork: Promise<unknown>[] = [];
    const stub = cache("rt-waituntil") as unknown as CacheStub;
    const rtc = new ReadThroughCache(stub, (p) => pendingWork.push(p));
    const q = uniq("waituntil");
    const fetcher = counter(q);

    await rtc.readThrough("search", "kagi", { q }, fetcher);
    await Promise.all(pendingWork);
    await rtc.readThrough("search", "kagi", { q }, fetcher);
    await Promise.all(pendingWork);

    expect(pendingWork.length).toBeGreaterThanOrEqual(2);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("KagiClient through the result cache", () => {
  const scrapeEnv = { ...env, KAGI_MODE: "scrape", KAGI_SESSION_TOKEN: "s" } as typeof env;

  function fakeSearch(impl: "scrape" | "searxng", q: string): SearchResponse {
    return { query: q, results: [], meta: { impl, cache_hit: false, elapsed_ms: 3 } } as SearchResponse;
  }

  it("answers a repeat search within TTL with zero Kagi calls", async () => {
    const scrape = vi
      .spyOn(KagiScrapeClient.prototype, "search")
      .mockImplementation(async ({ q }) => fakeSearch("scrape", q));
    const client = new KagiClient(scrapeEnv);
    const q = uniq("facade");

    await client.search({ q });
    const repeat = await client.search({ q: ` ${q} `, limit: 10 });
    await client.search({ q, max_age_s: 0 });

    expect(scrape).toHaveBeenCalledTimes(2);
    expect(repeat.meta).toMatchObject({ cache_hit: true });
    expect(typeof repeat.meta.cache_age_s).toBe("number");
  });

  it("does not store a SearXNG fallback under engine=auto", async () => {
    const kagi = vi.spyOn(KagiScrapeClient.prototype, "search").mockRejectedValue(new KagiUpstreamError(503, "down"));
    vi.spyOn(SearxngClient.prototype, "search").mockImplementation(async ({ q }) => fakeSearch("searxng", q));
    const client = new KagiClient(scrapeEnv);
    const q = uniq("auto");

    const first = await client.search({ q, engine: "auto" });
    const second = await client.search({ q, engine: "auto" });

    expect(first.meta.impl).toBe("searxng");
    expect(second.meta.cache_hit).toBe(false);
    expect(kagi).toHaveBeenCalledTimes(2);
  });

  it("shares a summary across confirm_muriel, which is a spend gate, not a result arg", async () => {
    const summarize = vi.spyOn(KagiScrapeClient.prototype, "summarize").mockImplementation(async () => ({
      source: { kind: "url", ref: "https://example.test" },
      summary: "ok",
      engine_used: "scrape-default",
      target_language: "EN",
      meta: { impl: "scrape", cache_hit: false, elapsed_ms: 0 },
    }));
    const client = new KagiClient(scrapeEnv);
    const ref = `https://example.test/${crypto.randomUUID()}`;

    await client.summarize({ kind: "url", ref, language: "EN", style: "summary" });
    const hit = await client.summarize({ kind: "url", ref, language: "EN", style: "summary", confirm_muriel: true });

    expect(summarize).toHaveBeenCalledTimes(1);
    expect(hit.meta.cache_hit).toBe(true);
  });

  it("treats fastgpt cache:false as a forced refresh", async () => {
    const fast = vi.spyOn(KagiScrapeClient.prototype, "fastGPT").mockImplementation(async ({ query }) => ({
      query,
      answer: "answer",
      references: [],
      meta: { impl: "scrape", cache_hit: false, elapsed_ms: 0 },
    }));
    const client = new KagiClient(scrapeEnv);
    const query = uniq("fastgpt");

    await client.fastGPT({ query });
    await client.fastGPT({ query });
    await client.fastGPT({ query, cache: false });

    expect(fast).toHaveBeenCalledTimes(2);
  });
});

describe("scheduled() purge", () => {
  it("removes expired entries from the shared result cache", async () => {
    const shared = cache("result-cache");
    const key = await cacheKey("summarize", "kagi", { ref: uniq("cron") });
    await shared.store(key, "summarize", "{}", Date.now() - TTL_SECONDS.summarize * 1000 - 1);
    const before = (await shared.stats()).entries;

    const ctx = createExecutionContext();
    await worker.scheduled({} as ScheduledController, env, ctx);
    await waitOnExecutionContext(ctx);

    expect((await shared.stats()).entries).toBe(before - 1);
  });
});
