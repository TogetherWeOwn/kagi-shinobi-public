// Global upstream Kagi call budget (ADR 0013).
//
// Every rate limit before this one counted *requests to the worker*. One
// request can fan out into many Kagi calls (POST /search takes 20 queries,
// kagi_personalized_rank probes up to 20 URLs), and MCP protocol traffic eats
// the per-bearer limit without reaching Kagi at all. Scrape mode rides one
// personal subscription, so what has to stay human-scale is the number of
// calls that actually reach kagi.com — across every caller, admin included.
//
// takeKagiCall() is called immediately before each upstream Kagi fetch. The
// day and month windows refuse outright; the per-second window paces, waiting
// out the current second (bounded) before refusing. Fails OPEN when the
// Meter is unreachable: the day/month volume caps are removed (all callers
// share only the per-second anti-ban pacer), so a dead counter must not take
// search down with it. The fail-open path paces through an isolate-local
// slot queue at the per-second rate (ADR 0019), refusing once the wait would
// pass the pace bound. Paid-API spend still fails closed in kagi/api/cost.ts.

import type { Env } from "../env.js";
import { KagiRateLimitError } from "./errors.js";
import { logWarn } from "../util/log.js";

export interface KagiCallLimits {
  perSecond: number;
  perDay: number;
  perMonth: number;
}

function readVar(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? String(fallback), 10);
  if (Number.isNaN(parsed) || parsed < 0) return 0;
  return parsed;
}

export function readKagiCallLimits(env: Env): KagiCallLimits {
  return {
    perSecond: readVar(env.KAGI_CALLS_PER_SECOND, 2),
    perDay: readVar(env.KAGI_CALLS_PER_DAY, 0),
    perMonth: readVar(env.KAGI_CALLS_PER_MONTH, 0),
  };
}

/** Longest a caller waits for the per-second window before being refused. */
const MAX_PACE_WAIT_MS = 3_000;

/**
 * Flat pause applied when the Meter is unreachable, no per-second rate is
 * configured, and the call is admitted fail-open. With no rate to pace at,
 * pacing is impossible; this only avoids a perfectly synchronized burst.
 */
const METER_DOWN_PACE_MS = 500;

/**
 * Next free slot of the isolate-local fail-open pacer (ms since epoch). Each
 * admitted call takes the later of now and this value, then advances it by
 * one per-second quantum, so concurrent callers leave spread out instead of
 * hitting Kagi together. Module-level because there is no DO to serialize on
 * in this path; each isolate paces its own callers. Anchored with max()
 * against the caller's clock, so slots never go backward even if a stale
 * value outlives the isolate's idle period.
 */
let failOpenNextSlotMs = 0;

async function paceFailOpen(perSecond: number, now: () => number): Promise<void> {
  if (perSecond <= 0) {
    await sleep(METER_DOWN_PACE_MS);
    return;
  }
  const t = now();
  const slot = Math.max(t, failOpenNextSlotMs);
  const wait = slot - t;
  if (wait > MAX_PACE_WAIT_MS) {
    throw new KagiRateLimitError(
      Math.max(1, Math.ceil(wait / 1000)),
      `Kagi call budget unavailable, fail-open wait exceeded (${wait}ms)`,
    );
  }
  // Claimed synchronously up to the first await below, so concurrent callers
  // cannot take the same slot: JS runs each continuation's read-and-advance
  // without interleaving.
  failOpenNextSlotMs = slot + 1000 / perSecond;
  if (wait > 0) await sleep(wait);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function takeKagiCall(env: Env, now: () => number = Date.now): Promise<void> {
  const { perSecond, perDay, perMonth } = readKagiCallLimits(env);
  if (perSecond <= 0 && perDay <= 0 && perMonth <= 0) return;

  let waited = 0;
  for (;;) {
    let verdict;
    try {
      const stub = env.METER.get(env.METER.idFromName("kagi-calls"));
      verdict = await stub.takeKagiCall(now(), perSecond, perDay, perMonth);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logWarn("kagi budget meter unreachable, failing open", { error: msg });
      await paceFailOpen(perSecond, now);
      return;
    }
    if (verdict.ok) return;
    if (verdict.window === "second" && waited + verdict.retry_after_ms <= MAX_PACE_WAIT_MS) {
      waited += verdict.retry_after_ms;
      await sleep(verdict.retry_after_ms);
      continue;
    }
    throw new KagiRateLimitError(
      Math.max(1, Math.ceil(verdict.retry_after_ms / 1000)),
      `Kagi call budget exhausted (${verdict.window}: ${verdict.count}/${verdict.limit})`,
    );
  }
}
