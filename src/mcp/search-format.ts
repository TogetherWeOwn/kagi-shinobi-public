// Concise search output: URL normalization, stable citation refs, snippet
// truncation, cross-query dedupe, and the concise/detailed formatters behind
// kagi_search_fetch's `response_format` input. See ADR 0013.
//
// Pure functions only — no bindings, no runtime globals — so both the Node
// `unit` project and the workerd `workers` project can import this.

import { z } from "zod";
import type { MetaBlock, SearchResponse } from "../kagi/types.js";

export type ResponseFormat = "concise" | "detailed";

/** Budget for one concise snippet line, ellipsis included. */
export const CONCISE_SNIPPET_MAX = 240;

// ---------------------------------------------------------------------------
// SHA-1 (hex). Hand-rolled so formatting stays synchronous in both runtimes:
// crypto.subtle.digest is async, and node:crypto is unavailable in workerd.
// SHA-1 is a content key here, not security — see ADR 0013. Pinned against the
// RFC 3179 vectors in test/mcp/search-format.test.ts.
// ---------------------------------------------------------------------------

function rotl32(x: number, n: number): number {
  return ((x << n) | (x >>> (32 - n))) | 0;
}

export function sha1Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  // Padded length: original + 0x80 + 8 length bytes, rounded up to 64.
  // URLs never approach 2^32 bits, so the high length word stays zero.
  const paddedLen = (((bytes.length + 9 + 63) >> 6) << 6);
  const buf = new Uint8Array(paddedLen);
  buf.set(bytes);
  buf[bytes.length] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(paddedLen - 4, bytes.length * 8, false);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;

  const w: number[] = new Array<number>(80);
  for (let off = 0; off < paddedLen; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4, false);
    for (let i = 16; i < 80; i++) {
      w[i] = rotl32(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let i = 0; i < 80; i++) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const tmp = (rotl32(a, 5) + f + e + k + w[i]) | 0;
      e = d;
      d = c;
      c = rotl32(b, 30);
      b = a;
      a = tmp;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
  }

  return [h0, h1, h2, h3, h4]
    .map((h) => (h >>> 0).toString(16).padStart(8, "0"))
    .join("");
}

// ---------------------------------------------------------------------------
// URL normalization. Two URLs that differ only by tracking junk, fragment, or
// letter-case of scheme/host are the same citation target.
// ---------------------------------------------------------------------------

const TRACKING_EXACT = new Set([
  "fbclid",
  "gclid",
  "gbraid",
  "wbraid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "igshid",
  "ttclid",
  "twclid",
  "yclid",
  "dclid",
  "pk_campaign",
  "pk_kwd",
  "matomo",
  "_hsenc",
  "_hsmi",
  "hsctatracking",
  "mkt_tok",
  "vero_conv",
  "vero_id",
]);

function isTrackingParam(name: string): boolean {
  const n = name.toLowerCase();
  return n.startsWith("utm_") || n.startsWith("piwik_") || TRACKING_EXACT.has(n);
}

export function normalizeUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    // Unparseable input hashes as-is: a stable ref beats no ref.
    return raw;
  }
  const scheme = u.protocol.toLowerCase();
  if (scheme !== "http:" && scheme !== "https:") return raw;
  const host = u.hostname.toLowerCase();
  let port = u.port;
  if ((scheme === "http:" && port === "80") || (scheme === "https:" && port === "443")) {
    port = "";
  }
  const params = u.searchParams;
  const doomed: string[] = [];
  params.forEach((_v, k) => {
    if (isTrackingParam(k) && !doomed.includes(k)) doomed.push(k);
  });
  for (const k of doomed) params.delete(k);
  params.sort();
  // The fragment never reaches a server, so it cannot change the document.
  const path = u.pathname === "/" ? "" : u.pathname;
  const query = params.toString();
  return `${scheme}//${host}${port ? `:${port}` : ""}${path}${query ? `?${query}` : ""}`;
}

