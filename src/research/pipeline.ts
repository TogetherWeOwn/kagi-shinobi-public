// Deep-research pipeline. Runs inside the DurableObject via ctx.waitUntil.
//
// The pipeline is depth-parametric: depth=1 does one round of
// search→summarize→synth, depth=2 adds a follow-up round, depth=3 does
// three. Depth is capped at 3 to bound cost. When the caller sets
// budget_cents=0 (the safe default) we still let the run start — the scrape
// paths are free — but api-only steps are skipped.

import type { KagiClient } from "../kagi/client.js";
import { capabilityFor, pickImpl } from "../kagi/capability.js";
import { chargedCostCents, safeErrorMessage } from "../kagi/errors.js";
import type { KagiImpl } from "../kagi/types.js";
import type {
  ResearchCitation,
  ResearchRunState,
  ResearchStep,
  ResearchStatus,
} from "./types.js";

const MAX_SUBQUERIES = 5;
const TOP_N_PER_SUBQUERY = 3;
// Costs are fractional cents (1.2¢ a search); an exact-budget call must not
// be refused over binary floating-point dust.
const COST_EPSILON = 1e-9;

export interface StepEmit {
  (stage: ResearchStatus, detail: string, cost_cents?: number): Promise<void>;
}

export interface StateAccessors {
  isCancelled(): Promise<boolean>;
  spentCents(): Promise<number>;
  budgetCents(): number;
  allowApi(): boolean;
}

// Per-run spend bookkeeping. `spentCents()` only learns about a call once
// its cost has been emitted (the DO persists step costs), which is after
// the fact — and a batch of concurrent calls would all pass a naive
// pre-flight check against the same stale balance. The tracker books each
// paid call's reported `meta.cost_cents` locally and immediately (paid
// calls are checked against the published rate *before* they run), and
// `remaining()` reconciles that with the persisted figure by taking
// whichever has seen more spend, never the sum — the same booking reaches
// both ledgers once emitted.
interface SpendTracker {
  bookedLocalCents: number;
}

function newSpendTracker(): SpendTracker {
  return { bookedLocalCents: 0 };
}

async function remainingCents(state: StateAccessors, tracker: SpendTracker): Promise<number> {
  const spent = Math.max(await state.spentCents(), tracker.bookedLocalCents);
  return state.budgetCents() - spent;
}

function bookSpend(tracker: SpendTracker, cents: number | undefined): void {
  if (cents !== undefined && Number.isFinite(cents) && cents > 0) {
    tracker.bookedLocalCents += cents;
  }
}

/**
 * Book a failed call's already-settled charge, when it carries one (see
 * withChargedCost in ../kagi/errors.ts), and return it so the caller emits
 * it on the failure step too. A paid call that throws after dispatch is
 * still a paid call: booking only fulfilled calls re-admits the same
 * balance for the next call and the run budget stops being a ceiling
 * exactly on the failure paths.
 */
function bookChargedFailure(tracker: SpendTracker, err: unknown): number | undefined {
  const cents = chargedCostCents(err);
  bookSpend(tracker, cents);
  return cents;
}

/** True when this run may not spend at all: free scrape path only. */
function noSpend(state: StateAccessors): boolean {
  return !state.allowApi() || state.budgetCents() <= 0;
}

/** The impl that would serve `tool`, or undefined when it cannot be served. */
function implFor(
  client: KagiClient,
  tool: string,
  override?: KagiImpl,
): KagiImpl | undefined {
  try {
    return pickImpl(tool, client.mode, override);
  } catch {
    return undefined;
  }
}

/** Published per-call API rate for a tool, 0 when the tool is not billable. */
function estimateCents(tool: string): number {
  return capabilityFor(tool)?.api_cents_per_call ?? 0;
}

async function canAfford(
  state: StateAccessors,
  tracker: SpendTracker,
  tool: string,
): Promise<boolean> {
  if (!state.allowApi()) return false;
  return (await remainingCents(state, tracker)) + COST_EPSILON >= estimateCents(tool);
}

