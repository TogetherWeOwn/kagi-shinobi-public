// Remote MCP server: exposes tools over Streamable HTTP.
//
// S2 wired the KagiClient facade so the mode dispatcher runs on every call.
// S3 added the official API endpoint impls. S4 registers the differentiated
// tools (small_web, fastgpt, extract, enrich_{web,news}) with mode-gated
// availability — tools whose active-mode support says "unavailable" never
// appear in tools/list.

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "./env.js";
import { createKagiClient, type KagiClient } from "./kagi/client.js";
import { isToolAvailable } from "./kagi/capability.js";
import { KagiError, safeErrorMessage } from "./kagi/errors.js";
import { isSupportedLanguage, SUPPORTED_LANGUAGES } from "./kagi/languages.js";
import type { SearchResponse } from "./kagi/types.js";
import { asStructured, mcpError, mcpResult } from "./mcp/result.js";
import {
  formatSearchConcise,
  formatSearchDetailed,
  responseFormatSchema,
  searchOutputSchema,
} from "./mcp/search-format.js";
import { getResearchStub } from "./research/run.js";
import { registerResources } from "./mcp/resources.js";
import { registerPrompts } from "./mcp/prompts.js";

const SEARCH_DESCRIPTION =
  "Fetch web results based on one or more queries using the Kagi.com web search engine. " +
  "Use for general search and when the user explicitly tells you to 'fetch' results/information. " +
  "Results are from all queries given. They are numbered continuously, so that a user may be able " +
  "to refer to a result by a specific number. Supports optional limit parameter to control results per query.";

const SUMMARIZE_DESCRIPTION =
  "Summarize content from a URL using the Kagi.com Summarizer API. The Summarizer can summarize " +
  "any document type (text webpage, video, audio, etc.)";

const SMALL_WEB_DESCRIPTION =
  "Search Kagi's Small Web index — an independent corpus of personal blogs, RSS feeds, and " +
  "non-commercial pages that don't appear in mainstream engines. Omit `q` to browse recent " +
  "posts via the free RSS feed.";

const FASTGPT_DESCRIPTION =
  "Ask Kagi's FastGPT for a cited answer to a question. Returns a short answer with " +
  "references. Faster than a full search when you want a direct answer.";

const EXTRACT_DESCRIPTION =
  "Fetch one or more URLs and return their clean-markdown content (up to 10 URLs per call). " +
  "Uses Kagi's /v1/extract endpoint.";

const ENRICH_WEB_DESCRIPTION =
  "Search Kagi's Teclis web enrichment index — an independent (non-Google/Bing) crawl of " +
  "general, non-commercial content. Returns metadata only; chain into kagi_extract for bodies.";

const ENRICH_NEWS_DESCRIPTION =
  "Search Kagi's TinyGem news enrichment index. Returns metadata only for non-mainstream " +
  "news sources.";

const SUMMARIZE_URL_DESCRIPTION =
  "Summarize a URL with Kagi's Universal Summarizer. Optional engine picker: " +
  "cecil (default, $0.03/1k tokens, capped at $0.30), agnes (same tier), daphne (same tier), " +
  "or muriel ($1 flat per summary — requires confirm_muriel=true).";

const SUMMARIZE_TEXT_DESCRIPTION =
  "Summarize raw text with Kagi's Universal Summarizer. Body cap 1MB. Same engine + " +
  "pricing options as kagi_summarize_url. API-only — not available in scrape mode.";

const ENGINE_ENUM = ["cecil", "agnes", "daphne", "muriel"] as const;

// Result cache bound on the five cached tools (search, fastgpt, the three
// summarizers). ADR 0017.
const maxAgeSchema = z
  .number()
  .int()
  .min(0)
  .optional()
  .describe(
    "Oldest acceptable cached result, in seconds (default: the cache TTL — search 24h, " +
      "fastgpt 6h, summaries 7d). 0 skips the cache and fetches fresh.",
  );

