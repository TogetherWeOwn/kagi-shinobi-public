// MCP prompts — reusable templates a client can surface as slash commands.
// Each returns a `messages: [{role, content: {type, text}}]` list that the
// caller submits verbatim to the model.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerPrompts(server: McpServer): void {
  server.prompt(
    "cite_this_claim",
    "Verify a specific factual claim with citations by running kagi_search + kagi_extract.",
    { claim: z.string().describe("The claim to verify.") },
    ({ claim }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Please verify the following claim by calling kagi_search_fetch with 2-3 focused queries, ` +
              `then kagi_extract on the top URLs, and finally compose a short (≤200 word) answer that ` +
              `cites sources inline as [1], [2], etc.\n\nClaim: ${claim}`,
          },
        },
      ],
    }),
  );

  server.prompt(
    "compare_default_vs_personalized",
    "Run the same query twice — once with default Kagi ranking, once with an explicit personalizations rule set — and diff the results.",
    { query: z.string() },
    ({ query }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `1. Call kagi_search_fetch with q="${query}".\n` +
              `2. Call kagi_personalized_rank with the top 10 URLs from step 1 and the same query, ` +
              `impl="api", passing your best guess at rules[] that would prioritize authoritative sources.\n` +
              `3. Report which URLs changed rank, in what direction, and hypothesize why.`,
          },
        },
      ],
    }),
  );

  server.prompt(
    "deep_research_plan",
    "Approve a research plan (sub-queries + budget) before firing kagi_research_create_run.",
    {
      question: z.string(),
      budget_cents: z
        .string()
        .optional()
        .describe("Optional cap for the paid-API steps. String because MCP prompt args are strings."),
    },
    ({ question, budget_cents }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `I want you to draft a research plan for:\n\n"${question}"\n\n` +
              `Budget cap: ${budget_cents ?? "0"} cents. Propose 3-5 sub-queries you'd search, ` +
              `and identify which stages would need paid API calls (extract, fastgpt synth) vs. ` +
              `which are free scrape-only. If I approve, call kagi_research_create_run with the ` +
              `question and the budget. Otherwise iterate on the plan.`,
          },
        },
      ],
    }),
  );

  server.prompt(
    "verify_url",
    "Cross-reference a URL against Kagi's Teclis enrichment index + reverse search to check its credibility.",
    { url: z.string() },
    ({ url }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Please:\n1. Call kagi_enrich_web with q=(the domain of ${url}) to find how the ` +
              `independent Teclis index characterizes the source.\n` +
              `2. Call kagi_search_fetch with q="cite:${url}" and q="link:${url}" if the site allows.\n` +
              `3. Summarize the freshness, authority, and any counter-signals in ≤150 words.`,
          },
        },
      ],
    }),
  );

  server.prompt(
    "search_and_extract",
    "Search, then automatically extract the top-N results as markdown for downstream reasoning.",
    { query: z.string(), top_n: z.string().describe("How many top URLs to extract (1-10).") },
    ({ query, top_n }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `1. Call kagi_search_fetch with q="${query}", limit=${top_n ?? "5"}.\n` +
              `2. Take the URLs from step 1 and call kagi_extract on them (up to 10).\n` +
              `3. Return a merged markdown document with each extracted page under a "## <n> — <title>" heading.`,
          },
        },
      ],
    }),
  );
}
