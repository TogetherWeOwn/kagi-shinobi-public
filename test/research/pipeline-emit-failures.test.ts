// R4 regression: a REJECTED step-event write must not lose a settled charge.
//
// `emit` is the Durable Object's persistence callback (src/research/run.ts:
// pushStep adds step.cost_cents to the persisted run total). If that write
// rejects BEFORE recording, the monthly reservation and the pipeline's local
// tracker keep the debit, but the persisted run ledger never sees it —
// emitted/persistable spend under-reports retained spend forever.
//
// Contract pinned here (behavior, not mechanism): under ONE failed write on a
// cost-bearing event, with every later write succeeding, the pipeline still
// completes and emitted total == retained monthly spend, with each dispatched
// paid call booked exactly once. Separating the emit from the paid-call try,
// carrying the debit onto a later event, or retrying the failed write can all
// satisfy this — the tests assert totals and dispatch counts, never which
// event carries a debit.
//
// Like test/research/pipeline-paid-failures.test.ts, these drive the REAL
// KagiClient in api mode with only global fetch stubbed, plus an emit that
// stands in for the DO: it records an event only when it does not throw, and
// spentCents() reads the sum of recorded costs, matching the DO contract.
// Published rates: FastGPT 1.5c, search 1.2c, extract 0.4c/URL, summarize 30c.

import { afterEach, describe, expect, it } from "vitest";
import { KagiClient } from "../../src/kagi/client";
import { readSpend } from "../../src/kagi/api/cost";
import { runPipeline } from "../../src/research/pipeline";
import type { StateAccessors, StepEmit } from "../../src/research/pipeline";
import type { ResearchRunState } from "../../src/research/types";
import { makeEnv, restoreFetch, stubFetch } from "../_helpers";

const NOW = "2026-01-01T00:00:00.000Z";
const FASTGPT_CENTS = 1.5;
const SEARCH_CENTS = 1.2;
const EXTRACT_CENTS = 0.4;
const SUMMARIZE_CENTS = 30;
const SOURCE_URL = "https://example.invalid/a";

type PersistedStep = { stage: string; detail: string; cost?: number };
type EmitPredicate = (step: PersistedStep) => boolean;

function makeState(): ResearchRunState {
  return {
    run_id: "run-emit-failure",
    question: "why is the sky blue",
    depth: 1,
    budget_cents: 0,
    allow_api: true,
    status: "queued",
    cost_cents: 0,
    created_at: NOW,
    updated_at: NOW,
    plan: [],
    steps: [],
    citations: [],
    report_markdown: "",
  };
}