/** Try FastGPT to decompose the question. Falls back to a single subquery. */
async function planSubqueries(
  client: KagiClient,
  question: string,
  state: StateAccessors,
  tracker: SpendTracker,
): Promise<{ subqueries: string[]; cost_cents?: number }> {
  if (noSpend(state)) return { subqueries: [question] };
  const impl = implFor(client, "kagi_fastgpt");
  // In an API-only deployment this call bills; a budget that cannot cover
  // one planning call keeps the whole run on the caller's question instead
  // of spending past the ceiling before the first search.
  if (impl === "api" && !(await canAfford(state, tracker, "kagi_fastgpt"))) {
    return { subqueries: [question] };
  }
  try {
    const prompt =
      `Decompose the following research question into 3-5 concise, ` +
      `keyword-focused sub-queries suitable for a web search engine. ` +
      `Return the sub-queries as a numbered list, one per line, no commentary.\n\n` +
      `Question: ${question}`;
    const resp = await client.fastGPT({ query: prompt, cache: true });
    const cost = resp.meta?.cost_cents;
    bookSpend(tracker, cost);
    const subqueries = resp.answer
      .split("\n")
      .map((s) => s.replace(/^\s*\d+[\.)\-]\s*/, "").trim())
      .filter((s) => s.length > 0 && s.length < 200)
      .slice(0, MAX_SUBQUERIES);
    return { subqueries: subqueries.length > 0 ? subqueries : [question], cost_cents: cost };
  } catch (err) {
    return { subqueries: [question], cost_cents: bookChargedFailure(tracker, err) };
  }
}

type SearchBundle = {
  subquery: string;
  urls: string[];
  titles: Record<string, string>;
  snippets: Record<string, string>;
};

async function searchAllSubqueries(
  client: KagiClient,
  subqueries: string[],
  emit: StepEmit,
  state: StateAccessors,
  tracker: SpendTracker,
): Promise<SearchBundle[]> {
  // A no-spend run pins every search to the free scrape impl. In an
  // API-only deployment that pin is refused by the dispatcher before any
  // network call, so the sub-query fails safe instead of billing.
  const forcedImpl: KagiImpl | undefined = noSpend(state) ? "scrape" : undefined;
  const servingImpl = implFor(client, "kagi_search_fetch", forcedImpl);
  const record = async (
    subquery: string,
    settled: PromiseSettledResult<Awaited<ReturnType<KagiClient["search"]>>>,
    out: SearchBundle[],
  ): Promise<void> => {
    if (settled.status === "fulfilled") {
      const titles: Record<string, string> = {};
      const snippets: Record<string, string> = {};
      const urls = settled.value.results.map((r) => {
        titles[r.url] = r.title;
        snippets[r.url] = r.snippet;
        return r.url;
      });
      out.push({ subquery, urls, titles, snippets });
      const cost = settled.value.meta?.cost_cents;
      bookSpend(tracker, cost);
      await emit("searching", `Found ${urls.length} results for "${subquery}"`, cost);
    } else {
      await emit(
        "searching",
        `Search failed for "${subquery}": ${describe(settled.reason)}`,
        bookChargedFailure(tracker, settled.reason),
      );
    }
  };

  const out: SearchBundle[] = [];
  if (servingImpl !== "api") {
    // Free path (or a pin the dispatcher will refuse): no billing at stake,
    // so fan out as before.
    const settled = await Promise.allSettled(
      subqueries.map((q) => client.search({ q, limit: TOP_N_PER_SUBQUERY, impl: forcedImpl })),
    );
    for (let i = 0; i < subqueries.length; i++) {
      await record(subqueries[i], settled[i], out);
    }
    return out;
  }

  // Paid path: run sequentially, re-checking the remaining budget before
  // each call and booking the actual cost before the next check. Fanning
  // these out would let every concurrent sub-query pass the same
  // pre-flight balance and overspend a small budget.
  for (const q of subqueries) {
    if (!(await canAfford(state, tracker, "kagi_search_fetch"))) {
      await emit("searching", `Search skipped for "${q}": research budget exhausted`);
      continue;
    }
    let settled: PromiseSettledResult<Awaited<ReturnType<KagiClient["search"]>>>;
    try {
      settled = { status: "fulfilled", value: await client.search({ q, limit: TOP_N_PER_SUBQUERY }) };
    } catch (reason) {
      settled = { status: "rejected", reason };
    }
    await record(q, settled, out);
  }
  return out;
}

