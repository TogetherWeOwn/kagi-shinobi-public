// Official API implementation of the KagiClient interface.
//
// Wires the per-endpoint modules (search, extract, fastgpt, summarize, enrich)
// into a class that mirrors the shape KagiScrapeClient exposes. Every method
// enforces MAX_API_CENTS_PER_MONTH via guardBillable inside the endpoint
// module — none of the methods below need to know pricing.

import type { Env } from "../../env.js";
import { KagiApiClient } from "./client.js";
import type {
  EnrichResponse,
  ExtractResponse,
  FastGPTResponse,
  SearchResponse,
  SummarizeResponse,
  SummarizerEngine,
  SummaryStyle,
} from "../types.js";
import { apiSearch } from "./search.js";
import { apiExtract } from "./extract.js";
import { apiFastGPT } from "./fastgpt.js";
import { apiSummarize } from "./summarize.js";
import { apiEnrichNews, apiEnrichWeb } from "./enrich.js";
import { apiSmallWeb, type ApiSmallWebArgs } from "./smallweb.js";
import { apiRank, type ApiRankArgs } from "./rank.js";
import type { RankResponse } from "../types.js";

export interface ApiSearchArgs {
  q: string;
  limit?: number;
  lens_id?: string;
  workflow?: "web" | "news" | "images" | "videos" | "podcasts";
  include_domains?: string[];
  exclude_domains?: string[];
  date_range?: { from?: string; to?: string };
  safe_search?: boolean;
}

export interface ApiSummarizeArgs {
  kind: "url" | "text";
  ref: string;
  language: string;
  style: SummaryStyle;
  engine?: SummarizerEngine;
  confirm_muriel?: boolean;
}

export interface ApiExtractArgs {
  urls: string[];
  format?: "markdown" | "text";
  timeout_ms?: number;
}

export interface ApiFastGPTArgs {
  query: string;
  cache?: boolean;
}

export interface ApiEnrichArgs {
  q: string;
}

/**
 * High-level API client. Every method is idempotent-friendly and rejects
 * cleanly with a KagiError subclass when misconfigured.
 */
export class KagiApiImpl {
  private client: KagiApiClient;

  constructor(private env: Env) {
    this.client = new KagiApiClient(env);
  }

  isConfigured(): boolean {
    return this.client.isConfigured();
  }

  async search(args: ApiSearchArgs): Promise<SearchResponse> {
    this.client.requireConfigured();
    return apiSearch(this.env, {
      query: args.q,
      limit: args.limit,
      workflow: args.workflow,
      lens_id: args.lens_id,
      safe_search: args.safe_search,
      filters:
        args.date_range?.from || args.date_range?.to
          ? { after: args.date_range?.from, before: args.date_range?.to }
          : undefined,
      personalizations: buildPersonalization(args.include_domains, args.exclude_domains),
    });
  }

  async summarize(args: ApiSummarizeArgs): Promise<SummarizeResponse> {
    this.client.requireConfigured();
    return apiSummarize(this.env, args);
  }

  async extract(args: ApiExtractArgs): Promise<ExtractResponse> {
    this.client.requireConfigured();
    return apiExtract(this.env, args);
  }

  async fastGPT(args: ApiFastGPTArgs): Promise<FastGPTResponse> {
    this.client.requireConfigured();
    return apiFastGPT(this.env, args);
  }

  async enrichWeb(args: ApiEnrichArgs): Promise<EnrichResponse> {
    this.client.requireConfigured();
    return apiEnrichWeb(this.env, args);
  }

  async enrichNews(args: ApiEnrichArgs): Promise<EnrichResponse> {
    this.client.requireConfigured();
    return apiEnrichNews(this.env, args);
  }

  async smallWeb(args: ApiSmallWebArgs): Promise<SearchResponse> {
    this.client.requireConfigured();
    return apiSmallWeb(this.env, args);
  }

  async rank(args: ApiRankArgs): Promise<RankResponse> {
    this.client.requireConfigured();
    return apiRank(this.env, args);
  }
}

function buildPersonalization(
  include: string[] | undefined,
  exclude: string[] | undefined,
) {
  if (!include?.length && !exclude?.length) return undefined;
  const domains: Array<{ domain: string; kind: "raise" | "block" }> = [];
  for (const d of include ?? []) domains.push({ domain: d, kind: "raise" });
  for (const d of exclude ?? []) domains.push({ domain: d, kind: "block" });
  return { domains };
}