afterEach(() => {
  restoreFetch();
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface ScenarioOptions {
  budgetCents: number;
  /** Reject the first event matching this predicate, before recording it. */
  failOnceOn?: EmitPredicate;
  searchFails?: boolean;
  extractFails?: boolean;
}

/**
 * Run the standard happy-path pipeline (plan 1.5c -> one search 1.2c -> one
 * source) with an optional one-time emit rejection and optional genuine
 * paid-call failures. Returns everything a test needs to compare the two
 * ledgers: persisted (emitted) steps vs retained monthly spend.
 */
async function runScenario(opts: ScenarioOptions) {
  const persisted: PersistedStep[] = [];
  const counts = { fastgpt: 0, search: 0, extract: 0, summarize: 0 };
  let failedAttempts = 0;
  let alreadyFailed = false;

  const emit = (async (stage, detail, cost_cents) => {
    const step: PersistedStep = { stage, detail, cost: cost_cents };
    if (!alreadyFailed && opts.failOnceOn?.(step)) {
      alreadyFailed = true;
      failedAttempts += 1;
      throw new Error("synthetic persistence failure");
    }
    persisted.push(step);
  }) as StepEmit;

  const accessors: StateAccessors = {
    isCancelled: async () => false,
    spentCents: async () => persisted.reduce((sum, s) => sum + (s.cost ?? 0), 0),
    budgetCents: () => opts.budgetCents,
    allowApi: () => true,
  };

  stubFetch(async (input) => {
    const url = String(input);
    if (url.includes("/fastgpt")) {
      counts.fastgpt += 1;
      return json({
        meta: {},
        data: {
          output: counts.fastgpt === 1 ? "1. alpha" : "synthesized report [1]",
          tokens: 10,
          references: [],
        },
      });
    }
    if (url.includes("/v1/search")) {
      counts.search += 1;
      if (opts.searchFails) return new Response("upstream broke", { status: 502 });
      return json({
        meta: {},
        data: { search: [{ url: SOURCE_URL, title: "A", snippet: "s" }] },
      });
    }
    if (url.includes("/v1/extract")) {
      counts.extract += 1;
      if (opts.extractFails) return new Response("upstream broke", { status: 502 });
      return json({
        meta: {},
        data: { pages: [{ url: SOURCE_URL, content: "# extracted page" }] },
      });
    }
    if (url.includes("/summarize")) {
      counts.summarize += 1;
      return json({ meta: {}, data: { output: "a summary", tokens: 5 } });
    }
    return json({ meta: {}, data: {} });
  });

  const env = makeEnv({
    KAGI_MODE: "api",
    KAGI_API_KEY: "synthetic-key",
    // Synthetic in-memory cap only; the checked-in cap stays "0".
    MAX_API_CENTS_PER_MONTH: "10000",
  });

  const result = await runPipeline(new KagiClient(env), makeState(), emit, accessors);
  const emittedTotal = persisted.reduce((sum, s) => sum + (s.cost ?? 0), 0);
  const retained = await readSpend(env);
  // Every dispatched paid call retains its published rate in the monthly
  // ledger (settled or charged-on-failure). If emitted == this sum, each
  // debit reached the run ledger exactly once — none lost, none doubled.
  const dispatchedTotal =
    counts.fastgpt * FASTGPT_CENTS +
    counts.search * SEARCH_CENTS +
    counts.extract * EXTRACT_CENTS +
    counts.summarize * SUMMARIZE_CENTS;

  return { result, persisted, counts, emittedTotal, retained, dispatchedTotal, failedAttempts };
}

const costBearing = (s: PersistedStep) => s.cost !== undefined && s.cost > 0;

describe("one rejected cost-bearing step write (R4 and analogous sites)", () => {
  it("R4: rejected extract-success write still books the 0.4c extract debit exactly once", async () => {
    // CISO reproduction at budget 10c: planning 1.5c, search 1.2c, extract
    // 0.4c succeeds, but the write of its cost-bearing "extracting" event
    // rejects before recording. At the candidate the catch treats that as
    // an extraction failure carrying no charge tag: retained 3.1c+ (the
    // monthly ledger keeps the debit) vs emitted 2.7c — the 0.4c vanishes
    // from the run ledger while the pipeline still returns a report.
    const { result, counts, emittedTotal, retained, dispatchedTotal, failedAttempts } =
      await runScenario({
        budgetCents: 10,
        failOnceOn: (s) =>
          costBearing(s) && s.stage === "extracting" && s.detail.startsWith("Extracted "),
      });

    expect(failedAttempts).toBe(1);
    expect(result.report_markdown.length).toBeGreaterThan(0);
    expect(counts.search).toBe(1);
    expect(counts.extract).toBe(1);
    expect(counts.summarize).toBe(0);
    expect(counts.fastgpt).toBeGreaterThanOrEqual(1);
    expect(counts.fastgpt).toBeLessThanOrEqual(2);
    expect(retained).toBeCloseTo(dispatchedTotal, 4);
    expect(retained).toBeGreaterThanOrEqual(FASTGPT_CENTS + SEARCH_CENTS + EXTRACT_CENTS - 1e-9);
    expect(emittedTotal).toBeCloseTo(retained, 4);
  });

  it("rejected planning-cost write still books the 1.5c planning debit exactly once", async () => {
    const { result, counts, emittedTotal, retained, dispatchedTotal, failedAttempts } =
      await runScenario({
        budgetCents: 10,
        failOnceOn: (s) =>
          costBearing(s) && s.stage === "planning" && s.detail.startsWith("Plan:"),
      });

    expect(failedAttempts).toBe(1);
    expect(result.report_markdown.length).toBeGreaterThan(0);
    expect(counts.search).toBe(1);
    expect(counts.summarize).toBe(0);
    expect(retained).toBeCloseTo(dispatchedTotal, 4);
    expect(emittedTotal).toBeCloseTo(retained, 4);
  });

  it("rejected search-success write still books the 1.2c search debit exactly once", async () => {
    const { result, counts, emittedTotal, retained, dispatchedTotal, failedAttempts } =
      await runScenario({
        budgetCents: 10,
        failOnceOn: (s) =>
          costBearing(s) && s.stage === "searching" && s.detail.startsWith("Found "),
      });

    expect(failedAttempts).toBe(1);
    expect(result.report_markdown.length).toBeGreaterThan(0);
    expect(counts.search).toBe(1);
    expect(counts.summarize).toBe(0);
    expect(retained).toBeCloseTo(dispatchedTotal, 4);
    expect(emittedTotal).toBeCloseTo(retained, 4);
  });

  it("rejected charged search-failure write still books the 1.2c search debit exactly once", async () => {
    // The search itself genuinely fails after dispatch (HTTP 502, charged);
    // the failure event carrying that debit is the write that rejects.
    const { result, counts, emittedTotal, retained, dispatchedTotal, failedAttempts } =
      await runScenario({
        budgetCents: 10,
        searchFails: true,
        failOnceOn: (s) =>
          costBearing(s) && s.stage === "searching" && s.detail.startsWith("Search failed"),
      });

    expect(failedAttempts).toBe(1);
    expect(result.report_markdown.length).toBeGreaterThan(0);
    expect(counts.search).toBe(1);
    expect(counts.extract).toBe(0);
    expect(counts.summarize).toBe(0);
    expect(retained).toBeCloseTo(dispatchedTotal, 4);
    expect(emittedTotal).toBeCloseTo(retained, 4);
  });

  it("rejected summarize-fallback aggregate write still books the 30c summarize debit exactly once", async () => {
    // Reaching a paid summarize aggregate: extract genuinely fails after
    // dispatch (its own 0.4c failure write is healthy), then the fallback
    // summarizes the one URL for 30c. The aggregate "Summarized ..." write
    // carrying that 30c is the one that rejects. Budget 100c so the 30c
    // fallback is affordable after plan + search + failed extract.
    const { result, counts, emittedTotal, retained, dispatchedTotal, failedAttempts } =
      await runScenario({
        budgetCents: 100,
        extractFails: true,
        failOnceOn: (s) =>
          costBearing(s) && s.stage === "extracting" && s.detail.startsWith("Summarized "),
      });

    expect(failedAttempts).toBe(1);
    expect(result.report_markdown.length).toBeGreaterThan(0);
    expect(counts.extract).toBe(1);
    expect(counts.summarize).toBe(1);
    expect(retained).toBeCloseTo(dispatchedTotal, 4);
    expect(emittedTotal).toBeCloseTo(retained, 4);
  });

  it("rejected synthesis-cost write still books the 1.5c synthesis debit exactly once", async () => {
    // The synthesis cost event is the pipeline's last cost-bearing write:
    // there is no later pipeline event to carry the debit onto, so this
    // site can only be made whole by retrying/flushing the write itself.
    const { result, counts, emittedTotal, retained, dispatchedTotal, failedAttempts } =
      await runScenario({
        budgetCents: 10,
        failOnceOn: (s) =>
          costBearing(s) && s.stage === "synthesizing" && s.detail === "Composed report",
      });

    expect(failedAttempts).toBe(1);
    expect(result.report_markdown.length).toBeGreaterThan(0);
    expect(counts.fastgpt).toBe(2);
    expect(counts.search).toBe(1);
    expect(counts.extract).toBe(1);
    expect(counts.summarize).toBe(0);
    expect(retained).toBeCloseTo(dispatchedTotal, 4);
    expect(emittedTotal).toBeCloseTo(retained, 4);
  });
});

describe("controls: healthy writes and genuine paid failures are unchanged", () => {
  it("successful extract with a healthy emit books every debit exactly once", async () => {
    const { result, counts, emittedTotal, retained, failedAttempts } = await runScenario({
      budgetCents: 10,
    });

    expect(failedAttempts).toBe(0);
    expect(result.report_markdown).toBe("synthesized report [1]");
    expect(counts).toEqual({ fastgpt: 2, search: 1, extract: 1, summarize: 0 });
    expect(retained).toBeCloseTo(FASTGPT_CENTS * 2 + SEARCH_CENTS + EXTRACT_CENTS, 4);
    expect(emittedTotal).toBeCloseTo(retained, 4);
  });

  it("genuine extract failure falls back with its 0.4c charged debit exactly once", async () => {
    // The paid extract call itself throws (HTTP 502) with a healthy emit:
    // the failure event must carry the 0.4c, and at a 10c budget the 30c
    // summarize fallback must not dispatch. Emitted == retained == 3.1c.
    const { result, counts, emittedTotal, retained, failedAttempts } = await runScenario({
      budgetCents: 10,
      extractFails: true,
    });

    expect(failedAttempts).toBe(0);
    expect(result.report_markdown.length).toBeGreaterThan(0);
    expect(counts).toEqual({ fastgpt: 1, search: 1, extract: 1, summarize: 0 });
    expect(retained).toBeCloseTo(FASTGPT_CENTS + SEARCH_CENTS + EXTRACT_CENTS, 4);
    expect(emittedTotal).toBeCloseTo(retained, 4);
  });
});
