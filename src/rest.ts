// REST handlers for /search and /summarize.
//
// Both endpoints route through the KagiClient facade (mode-aware). Response
// shape mirrors the canonical types.ts contracts so REST callers get the
// same structured data as MCP callers.

import type { Env } from "./env.js";
import { jsonError, jsonOk } from "./util/errors.js";
import { createKagiClient, type KagiClient, type KagiClientOptions } from "./kagi/client.js";
import { KagiError, KagiTimeoutError, safeErrorMessage, type KagiErrorDetail } from "./kagi/errors.js";
import { KAGI_ERROR_STATUS, restErrorCode } from "./kagi/http.js";
import { isSupportedLanguage } from "./kagi/languages.js";
import { logWarn } from "./util/log.js";
import type { SearchEngine, SearchResponse } from "./kagi/types.js";

/**
 * Ceiling on queries per request, because /search fans out to one upstream
 * call per query.
 *
 * PER_BEARER_RPM limits *requests*, not the calls a request spawns, so without
 * this a single authorized request multiplies into an unbounded concurrent
 * burst: billable in api mode, session-ban bait in scrape mode, and over the
 * Workers subrequest cap either way. 20 matches the ceiling
 * kagi_personalized_rank already applies to its own fan-out.
 */
const MAX_QUERIES_PER_REQUEST = 20;

interface SearchBody {
  queries?: unknown;
  limit?: unknown;
  impl?: unknown;
  engine?: unknown;
  max_age_s?: unknown;
}

interface SummarizeBody {
  url?: unknown;
  summary_type?: unknown;
  target_language?: unknown;
  impl?: unknown;
  max_age_s?: unknown;
}

const INVALID_MAX_AGE = "max_age_s must be a non-negative integer (seconds; 0 skips the cache)";

export async function handleSearch(
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
): Promise<Response> {
  let body: SearchBody;
  try {
    body = (await request.json()) as SearchBody;
  } catch {
    return jsonError(400, "invalid-json", "Body must be JSON");
  }

  const { queries, limit, impl, engine, max_age_s } = body;
  if (!Array.isArray(queries) || queries.length === 0) {
    return jsonError(400, "missing-queries", "Body needs { queries: string[] }");
  }
  if (queries.length > MAX_QUERIES_PER_REQUEST) {
    return jsonError(
      400,
      "too-many-queries",
      `At most ${MAX_QUERIES_PER_REQUEST} queries per request; split the batch`,
    );
  }
  const normQueries: string[] = [];
  for (const q of queries) {
    if (typeof q !== "string" || q.trim().length === 0) {
      return jsonError(400, "invalid-query", "All queries must be non-empty strings");
    }
    normQueries.push(q.trim());
  }

  let normLimit = 10;
  if (limit !== undefined) {
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 50) {
      return jsonError(400, "invalid-limit", "limit must be an integer between 1 and 50");
    }
    normLimit = limit;
  }
  const normImpl = normalizeImpl(impl);
  if (normImpl === "__invalid__") {
    return jsonError(400, "invalid-impl", "impl must be 'scrape' or 'api'");
  }
  const normEngine = normalizeEngine(engine);
  if (normEngine === "__invalid__") {
    return jsonError(400, "invalid-engine", "engine must be 'kagi', 'searxng' or 'auto'");
  }
  if (normEngine !== undefined && normEngine !== "kagi" && normImpl !== undefined) {
    return jsonError(400, "invalid-impl", "impl only applies under engine='kagi'");
  }
  const maxAgeS = normalizeMaxAge(max_age_s);
  if (maxAgeS === "__invalid__") {
    return jsonError(400, "invalid-max-age", INVALID_MAX_AGE);
  }

  let client: KagiClient;
  try {
    client = createKagiClient(env, clientOptions(ctx));
  } catch (err) {
    return kagiErrorResponse(err);
  }

  const settled = await Promise.allSettled(
    normQueries.map((q) =>
      withTimeout(
        client.search({
          q,
          limit: normLimit,
          impl: normImpl,
          engine: normEngine,
          max_age_s: maxAgeS,
        }),
        15_000,
      ),
    ),
  );

  const results: Array<{
    query: string;
    ok: boolean;
    data?: SearchResponse;
    error?: string;
  }> = [];
  for (let i = 0; i < normQueries.length; i++) {
    const s = settled[i];
    if (s.status === "fulfilled") {
      results.push({ query: normQueries[i], ok: true, data: s.value });
    } else {
      results.push({
        query: normQueries[i],
        ok: false,
        error: reasonToString(s.reason),
      });
    }
  }
  return jsonOk({ mode: client.mode, results });
}

