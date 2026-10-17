// Small Web via the paid API: run a /v1/search and lift the interesting_finds
// bucket as primary results. Cheaper alternative in scrape mode is the RSS
// feed (scrape/smallweb.ts).

import type { Env } from "../../env.js";
import { apiSearch } from "./search.js";
import type { SearchResponse } from "../types.js";

export interface ApiSmallWebArgs {
  q?: string;
  limit?: number;
}

export async function apiSmallWeb(
  env: Env,
  args: ApiSmallWebArgs,
): Promise<SearchResponse> {
  // No `q` → search a broad seed so interesting_finds fires. This does bill
  // as a full v1 search (~1.2¢); RSS path in scrape mode is free.
  const q = args.q ?? "smallweb recent";
  const resp = await apiSearch(env, { query: q, limit: args.limit });
  const finds = resp.buckets?.small_web ?? [];
  return {
    query: q,
    results: finds,
    meta: resp.meta,
    buckets: resp.buckets,
  };
}
