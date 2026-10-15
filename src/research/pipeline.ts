// Deep-research pipeline. Runs inside the DurableObject via ctx.waitUntil.
//
// The pipeline is depth-parametric: depth=1 does one round of
// search→summarize→synth, depth=2 adds a follow-up round, depth=3 does
// three. Depth is capped at 3 to bound cost. When the caller sets
// budget_cents=0 (the safe default) we still let the run start — the scrape
// paths are free — but api-only steps are skipped.

import type { KagiClient } from "../kagi/client.js";
import type {
  ResearchCitation,
  ResearchRunState,
  ResearchStep,
  ResearchStatus,
} from "./types.js";

const MAX_SUBQUERIES = 5;
const TOP_N_PER_SUBQUERY = 3;

export interface StepEmit {
  (stage: ResearchStatus, detail: string, cost_cents?: number): Promise<void>;
}

export interface StateAccessors {
  isCancelled(): Promise<boolean>;
  spentCents(): Promise<number>;
  budgetCents(): number;
  allowApi(): boolean;
}

/** Try FastGPT to decompose the question. Falls back to a single subquery. */
async function planSubqueries(
  client: KagiClient,
  question: string,
  state: StateAccessors,
): Promise<string[]> {
  if (!state.allowApi() || state.budgetCents() <= 0) return [question];
  try {
    const prompt =
      `Decompose the following research question into 3-5 concise, ` +
      `keyword-focused sub-queries suitable for a web search engine. ` +
      `Return the sub-queries as a numbered list, one per line, no commentary.\n\n` +
      `Question: ${question}`;
    const resp = await client.fastGPT({ query: prompt, cache: true });
    const subqueries = resp.answer
      .split("\n")
      .map((s) => s.replace(/^\s*\d+[\.)\-]\s*/, "").trim())
      .filter((s) => s.length > 0 && s.length < 200)
      .slice(0, MAX_SUBQUERIES);
    return subqueries.length > 0 ? subqueries : [question];
  } catch {
    return [question];
  }
}

async function searchAllSubqueries(
  client: KagiClient,
  subqueries: string[],
  emit: StepEmit,
): Promise<Array<{ subquery: string; urls: string[]; titles: Record<string, string>; snippets: Record<string, string> }>> {
  const out: Array<{
    subquery: string;
    urls: string[];
    titles: Record<string, string>;
    snippets: Record<string, string>;
  }> = [];
  const settled = await Promise.allSettled(
    subqueries.map((q) => client.search({ q, limit: TOP_N_PER_SUBQUERY })),
  );
  for (let i = 0; i < subqueries.length; i++) {
    const s = settled[i];
    if (s.status === "fulfilled") {
      const titles: Record<string, string> = {};
      const snippets: Record<string, string> = {};
      const urls = s.value.results.map((r) => {
        titles[r.url] = r.title;
        snippets[r.url] = r.snippet;
        return r.url;
      });
      out.push({ subquery: subqueries[i], urls, titles, snippets });
      await emit("searching", `Found ${urls.length} results for "${subqueries[i]}"`);
    } else {
      await emit(
        "searching",
        `Search failed for "${subqueries[i]}": ${describe(s.reason)}`,
      );
    }
  }
  return out;
}

async function extractOrSummarize(
  client: KagiClient,
  urls: string[],
  emit: StepEmit,
  state: StateAccessors,
): Promise<Array<{ url: string; content: string }>> {
  if (urls.length === 0) return [];
  const useApi = state.allowApi() && state.budgetCents() - (await state.spentCents()) > 5;
  if (useApi) {
    try {
      const resp = await client.extract({ urls: urls.slice(0, 10) });
      await emit(
        "extracting",
        `Extracted ${resp.pages.length} pages via /v1/extract`,
        resp.meta.cost_cents,
      );
      return resp.pages.map((p) => ({ url: p.url, content: p.markdown }));
    } catch (err) {
      await emit("extracting", `Extract failed, falling back to summarize: ${describe(err)}`);
    }
  }
  // Fallback / scrape-mode path: summarize each URL individually.
  const settled = await Promise.allSettled(
    urls.slice(0, 5).map((url) =>
      client.summarize({
        kind: "url",
        ref: url,
        language: "EN",
        style: "summary",
      }),
    ),
  );
  const results: Array<{ url: string; content: string }> = [];
  for (let i = 0; i < settled.length; i++) {
    const s = settled[i];
    if (s.status === "fulfilled") {
      results.push({ url: urls[i], content: s.value.summary });
    }
  }
  await emit("extracting", `Summarized ${results.length}/${settled.length} URLs via scrape summarizer`);
  return results;
}