const RANK_DESCRIPTION =
  "Rerank a list of URLs by how well they align with Kagi's personalization " +
  "for the account. Scrape mode uses site: probes against the account's saved " +
  "block/promote lists. API mode accepts explicit rules[] with domain + action.";

const RESEARCH_CREATE_DESCRIPTION =
  "Start a deep-research run that decomposes a question into sub-queries, " +
  "searches Kagi, extracts / summarizes top sources, and synthesizes a " +
  "cited report. Returns a run_id — use kagi_research_wait_for_run and " +
  "kagi_research_get_output to check progress. Set budget_cents (default 0, " +
  "meaning free scrape-only) to allow paid API calls.";

const RESEARCH_WAIT_DESCRIPTION =
  "Block until the run reaches a terminal state (done / failed / cancelled) " +
  "or timeout_seconds elapses. Returns the current run state either way.";

const RESEARCH_OUTPUT_DESCRIPTION =
  "Get the current state + report of a research run. Safe to call any time; " +
  "returns partial data if the run is still in progress.";

const RESEARCH_CANCEL_DESCRIPTION =
  "Cancel a running research job. Idempotent. Any partial output collected " +
  "so far remains available via kagi_research_get_output.";

export class KagiMcpAgent extends McpAgent<Env> {
  server = new McpServer({
    name: "kagi-shinobi",
    version: "0.2.0-dev",
  });

  async init(): Promise<void> {
    const client = createKagiClient(this.env, { waitUntil: (p) => this.ctx.waitUntil(p) });
    const mode = client.mode;

    // Always registered — capability matrix marks these "both".
    this.registerSearchFetch(client);
    this.registerSummarizer(client);
    this.registerSmallWeb(client);

    // kagi_summarize_url is "both" — always available.
    this.registerSummarizeUrl(client);

    // Mode-gated tools: only appear when the impl is reachable.
    if (isToolAvailable("kagi_fastgpt", mode)) this.registerFastGPT(client);
    if (isToolAvailable("kagi_extract", mode)) this.registerExtract(client);
    if (isToolAvailable("kagi_enrich_web", mode)) this.registerEnrichWeb(client);
    if (isToolAvailable("kagi_enrich_news", mode)) this.registerEnrichNews(client);
    if (isToolAvailable("kagi_summarize_text", mode)) this.registerSummarizeText(client);
    if (isToolAvailable("kagi_personalized_rank", mode)) this.registerRank(client);

    // Deep research trio + cancel. Available in every mode — the pipeline
    // will use whatever impls are reachable and fall back to scrape when
    // budget_cents=0 (the safe default).
    this.registerResearchCreate();
    this.registerResearchWait();
    this.registerResearchOutput();
    this.registerResearchCancel();

    // S9: resources + prompts. Registered last so tools/resources/prompts
    // all live in one init() body — easier to audit.
    registerResources(this.server, this.env);
    registerPrompts(this.server);
  }

  private registerResearchCreate(): void {
    this.server.tool(
      "kagi_research_create_run",
      RESEARCH_CREATE_DESCRIPTION,
      {
        question: z.string().min(1),
        depth: z.number().int().min(1).max(3).optional(),
        budget_cents: z
          .number()
          .min(0)
          .optional()
          .describe("Max API cents this run may spend. Default 0 (scrape-only)."),
        allow_api: z.boolean().optional(),
      },
      async ({ question, depth, budget_cents, allow_api }) => {
        try {
          const stub = getResearchStub(this.env);
          const result = await stub.createRun({
            question,
            depth: depth ?? 1,
            budget_cents: budget_cents ?? 0,
            allow_api: allow_api ?? true,
          });
          return mcpResult({
            text: `Started run ${result.run_id}. Poll with kagi_research_wait_for_run.`,
            structured: { run_id: result.run_id },
          });
        } catch (err) {
          return kagiErrorMcp(err);
        }
      },
    );
  }