export async function handleSummarize(
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
): Promise<Response> {
  let body: SummarizeBody;
  try {
    body = (await request.json()) as SummarizeBody;
  } catch {
    return jsonError(400, "invalid-json", "Body must be JSON");
  }

  const { url, summary_type, target_language, impl, max_age_s } = body;
  if (typeof url !== "string" || url.trim().length === 0) {
    return jsonError(400, "missing-url", "Body needs { url: string }");
  }
  const type =
    summary_type === undefined || summary_type === "summary" || summary_type === "takeaway"
      ? (summary_type ?? "summary")
      : null;
  if (type === null) {
    return jsonError(400, "invalid-summary-type", "summary_type must be 'summary' or 'takeaway'");
  }
  let language = "EN";
  if (target_language !== undefined) {
    if (typeof target_language !== "string" || !isSupportedLanguage(target_language)) {
      return jsonError(400, "invalid-language", `target_language not supported`);
    }
    language = target_language;
  }
  const normImpl = normalizeImpl(impl);
  if (normImpl === "__invalid__") {
    return jsonError(400, "invalid-impl", "impl must be 'scrape' or 'api'");
  }
  const maxAgeS = normalizeMaxAge(max_age_s);
  if (maxAgeS === "__invalid__") {
    return jsonError(400, "invalid-max-age", INVALID_MAX_AGE);
  }

  let client: KagiClient;
  try {
    client = createKagiClient(env, clientOptions(ctx));
  } catch (err) {
    return kagiErrorResponse(err);
  }

  try {
    const data = await client.summarize({
      kind: "url",
      ref: url,
      language,
      style: type,
      impl: normImpl,
      max_age_s: maxAgeS,
    });
    return jsonOk({ ok: true, mode: client.mode, data });
  } catch (err) {
    return kagiErrorResponse(err);
  }
}

function normalizeImpl(v: unknown): "scrape" | "api" | undefined | "__invalid__" {
  if (v === undefined) return undefined;
  if (v === "scrape" || v === "api") return v;
  return "__invalid__";
}

function normalizeMaxAge(v: unknown): number | undefined | "__invalid__" {
  if (v === undefined) return undefined;
  if (typeof v === "number" && Number.isInteger(v) && v >= 0) return v;
  return "__invalid__";
}

/** Hand the cache's post-response work (L1 writes) to the request's waitUntil. */
function clientOptions(ctx: ExecutionContext | undefined): KagiClientOptions {
  return ctx ? { waitUntil: (p) => ctx.waitUntil(p) } : {};
}

