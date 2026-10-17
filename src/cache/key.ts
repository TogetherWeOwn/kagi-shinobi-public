// Result-cache keys, domains and TTLs — the pure half of the cache.
//
// Nothing here imports `cloudflare:*`, so the unit project (plain Node) can
// pin key derivation and normalization, and client.ts can import it without
// dragging the Durable Object class into the Node loader. See ADR 0017.

/** Cacheable domains. Everything else bypasses the cache — see ADR 0017. */
export type CacheDomain = "search" | "fastgpt" | "summarize";

/** TTLs per the card: search 24h, fastgpt 6h, summarize 7d. */
export const TTL_SECONDS: Record<CacheDomain, number> = {
  search: 24 * 60 * 60,
  fastgpt: 6 * 60 * 60,
  summarize: 7 * 24 * 60 * 60,
};

export const CACHE_DOMAINS = Object.keys(TTL_SECONDS) as CacheDomain[];

/** The single ResultCache instance every isolate talks to. */
export const RESULT_CACHE_NAME = "result-cache";

/**
 * How long a claim holds a key before another caller may take it over. Bounds
 * how long a crashed or hung winner can stall its losers; comfortably above
 * the 15 s REST timeout on an upstream call.
 */
export const CLAIM_LEASE_MS = 30_000;

/**
 * Normalize args for keying: drop `undefined`, trim strings, sort object keys
 * (array order is kept — it is meaningful). `{q: " kagi "}` and `{q: "kagi",
 * lens_id: undefined}` therefore share a key.
 */
export function normalizeArgs(value: unknown): unknown {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(normalizeArgs);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = normalizeArgs(v);
    }
    return out;
  }
  return value;
}

/** `sha256(domain|engine|normalized args)` as lowercase hex. */
export async function cacheKey(
  domain: CacheDomain,
  engine: string,
  args: Record<string, unknown>,
): Promise<string> {
  const input = `${domain}|${engine}|${JSON.stringify(normalizeArgs(args))}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
