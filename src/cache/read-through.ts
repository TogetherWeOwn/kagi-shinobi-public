// Read-through result cache in front of the KagiClient facade (ADR 0017).
//
//   L1  Cache API (caches.default) — per-colo, free to read. Misses (or
//       throws) on *.workers.dev and inside some contexts; any failure is an
//       ordinary miss.
//   L2  ResultCache Durable Object — authoritative, answers everywhere, and
//       owns single-flight via `acquire()`.
//
// The facade calls `readThrough()` before dispatching to an impl, so a hit
// never reaches `takeKagiCall` or `guardBillable`: a repeat query within TTL
// makes 0 Kagi calls and consumes 0 budget. The cache is an optimization —
// every L2 failure fails open to a direct fetch.
//
// Only this file's types come from store.ts; the value import would pull
// `cloudflare:workers` into the Node unit project via client.ts.

import type { Env } from "../env.js";
import type { MetaBlock } from "../kagi/types.js";
import type { AcquireResult, ResultCache } from "./store.js";
import { CLAIM_LEASE_MS, RESULT_CACHE_NAME, TTL_SECONDS, cacheKey, type CacheDomain } from "./key.js";

const L1_ORIGIN = "https://result-cache.kagi-shinobi.internal/";
const FETCHED_AT_HEADER = "X-Fetched-At";
/** DO-SQLite caps a row at 2 MB; summarize_text can echo 1 MB of input. */
export const MAX_STORED_BYTES = 512 * 1024;
const POLL_INITIAL_MS = 25;
const POLL_MAX_MS = 500;

export type WaitUntil = (promise: Promise<unknown>) => void;

export interface ReadThroughOptions<T> {
  /**
   * Oldest acceptable entry, in seconds. `0` skips the read, fetches fresh and
   * still stores, refreshing the entry for the next caller.
   */
  maxAgeS?: number;
  /** Responses failing this are returned but not stored. Default: all. */
  storable?: (value: T) => boolean;
}

/** The RPC surface of a ResultCache stub that the read-through path uses. */
export interface CacheStub {
  acquire(key: string, domain: CacheDomain, nowMs: number, maxAgeS?: number): Promise<AcquireResult>;
  recordHit(domain: CacheDomain): Promise<void>;
  release(key: string): Promise<void>;
  store(key: string, domain: CacheDomain, body: string, fetchedAtMs: number): Promise<void>;
}

/** The ResultCache stub, or null when the binding is absent (cache off). */
export function resultCacheStub(env: Env): DurableObjectStub<ResultCache> | null {
  const ns = (env as Partial<Env>).RESULT_CACHE;
  if (!ns) return null;
  return ns.get(ns.idFromName(RESULT_CACHE_NAME));
}

export class ReadThroughCache {
  /**
   * @param waitUntil Runs post-response work (L1 writes, L1-hit counts) in the
   *   background. Absent, that work is awaited inline instead — never left
   *   floating.
   */
  constructor(
    private readonly stub: CacheStub | null,
    private readonly waitUntil?: WaitUntil,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {}

  async readThrough<T extends { meta: MetaBlock }>(
    domain: CacheDomain,
    engine: string,
    args: Record<string, unknown>,
    fetcher: () => Promise<T>,
    opts: ReadThroughOptions<T> = {},
  ): Promise<T> {
    const stub = this.stub;
    if (!stub) return fetcher();
    const start = this.now();
    const key = await cacheKey(domain, engine, args);

    if (opts.maxAgeS === 0) {
      const value = await fetcher();
      await this.persist(stub, key, domain, value, opts, false);
      return value;
    }

    const l1 = await this.l1Get(key);
    if (l1) {
      const ageS = Math.max(0, Math.floor((start - l1.fetchedAt) / 1000));
      if (ageS < TTL_SECONDS[domain] && (opts.maxAgeS === undefined || ageS <= opts.maxAgeS)) {
        await this.background(stub.recordHit(domain));
        return this.asHit<T>(l1.body, ageS, start);
      }
    }

    const deadline = start + CLAIM_LEASE_MS + 5_000;
    let delay = POLL_INITIAL_MS;
    for (;;) {
      let r: AcquireResult;
      try {
        r = await stub.acquire(key, domain, this.now(), opts.maxAgeS);
      } catch {
        return fetcher();
      }
      if (r.status === "hit") {
        await this.background(this.l1Put(key, domain, r.body, r.fetched_at));
        return this.asHit<T>(r.body, r.age_s, start);
      }
      if (r.status === "claimed") {
        let value: T;
        try {
          value = await fetcher();
        } catch (err) {
          await swallow(stub.release(key));
          throw err;
        }
        await this.persist(stub, key, domain, value, opts, true);
        return value;
      }
      // Pending: another caller is fetching. Its lease expiring turns the
      // next acquire into "claimed", so this loop ends on its own; the
      // deadline only guards against a misbehaving store.
      if (this.now() >= deadline) return fetcher();
      await this.sleep(delay);
      delay = Math.min(delay * 2, POLL_MAX_MS);
    }
  }

  private async persist<T>(
    stub: CacheStub,
    key: string,
    domain: CacheDomain,
    value: T,
    opts: ReadThroughOptions<T>,
    claimed: boolean,
  ): Promise<void> {
    const body = JSON.stringify(value);
    const ok = (opts.storable?.(value) ?? true) && body.length <= MAX_STORED_BYTES;
    if (!ok) {
      if (claimed) await swallow(stub.release(key));
      return;
    }
    const fetchedAt = this.now();
    // Awaited, not backgrounded: pollers are waiting on exactly this row.
    await swallow(stub.store(key, domain, body, fetchedAt));
    await this.background(this.l1Put(key, domain, body, fetchedAt));
  }

  private asHit<T extends { meta: MetaBlock }>(body: string, ageS: number, start: number): T {
    const value = JSON.parse(body) as T;
    const meta: MetaBlock = {
      ...value.meta,
      cache_hit: true,
      cache_age_s: ageS,
      elapsed_ms: Math.max(0, this.now() - start),
    };
    // Spend was settled when the entry was fetched; this call cost nothing.
    if (meta.cost_cents !== undefined) meta.cost_cents = 0;
    // These describe the upstream call that filled the entry, not this one.
    delete meta.refresh_triggered;
    delete meta.session_stale;
    return { ...value, meta };
  }

  private async l1Get(key: string): Promise<{ body: string; fetchedAt: number } | null> {
    try {
      const hit = await caches.default.match(L1_ORIGIN + key);
      if (!hit) return null;
      const fetchedAt = Number(hit.headers.get(FETCHED_AT_HEADER));
      if (!Number.isFinite(fetchedAt)) return null;
      return { body: await hit.text(), fetchedAt };
    } catch {
      return null;
    }
  }

  private async l1Put(key: string, domain: CacheDomain, body: string, fetchedAt: number): Promise<void> {
    const remainingS = TTL_SECONDS[domain] - Math.floor((this.now() - fetchedAt) / 1000);
    if (remainingS <= 0) return;
    await caches.default.put(
      L1_ORIGIN + key,
      new Response(body, {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": `max-age=${remainingS}`,
          [FETCHED_AT_HEADER]: String(fetchedAt),
        },
      }),
    );
  }

  private async background(work: Promise<unknown>): Promise<void> {
    const safe = swallow(work);
    if (this.waitUntil) this.waitUntil(safe);
    else await safe;
  }
}

async function swallow(work: Promise<unknown>): Promise<void> {
  try {
    await work;
  } catch {
    // Best-effort cache bookkeeping must never fail a request.
  }
}