  private registerResearchWait(): void {
    this.server.tool(
      "kagi_research_wait_for_run",
      RESEARCH_WAIT_DESCRIPTION,
      {
        run_id: z.string().min(1),
        timeout_seconds: z.number().int().min(1).max(300).default(30),
      },
      async ({ run_id, timeout_seconds }) => {
        try {
          const stub = getResearchStub(this.env);
          const state = await stub.waitForRun(run_id, timeout_seconds);
          if (!state) return mcpError({ kind: "not_found", message: `run ${run_id} not found` });
          return mcpResult({
            text: `Status: ${state.status} (${state.cost_cents.toFixed(2)}¢ spent)`,
            structured: asStructured(state),
          });
        } catch (err) {
          return kagiErrorMcp(err);
        }
      },
    );
  }

  private registerResearchOutput(): void {
    this.server.tool(
      "kagi_research_get_output",
      RESEARCH_OUTPUT_DESCRIPTION,
      { run_id: z.string().min(1) },
      async ({ run_id }) => {
        try {
          const stub = getResearchStub(this.env);
          const state = await stub.getOutput(run_id);
          if (!state) return mcpError({ kind: "not_found", message: `run ${run_id} not found` });
          const text =
            state.status === "done"
              ? state.report_markdown
              : `Status: ${state.status}${state.error ? ` — ${state.error}` : ""}`;
          return mcpResult({ text, structured: asStructured(state) });
        } catch (err) {
          return kagiErrorMcp(err);
        }
      },
    );
  }

  private registerResearchCancel(): void {
    this.server.tool(
      "kagi_research_cancel_run",
      RESEARCH_CANCEL_DESCRIPTION,
      { run_id: z.string().min(1) },
      async ({ run_id }) => {
        try {
          const stub = getResearchStub(this.env);
          const result = await stub.cancelRun(run_id);
          return mcpResult({
            text: result.cancelled ? "Cancelled." : "Run was already terminal or not found.",
            structured: { ...result },
          });
        } catch (err) {
          return kagiErrorMcp(err);
        }
      },
    );
  }

  private registerRank(client: KagiClient): void {
    this.server.tool(
      "kagi_personalized_rank",
      RANK_DESCRIPTION,
      {
        urls: z.array(z.string().url()).min(1).max(20),
        q: z.string().optional().describe("Query context. Required for impl=api."),
        rules: z
          .array(
            z.object({
              domain: z.string().optional(),
              regex: z.string().optional(),
              action: z.enum(["pin", "raise", "lower", "block"]),
            }),
          )
          .optional()
          .describe("Personalization rules. api-mode only; ignored in scrape mode."),
        impl: z.enum(["scrape", "api"]).optional(),
      },
      async ({ urls, q, rules, impl }) => {
        try {
          const canonical = await client.rank({ urls, q, rules, impl });
          const text = canonical.ranked
            .map(
              (r, i) =>
                `${i + 1}. [${r.action}] score=${r.score.toFixed(2)} ${r.url}${r.rationale ? " — " + r.rationale : ""}`,
            )
            .join("\n");
          return mcpResult({ text, structured: asStructured(canonical) });
        } catch (err) {
          return kagiErrorMcp(err);
        }
      },
    );
  }