function normalizeEngine(v: unknown): SearchEngine | undefined | "__invalid__" {
  if (v === undefined) return undefined;
  if (v === "kagi" || v === "searxng" || v === "auto") return v;
  return "__invalid__";
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    // Typed so a timeout stays client-visible as itself (504 / the timeout
    // message) instead of being genericized with the untyped errors below.
    const t = setTimeout(() => reject(new KagiTimeoutError(ms)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

// Per-query failures use the same rule as the top-level envelope: typed
// KagiError vocabulary verbatim, everything else generic. Echoing
// `${name}: ${message}` here leaked untyped upstream text, paths and
// markers into an otherwise-sanitized 200 response.
function reasonToString(reason: unknown): string {
  return safeErrorMessage(reason);
}

// ADR 0012: status and code both come from `kind`, so the subclass a caller
// happened to throw cannot change the answer. The chain this replaced keyed
// status off the class and code off the kind, which is why a bare
// `new KagiError("upstream", ...)` returned 500 `kagi-upstream` while
// `KagiUpstreamError` returned 502 with the same code.
export function kagiErrorResponse(err: unknown): Response {
  if (err instanceof KagiError) {
    // `?? 500` is a fail-closed guard, not a fallback for ordinary use: the
    // Record makes a missing entry a typecheck error, so this only fires for a
    // kind that reached us past the type system — a cast, a JS caller, a value
    // off the wire. Measured, because the failure mode is not obvious:
    // `new Response(body, { status: undefined })` returns **200**, so without
    // this an unmapped kind would answer an error with a success status.
    const status = KAGI_ERROR_STATUS[err.kind] ?? 500;
    return jsonError(status, restErrorCode(err.kind), err.message, {
      detail: err.detail,
      headers: retryAfterHeader(err.detail),
    });
  }
  const msg = err instanceof Error ? err.message : String(err);
  // `error`, not `msg` — logWarn spreads fields last, so a field named `msg`
  // would overwrite the log message and leave the line without context.
  logWarn("unhandled error in REST handler", { error: msg });
  // Never echo raw error text to the client: upstream bodies, fetch failures
  // and non-Error throws can carry paths, tokens or stack fragments. The
  // detail stays in the server log above; the client gets a stable code.
  return jsonError(500, "internal", "Internal error");
}

// Latent today: KagiRateLimitError is the only error declaring retry_after, and
// nothing in src/ constructs one — a Kagi 429 arrives as KagiUpstreamError, so
// as kind `upstream`. Wired anyway because a mapping keyed by kind owes every
// kind an answer, and a 429 without Retry-After invites a client to hammer.
// Keyed off the field rather than the class so it stays correct if another kind
// starts carrying one. See ADR 0012.
function retryAfterHeader(detail: KagiErrorDetail): Record<string, string> | undefined {
  const seconds = detail.retry_after;
  return typeof seconds === "number" ? { "Retry-After": String(seconds) } : undefined;
}

/**
 * GET /search?q=...&format=json — a SearXNG-shaped view of one query, so
 * SearXNG's built-in `json_engine` can consume this worker directly
 * (results_query=results, url_query=url, title_query=title,
 * content_query=content). Shape only; no new upstream behaviour — it calls
 * the same client.search as POST /search with a single query. ADR 0013.
 */
export async function handleSearchGet(
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const q = (params.get("q") ?? "").trim();
  if (q.length === 0) {
    return jsonError(400, "missing-query", "Query string needs ?q=<terms>");
  }
  if (q.length > 500) {
    return jsonError(400, "invalid-query", "q must be at most 500 characters");
  }
  const format = params.get("format") ?? "json";
  if (format !== "json") {
    return jsonError(400, "invalid-format", "Only format=json is supported");
  }
  let limit = 10;
  const rawLimit = params.get("limit");
  if (rawLimit !== null) {
    const n = Number(rawLimit);
    if (!Number.isInteger(n) || n < 1 || n > 50) {
      return jsonError(400, "invalid-limit", "limit must be an integer between 1 and 50");
    }
    limit = n;
  }
  let maxAgeS: number | undefined;
  const rawMaxAge = params.get("max_age_s");
  if (rawMaxAge !== null) {
    const n = rawMaxAge.trim() === "" ? NaN : Number(rawMaxAge);
    if (!Number.isInteger(n) || n < 0) {
      return jsonError(400, "invalid-max-age", INVALID_MAX_AGE);
    }
    maxAgeS = n;
  }

  let client: KagiClient;
  try {
    client = createKagiClient(env, clientOptions(ctx));
  } catch (err) {
    return kagiErrorResponse(err);
  }

  let data: SearchResponse;
  try {
    data = await withTimeout(client.search({ q, limit, max_age_s: maxAgeS }), 15_000);
  } catch (err) {
    return kagiErrorResponse(err);
  }

  const results = data.results.map((r) => ({
    url: r.url,
    title: r.title,
    content: r.snippet,
    engine: "kagi",
    ...(r.published_at ? { publishedDate: r.published_at } : {}),
    ...(r.thumbnail_url ? { thumbnail: r.thumbnail_url } : {}),
  }));
  return jsonOk({
    query: q,
    number_of_results: results.length,
    results,
    answers: data.buckets?.direct_answer ? [data.buckets.direct_answer] : [],
    suggestions: data.buckets?.related_search ?? [],
    mode: client.mode,
  });
}
