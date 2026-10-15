// Per-bearer rate limiter.
//
// Counters live in the Meter Durable Object, addressed by
// idFromName(sha256_16(bearer)) — one instance per bearer, so buckets are
// naturally sharded and each instance lands near the caller that created it.
// The bearer is hashed before use as the instance name: the raw value never
// reaches storage or logs.
//
// This used to be a KV read-then-write, which under-counted under concurrency
// (see docs/adr/0006-serialize-rate-and-spend-counters.md). The check and the
// increment now happen inside a single synchronous DO method, so they cannot
// interleave.

import type { Env } from "../env.js";
import type { RateVerdict } from "../meter/meter.js";

export type RateLimitResult = RateVerdict;

async function bearerHash(bearer: string): Promise<string> {
  const bytes = new TextEncoder().encode(bearer);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function readLimit(env: Env): number {
  const raw = env.PER_BEARER_RPM ?? "60";
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0) return 0;
  return parsed;
}

export async function checkAndIncrement(
  env: Env,
  bearer: string,
  now: Date = new Date(),
): Promise<RateLimitResult> {
  const limit = readLimit(env);
  if (limit <= 0) return { allowed: true, limit_rpm: 0, count: 0 };

  const ms = now.getTime();
  const minute = Math.floor(ms / 60_000);
  const id = env.METER.idFromName(await bearerHash(bearer));
  return env.METER.get(id).checkRate(limit, minute, ms % 60_000);
}

// ---------------------------------------------------------------------------
// Client-key limits (ADR 0013).
//
// A client key is metered by its *name*, not its bearer, so the bucket
// survives a key being re-issued under the same name. Two windows: a
// per-minute burst cap (CLIENT_KEY_RPM) and a per-UTC-day cap
// (CLIENT_KEY_RPD). The day window reuses Meter.checkRate with the day index
// as the bucket — the DO only needs buckets to be monotonic — and computes
// its own Retry-After because checkRate's assumes a one-minute bucket.

function readVar(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? String(fallback), 10);
  if (Number.isNaN(parsed) || parsed < 0) return 0;
  return parsed;
}

export function readClientLimits(env: Env): { rpm: number; rpd: number } {
  return { rpm: readVar(env.CLIENT_KEY_RPM, 0), rpd: readVar(env.CLIENT_KEY_RPD, 0) };
}

export async function checkClientRate(
  env: Env,
  name: string,
  now: Date = new Date(),
): Promise<RateLimitResult> {
  const { rpm, rpd } = readClientLimits(env);
  const ms = now.getTime();

  if (rpd > 0) {
    const day = Math.floor(ms / 86_400_000);
    const stub = env.METER.get(env.METER.idFromName(`client-day:${name}`));
    const verdict = await stub.checkRate(rpd, day, 0);
    if (!verdict.allowed) {
      const untilMidnight = Math.max(1, Math.ceil((86_400_000 - (ms % 86_400_000)) / 1000));
      return { ...verdict, retry_after_seconds: untilMidnight };
    }
  }
  if (rpm > 0) {
    const minute = Math.floor(ms / 60_000);
    const stub = env.METER.get(env.METER.idFromName(`client-minute:${name}`));
    return stub.checkRate(rpm, minute, ms % 60_000);
  }
  return { allowed: true, limit_rpm: 0, count: 0 };
}
