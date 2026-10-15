// Monthly API-cost cap.
//
// Every billable API call passes through `guardBillable()`, which reserves the
// projected charge against MAX_API_CENTS_PER_MONTH before the network call and
// refuses with KagiBudgetExceededError if it would breach the cap. The caller
// then settles with the ACTUAL charge, which may be lower (per Kagi's docs
// /enrich is only billed on non-zero results, so an empty response settles 0).
//
// Reserve-then-settle, not call-then-debit: two concurrent callers must not
// both admit against the same stale total. The counter lives in the Meter
// Durable Object so the read and the write cannot interleave — this was a KV
// read-then-write that could overshoot the cap. See
// docs/adr/0006-serialize-rate-and-spend-counters.md.
//
// Failing to settle leaves the full reservation in place, which biases toward
// over-throttling on the next call — safe by design.

import type { Env } from "../../env.js";
import { KagiBudgetExceededError } from "../errors.js";

function monthKey(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/** The spend counter is a single global instance, unlike the per-bearer rate buckets. */
function meterStub(env: Env) {
  return env.METER.get(env.METER.idFromName("spend"));
}

export function readCap(env: Env): number {
  const raw = env.MAX_API_CENTS_PER_MONTH ?? "0";
  const parsed = Number.parseFloat(raw);
  if (Number.isNaN(parsed) || parsed < 0) return 0;
  return parsed;
}

export async function readSpend(env: Env, now: Date = new Date()): Promise<number> {
  return meterStub(env).spendSnapshot(monthKey(now));
}

export interface Guard {
  /** Call after the network round-trip completes with the ACTUAL cost. */
  settle(actualCents: number): Promise<void>;
}

/**
 * Reserve budget for a billable call. Throws KagiBudgetExceededError if the
 * projected cost would push spend past the cap, or if the operator has not
 * opted into paid API usage at all (cap of 0).
 */
export async function guardBillable(env: Env, projectedCents: number): Promise<Guard> {
  const cap = readCap(env);
  const month = monthKey();
  const stub = meterStub(env);

  const verdict = await stub.reserveSpend(month, projectedCents, cap);
  if (!verdict.ok) {
    throw new KagiBudgetExceededError(verdict.spent_cents, cap);
  }

  return {
    async settle(actualCents: number) {
      // Apply only the difference — the projection is already on the books.
      const delta = Math.max(0, actualCents) - projectedCents;
      if (delta === 0) return;
      await stub.settleSpend(month, delta);
    },
  };
}

/** Backs the api-status MCP resource. /health does not report spend. */
export async function budgetSnapshot(env: Env): Promise<{
  cap_cents: number;
  spent_cents: number;
  remaining_cents: number;
  month: string;
}> {
  const cap = readCap(env);
  const month = monthKey();
  const spent = await meterStub(env).spendSnapshot(month);
  return {
    cap_cents: cap,
    spent_cents: spent,
    remaining_cents: Math.max(0, cap - spent),
    month,
  };
}