  private registerSummarizeUrl(client: KagiClient): void {
    this.server.tool(
      "kagi_summarize_url",
      SUMMARIZE_URL_DESCRIPTION,
      {
        url: z.string().url(),
        engine: z.enum(ENGINE_ENUM).optional(),
        summary_type: z.enum(["summary", "takeaway"]).default("summary"),
        target_language: z.string().optional(),
        confirm_muriel: z
          .boolean()
          .optional()
          .describe("Required when engine=muriel unless SUMMARIZER_MURIEL_REQUIRES_CONFIRM=false."),
        cache: z.boolean().optional(),
        impl: z.enum(["scrape", "api"]).optional(),
        max_age_s: maxAgeSchema,
      },
      async ({ url, engine, summary_type, target_language, confirm_muriel, impl, max_age_s }) => {
        try {
          const language = target_language ?? "EN";
          if (target_language && !isSupportedLanguage(target_language)) {
            return mcpError({
              kind: "invalid_language",
              message: `unsupported target_language '${target_language}'`,
              detail: { supported: [...SUPPORTED_LANGUAGES] },
            });
          }
          const canonical = await client.summarize({
            kind: "url",
            ref: url,
            language,
            style: summary_type,
            engine,
            confirm_muriel,
            impl,
            max_age_s,
          });
          return mcpResult({
            text: canonical.summary || "",
            structured: asStructured(canonical),
          });
        } catch (err) {
          return kagiErrorMcp(err);
        }
      },
    );
  }

  private registerSummarizeText(client: KagiClient): void {
    this.server.tool(
      "kagi_summarize_text",
      SUMMARIZE_TEXT_DESCRIPTION,
      {
        text: z.string().min(1).max(1_000_000).describe("Raw text to summarize (max 1MB)."),
        engine: z.enum(ENGINE_ENUM).optional(),
        summary_type: z.enum(["summary", "takeaway"]).default("summary"),
        target_language: z.string().optional(),
        confirm_muriel: z.boolean().optional(),
        cache: z.boolean().optional(),
        max_age_s: maxAgeSchema,
      },
      async ({ text, engine, summary_type, target_language, confirm_muriel, max_age_s }) => {
        try {
          const language = target_language ?? "EN";
          if (target_language && !isSupportedLanguage(target_language)) {
            return mcpError({
              kind: "invalid_language",
              message: `unsupported target_language '${target_language}'`,
              detail: { supported: [...SUPPORTED_LANGUAGES] },
            });
          }
          const canonical = await client.summarize({
            kind: "text",
            ref: text,
            language,
            style: summary_type,
            engine,
            confirm_muriel,
            max_age_s,
          });
          return mcpResult({
            text: canonical.summary || "",
            structured: asStructured(canonical),
          });
        } catch (err) {
          return kagiErrorMcp(err);
        }
      },
    );
  }

  private registerSearchFetch(client: KagiClient): void {
    // registerTool (not the deprecated server.tool overload) so the slim
    // shape is published as outputSchema and SDK-validated. ADR 0013.
    this.server.registerTool(
      "kagi_search_fetch",
      {
        description: SEARCH_DESCRIPTION,
        inputSchema: {
          queries: z
            .array(z.string().min(1))
            .min(1)
            // Bounded for the same reason as the REST path: each query becomes
            // one concurrent upstream call, and the per-minute limit counts
            // requests, not the calls they spawn. Matches the ceiling on
            // kagi_personalized_rank's urls.
            .max(20)
            .describe(
              "One or more concise, keyword-focused search queries (max 20 per call). Include essential context within each query for standalone use.",
            ),
          limit: z
            .number()
            .int()
            .min(1)
            .max(50)
            .optional()
            .describe("Maximum number of search results per query (default: 10, max: 50)"),
          impl: z
            .enum(["scrape", "api"])
            .optional()
            .describe(
              "Override which implementation handles this call. Ignored in single-impl modes. Only applies under engine='kagi'.",
            ),
          engine: z
            .enum(["kagi", "searxng", "auto"])
            .optional()
            .describe(
              "Which engine serves the query: 'kagi' (default, tri-mode dispatcher), " +
                "'searxng' (free SearXNG fallback, noisier), or 'auto' (Kagi while " +
                "under budget and the session is healthy, otherwise SearXNG).",
            ),
          response_format: responseFormatSchema,
          max_age_s: maxAgeSchema,
        },
        outputSchema: searchOutputSchema,
      },
      async ({ queries, limit, impl, engine, response_format, max_age_s }) => {
        const cap = limit ?? 10;
        const settled = await Promise.allSettled(
          queries.map((q) => client.search({ q, limit: cap, impl, engine, max_age_s })),
        );

        const perQuery: (SearchResponse | null)[] = [];
        const errors: Array<{ query: string; error: string }> = [];

        for (let i = 0; i < queries.length; i++) {
          const s = settled[i];
          const q = queries[i];
          if (s.status === "fulfilled") {
            perQuery.push(s.value);
          } else {
            perQuery.push(null);
            errors.push({ query: q, error: describeError(s.reason) });
          }
        }

        const format = response_format ?? "concise";
        const formatted =
          format === "detailed"
            ? formatSearchDetailed(queries, perQuery, { mode: client.mode, errors })
            : formatSearchConcise(queries, perQuery, { mode: client.mode, errors });

        return mcpResult({
          text: formatted.text,
          structured: asStructured(formatted.structured),
        });
      },
    );
  }

