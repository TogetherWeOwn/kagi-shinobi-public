// KV-backed session token store.
//
// Layout: single KV key (`TOKEN_KV_KEY`) holding a JSON envelope. Wrapping in
// an envelope (instead of storing the raw token) lets us track when it was
// last refreshed and whether the last request marked it stale, which drives
// the /health endpoint and the refresh decision.

import type { Env } from "../env.js";

export interface TokenEnvelope {
  token: string;
  updatedAt: number;
  source: "secret" | "admin" | "browser-refresh";
  stale?: boolean;
  staleAt?: number;
  staleReason?: string;
}

// Isolate-local read-through cache. Nothing invalidates it across isolates,
// so this TTL is the blast radius of a token rotation: an isolate that did not
// handle the write to /admin/token keeps serving the superseded token until
// its entry ages out, and `currentToken()` in the scrape client reads a
// lingering `stale: true` as a reason to spawn a Browser Rendering refresh
// that is no longer needed.
//
// 60s is Workers KV's own propagation floor (its per-colo cache defaults to
// 60s, and writes take up to that long to become visible elsewhere). Above
// that, this cache is strictly worse than reading KV directly; below it, the
// extra reads buy nothing, because KV would serve a cached value anyway.
//
// The cache is kept rather than deleted because `saveToken` writes through it:
// that is what stops an isolate which just refreshed from reading its own
// pre-refresh value back out of KV's colo cache and refreshing again. Deleting
// it would trade a cross-isolate staleness window for a self-inflicted loop.
//
// The residual <=60s window is irreducible at the KV layer — KV has no
// cache-bypass read. Refresh stampedes inside that window are handled by the
// Meter lease in src/token/refresh.ts.
// See docs/adr/0007-bound-token-cache-and-coordinate-refresh.md.
const CACHE_TTL_MS = 60 * 1000;
let memoryCache: { env: TokenEnvelope; loadedAt: number } | null = null;

export async function loadToken(env: Env): Promise<TokenEnvelope | null> {
  const now = Date.now();
  if (memoryCache && now - memoryCache.loadedAt < CACHE_TTL_MS) {
    return memoryCache.env;
  }

  const raw = await env.TOKEN_KV.get(env.TOKEN_KV_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as TokenEnvelope;
      memoryCache = { env: parsed, loadedAt: now };
      return parsed;
    } catch {
      // Fall through to seed from secret.
    }
  }

  // First boot: seed from the KAGI_SESSION_TOKEN secret if present.
  if (env.KAGI_SESSION_TOKEN) {
    const seeded: TokenEnvelope = {
      token: env.KAGI_SESSION_TOKEN,
      updatedAt: now,
      source: "secret",
    };
    await saveToken(env, seeded);
    return seeded;
  }

  return null;
}

export async function saveToken(env: Env, envelope: TokenEnvelope): Promise<void> {
  const value = JSON.stringify(envelope);
  await env.TOKEN_KV.put(env.TOKEN_KV_KEY, value);
  memoryCache = { env: envelope, loadedAt: Date.now() };
}

export async function markStale(
  env: Env,
  reason: string,
): Promise<TokenEnvelope | null> {
  const current = await loadToken(env);
  if (!current) return null;
  const updated: TokenEnvelope = {
    ...current,
    stale: true,
    staleAt: Date.now(),
    staleReason: reason,
  };
  await saveToken(env, updated);
  return updated;
}

export function clearMemoryCache(): void {
  memoryCache = null;
}
