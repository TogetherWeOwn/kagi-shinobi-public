// Adapters that turn scrape / api responses into the canonical types.ts
// shapes. Kept in a single module so the divergence surface is auditable.

import type { SearchDataItem, SearchResultItem } from "./search.js";
import type { SearchResponse, SearchResult, SummarizeResponse, SummarizerEngine, SummaryStyle } from "./types.js";
import { buildMeta, type MetaInit } from "../mcp/meta.js";
import { domainFromUrl } from "../util/url.js";

export function scrapeSearchToCanonical(
  query: string,
  items: SearchDataItem[],
  metaInit: MetaInit,
): SearchResponse {
  const results: SearchResult[] = [];
  const related: string[] = [];
  let rank = 1;
  for (const item of items) {
    if (isResult(item)) {
      results.push({
        rank: rank++,
        url: item.url,
        title: item.title,
        snippet: item.snippet,
        source_domain: domainFromUrl(item.url),
        source_impl: "scrape",
      });
    } else if (item.t === 1) {
      related.push(...item.list);
    }
  }
  const response: SearchResponse = {
    query,
    results,
    meta: buildMeta(metaInit),
  };
  if (related.length > 0) {
    response.buckets = { related_search: related };
  }
  return response;
}

function isResult(item: SearchDataItem): item is SearchResultItem {
  return item.t === 0;
}

export interface ScrapeSummarizeInit {
  ref: string;
  kind: "url" | "text";
  language: string;
  style: SummaryStyle;
  engine: SummarizerEngine;
  metaInit: MetaInit;
}

export function scrapeSummarizeToCanonical(
  raw: { data: { output: string } },
  init: ScrapeSummarizeInit,
): SummarizeResponse {
  return {
    source: { kind: init.kind, ref: init.ref },
    summary: raw.data.output,
    engine_used: init.engine,
    target_language: init.language,
    meta: buildMeta(init.metaInit),
  };
}
