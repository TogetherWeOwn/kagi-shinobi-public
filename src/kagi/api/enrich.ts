// GET /v0/enrich/{web,news} — Kagi's Teclis / TinyGem enrichment indexes.
//
// Priced at $2 / 1000 searches, BUT the docs explicitly state:
//   "we bill only when non-zero results are returned"
// so we guard the projected charge and settle with 0 on empty responses.

import type { Env } from "../../env.js";
import { KagiApiClient } from "./client.js";
import { guardBillable } from "./cost.js";
import type { V0EnrichItem } from "./types.js";
import { buildMeta } from "../../mcp/meta.js";
import { withChargedCost } from "../errors.js";
import type { EnrichResponse, SearchResult } from "../types.js";
import { domainFromUrl } from "../../util/url.js";

const CENTS_PER_CALL = 0.2; // $2 / 1000

export interface ApiEnrichArgs {
  q: string;
}

export function apiEnrichWeb(env: Env, args: ApiEnrichArgs): Promise<EnrichResponse> {
  return enrich(env, "web", args);
}

export function apiEnrichNews(env: Env, args: ApiEnrichArgs): Promise<EnrichResponse> {
  return enrich(env, "news", args);
}

async function enrich(
  env: Env,
  vertical: "web" | "news",
  args: ApiEnrichArgs,
): Promise<EnrichResponse> {
  const start_ms = Date.now();
  const guard = await guardBillable(env, CENTS_PER_CALL);
  const url = `https://kagi.com/api/v0/enrich/${vertical}?q=${encodeURIComponent(args.q)}`;
  const client = new KagiApiClient(env);
  const wire = await client.request<V0EnrichItem[]>({
    method: "GET",
    url,
  });
  const items = wire.data;
  const nonZero = items.length > 0;
  // Docs: bill only when non-zero results are returned.
  await guard.settle(nonZero ? CENTS_PER_CALL : 0);

  // Past settle a non-zero call is paid for; a mapping throw must carry the
  // charge so budget-keeping callers book it (see withChargedCost).
  try {
    const results: SearchResult[] = items
      .filter((it) => Boolean(it.url))
      .map((it, i) => ({
        rank: it.rank ?? i + 1,
        url: it.url,
        title: it.title ?? "",
        snippet: it.snippet ?? "",
        published_at: it.published,
        source_domain: domainFromUrl(it.url),
        source_impl: "api" as const,
      }));

    return {
      index: vertical === "web" ? "teclis" : "tinygem",
      results,
      meta: buildMeta({
        impl: "api",
        start_ms,
        cost_cents: nonZero ? CENTS_PER_CALL : 0,
        trace_id: wire.trace_id,
      }),
    };
  } catch (err) {
    throw withChargedCost(err, nonZero ? CENTS_PER_CALL : 0);
  }
}
