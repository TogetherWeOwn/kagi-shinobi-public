// Meter — the serialization point for both protective counters.
//
// Why a Durable Object and not KV: both counters were previously KV
// read-then-write. Concurrent requests read the same value and each wrote
// `value + 1`, so ten parallel calls advanced the counter by one. The error
// ran toward UNDER-counting — letting traffic and spend past the limit — the
// opposite of what ADR 0005 and the old comments claimed. Workers KV has no
// compare-and-swap, so the race cannot be closed at that layer.
//
// Every method below is synchronous end to end. `ctx.storage.sql` is a
// synchronous API, and a DO processes one call at a time, so a method that
// never awaits between its read and its write is atomic. Do not introduce an
// `await` inside these methods — that is precisely what reopens the race.
//
// See docs/adr/0006-serialize-rate-and-spend-counters.md.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env.js";

/** Keep two minutes of rate buckets so a clock skew of one minute is safe. */
const RATE_RETENTION_MINUTES = 2;

export interface RateVerdict {
  allowed: boolean;
  limit_rpm: number;
  count: number;
  retry_after_seconds?: number;
}

export interface SpendVerdict {
  ok: boolean;
  spent_cents: number;
  cap_cents: number;
}

export interface RefreshLeaseVerdict {
  acquired: boolean;
  /** 0 when acquired; otherwise how long until the held lease expires. */
  retry_after_ms: number;
}

export interface KagiCallVerdict {
  ok: boolean;
  /** Which window refused; absent when ok. */
  window?: "second" | "day" | "month";
  count?: number;
  limit?: number;
  /** 0 when ok; otherwise ms until the refusing window rolls over. */
  retry_after_ms: number;
}

/** Single-row key for the browser-refresh lease. */
const REFRESH_LEASE = "refresh";