/** Stable citation ref: first 10 hex chars of the normalized URL's SHA-1. */
export function stableRef(url: string): string {
  return sha1Hex(normalizeUrl(url)).slice(0, 10);
}

// ---------------------------------------------------------------------------
// Snippet truncation: collapse whitespace, then cut at a word boundary with an
// ellipsis. Total length never exceeds CONCISE_SNIPPET_MAX.
// ---------------------------------------------------------------------------

export function truncateSnippet(snippet: string): string {
  const collapsed = snippet.replace(/\s+/g, " ").trim();
  if (collapsed.length <= CONCISE_SNIPPET_MAX) return collapsed;
  const budget = CONCISE_SNIPPET_MAX - 1; // room for the ellipsis
  const window = collapsed.slice(0, budget + 1);
  const lastSpace = window.lastIndexOf(" ");
  // A space only counts as a word boundary when it leaves most of the budget
  // intact; otherwise this is one long token and we hard-cut.
  const cut = lastSpace > CONCISE_SNIPPET_MAX / 2 ? window.slice(0, lastSpace) : window.slice(0, budget);
  return `${cut}…`;
}

// ---------------------------------------------------------------------------
// Cross-query dedupe: collapse results sharing a normalized URL to the first
// occurrence. Applies in both formats — citation identity, not verbosity.
// ---------------------------------------------------------------------------

export interface DedupeOutcome {
  deduped: Array<SearchResponse | null>;
  dropped: number;
}

export function dedupeResponses(perQuery: Array<SearchResponse | null>): DedupeOutcome {
  const seen = new Set<string>();
  let dropped = 0;
  const deduped = perQuery.map((resp) => {
    if (resp === null) return resp;
    const results = resp.results.filter((r) => {
      const key = normalizeUrl(r.url);
      if (seen.has(key)) {
        dropped++;
        return false;
      }
      seen.add(key);
      return true;
    });
    return { ...resp, results };
  });
  return { deduped, dropped };
}

// ---------------------------------------------------------------------------
// Formatters.
// ---------------------------------------------------------------------------

export interface FormatErrors {
  query: string;
  error: string;
}

export interface FormatInput {
  mode: string;
  errors: FormatErrors[];
}

export interface ConciseResultItem {
  id: string;
  ref: string;
  url: string;
  rank: number;
}

export interface ConciseQueryBlock {
  query: string;
  results: ConciseResultItem[];
  meta: MetaBlock;
}

export interface ConciseStructured {
  response_format: "concise";
  mode: string;
  queries: ConciseQueryBlock[];
  errors: FormatErrors[];
  dedup_dropped: number;
}

export interface DetailedStructured {
  response_format: "detailed";
  mode: string;
  queries: SearchResponse[];
  errors: FormatErrors[];
  dedup_dropped: number;
}

function errorBlock(errors: FormatErrors[]): string {
  if (errors.length === 0) return "";
  return `\n\nErrors encountered:\n${errors.map((e) => `Query "${e.query}": ${e.error}`).join("\n")}`;
}

function citationLine(n: number, title: string, domain: string, date?: string): string {
  const head = `[S${n}] ${title || "No Title"}`;
  const where = domain ? ` — ${domain}` : "";
  const when = date ? ` (${date})` : "";
  return `${head}${where}${when}`;
}

export function formatSearchConcise(
  queries: string[],
  perQuery: Array<SearchResponse | null>,
  input: FormatInput,
): { text: string; structured: ConciseStructured } {
  const { deduped, dropped } = dedupeResponses(perQuery);
  const chunks: string[] = [];
  const blocks: ConciseQueryBlock[] = [];
  let n = 1;
  for (let i = 0; i < queries.length; i++) {
    const resp = deduped[i];
    const results = resp?.results ?? [];
    const items: ConciseResultItem[] = [];
    const lines = results.map((r) => {
      const id = `S${n++}`;
      items.push({ id, ref: stableRef(r.url), url: r.url, rank: r.rank });
      const line = citationLine(Number(id.slice(1)), r.title, r.source_domain, r.published_at);
      const snippet = truncateSnippet(r.snippet);
      return snippet ? `${line}\n${snippet}` : line;
    });
    if (resp) blocks.push({ query: queries[i], results: items, meta: resp.meta });
    chunks.push(
      `-----\nResults for search query "${queries[i]}":\n-----\n${lines.length > 0 ? lines.join("\n\n") : "(no results)"}`,
    );
  }
  return {
    text: chunks.join("\n\n") + errorBlock(input.errors),
    structured: {
      response_format: "concise",
      mode: input.mode,
      queries: blocks,
      errors: input.errors,
      dedup_dropped: dropped,
    },
  };
}