async function extractOrSummarize(
  client: KagiClient,
  urls: string[],
  emit: StepEmit,
  state: StateAccessors,
  tracker: SpendTracker,
): Promise<Array<{ url: string; content: string }>> {
  if (urls.length === 0) return [];
  const useApi = state.allowApi() && (await remainingCents(state, tracker)) > 5;
  if (useApi) {
    try {
      const resp = await client.extract({ urls: urls.slice(0, 10) });
      bookSpend(tracker, resp.meta.cost_cents);
      await emit(
        "extracting",
        `Extracted ${resp.pages.length} pages via /v1/extract`,
        resp.meta.cost_cents,
      );
      return resp.pages.map((p) => ({ url: p.url, content: p.markdown }));
    } catch (err) {
      await emit(
        "extracting",
        `Extract failed, falling back to summarize: ${describe(err)}`,
        bookChargedFailure(tracker, err),
      );
    }
  }
  // Fallback / scrape-mode path: summarize each URL individually. The same
  // no-spend pin and per-call budget check as the search stage apply: in
  // an API-only deployment this fallback is a paid call per URL, and a
  // search that already spent the budget must not re-spend it here.
  const forcedImpl: KagiImpl | undefined = noSpend(state) ? "scrape" : undefined;
  const servingImpl = implFor(client, "kagi_summarize_url", forcedImpl);
  const summarizeOne = (url: string) =>
    client.summarize({
      kind: "url",
      ref: url,
      language: "EN",
      style: "summary",
      impl: forcedImpl,
    });
  const batch = urls.slice(0, 5);
  const results: Array<{ url: string; content: string }> = [];
  let totalCost = 0;
  if (servingImpl !== "api") {
    const settled = await Promise.allSettled(batch.map(summarizeOne));
    for (let i = 0; i < settled.length; i++) {
      const s = settled[i];
      if (s.status === "fulfilled") {
        results.push({ url: batch[i], content: s.value.summary });
        bookSpend(tracker, s.value.meta?.cost_cents);
        totalCost += s.value.meta?.cost_cents ?? 0;
      } else {
        totalCost += bookChargedFailure(tracker, s.reason) ?? 0;
      }
    }
  } else {
    for (const url of batch) {
      if (!(await canAfford(state, tracker, "kagi_summarize_url"))) break;
      try {
        const resp = await summarizeOne(url);
        results.push({ url, content: resp.summary });
        bookSpend(tracker, resp.meta?.cost_cents);
        totalCost += resp.meta?.cost_cents ?? 0;
      } catch (err) {
        // Counted in the denominator below; a charge settled before the
        // failure is still booked (and emitted via totalCost).
        totalCost += bookChargedFailure(tracker, err) ?? 0;
      }
    }
  }
  await emit(
    "extracting",
    `Summarized ${results.length}/${batch.length} URLs via scrape summarizer`,
    totalCost > 0 ? totalCost : undefined,
  );
  return results;
}

async function synthesize(
  client: KagiClient,
  question: string,
  materials: Array<{ url: string; title: string; content: string }>,
  state: StateAccessors,
  tracker: SpendTracker,
): Promise<{ report: string; cost_cents?: number }> {
  if (materials.length === 0) {
    return { report: "No source material was gathered for this question." };
  }
  let synthFailureCost: number | undefined;
  const impl = implFor(client, "kagi_fastgpt");
  const canFastGPT =
    state.allowApi() &&
    (await remainingCents(state, tracker)) > 3 &&
    (impl !== "api" || (await canAfford(state, tracker, "kagi_fastgpt")));
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
      const cost = resp.meta?.cost_cents;
      bookSpend(tracker, cost);
      return { report: resp.answer, cost_cents: cost };
    } catch (err) {
      // Fall through to the deterministic report — but a charge settled
      // before the failure is still booked and reported to the caller.
      synthFailureCost = bookChargedFailure(tracker, err);
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
  return { report: lines.join("\n"), cost_cents: synthFailureCost };
}

// Step details are returned to clients with the run state, so they get the
// same treatment as every other surface: typed vocabulary or generic.
function describe(err: unknown): string {
  return safeErrorMessage(err);
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
  const tracker = newSpendTracker();

  if (await state.isCancelled()) throw new Error("cancelled");

  // Plan.
  await emit("planning", "Decomposing question into sub-queries");
  const { subqueries: plan, cost_cents: planCost } = await planSubqueries(
    client,
    question,
    state,
    tracker,
  );
  await emit("planning", `Plan: ${plan.length} sub-queries`, planCost);

  // Search all subqueries.
  if (await state.isCancelled()) throw new Error("cancelled");
  const searchBundles = await searchAllSubqueries(client, plan, emit, state, tracker);

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
  const materials = await extractOrSummarize(client, topUrls, emit, state, tracker);

  // Synthesize.
  if (await state.isCancelled()) throw new Error("cancelled");
  await emit("synthesizing", "Composing report");
  const enriched = materials.map((m) => ({
    url: m.url,
    title: seen.get(m.url)?.title ?? m.url,
    content: m.content,
  }));
  const { report: report_markdown, cost_cents: synthCost } = await synthesize(
    client,
    question,
    enriched,
    state,
    tracker,
  );
  if (synthCost !== undefined && synthCost > 0) {
    await emit("synthesizing", "Composed report", synthCost);
  }

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