export class Meter extends DurableObject<Env> {
  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS rate (
          bucket INTEGER NOT NULL,
          n INTEGER NOT NULL,
          PRIMARY KEY (bucket)
        )`,
      );
      this.ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS spend (
          month TEXT PRIMARY KEY,
          cents REAL NOT NULL
        )`,
      );
      this.ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS calls (
          win TEXT PRIMARY KEY,
          n INTEGER NOT NULL
        )`,
      );
      this.ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS lease (
          name TEXT PRIMARY KEY,
          until INTEGER NOT NULL
        )`,
      );
    });
  }

  /**
   * Check-and-increment one rate bucket. Instances are addressed per bearer
   * (idFromName(bearerHash)), so `bucket` only needs to distinguish minutes.
   */
  checkRate(limit: number, minute: number, msIntoMinute: number): RateVerdict {
    if (limit <= 0) return { allowed: true, limit_rpm: 0, count: 0 };

    this.ctx.storage.sql.exec("DELETE FROM rate WHERE bucket < ?", minute - RATE_RETENTION_MINUTES);

    const rows = [...this.ctx.storage.sql.exec("SELECT n FROM rate WHERE bucket = ?", minute)];
    const current = rows.length > 0 ? Number(rows[0].n) : 0;

    if (current >= limit) {
      const retry = Math.max(1, Math.ceil((60_000 - msIntoMinute) / 1000));
      return { allowed: false, limit_rpm: limit, count: current, retry_after_seconds: retry };
    }

    this.ctx.storage.sql.exec(
      `INSERT INTO rate (bucket, n) VALUES (?, 1)
       ON CONFLICT (bucket) DO UPDATE SET n = n + 1`,
      minute,
    );
    return { allowed: true, limit_rpm: limit, count: current + 1 };
  }

  /**
   * Reserve budget for a billable call. The projected amount is debited at
   * admission, not after the network round-trip — otherwise two concurrent
   * callers both admit against the same stale total. `settleSpend` then
   * applies the difference once the real cost is known.
   */
  reserveSpend(month: string, projectedCents: number, capCents: number): SpendVerdict {
    const spent = this.readSpendRow(month);

    // capCents <= 0 means the operator has not opted into paid API usage.
    if (capCents <= 0) return { ok: false, spent_cents: spent, cap_cents: capCents };
    if (spent + projectedCents > capCents) {
      return { ok: false, spent_cents: spent, cap_cents: capCents };
    }

    this.writeSpend(month, spent + projectedCents);
    return { ok: true, spent_cents: spent + projectedCents, cap_cents: capCents };
  }

  /**
   * Apply the difference between the actual and the reserved cost. Negative
   * deltas are normal — /enrich is only billed on non-zero results, so a call
   * that came back empty refunds its whole reservation.
   */
  settleSpend(month: string, deltaCents: number): number {
    const next = Math.max(0, this.readSpendRow(month) + deltaCents);
    this.writeSpend(month, next);
    return next;
  }

  spendSnapshot(month: string): number {
    return this.readSpendRow(month);
  }

  /**
   * Take the global browser-refresh lease, or refuse if someone holds it.
   *
   * `inflight` in src/token/refresh.ts coalesces refreshes within one isolate
   * only. A rotation is invisible to other isolates for up to KV's propagation
   * window, and each of them reads the lingering `stale: true` as a reason to
   * launch its own Browser Rendering session — billable, slow, and bounded by
   * a small per-account concurrent-browser limit. This is the cross-isolate
   * half of that coalescing.
   *
   * Taking the lease is the commitment, not succeeding: a caller that takes it
   * and then fails to log in still blocks the next caller for the full window.
   * That is deliberate — a failing login (bad credentials, captcha) is exactly
   * the case where retrying from every isolate does the most damage.
   *
   * `force` is for POST /admin/refresh, where an operator has asked for a
   * refresh explicitly. It still writes the lease, so everyone else backs off
   * behind the operator's own attempt.
   */
  tryRefreshLease(nowMs: number, leaseMs: number, force = false): RefreshLeaseVerdict {
    const rows = [
      ...this.ctx.storage.sql.exec("SELECT until FROM lease WHERE name = ?", REFRESH_LEASE),
    ];
    const heldUntil = rows.length > 0 ? Number(rows[0].until) : 0;

    if (!force && Number.isFinite(heldUntil) && nowMs < heldUntil) {
      return { acquired: false, retry_after_ms: heldUntil - nowMs };
    }

    this.ctx.storage.sql.exec(
      `INSERT INTO lease (name, until) VALUES (?, ?)
       ON CONFLICT (name) DO UPDATE SET until = excluded.until`,
      REFRESH_LEASE,
      nowMs + leaseMs,
    );
    return { acquired: true, retry_after_ms: 0 };
  }

  /**
   * Admit one upstream Kagi call against the global call budget (ADR 0013),
   * or refuse naming the window that is full. Checks all three windows before
   * incrementing any, so a refusal never consumes budget. Synchronous end to
   * end, like every method here. Addressed as a single global instance
   * (idFromName("kagi-calls")). A limit of 0 disables that window.
   */
  takeKagiCall(nowMs: number, perSecond: number, perDay: number, perMonth: number): KagiCallVerdict {
    const sec = Math.floor(nowMs / 1000);
    const day = Math.floor(nowMs / 86_400_000);
    const d = new Date(nowMs);
    const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const keys = { second: `s:${sec}`, day: `d:${day}`, month: `m:${month}` } as const;

    this.ctx.storage.sql.exec("DELETE FROM calls WHERE win LIKE 's:%' AND win != ?", keys.second);
    this.ctx.storage.sql.exec("DELETE FROM calls WHERE win LIKE 'd:%' AND win != ?", keys.day);

    const read = (k: string): number => {
      const rows = [...this.ctx.storage.sql.exec("SELECT n FROM calls WHERE win = ?", k)];
      return rows.length > 0 ? Number(rows[0].n) : 0;
    };
    const nextMonthMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    const windows: Array<["second" | "day" | "month", string, number, number]> = [
      ["month", keys.month, perMonth, nextMonthMs - nowMs],
      ["day", keys.day, perDay, (day + 1) * 86_400_000 - nowMs],
      ["second", keys.second, perSecond, (sec + 1) * 1000 - nowMs],
    ];
    for (const [window, key, limit, retry] of windows) {
      if (limit <= 0) continue;
      const count = read(key);
      if (count >= limit) {
        return { ok: false, window, count, limit, retry_after_ms: Math.max(1, retry) };
      }
    }
    for (const [, key, limit] of windows) {
      if (limit <= 0) continue;
      this.ctx.storage.sql.exec(
        `INSERT INTO calls (win, n) VALUES (?, 1)
         ON CONFLICT (win) DO UPDATE SET n = n + 1`,
        key,
      );
    }
    return { ok: true, retry_after_ms: 0 };
  }

  private readSpendRow(month: string): number {
    const rows = [...this.ctx.storage.sql.exec("SELECT cents FROM spend WHERE month = ?", month)];
    if (rows.length === 0) return 0;
    const value = Number(rows[0].cents);
    return Number.isFinite(value) && value > 0 ? value : 0;
  }

  private writeSpend(month: string, cents: number): void {
    // Round to 4dp so float drift cannot accumulate across many debits.
    const rounded = Math.round(cents * 10_000) / 10_000;
    this.ctx.storage.sql.exec(
      `INSERT INTO spend (month, cents) VALUES (?, ?)
       ON CONFLICT (month) DO UPDATE SET cents = excluded.cents`,
      month,
      rounded,
    );
  }
}
