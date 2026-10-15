// POST /v1/search — Kagi's paid search API.
//
// Priced at $12 / 1000 requests. Every call is billable regardless of results
// (unlike /enrich). Personalization + lens_id are per-request; the account's
// stored settings still apply on top of them.

import type { Env } from "../../env.js";
import { KagiApiClient } from "./client.js";
import { guardBillable } from "./cost.js";
import type { V1SearchData, V1SearchItem, V1SearchRequest } from "./types.js";
import { buildMeta } from "../../mcp/meta.js";
import type { SearchBuckets, SearchResponse, SearchResult } from "../types.js";
import { domainFromUrl } from "../../util/url.js";

const SEARCH_URL = "https://kagi.com/api/v1/search";
const CENTS_PER_CALL = 1.2; // $12 / 1000

export interface ApiSearchFullArgs extends V1SearchRequest {}

export async function apiSearch(
  env: Env,
  req: ApiSearchFullArgs,
): Promise<SearchResponse> {
  const start_ms = Date.now();
  const guard = await guardBillable(env, CENTS_PER_CALL);
  const client = new KagiApiClient(env);
  const wire = await client.request<V1SearchData>({
    method: "POST",
    url: SEARCH_URL,
    body: req,
  });
  await guard.settle(CENTS_PER_CALL);
  return normalize(req.query, wire.data, wire.trace_id, start_ms);
}

function normalize(
  query: string,
  envelope: V1SearchData,
  trace_id: string | undefined,
  start_ms: number,
): SearchResponse {
  const results: SearchResult[] = itemsToResults(envelope.search, 1);
  const buckets: SearchBuckets = {};
  if (envelope.image?.length) buckets.images = itemsToResults(envelope.image, 1);
  if (envelope.video?.length) buckets.videos = itemsToResults(envelope.video, 1);
  if (envelope.news?.length) buckets.news = itemsToResults(envelope.news, 1);
  if (envelope.podcast?.length) buckets.podcasts = itemsToResults(envelope.podcast, 1);
  if (envelope.interesting_finds?.length) {
    buckets.small_web = itemsToResults(envelope.interesting_finds, 1);
  }
  if (envelope.related_search?.length) buckets.related_search = envelope.related_search;
  if (envelope.infobox) buckets.infobox = envelope.infobox;
  // direct_answer arrives as an item list; flatten to a string if present.
  if (envelope.direct_answer?.length) {
    const snippet = envelope.direct_answer[0]?.snippet;
    if (snippet) buckets.direct_answer = snippet;
  }
  const response: SearchResponse = {
    query,
    results,
    meta: buildMeta({
      impl: "api",
      start_ms,
      cost_cents: CENTS_PER_CALL,
      trace_id,
    }),
  };
  if (hasAnyBucketKey(buckets)) response.buckets = buckets;
  return response;
}

function itemsToResults(items: V1SearchItem[] | undefined, startRank: number): SearchResult[] {
  if (!items) return [];
  return items
    .filter((it) => typeof it.url === "string" && it.url.length > 0)
    .map((it, i) => ({
      rank: startRank + i,
      url: it.url as string,
      title: it.title ?? "",
      snippet: it.snippet ?? "",
      published_at: it.time,
      source_domain: domainFromUrl(it.url as string),
      thumbnail_url: it.image?.url,
      source_impl: "api" as const,
      props: it.props,
    }));
}

function hasAnyBucketKey(b: SearchBuckets): boolean {
  return Object.keys(b).length > 0;
}
