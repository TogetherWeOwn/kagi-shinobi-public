// Bearer-token gate for every non-/health endpoint.
//
// The comparison below does NOT leak *which* character differs: the loop XORs
// every position and only tests the accumulator at the end. It DOES leak the
// token's length, via the early return in timingSafeEqual — an earlier version
// of this comment claimed otherwise, which was wrong.
//
// Measured rather than argued (2026-08-06, Node 22, 2M iterations, median of
// 7 rounds, against a 43-char secret):
//
//   wrong token, same length : 105.35 ns/call   (walks the full loop)
//   wrong token, diff length :   1.80 ns/call   (early return)
//   delta                    : 103.55 ns        (58x ratio)
//
// The ratio is stark but the absolute delta is ~100 ns against 1-10 ms of
// internet jitter, so separating the two needs on the order of 1e8 requests —
// roughly three years at the default PER_BEARER_RPM=60 — and yields only the
// length, not the token. Left as-is deliberately. The fix is to compare
// SHA-256 digests, which is correct but makes requireBearer async and every
// caller with it; do that if the rate limit is raised substantially, if this
// gate moves somewhere unmetered, or if ADMIN_TOKEN stops being a
// high-entropy generated value.

import type { Env } from "../env.js";
import { jsonError } from "./errors.js";

export function requireBearer(request: Request, env: Env): Response | null {
  const header = request.headers.get("Authorization");
  if (!header || !header.startsWith("Bearer ")) {
    return jsonError(401, "missing-bearer", "Authorization: Bearer <token> required");
  }
  const provided = header.slice("Bearer ".length).trim();
  if (!env.ADMIN_TOKEN) {
    return jsonError(500, "server-misconfigured", "ADMIN_TOKEN secret not set");
  }
  if (!timingSafeEqual(provided, env.ADMIN_TOKEN)) {
    return jsonError(401, "invalid-bearer", "Bearer token rejected");
  }
  return null;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Scoped client keys (ADR 0013).
//
// CLIENT_KEYS is an optional secret holding a JSON object that maps a client
// name to the lowercase hex SHA-256 of that client's key:
//
//   {"searxng-main":"9f86d081884c7d65..."}
//
// Only digests are stored, so the secret alone does not hand out a usable
// credential. A client key is accepted alongside ADMIN_TOKEN on the read-only
// search surfaces (see CLIENT_SCOPED_PATHS in src/index.ts) and never on
// /admin/*. Comparison is digest-vs-digest at a fixed 64-char length, so the
// length leak documented above for ADMIN_TOKEN does not apply here.

export type Principal = { kind: "admin" } | { kind: "client"; name: string };

const HEX64 = /^[0-9a-f]{64}$/;

/** Parse CLIENT_KEYS. Malformed entries are dropped, never thrown on. */
export function parseClientKeys(raw: string | undefined): Array<[string, string]> {
  if (!raw || raw.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [];
  const out: Array<[string, string]> = [];
  for (const [name, digest] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof digest !== "string") continue;
    const d = digest.trim().toLowerCase();
    if (name.length > 0 && HEX64.test(d)) out.push([name, d]);
  }
  return out;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Resolve the bearer to a principal: the admin token, or a named client key.
 * Returns a 401 Response when neither matches. Callers decide scope.
 */
export async function authenticate(request: Request, env: Env): Promise<Principal | Response> {
  const adminFailure = requireBearer(request, env);
  if (adminFailure === null) return { kind: "admin" };
  // missing-bearer / server-misconfigured are final; only invalid-bearer
  // falls through to the client-key table.
  if (adminFailure.status !== 401) return adminFailure;
  const header = request.headers.get("Authorization");
  if (!header || !header.startsWith("Bearer ")) return adminFailure;

  const keys = parseClientKeys(env.CLIENT_KEYS);
  if (keys.length === 0) return adminFailure;

  const provided = await sha256Hex(header.slice("Bearer ".length).trim());
  let match: string | null = null;
  // Walk every entry regardless of an early match, so the position of the
  // matching key is not observable either.
  for (const [name, digest] of keys) {
    if (timingSafeEqual(provided, digest) && match === null) match = name;
  }
  return match === null ? adminFailure : { kind: "client", name: match };
}

/**
 * Paths a scoped client key may reach. Everything else — /summarize and all of
 * /admin/* — stays admin-only.
 */
export function isClientScopedPath(path: string): boolean {
  return path === "/search" || path === "/mcp" || path.startsWith("/mcp/");
}
