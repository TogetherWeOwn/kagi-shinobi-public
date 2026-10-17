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
import { KagiParseError, withChargedCost } from "../errors.js";
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
  // Past the guard the projected charge is reserved; any throw from here —
  // dispatch, shape validation, settle or mapping — must carry it so
  // budget-keeping callers book the debit (see withChargedCost), exactly as
  // in the other billable wrappers. The one exception is a genuine empty
  // ARRAY whose settle(0) has already succeeded: that call is proven
  // unbilled, and `settledFree` records it so a later throw is not priced.
  // A missing/null/non-array `data` proves nothing about billing — the
  // request was dispatched — so it must never reach settle(0) and refund
  // the reservation as if it were an empty result.
  let settledFree = false;
  try {
    const url = `https://kagi.com/api/v0/enrich/${vertical}?q=${encodeURIComponent(args.q)}`;
    const client = new KagiApiClient(env);
    const wire = await client.request<V0EnrichItem[]>({
      method: "GET",
      url,
    });
    const items = wire.data;
    if (!Array.isArray(items)) {
      throw new KagiParseError("Enrich response did not include a result list");
    }
    const nonZero = items.length > 0;
    // Docs: bill only when non-zero results are returned.
    await guard.settle(nonZero ? CENTS_PER_CALL : 0);
    settledFree = !nonZero;

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
    throw withChargedCost(err, settledFree ? 0 : CENTS_PER_CALL);
  }
}
