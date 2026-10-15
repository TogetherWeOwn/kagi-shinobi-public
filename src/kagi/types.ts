// Canonical shapes returned by the KagiClient facade, regardless of impl.
//
// Both the scrape and the official-API Kagi implementations normalize into
// these types so downstream MCP tools never branch on which impl produced the
// data. SearXNG results normalize here too (source_impl "searxng") —
// engine=kagi|searxng|auto is a layer above impl, so the schema is identical
// whichever engine served the query. See ADR 0014.
//
// Divergent per-impl fields go into `props` — treat as opaque unless you're
// scoped to a specific impl (e.g. an api-only tool).

export type ImplKind = "scrape" | "api" | "searxng";

/**
 * The Kagi-internal impls (scrape vs official API). Callers pick one with the
 * `impl` override; `searxng` is not an impl but an engine tier above it, so
 * it never appears here. See ADR 0014.
 */
export type KagiImpl = "scrape" | "api";

/**
 * Search engine tier, a layer above `impl`. `kagi` routes through the tri-mode
 * dispatcher (scrape/api/hybrid) exactly as before; `searxng` goes to the
 * self-hosted SearXNG fallback; `auto` tries Kagi first and serves SearXNG on
 * any Kagi-side failure, annotating `meta.warnings`. See ADR 0014.
 */
export type SearchEngine = "kagi" | "searxng" | "auto";

export interface MetaBlock {
  impl: ImplKind;
  cache_hit: boolean;
  /** Seconds since the upstream fetch that produced this response. Absent on a miss. */
  cache_age_s?: number;
  elapsed_ms: number;
  cost_cents?: number;          // API impl only
  trace_id?: string;            // API meta.trace / X-Kagi-Trace
  session_stale?: boolean;      // Scrape impl only
  refresh_triggered?: boolean;  // Scrape impl only
  warnings?: string[];          // Non-fatal caveats (e.g. workflow fallback in scrape)
}

export interface SearchResult {
  rank: number;
  url: string;
  title: string;
  snippet: string;
  published_at?: string;        // ISO 8601 (api provides; scrape rarely)
  source_domain: string;
  thumbnail_url?: string;
  source_impl: ImplKind;
  props?: Record<string, unknown>;
}

export interface SearchBuckets {
  images?: SearchResult[];
  videos?: SearchResult[];
  news?: SearchResult[];
  podcasts?: SearchResult[];
  small_web?: SearchResult[];   // v1 "interesting_finds"
  direct_answer?: string;
  related_search?: string[];
  infobox?: Record<string, unknown>;
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
  buckets?: SearchBuckets;
  meta: MetaBlock;
}

export interface FastGPTReference {
  title: string;
  url: string;
  snippet: string;
}

export interface FastGPTResponse {
  query: string;
  answer: string;
  references: FastGPTReference[];
  tokens?: number;
  meta: MetaBlock;
}

export type SummarizerEngine = "cecil" | "agnes" | "daphne" | "muriel" | "scrape-default";
export type SummaryStyle = "summary" | "takeaway";

export interface SummarizeResponse {
  source: { kind: "url" | "text"; ref: string };
  summary: string;
  engine_used: SummarizerEngine;
  target_language: string;
  tokens?: number;
  meta: MetaBlock;
}

export interface ExtractedPage {
  url: string;
  markdown: string;
  title?: string;
  word_count?: number;
  props?: Record<string, unknown>;
}

export interface ExtractResponse {
  pages: ExtractedPage[];
  meta: MetaBlock;
}

export interface EnrichResponse {
  index: "teclis" | "tinygem";
  results: SearchResult[];
  meta: MetaBlock;
}

export interface Lens {
  id: string;
  name: string;
  is_custom: boolean;
  description?: string;
}

export interface LensListResponse {
  lenses: Lens[];
  meta: MetaBlock;
}

export type PersonalizationAction = "pin" | "raise" | "lower" | "block" | "neutral";

export interface PersonalizationRule {
  domain?: string;
  regex?: string;
  action: Exclude<PersonalizationAction, "neutral">;
}

export interface RankedUrl {
  url: string;
  score: number;              // 0..1; higher = better
  action: PersonalizationAction;
  rationale?: string;
}

export interface RankResponse {
  query?: string;
  ranked: RankedUrl[];
  meta: MetaBlock;
}
