// Shared test helpers — in-memory KV, env factory, fetch mock builder.

import { vi } from "vitest";
import type { Env } from "../src/env";

class MemKV {
  private store = new Map<string, string>();
  async get(k: string): Promise<string | null> {
    return this.store.get(k) ?? null;
  }
  async put(k: string, v: string): Promise<void> {
    this.store.set(k, v);
  }
  async delete(k: string): Promise<void> {
    this.store.delete(k);
  }
  snapshot(): Record<string, string> {
    return Object.fromEntries(this.store);
  }
}

/**
 * In-memory stand-in for the Meter Durable Object, for the fast `unit`
 * project. It mirrors the DO's contract but NOT its atomicity — JS is
 * single-threaded here, so a race cannot be reproduced against it.
 *
 * Tests that assert the counters actually serialize belong in test/workers/,
 * against the real DO. This stub exists for tests that merely depend on the
 * guard admitting or refusing (endpoint behavior), not on how it counts.
 */
class MemMeter {
  private rate = new Map<number, number>();
  private spend = new Map<string, number>();
  private leaseUntil = 0;

  checkRate(limit: number, minute: number, msIntoMinute: number) {
    if (limit <= 0) return { allowed: true, limit_rpm: 0, count: 0 };
    const current = this.rate.get(minute) ?? 0;
    if (current >= limit) {
      return {
        allowed: false,
        limit_rpm: limit,
        count: current,
        retry_after_seconds: Math.max(1, Math.ceil((60_000 - msIntoMinute) / 1000)),
      };
    }
    this.rate.set(minute, current + 1);
    return { allowed: true, limit_rpm: limit, count: current + 1 };
  }

  reserveSpend(month: string, projectedCents: number, capCents: number) {
    const spent = this.spend.get(month) ?? 0;
    if (capCents <= 0 || spent + projectedCents > capCents) {
      return { ok: false, spent_cents: spent, cap_cents: capCents };
    }
    this.spend.set(month, spent + projectedCents);
    return { ok: true, spent_cents: spent + projectedCents, cap_cents: capCents };
  }

  settleSpend(month: string, deltaCents: number) {
    const next = Math.max(0, (this.spend.get(month) ?? 0) + deltaCents);
    this.spend.set(month, next);
    return next;
  }

  spendSnapshot(month: string) {
    return this.spend.get(month) ?? 0;
  }

  // Admit-all stand-in for the global Kagi call budget. The real windows are
  // exercised against the DO in test/workers/kagi-budget.test.ts.
  takeKagiCall(_nowMs: number, _perSecond: number, _perDay: number, _perMonth: number) {
    return { ok: true, retry_after_ms: 0 };
  }

  tryRefreshLease(nowMs: number, leaseMs: number, force = false) {
    if (!force && nowMs < this.leaseUntil) {
      return { acquired: false, retry_after_ms: this.leaseUntil - nowMs };
    }
    this.leaseUntil = nowMs + leaseMs;
    return { acquired: true, retry_after_ms: 0 };
  }
}

/** Namespace shim: one MemMeter per name, matching real DO addressing. */
function makeMemMeterNamespace() {
  const instances = new Map<string, MemMeter>();
  return {
    idFromName: (name: string) => name,
    get: (id: string) => {
      const existing = instances.get(id);
      if (existing) return existing;
      const created = new MemMeter();
      instances.set(id, created);
      return created;
    },
  };
}

export interface TestEnv extends Env {
  TOKEN_KV: MemKV & KVNamespace;
}

export function makeEnv(overrides: Partial<Env> = {}): TestEnv {
  const kv = new MemKV();
  return {
    ADMIN_TOKEN: "test-admin",
    TOKEN_KV: kv as unknown as MemKV & KVNamespace,
    METER: makeMemMeterNamespace() as unknown as Env["METER"],
    TOKEN_KV_KEY: "session_token",
    AUTO_REFRESH_ENABLED: "false",
    KAGI_MODE: "scrape",
    MAX_API_CENTS_PER_MONTH: "0",
    ...overrides,
  } as TestEnv;
}

/**
 * Build a fake fetch that returns a fixed JSON body wrapped in Kagi's envelope
 * `{meta, data}` shape and honors any headers you want to assert on.
 */
export function fakeFetch(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return async (_input, _init) =>
    new Response(JSON.stringify(body), {
      status: init.status ?? 200,
      headers: {
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
}

export function stubFetch(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
) {
  return vi.stubGlobal("fetch", handler);
}

export function restoreFetch() {
  vi.unstubAllGlobals();
}