  private registerSummarizer(client: KagiClient): void {
    this.server.tool(
      "kagi_summarizer",
      SUMMARIZE_DESCRIPTION,
      {
        url: z.string().url().describe("A URL to a document to summarize."),
        summary_type: z
          .enum(["summary", "takeaway"])
          .default("summary")
          .describe(
            "Type of summary to produce. 'summary' for prose, 'takeaway' for bulleted key points.",
          ),
        target_language: z
          .string()
          .optional()
          .describe(
            "Desired output language. Two-letter code (e.g. 'EN'). Defaults to the document's original language.",
          ),
        impl: z
          .enum(["scrape", "api"])
          .optional()
          .describe(
            "Override which implementation handles this call. Ignored in single-impl modes.",
          ),
        max_age_s: maxAgeSchema,
      },
      async ({ url, summary_type, target_language, impl, max_age_s }) => {
        try {
          const language = target_language ?? "EN";
          if (target_language && !isSupportedLanguage(target_language)) {
            // Same envelope as this tool's catch block and as the other two
            // summarize tools — see ADR 0010.
            return mcpError({
              kind: "invalid_language",
              message: `unsupported target_language '${target_language}'`,
              detail: { supported: [...SUPPORTED_LANGUAGES] },
            });
          }
          const canonical = await client.summarize({
            kind: "url",
            ref: url,
            language,
            style: summary_type,
            impl,
            max_age_s,
          });
          return mcpResult({
            text: canonical.summary || "",
            structured: asStructured(canonical),
          });
        } catch (err) {
          return kagiErrorMcp(err);
        }
      },
    );
  }

  private registerSmallWeb(client: KagiClient): void {
    this.server.tool(
      "kagi_small_web",
      SMALL_WEB_DESCRIPTION,
      {
        q: z
          .string()
          .optional()
          .describe("Search query. Omit to browse recent Small Web posts via RSS (free)."),
        limit: z.number().int().min(1).max(50).optional(),
        impl: z.enum(["scrape", "api"]).optional(),
      },
      async ({ q, limit, impl }) => {
        try {
          const canonical = await client.smallWeb({ q, limit, impl });
          return mcpResult({
            text: formatSmallWebText(canonical),
            structured: asStructured(canonical),
          });
        } catch (err) {
          return kagiErrorMcp(err);
        }
      },
    );
  }

  private registerFastGPT(client: KagiClient): void {
    this.server.tool(
      "kagi_fastgpt",
      FASTGPT_DESCRIPTION,
      {
        query: z.string().min(1).describe("The question to answer."),
        cache: z
          .boolean()
          .optional()
          .describe("Allow a cached answer (default: true; cached responses are free). API-only."),
        impl: z
          .enum(["scrape", "api"])
          .optional()
          .describe(
            "Override which implementation handles this call. Hybrid default is scrape (free).",
          ),
        max_age_s: maxAgeSchema,
      },
      async ({ query, cache, impl, max_age_s }) => {
        try {
          const canonical = await client.fastGPT({ query, cache, impl, max_age_s });
          const text =
            canonical.answer +
            (canonical.references.length > 0
              ? "\n\nReferences:\n" +
                canonical.references
                  .map((r, i) => `${i + 1}. ${r.title} — ${r.url}`)
                  .join("\n")
              : "");
          return mcpResult({ text, structured: asStructured(canonical) });
        } catch (err) {
          return kagiErrorMcp(err);
        }
      },
    );
  }

