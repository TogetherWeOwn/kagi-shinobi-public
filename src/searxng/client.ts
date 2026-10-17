// SearXNG fallback search client.
//
// Kagi scrape mode rides one personal subscription, so it must stay
// human-scale; a self-hosted SearXNG instance is free and unlimited but
// noisier. This client
// is the fallback tier behind `engine=searxng|auto`: it fetches SearXNG's
// `format=json` and normalizes into the canonical `SearchResponse` with
// `source_impl: "searxng"`, so the schema is identical whichever engine
// served the query. See ADR 0014.
//
// The wire shape consumed here is the same one this worker *serves* on
// GET /search for SearXNG's `json_engine`
// (`{query, number_of_results, results:[{url,title,content,engine,...}]}`) —
// that endpoint serves SearXNG format, this client consumes it, so the two
// shapes must stay in step.
//
// Transport: the SearXNG instance is reached through the operator-configured
// `SEARXNG_BASE_URL` (a Cloudflare Tunnel hostname fronted by Access, or a
// VPC-adjacent binding the operator wires — never the IP-pinned Caddy
// `/mcp-ext` path, which this client does not know). When the Access service
// token secrets are set, they ride as `CF-Access-*` headers. The base URL
// itself is a var, not a secret; the credentials are secrets.

import type { Env } from "../env.js";
import { KagiError, KagiNotConfiguredError, safeStatusPhrase } from "../kagi/errors.js";
import type { SearchResponse, SearchResult } from "../kagi/types.js";
import { buildMeta } from "../mcp/meta.js";
import { domainFromUrl } from "../util/url.js";

/** One entry of SearXNG `format=json` `results[]`. All fields optional on the
 *  wire — SearXNG merges engines that disagree on completeness — so the
 *  normalizer below treats everything past `url` as best-effort. */
export interface SearxngJsonResult {
  url?: unknown;
  title?: unknown;
  content?: unknown;
  engine?: unknown;
  publishedDate?: unknown;
  thumbnail?: unknown;
}

export interface SearxngJsonResponse {
  query?: unknown;
  number_of_results?: unknown;
  results?: unknown;
  answers?: unknown;
  suggestions?: unknown;
}

export interface SearxngSearchArgs {
  q: string;
  limit?: number;
}

const SEARCH_TIMEOUT_MS = 15_000;

/** True when the operator has pointed this worker at a SearXNG instance. */
export function isSearxngConfigured(env: Env): boolean {
  return typeof env.SEARXNG_BASE_URL === "string" && env.SEARXNG_BASE_URL.trim().length > 0;
}

export class SearxngClient {
  constructor(private env: Env) {}

  requireConfigured(): void {
    if (!isSearxngConfigured(this.env)) {
      throw new KagiNotConfiguredError(
        "SEARXNG_BASE_URL is not set — the SearXNG fallback is unavailable. " +
          "Set the var to the Tunnel hostname (or binding) of your SearXNG instance.",
      );
    }
  }

  async search(args: SearxngSearchArgs): Promise<SearchResponse> {
    this.requireConfigured();
    const start_ms = Date.now();
    const limit = args.limit ?? 10;

    const base = (this.env.SEARXNG_BASE_URL as string).replace(/\/+$/, "");
    // SearXNG `format=json` has no `limit` param (paging is via `pageno`),
    // so the requested limit is enforced client-side in `normalize` below —
    // sending an inert param would imply the instance honors it.
    const url = `${base}/search?q=${encodeURIComponent(args.q)}&format=json`;

    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": "kagi-shinobi/0.2 (+searxng-fallback)",
    };
    // Cloudflare Access service token, when the operator put the Tunnel
    // behind Access. Absent for a VPC-adjacent binding, which needs none.
    if (this.env.SEARXNG_ACCESS_CLIENT_ID && this.env.SEARXNG_ACCESS_CLIENT_SECRET) {
      headers["CF-Access-Client-Id"] = this.env.SEARXNG_ACCESS_CLIENT_ID;
      headers["CF-Access-Client-Secret"] = this.env.SEARXNG_ACCESS_CLIENT_SECRET;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
    let wire: SearxngJsonResponse;
    try {
      const response = await fetch(url, { headers, signal: controller.signal });
      if (!response.ok) {
        // Numeric status + our allowlisted phrase only, never the raw body
        // or the remote reason phrase — a typed KagiError's message/detail
        // are client-visible (see safeErrorMessage).
        throw new KagiError(
          "upstream",
          `SearXNG answered HTTP ${response.status}: ${safeStatusPhrase(response.status)}`,
          { status: response.status, status_text: safeStatusPhrase(response.status) },
        );
      }
      wire = (await response.json()) as SearxngJsonResponse;
    } catch (err) {
      if (err instanceof KagiError) throw err;
      if ((err as { name?: string }).name === "AbortError") {
        throw new KagiError("timeout", `SearXNG request timed out after ${SEARCH_TIMEOUT_MS}ms`, {
          ms: SEARCH_TIMEOUT_MS,
        });
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    return normalize(args.q, wire, start_ms, limit);
  }
}

/** SearXNG `format=json` into the canonical `SearchResponse`. Exported so
 *  tests can pin the mapping without a network round-trip. `limit` caps the
 *  returned results — SearXNG's `format=json` ignores any limit param, so the
 *  cap is enforced here, not on the wire. Omitted = no cap. */
export function normalizeSearxngResponse(
  query: string,
  wire: SearxngJsonResponse,
  start_ms: number,
  limit?: number,
): SearchResponse {
  return normalize(query, wire, start_ms, limit);
}

function normalize(
  query: string,
  wire: SearxngJsonResponse,
  start_ms: number,
  limit?: number,
): SearchResponse {
  const results: SearchResult[] = [];
  const raw = Array.isArray(wire.results) ? wire.results : [];
  let rank = 1;
  for (const item of raw) {
    if (limit !== undefined && results.length >= limit) break;
    const r = toResult(item as SearxngJsonResult, rank);
    if (r) {
      results.push(r);
      rank++;
    }
  }
  const response: SearchResponse = {
    query,
    results,
    meta: buildMeta({
      impl: "searxng",
      start_ms,
      warnings: [
        "Served by the SearXNG fallback: free and unlimited, but noisier than Kagi.",
      ],
    }),
  };
  const related = asStringList(wire.suggestions);
  const answers = asStringList(wire.answers);
  if (related.length > 0 || answers.length > 0) {
    response.buckets = {
      ...(related.length > 0 ? { related_search: related } : {}),
      ...(answers.length > 0 ? { direct_answer: answers[0] } : {}),
    };
  }
  return response;
}

function toResult(item: SearxngJsonResult, rank: number): SearchResult | null {
  if (!item || typeof item !== "object") return null;
  const url = typeof item.url === "string" ? item.url : "";
  if (!url) return null;
  const result: SearchResult = {
    rank,
    url,
    title: typeof item.title === "string" ? item.title : "",
    snippet: typeof item.content === "string" ? item.content : "",
    source_domain: domainFromUrl(url),
    source_impl: "searxng",
  };
  if (typeof item.publishedDate === "string" && item.publishedDate) {
    result.published_at = item.publishedDate;
  }
  if (typeof item.thumbnail === "string" && item.thumbnail) {
    result.thumbnail_url = item.thumbnail;
  }
  // Which upstream SearXNG engine produced this hit (e.g. "brave",
  // "duckduckgo"). Opaque per-impl detail, per the types.ts convention.
  if (typeof item.engine === "string" && item.engine) {
    result.props = { engine: item.engine };
  }
  return result;
}

function asStringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.length > 0);
}
