// Wire-level types for the official Kagi API.
//
// Hand-written from the docs (help.kagi.com/kagi/api, kagi.redocly.app). A
// follow-up sprint can swap these for `openapi-typescript` output once Kagi's
// spec URL stabilizes — see docs/adr/0001-tri-mode-architecture.md.
//
// Keep this file focused on the wire shape ONLY. Canonical (facade-facing)
// shapes live in ../types.ts.

// Envelope shape (`{meta, data}`) is unwrapped inside KagiApiClient — none of
// the endpoint modules need to import it.

// ---------- v1 /search ----------

export type V1Workflow = "web" | "news" | "images" | "videos" | "podcasts";

export interface V1PersonalizationDomain {
  domain: string;
  kind: "block" | "lower" | "raise" | "pin";
}

export interface V1PersonalizationRegex {
  regex: string;
  replacement?: string;
}

export interface V1LensInline {
  sites_included?: string[];
  sites_excluded?: string[];
  keywords_included?: string[];
  keywords_excluded?: string[];
  file_type?: string;
  time_after?: string;
  time_before?: string;
  time_relative?: "day" | "week" | "month";
  search_region?: string;
}

export interface V1SearchRequest {
  query: string;
  workflow?: V1Workflow;
  format?: "json" | "markdown"; // markdown is EXPERIMENTAL per docs
  lens_id?: string;
  lens?: V1LensInline;
  timeout?: number;
  page?: number; // 1..10
  limit?: number; // 1..1024
  filters?: { region?: string; after?: string; before?: string };
  extract?: { count?: number; timeout?: number };
  safe_search?: boolean;
  personalizations?: {
    domains?: V1PersonalizationDomain[];
    regexes?: V1PersonalizationRegex[];
  };
}

export interface V1SearchItem {
  url?: string;
  title?: string;
  snippet?: string;
  time?: string;
  image?: { url?: string; height?: number; width?: number };
  props?: Record<string, unknown>;
}

export interface V1SearchData {
  search?: V1SearchItem[];
  image?: V1SearchItem[];
  video?: V1SearchItem[];
  podcast?: V1SearchItem[];
  podcast_creator?: V1SearchItem[];
  news?: V1SearchItem[];
  adjacent_question?: V1SearchItem[];
  direct_answer?: V1SearchItem[];
  interesting_news?: V1SearchItem[];
  interesting_finds?: V1SearchItem[]; // Small Web bucket
  infobox?: Record<string, unknown>;
  code?: V1SearchItem[];
  package_tracking?: V1SearchItem[];
  public_records?: V1SearchItem[];
  weather?: Record<string, unknown>;
  related_search?: string[];
  listicle?: V1SearchItem[];
  web_archive?: V1SearchItem[];
}

// ---------- v1 /extract ----------

export interface V1ExtractRequest {
  urls: string[]; // max 10
  format?: "markdown" | "text";
  timeout?: number;
}

export interface V1ExtractPage {
  url: string;
  title?: string;
  content?: string; // markdown or text depending on format
  word_count?: number;
  props?: Record<string, unknown>;
}

export interface V1ExtractData {
  pages: V1ExtractPage[];
}

// ---------- v0 /fastgpt ----------

export interface V0FastGPTRequest {
  query: string;
  cache?: boolean;
}

export interface V0FastGPTReference {
  title: string;
  snippet: string;
  url: string;
}

export interface V0FastGPTData {
  output: string;
  tokens?: number;
  references?: V0FastGPTReference[];
}

// ---------- v0 /summarize ----------

export type V0SummarizerEngine = "cecil" | "agnes" | "daphne" | "muriel";

export interface V0SummarizeRequest {
  /** URL to summarize. Mutually exclusive with `text`. */
  url?: string;
  /** Raw text to summarize. Mutually exclusive with `url`. */
  text?: string;
  engine?: V0SummarizerEngine;
  summary_type?: "summary" | "takeaway";
  target_language?: string;
  cache?: boolean;
}

export interface V0SummarizeData {
  output: string;
  tokens?: number;
}

// ---------- v0 /enrich/{web,news} ----------

export interface V0EnrichRequest {
  q: string;
}

export interface V0EnrichItem {
  rank?: number;
  url: string;
  title?: string;
  snippet?: string;
  published?: string;
  t?: number;
}
