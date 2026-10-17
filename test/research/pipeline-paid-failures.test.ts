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

// CISO P1 (residual): the F2 fix above covers throws AFTER settle. But a
// dispatch can also fail BEFORE settle — an undecodable or null envelope, an
// HTTP-error status, a transport rejection — and still have been billed by
// Kagi. The monthly guard keeps such unsettled reservations on its books, so
// the run ledger must too: any throw after the monthly guard has admitted
// the call books the projected cents against the run budget. Only a guard
// refusal itself (nothing was ever reserved or dispatched) books nothing.
// Behavior pinned, not mechanism: with budget 2.7c = planning 1.5c + one
// search 1.2c, exactly one failing search may be dispatched and the emitted
// total must be the full 2.7c, whichever pre-settle shape the failure takes.
describe("paid calls that throw before settle (P1)", () => {
  const PLAN_OK = {
    meta: {},
    data: { output: "1. alpha\n2. beta\n3. gamma", tokens: 10, references: [] },
  };

  /** Planning succeeds; every search fails the same pre-settle way. */
  function runWithFailingSearches(searchResponder: () => Promise<Response>) {
    let searchCalls = 0;
    stubFetch(async (input) => {
      const url = String(input);
      if (url.includes("/fastgpt")) return json(PLAN_OK);
      if (url.includes("/v1/search")) {
        searchCalls += 1;
        return searchResponder();
      }
      return json({ meta: {}, data: {} });
    });
    const env = apiEnv();
    const budget = FASTGPT_CENTS + SEARCH_CENTS; // 2.7
    return {
      env,
      budget,
      searchCalls: () => searchCalls,
      run: () => runPipeline(new KagiClient(env), makeState(), emit, makeAccessors(budget)),
    };
  }

  const failureModes: Array<[string, () => Promise<Response>]> = [
    [
      "HTTP 200 with a non-JSON body",
      async () =>
        new Response("<html>not json</html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
    ],
    ["HTTP 200 with a JSON null envelope", async () => json(null)],
    [
      "HTTP 502",
      async () => new Response("upstream broke", { status: 502, statusText: "Bad Gateway" }),
    ],
    [
      "a transport rejection",
      async () => {
        throw new TypeError("fetch failed");
      },
    ],
  ];

  for (const [mode, responder] of failureModes) {
    it(`books a search failing as ${mode}, so only one is dispatched within a 2.7c budget`, async () => {
      const { env, budget, searchCalls, run } = runWithFailingSearches(responder);

      const result = await run();

      expect(result.plan).toEqual(["alpha", "beta", "gamma"]);
      expect(searchCalls()).toBe(1);
      expect(emittedTotal()).toBeCloseTo(budget);
      expect(await readSpend(env)).toBeLessThanOrEqual(budget + 1e-9);
    });
  }

  it("books planning FastGPT that fails before settle, so the fallback search is not dispatched over budget", async () => {
    // Same shape as the post-settle planning test above, but the FastGPT
    // dispatch fails with an HTTP error — before any settle could run.
    // Budget 2.0c admits planning (1.5c) alone; once that dispatched failure
    // is booked, the fallback search (another 1.2c) no longer fits.
    let fastgptCalls = 0;
    let searchCalls = 0;
    stubFetch(async (input) => {
      const url = String(input);
      if (url.includes("/fastgpt")) {
        fastgptCalls += 1;
        return new Response("upstream broke", { status: 502, statusText: "Bad Gateway" });
      }
      if (url.includes("/v1/search")) {
        searchCalls += 1;
        return json({
          meta: {},
          data: { search: [{ url: "https://a.example/1", title: "A", snippet: "s" }] },
        });
      }
      return json({ meta: {}, data: {} });
    });
    const env = apiEnv();
    const budget = 2.0;

    const result = await runPipeline(new KagiClient(env), makeState(), emit, makeAccessors(budget));

    expect(fastgptCalls).toBeGreaterThanOrEqual(1);
    expect(result.plan).toEqual(["why is the sky blue"]);
    expect(searchCalls).toBe(0);
    expect(emittedTotal()).toBeCloseTo(FASTGPT_CENTS);
    expect(await readSpend(env)).toBeLessThanOrEqual(budget + 1e-9);
  });

  it("a monthly-cap guard refusal dispatches nothing and books nothing", async () => {
    // The one failure that must stay free: the guard refuses before any
    // reservation or dispatch, so there is nothing Kagi could have billed.
    // Booking projected cents here would burn run budget on calls that
    // never left the worker.
    let fetchCalls = 0;
    stubFetch(async () => {
      fetchCalls += 1;
      return json(PLAN_OK);
    });
    const env = makeEnv({
      KAGI_MODE: "api",
      KAGI_API_KEY: "synthetic-key",
      MAX_API_CENTS_PER_MONTH: "0",
    });
    const budget = FASTGPT_CENTS + SEARCH_CENTS;

    await runPipeline(new KagiClient(env), makeState(), emit, makeAccessors(budget));

    expect(fetchCalls).toBe(0);
    expect(emittedTotal()).toBe(0);
  });
});

// Residual: a planning response can settle its 1.5c charge and only then
// turn out malformed in the pipeline's own hands (a null `output` field is
// returned as the answer and throws when split). The spend tracker may see
// that booking locally, but unless it is also EMITTED it never reaches the
// persisted run state — after a restart the run looks 1.5c cheaper than it
// was. Emitted (persistable) spend must equal retained spend, exactly once.
describe("planning charge settled before a pipeline-side failure", () => {
  it("emits the retained planning charge once, so emitted total equals retained 2.7c", async () => {
    let fastgptCalls = 0;
    let searchCalls = 0;
    stubFetch(async (input) => {
      const url = String(input);
      if (url.includes("/fastgpt")) {
        fastgptCalls += 1;
        return json({ meta: {}, data: { output: null, references: [] } });
      }
      if (url.includes("/v1/search")) {
        searchCalls += 1;
        return json({ meta: {}, data: { search: [] } });
      }
      return json({ meta: {}, data: {} });
    });
    const env = apiEnv();
    const budget = FASTGPT_CENTS + SEARCH_CENTS; // 2.7

    const result = await runPipeline(
      new KagiClient(env),
      makeState(),
      emit,
      makeAccessors(budget),
    );

    // Planning was dispatched and unusable, so the raw question is the plan;
    // exactly one search fits beside the retained planning charge.
    expect(fastgptCalls).toBe(1);
    expect(result.plan).toEqual(["why is the sky blue"]);
    expect(searchCalls).toBe(1);
    const retained = await readSpend(env);
    expect(retained).toBeCloseTo(budget);
    expect(emittedTotal()).toBeCloseTo(retained);
  });
});