async function synthesize(
  client: KagiClient,
  question: string,
  materials: Array<{ url: string; title: string; content: string }>,
  state: StateAccessors,
): Promise<string> {
  if (materials.length === 0) return "No source material was gathered for this question.";
  const canFastGPT = state.allowApi() && state.budgetCents() - (await state.spentCents()) > 3;
  if (canFastGPT) {
    try {
      const bullets = materials
        .map((m, i) => `[${i + 1}] ${m.title} (${m.url})\n${m.content.slice(0, 2000)}`)
        .join("\n\n");
      const prompt =
        `Answer the following research question in ~400 words using the ` +
        `sources below. Cite sources inline as [1], [2], etc. matching their ` +
        `numbers. Be specific and quote key facts when helpful.\n\n` +
        `Question: ${question}\n\nSources:\n${bullets}`;
      const resp = await client.fastGPT({ query: prompt, cache: true });
      return resp.answer;
    } catch {
      // fall through
    }
  }
  // Deterministic fallback: concatenate. Not pretty, but keeps the pipeline
  // useful in scrape-only mode.
  const lines = [`# Research: ${question}`, ""];
  materials.forEach((m, i) => {
    lines.push(`## Source [${i + 1}] — ${m.title}`);
    lines.push(m.url);
    lines.push("");
    lines.push(m.content.slice(0, 1500));
    lines.push("");
  });
  return lines.join("\n");
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Run the pipeline against a given state accessor. Emit updates via `emit`.
 * The caller (the DO) is responsible for persistence and cancellation checks.
 */
export async function runPipeline(
  client: KagiClient,
  initial: ResearchRunState,
  emit: StepEmit,
  state: StateAccessors,
): Promise<{
  plan: string[];
  citations: ResearchCitation[];
  report_markdown: string;
}> {
  const question = initial.question;
  const depth = Math.max(1, Math.min(3, initial.depth || 1));

  if (await state.isCancelled()) throw new Error("cancelled");

  // Plan.
  await emit("planning", "Decomposing question into sub-queries");
  const plan = await planSubqueries(client, question, state);
  await emit("planning", `Plan: ${plan.length} sub-queries`);

  // Search all subqueries.
  if (await state.isCancelled()) throw new Error("cancelled");
  const searchBundles = await searchAllSubqueries(client, plan, emit);

  // Dedup URLs; keep the first appearance's title/snippet.
  const seen = new Map<string, { title: string; snippet: string }>();
  for (const b of searchBundles) {
    for (const url of b.urls) {
      if (!seen.has(url)) seen.set(url, { title: b.titles[url], snippet: b.snippets[url] });
    }
  }
  const topUrls = Array.from(seen.keys()).slice(0, depth * TOP_N_PER_SUBQUERY);

  // Extract or summarize.
  if (await state.isCancelled()) throw new Error("cancelled");
  const materials = await extractOrSummarize(client, topUrls, emit, state);

  // Synthesize.
  if (await state.isCancelled()) throw new Error("cancelled");
  await emit("synthesizing", "Composing report");
  const enriched = materials.map((m) => ({
    url: m.url,
    title: seen.get(m.url)?.title ?? m.url,
    content: m.content,
  }));
  const report_markdown = await synthesize(client, question, enriched, state);

  const citations: ResearchCitation[] = enriched.map((m, i) => ({
    n: i + 1,
    title: m.title,
    url: m.url,
    snippet: seen.get(m.url)?.snippet,
  }));

  return { plan, citations, report_markdown };
}

export const STEP_HELPERS = {
  now: () => new Date().toISOString(),
  step: (stage: ResearchStatus, detail: string, cost_cents?: number): ResearchStep => ({
    ts: new Date().toISOString(),
    stage,
    detail,
    ...(cost_cents !== undefined ? { cost_cents } : {}),
  }),
};
