// F2 regression: a paid call that throws AFTER dispatch is still a paid
// call. The API wrappers settle their monthly-cap charge before response
// normalization can throw, so if the pipeline books only fulfilled calls it
// re-admits the same balance again and again — the run budget stops being a
// ceiling exactly on the failure paths.
//
// Unlike test/research/pipeline.test.ts (fake facade), these tests drive the
// REAL KagiClient in api mode with only global fetch stubbed, because the
// bug is the interaction between wrapper settle order and pipeline booking.
// Behavior is pinned, not mechanism: reserving the published estimate before
// dispatch and retaining the debit on failure is one valid fix; any fix
// that keeps dispatched spend and emitted spend inside the run budget
// passes. Published rates: FastGPT 1.5c, search 1.2c.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KagiClient } from "../../src/kagi/client";
import { readSpend } from "../../src/kagi/api/cost";
import { runPipeline } from "../../src/research/pipeline";
import type { StateAccessors, StepEmit } from "../../src/research/pipeline";
import type { ResearchRunState } from "../../src/research/types";
import { makeEnv, restoreFetch, stubFetch } from "../_helpers";

const NOW = "2026-01-01T00:00:00.000Z";
const FASTGPT_CENTS = 1.5;
const SEARCH_CENTS = 1.2;

function makeState(): ResearchRunState {
  return {
    run_id: "run-paid-failure",
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

let emitted: Array<{ stage: string; detail: string; cost?: number }>;
let emit: StepEmit;

beforeEach(() => {
  emitted = [];
  emit = (async (stage, detail, cost_cents) => {
    emitted.push({ stage, detail, cost: cost_cents });
  }) as StepEmit;
});

afterEach(() => {
  restoreFetch();
});

const emittedTotal = () => emitted.reduce((sum, e) => sum + (e.cost ?? 0), 0);

/** Accessors mirroring the real run store: spent = sum of emitted costs. */
function makeAccessors(budgetCents: number): StateAccessors {
  return {
    isCancelled: async () => false,
    spentCents: async () => emittedTotal(),
    budgetCents: () => budgetCents,
    allowApi: () => true,
  };
}

function apiEnv() {
  return makeEnv({
    KAGI_MODE: "api",
    KAGI_API_KEY: "synthetic-key",
    // Synthetic in-memory cap only; the checked-in cap stays "0".
    MAX_API_CENTS_PER_MONTH: "10000",
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("paid calls that throw after dispatch (F2)", () => {
  it("charges a search that fails in normalization and does not dispatch the next sub-query", async () => {
    // CISO probe scenario: budget 2.7c = planning 1.5c + exactly one search.
    // Each search answers HTTP 200 with data.search: [null], which settles
    // the 1.2c charge and then throws while normalizing. Only the first
    // search may be dispatched; its charge must appear in emitted spend.
    let searchCalls = 0;
    stubFetch(async (input) => {
      const url = String(input);
      if (url.includes("/fastgpt")) {
        return json({
          meta: {},
          data: { output: "1. alpha\n2. beta\n3. gamma", tokens: 10, references: [] },
        });
      }
      if (url.includes("/v1/search")) {
        searchCalls += 1;
        return json({ meta: {}, data: { search: [null] } });
      }
      return json({ meta: {}, data: {} });
    });
    const env = apiEnv();
    const client = new KagiClient(env);
    const budget = FASTGPT_CENTS + SEARCH_CENTS; // 2.7

    const result = await runPipeline(client, makeState(), emit, makeAccessors(budget));

    expect(result.plan).toEqual(["alpha", "beta", "gamma"]);
    expect(searchCalls).toBe(1);
    expect(emittedTotal()).toBeCloseTo(budget);
    expect(await readSpend(env)).toBeLessThanOrEqual(budget + 1e-9);
  });

  it("charges planning FastGPT that fails after dispatch, so the fallback search is not dispatched over budget", async () => {
    // Second paid failure path (planning). Budget 2.0c admits planning
    // (1.5c) but not planning + a search (2.7c). The FastGPT response is
    // HTTP 200 with a null reference entry: charged on settle, then throws
    // in normalization, so planning falls back to the raw question. That
    // paid failure must debit the run — the fallback search may not be
    // dispatched against the apparently untouched balance.
    let fastgptCalls = 0;
    let searchCalls = 0;
    stubFetch(async (input) => {
      const url = String(input);
      if (url.includes("/fastgpt")) {
        fastgptCalls += 1;
        return json({
          meta: {},
          data: { output: "1. should-not-be-used", tokens: 10, references: [null] },
        });
      }
      if (url.includes("/v1/search")) {
        searchCalls += 1;
        return json({
          meta: {},
          data: {
            search: [{ url: "https://a.example/1", title: "A", snippet: "s" }],
          },
        });
      }
      if (url.includes("/v1/extract")) {
        return json({
          meta: {},
          data: { pages: [{ url: "https://a.example/1", content: "# hi" }] },
        });
      }
      if (url.includes("/summarize")) {
        return json({ meta: {}, data: { output: "a summary", tokens: 5 } });
      }
      return json({ meta: {}, data: {} });
    });
    const env = apiEnv();
    const client = new KagiClient(env);
    const budget = 2.0;

    const result = await runPipeline(client, makeState(), emit, makeAccessors(budget));

    // Planning really was dispatched and really did fail (fallback plan).
    expect(fastgptCalls).toBeGreaterThanOrEqual(1);
    expect(result.plan).toEqual(["why is the sky blue"]);
    expect(searchCalls).toBe(0);
    expect(emittedTotal()).toBeCloseTo(FASTGPT_CENTS);
    expect(await readSpend(env)).toBeLessThanOrEqual(budget + 1e-9);
  });
});
