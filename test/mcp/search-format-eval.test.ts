// Acceptance eval for ADR 0013: the median chars of the whole
// tool payload (text + JSON.stringify(structuredContent)) for a 10-result
// search drops ≥40% vs the frozen legacy baseline, measured over 20 fixed
// queries. The card names *both* the text filler and the structured
// repetition as the problem, so the metric covers both channels.
//
// The baseline formatter is inlined here on purpose — it is the pre-change
// output byte-for-byte, so a future edit to src/ cannot move the goalposts.
// The generator below is deterministic (seeded PRNG, fixed corpus), so the
// numbers reproduce exactly on every run.

import { describe, expect, it } from "vitest";
import type { SearchResponse } from "../../src/kagi/types";
import { formatSearchConcise } from "../../src/mcp/search-format";

// Frozen copy of the pre-change tool output (src/mcp.ts, before ADR 0013):
// the text formatter plus the full structured passthrough.
function baselinePayload(queries: string[], responses: (SearchResponse | null)[]): string {
  const chunks: string[] = [];
  let startIndex = 1;
  for (let i = 0; i < queries.length; i++) {
    const resp = responses[i];
    const results = resp?.results ?? [];
    const lines = results.map((r, idx) => {
      const n = startIndex + idx;
      return `${n}: ${r.title || "No Title"}
${r.url}
Published Date: ${r.published_at ?? "Not Available"}
${r.snippet || "No snippet available"}`;
    });
    startIndex += results.length;
    chunks.push(`-----\nResults for search query "${queries[i]}":\n-----\n${lines.join("\n\n")}`);
  }
  const text = chunks.join("\n\n");
  const structured = {
    queries: responses.filter((r): r is SearchResponse => r !== null),
    errors: [],
    mode: "scrape",
  };
  return text + JSON.stringify(structured);
}

function concisePayload(queries: string[], responses: (SearchResponse | null)[]): string {
  const { text, structured } = formatSearchConcise(queries, responses, {
    mode: "scrape",
    errors: [],
  });
  return text + JSON.stringify(structured);
}

// Deterministic PRNG (mulberry32) — fixed seed, so the corpus never shifts.
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DOMAINS = [
  "example.com",
  "blog.example.org",
  "news.example.net",
  "docs.example.dev",
  "shop.example.io",
  "wiki.example.edu",
  "forum.example.co",
  "video.example.tv",
];

const TOPICS = [
  "cloudflare workers durable objects",
  "kagi search api pricing",
  "typescript strict mode best practices",
  "mcp protocol streamable http",
  "cheerio server side rendering parse",
  "vitest coverage thresholds ratchet",
  "zod schema validation error",
  "browser rendering puppeteer login",
  "kv namespace session token cache",
  "rate limiting per bearer token",
  "small web independent corpus",
  "fastgpt cited answer references",
  "universal summarizer engines",
  "teclis web enrichment index",
  "personalized rank site probes",
  "deep research subquery pipeline",
  "canonical response shapes meta",
  "error envelope kind mapping",
  "schema snapshot wire contract",
  "e2e scope rule adr eleven",
];

const SNIPPETS = [
  "A comprehensive guide covering the fundamentals with practical examples and detailed explanations of the core concepts involved in this topic area.",
  "Learn how it works under the hood, including the architecture decisions, trade-offs, and performance characteristics you should know about before adopting it.",
  "Official documentation with quickstart instructions, configuration reference, troubleshooting tips, and migration notes for upgrading from earlier versions.",
  "Community discussion thread with real-world experiences, workarounds for common pitfalls, benchmarks, and comparisons against the alternatives people actually use.",
  "In-depth analysis with diagrams, code samples, and a step-by-step walkthrough that takes you from zero to a working implementation in under an hour.",
];

/** 10 deterministic results for query index qi. Mixes dates, tracking params. */
function resultsFor(qi: number): SearchResponse {
  const rand = prng(11838 + qi);
  const domain0 = DOMAINS[qi % DOMAINS.length];
  const mk = (i: number) => {
    const d = DOMAINS[Math.floor(rand() * DOMAINS.length)];
    const words = TOPICS[(qi + i) % TOPICS.length].split(" ").slice(0, 3).join("-");
    const tracking = i % 3 === 0 ? `?utm_source=newsletter&utm_medium=email&q=${i}` : i % 3 === 1 ? `#section-${i}` : "";
    const snippet = SNIPPETS[Math.floor(rand() * SNIPPETS.length)];
    const long = rand() < 0.4 ? ` ${SNIPPETS[Math.floor(rand() * SNIPPETS.length)]}` : "";
    return {
      rank: i + 1,
      url: `https://${d}/${words}/${qi}/${i}${tracking}`,
      title: `${TOPICS[(qi + i) % TOPICS.length]} — part ${i + 1} (${domain0} roundup)`,
      snippet: snippet + long,
      ...(i % 2 === 0 ? { published_at: `2025-${String((qi + i) % 12 + 1).padStart(2, "0")}-15` } : {}),
      source_domain: d,
      source_impl: "scrape" as const,
    };
  };
  return {
    query: TOPICS[qi],
    results: Array.from({ length: 10 }, (_, i) => mk(i)),
    meta: { impl: "scrape" as const, cache_hit: false, elapsed_ms: 12 },
  };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

describe("ADR 0013 acceptance: concise output is ≥40% smaller", () => {
  it("median payload chars for a 10-result search drops ≥40% vs baseline on 20 fixed queries", () => {
    expect(TOPICS).toHaveLength(20);
    const baseLens: number[] = [];
    const conciseLens: number[] = [];
    for (let qi = 0; qi < 20; qi++) {
      const perQuery = [resultsFor(qi)];
      baseLens.push(baselinePayload([TOPICS[qi]], perQuery).length);
      conciseLens.push(concisePayload([TOPICS[qi]], perQuery).length);
    }
    const baseMed = median(baseLens);
    const conciseMed = median(conciseLens);
    const drop = (baseMed - conciseMed) / baseMed;
    // eslint-disable-next-line no-console
    console.log(
      `baseline median=${baseMed} concise median=${conciseMed} drop=${(drop * 100).toFixed(1)}%`,
    );
    expect(drop).toBeGreaterThanOrEqual(0.4);
  });
});