export function formatSearchDetailed(
  queries: string[],
  perQuery: Array<SearchResponse | null>,
  input: FormatInput,
): { text: string; structured: DetailedStructured } {
  const { deduped, dropped } = dedupeResponses(perQuery);
  const chunks: string[] = [];
  let startIndex = 1;
  for (let i = 0; i < queries.length; i++) {
    const resp = deduped[i];
    const results = resp?.results ?? [];
    const lines = results.map((r, idx) => {
      const num = startIndex + idx;
      return `${num}: ${r.title || "No Title"}\n${r.url}\nPublished Date: ${r.published_at ?? "Not Available"}\n${r.snippet || "No snippet available"}`;
    });
    startIndex += results.length;
    chunks.push(`-----\nResults for search query "${queries[i]}":\n-----\n${lines.join("\n\n")}`);
  }
  return {
    text: chunks.join("\n\n") + errorBlock(input.errors),
    structured: {
      response_format: "detailed",
      mode: input.mode,
      queries: deduped.filter((r): r is SearchResponse => r !== null),
      errors: input.errors,
      dedup_dropped: dropped,
    },
  };
}

// ---------------------------------------------------------------------------
// Published output schema for kagi_search_fetch (ADR 0013). The tool registers
// via server.registerTool() so the SDK advertises and validates this shape.
// ---------------------------------------------------------------------------

const metaSchema = z.object({
  impl: z.string(),
  cache_hit: z.boolean(),
  cache_age_s: z.number().optional(),
  elapsed_ms: z.number(),
  cost_cents: z.number().optional(),
  trace_id: z.string().optional(),
  session_stale: z.boolean().optional(),
  refresh_triggered: z.boolean().optional(),
  warnings: z.array(z.string()).optional(),
});

const conciseResultSchema = z.object({
  id: z.string(),
  ref: z.string(),
  url: z.string(),
  rank: z.number(),
});

const conciseQuerySchema = z.object({
  query: z.string(),
  results: z.array(conciseResultSchema),
  meta: metaSchema,
});

const searchResultSchema = z.object({
  rank: z.number(),
  url: z.string(),
  title: z.string(),
  snippet: z.string(),
  published_at: z.string().optional(),
  source_domain: z.string(),
  thumbnail_url: z.string().optional(),
  source_impl: z.string(),
  props: z.record(z.string(), z.unknown()).optional(),
});

const detailedQuerySchema = z.object({
  query: z.string(),
  results: z.array(searchResultSchema),
  buckets: z
    .object({
      direct_answer: z.string().optional(),
      related_search: z.array(z.string()).optional(),
      infobox: z.record(z.string(), z.unknown()).optional(),
    })
    .catchall(z.unknown())
    .optional(),
  meta: metaSchema,
});

const errorEntrySchema = z.object({
  query: z.string(),
  error: z.string(),
});

export const searchOutputSchema = {
  response_format: z.enum(["concise", "detailed"]),
  mode: z.string(),
  queries: z.array(z.union([conciseQuerySchema, detailedQuerySchema])),
  errors: z.array(errorEntrySchema),
  dedup_dropped: z.number(),
};

export const responseFormatSchema = z
  .enum(["concise", "detailed"])
  .optional()
  .describe(
    "Output verbosity. concise (default) renders one citation line plus a ≤240-char snippet per result with a slim structured channel; detailed keeps the legacy full text and full structured responses.",
  );