  private registerExtract(client: KagiClient): void {
    this.server.tool(
      "kagi_extract",
      EXTRACT_DESCRIPTION,
      {
        urls: z.array(z.string().url()).min(1).max(10).describe("1 to 10 URLs to extract."),
        format: z.enum(["markdown", "text"]).optional(),
        timeout_ms: z.number().int().min(1000).max(120_000).optional(),
      },
      async ({ urls, format, timeout_ms }) => {
        try {
          const canonical = await client.extract({ urls, format, timeout_ms });
          const text = canonical.pages
            .map((p, i) => `--- Page ${i + 1}: ${p.url} ---\n${p.markdown}`)
            .join("\n\n");
          return mcpResult({ text, structured: asStructured(canonical) });
        } catch (err) {
          return kagiErrorMcp(err);
        }
      },
    );
  }

  private registerEnrichWeb(client: KagiClient): void {
    this.server.tool(
      "kagi_enrich_web",
      ENRICH_WEB_DESCRIPTION,
      { q: z.string().min(1) },
      async ({ q }) => {
        try {
          const canonical = await client.enrichWeb({ q });
          return mcpResult({
            text: formatEnrichText(canonical.index, canonical.results),
            structured: asStructured(canonical),
          });
        } catch (err) {
          return kagiErrorMcp(err);
        }
      },
    );
  }

  private registerEnrichNews(client: KagiClient): void {
    this.server.tool(
      "kagi_enrich_news",
      ENRICH_NEWS_DESCRIPTION,
      { q: z.string().min(1) },
      async ({ q }) => {
        try {
          const canonical = await client.enrichNews({ q });
          return mcpResult({
            text: formatEnrichText(canonical.index, canonical.results),
            structured: asStructured(canonical),
          });
        } catch (err) {
          return kagiErrorMcp(err);
        }
      },
    );
  }
}

// Three per-class branches used to precede the KagiError one, for
// confirm_required, unsupported_in_mode, and not_configured. Each produced
// output identical to this generic branch — verified by pinning their whole
// envelopes in test/workers/mcp-tools.test.ts before removing them, not by
// reading the code. ADR 0012: neither surface branches on class any more.
function kagiErrorMcp(err: unknown) {
  if (err instanceof KagiError) {
    return mcpError({ kind: err.kind, message: err.message, detail: err.detail });
  }
  // REST parity (kagiErrorResponse): an untyped throw's text is a
  // server-side diagnostic, never client output.
  return mcpError({
    kind: "internal",
    message: safeErrorMessage(err),
  });
}

function describeError(reason: unknown): string {
  return safeErrorMessage(reason);
}

function formatSmallWebText(resp: SearchResponse): string {
  if (resp.results.length === 0) return "(no Small Web results)";
  return resp.results
    .map((r, i) => `${i + 1}. ${r.title || "(untitled)"}\n${r.url}\n${r.snippet || ""}`)
    .join("\n\n");
}

function formatEnrichText(
  index: "teclis" | "tinygem",
  results: Array<{ url: string; title: string; snippet: string; published_at?: string }>,
): string {
  if (results.length === 0) return `(no ${index} results — no charge)`;
  return results
    .map(
      (r, i) =>
        `${i + 1}. ${r.title}\n${r.url}${r.published_at ? "\n" + r.published_at : ""}\n${r.snippet}`,
    )
    .join("\n\n");
}

