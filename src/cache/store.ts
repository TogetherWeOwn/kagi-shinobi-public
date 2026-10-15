// ResultCache — the authoritative L2 of the read-through result cache.
//
// The Cache API does not operate on *.workers.dev, so the L1 fast path in
// read-through.ts misses there on every query. This Durable Object
// (DO-SQLite) is the layer the correctness argument depends on: it answers
// everywhere, including workers.dev.
//
// Single-flight lives here, not in a module map like refresh.ts's `inflight`:
// that only coalesces within one isolate, while ten identical queries landing
// on different isolates would each miss and hit Kagi. `acquire()` is
// synchronous end to end (like every Meter method — no `await` between read
// and write), so exactly one caller is told "claimed" for a key; the rest are
// told "pending" and poll until the winner stores. See
// docs/adr/0017-result-cache.md.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env.js";
import { CACHE_DOMAINS, CLAIM_LEASE_MS, TTL_SECONDS, type CacheDomain } from "./key.js";

export type AcquireResult =
  | { status: "hit"; body: string; age_s: number; fetched_at: number }
  /** The caller won the key and must fetch, then `store()` or `release()`. */
  | { status: "claimed" }
  /** Another caller holds a live claim; poll again shortly. */
  | { status: "pending" };

type CounterKind = "hits" | "misses" | "stores";

export interface CacheStats {
  hits: number;
  /** Upstream fetches the cache could not avoid (one per winning claim). */
  misses: number;
  stores: number;
  entries: number;
  hit_rate: number;
  by_domain: Record<CacheDomain, Record<CounterKind, number>>;
}

export class ResultCache extends DurableObject<Env> {
  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS entries (
          key TEXT PRIMARY KEY,
          domain TEXT NOT NULL,
          body TEXT NOT NULL,
          fetched_at INTEGER NOT NULL
        )`,
      );
      this.ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS claims (
          key TEXT PRIMARY KEY,
          since INTEGER NOT NULL
        )`,
      );
      // Cumulative counters. Purge deletes rows from `entries`, never from
      // here, so the hit rate survives the hourly purge.
      this.ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS counters (
          name TEXT PRIMARY KEY,
          n INTEGER NOT NULL
        )`,
      );
    });
  }

  /**
   * Read `key`, or claim the right to fetch it. Atomic: no `await` between
   * the reads and the writes.
   *
   * - A live entry no older than `maxAgeS` is a hit. Expired rows are deleted
   *   on the way past; an entry older than `maxAgeS` but inside its TTL is
   *   kept (a looser caller may still use it) and treated as absent here.
   * - Otherwise, if another caller claimed the key less than CLAIM_LEASE_MS
   *   ago, "pending".
   * - Otherwise this caller takes (or takes over) the claim: "claimed". Only
   *   claims count as misses, so `misses` is the number of upstream fetches
   *   the cache let through.
   */
  acquire(key: string, domain: CacheDomain, nowMs: number, maxAgeS?: number): AcquireResult {
    const rows = [
      ...this.ctx.storage.sql.exec("SELECT body, fetched_at FROM entries WHERE key = ?", key),
    ];
    if (rows.length > 0) {
      const fetchedAt = Number(rows[0].fetched_at);
      const ageS = Math.max(0, Math.floor((nowMs - fetchedAt) / 1000));
      if (ageS >= TTL_SECONDS[domain]) {
        this.ctx.storage.sql.exec("DELETE FROM entries WHERE key = ?", key);
      } else if (maxAgeS === undefined || (maxAgeS > 0 && ageS <= maxAgeS)) {
        this.bump(domain, "hits");
        return { status: "hit", body: String(rows[0].body), age_s: ageS, fetched_at: fetchedAt };
      }
    }
    const claims = [...this.ctx.storage.sql.exec("SELECT since FROM claims WHERE key = ?", key)];
    if (claims.length > 0 && Number(claims[0].since) > nowMs - CLAIM_LEASE_MS) {
      return { status: "pending" };
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO claims (key, since) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET since = excluded.since`,
      key,
      nowMs,
    );
    this.bump(domain, "misses");
    return { status: "claimed" };
  }

  /** Count a hit served by the L1 Cache API, which never reaches `acquire()`. */
  recordHit(domain: CacheDomain): void {
    this.bump(domain, "hits");
  }

  /**
   * Release a claim without storing (the fetch failed, or the response is
   * not storable). The next poller claims immediately.
   */
  release(key: string): void {
    this.ctx.storage.sql.exec("DELETE FROM claims WHERE key = ?", key);
  }

  /** Store a fetched response and release the claim. Overwrites on re-fetch. */
  store(key: string, domain: CacheDomain, body: string, fetchedAtMs: number): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO entries (key, domain, body, fetched_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET domain = excluded.domain, body = excluded.body, fetched_at = excluded.fetched_at`,
      key,
      domain,
      body,
      fetchedAtMs,
    );
    this.ctx.storage.sql.exec("DELETE FROM claims WHERE key = ?", key);
    this.bump(domain, "stores");
  }

  /**
   * Delete every entry past its TTL, and every claim past its lease. Runs
   * hourly from the worker's `scheduled()` handler, so Kagi results stay
   * transient. Returns the number of entries removed.
   */
  purge(nowMs: number): number {
    let removed = 0;
    for (const domain of CACHE_DOMAINS) {
      const cursor = this.ctx.storage.sql.exec(
        "DELETE FROM entries WHERE domain = ? AND fetched_at <= ? RETURNING key",
        domain,
        nowMs - TTL_SECONDS[domain] * 1000,
      );
      removed += [...cursor].length;
    }
    this.ctx.storage.sql.exec("DELETE FROM claims WHERE since <= ?", nowMs - CLAIM_LEASE_MS);
    return removed;
  }

  stats(): CacheStats {
    const rows = [...this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM entries")];
    const entries = rows.length > 0 ? Number(rows[0].n) : 0;
    const byDomain = {} as CacheStats["by_domain"];
    for (const domain of CACHE_DOMAINS) {
      byDomain[domain] = {
        hits: this.readCounter(`${domain}:hits`),
        misses: this.readCounter(`${domain}:misses`),
        stores: this.readCounter(`${domain}:stores`),
      };
    }
    const hits = this.readCounter("total:hits");
    const misses = this.readCounter("total:misses");
    return {
      hits,
      misses,
      stores: this.readCounter("total:stores"),
      entries,
      hit_rate: hits + misses === 0 ? 0 : hits / (hits + misses),
      by_domain: byDomain,
    };
  }

  private bump(domain: CacheDomain, kind: CounterKind): void {
    for (const name of [`${domain}:${kind}`, `total:${kind}`]) {
      this.ctx.storage.sql.exec(
        `INSERT INTO counters (name, n) VALUES (?, 1)
         ON CONFLICT (name) DO UPDATE SET n = n + 1`,
        name,
      );
    }
  }

  private readCounter(name: string): number {
    const rows = [...this.ctx.storage.sql.exec("SELECT n FROM counters WHERE name = ?", name)];
    return rows.length > 0 ? Number(rows[0].n) : 0;
  }
}
