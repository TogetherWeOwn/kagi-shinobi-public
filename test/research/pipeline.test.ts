// The deep-research pipeline.
//
// runPipeline takes its KagiClient by injection and its persistence through
// callbacks, so the whole state machine is testable without a Durable Object:
// a fake client decides what each stage sees, and the StateAccessors decide
// what the pipeline is allowed to spend and whether it has been cancelled.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { runPipeline, STEP_HELPERS } from "../../src/research/pipeline";
import type { StateAccessors, StepEmit } from "../../src/research/pipeline";
import type { KagiClient } from "../../src/kagi/client";
import type { ResearchRunState } from "../../src/research/types";

const NOW = "2026-01-01T00:00:00.000Z";

function makeState(overrides: Partial<ResearchRunState> = {}): ResearchRunState {
  return {
    run_id: "run-1",
    question: "why is the sky blue",
    depth: 1,
    budget_cents: 0,
    allow_api: false,
    status: "queued",
    cost_cents: 0,
    created_at: NOW,
    updated_at: NOW,
    plan: [],
    steps: [],
    citations: [],
    report_markdown: "",
    ...overrides,
  };
}

/** StateAccessors with sane defaults; override per test. */
function makeAccessors(overrides: Partial<StateAccessors> = {}): StateAccessors {
  return {
    isCancelled: async () => false,
    spentCents: async () => 0,
    budgetCents: () => 0,
    allowApi: () => false,
    ...overrides,
  };
}

/** A search result the pipeline can consume. */
function searchResult(urls: string[]) {
  return {
    query: "q",
    results: urls.map((url, i) => ({
      rank: i + 1,
      url,
      title: `Title ${i}`,
      snippet: `Snippet ${i}`,
    })),
    meta: { impl: "scrape", cache_hit: false, elapsed_ms: 1 },
  };
}

function makeClient(overrides: Record<string, unknown> = {}): KagiClient {
  return {
    mode: "scrape",
    search: vi.fn().mockResolvedValue(searchResult(["https://a.example/1"])),
    summarize: vi.fn().mockResolvedValue({ summary: "a summary" }),
    fastGPT: vi.fn().mockResolvedValue({ answer: "an answer" }),
    extract: vi.fn().mockResolvedValue({
      pages: [{ url: "https://a.example/1", markdown: "# extracted" }],
      meta: { cost_cents: 0.4 },
    }),
    ...overrides,
  } as unknown as KagiClient;
}

let emitted: Array<{ stage: string; detail: string; cost?: number }>;
let emit: StepEmit;

beforeEach(() => {
  emitted = [];
  emit = (async (stage, detail, cost_cents) => {
    emitted.push({ stage, detail, cost: cost_cents });
  }) as StepEmit;
});

const stages = () => emitted.map((e) => e.stage);
const details = () => emitted.map((e) => e.detail);

describe("planning", () => {
  it("uses the raw question as the only sub-query when the API is off", async () => {
    const client = makeClient();

    const result = await runPipeline(client, makeState(), emit, makeAccessors());

    expect(result.plan).toEqual(["why is the sky blue"]);
    expect(client.fastGPT).not.toHaveBeenCalled();
    expect(details()).toContain("Plan: 1 sub-queries");
  });

  it("does not spend on planning when the budget is zero, even with the API allowed", async () => {
    const client = makeClient();

    const result = await runPipeline(
      client,
      makeState(),
      emit,
      makeAccessors({ allowApi: () => true, budgetCents: () => 0 }),
    );

    expect(result.plan).toEqual(["why is the sky blue"]);
    expect(client.fastGPT).not.toHaveBeenCalled();
  });

  it("decomposes the question via FastGPT when funded", async () => {
    const client = makeClient({
      fastGPT: vi
        .fn()
        .mockResolvedValueOnce({ answer: "1. rayleigh scattering\n2. atmosphere composition" })
        .mockResolvedValue({ answer: "synthesized" }),
    });

    const result = await runPipeline(
      client,
      makeState(),
      emit,
      makeAccessors({ allowApi: () => true, budgetCents: () => 100 }),
    );

    expect(result.plan).toEqual(["rayleigh scattering", "atmosphere composition"]);
  });

  it("strips numbering in the 1. / 1) / 1- forms", async () => {
    const client = makeClient({
      fastGPT: vi
        .fn()
        .mockResolvedValueOnce({ answer: "1. alpha\n2) beta\n3- gamma" })
        .mockResolvedValue({ answer: "synthesized" }),
    });

    const result = await runPipeline(
      client,
      makeState(),
      emit,
      makeAccessors({ allowApi: () => true, budgetCents: () => 100 }),
    );

    expect(result.plan).toEqual(["alpha", "beta", "gamma"]);
  });

  it("drops blank lines and over-long lines, and caps the plan at five", async () => {
    const answer = [
      "1. one",
      "",
      "   ",
      `2. ${"x".repeat(250)}`,
      "3. three",
      "4. four",
      "5. five",
      "6. six",
      "7. seven",
    ].join("\n");
    const client = makeClient({
      fastGPT: vi
        .fn()
        .mockResolvedValueOnce({ answer })
        .mockResolvedValue({ answer: "synthesized" }),
    });

    const result = await runPipeline(
      client,
      makeState(),
      emit,
      makeAccessors({ allowApi: () => true, budgetCents: () => 100 }),
    );

    expect(result.plan).toEqual(["one", "three", "four", "five", "six"]);
  });

  it("falls back to the question when FastGPT returns nothing usable", async () => {
    const client = makeClient({
      fastGPT: vi
        .fn()
        .mockResolvedValueOnce({ answer: "\n\n   \n" })
        .mockResolvedValue({ answer: "synthesized" }),
    });

    const result = await runPipeline(
      client,
      makeState(),
      emit,
      makeAccessors({ allowApi: () => true, budgetCents: () => 100 }),
    );

    expect(result.plan).toEqual(["why is the sky blue"]);
  });

  it("falls back to the question when FastGPT throws", async () => {
    const client = makeClient({
      fastGPT: vi
        .fn()
        .mockRejectedValueOnce(new Error("upstream down"))
        .mockResolvedValue({ answer: "synthesized" }),
    });

    const result = await runPipeline(
      client,
      makeState(),
      emit,
      makeAccessors({ allowApi: () => true, budgetCents: () => 100 }),
    );

    expect(result.plan).toEqual(["why is the sky blue"]);
  });
});

describe("searching", () => {
  it("searches every sub-query and reports the hit count", async () => {
    const client = makeClient({
      search: vi
        .fn()
        .mockResolvedValue(searchResult(["https://a.example/1", "https://a.example/2"])),
    });

    await runPipeline(client, makeState(), emit, makeAccessors());

    expect(client.search).toHaveBeenCalledWith({ q: "why is the sky blue", limit: 3 });
    expect(details()).toContain('Found 2 results for "why is the sky blue"');
  });

  it("records a failed sub-query without failing the run", async () => {
    const client = makeClient({
      search: vi.fn().mockRejectedValue(new Error("kagi is down")),
    });

    const result = await runPipeline(client, makeState(), emit, makeAccessors());

    expect(details()).toContain('Search failed for "why is the sky blue": kagi is down');
    expect(result.citations).toEqual([]);
  });

  it("stringifies a non-Error rejection reason", async () => {
    const client = makeClient({
      search: vi.fn().mockRejectedValue("plain string boom"),
    });

    await runPipeline(client, makeState(), emit, makeAccessors());

    expect(details()).toContain('Search failed for "why is the sky blue": plain string boom');
  });

  it("deduplicates URLs across sub-queries, keeping the first title", async () => {
    const search = vi
      .fn()
      .mockResolvedValueOnce({
        query: "a",
        results: [{ rank: 1, url: "https://dup.example/", title: "First", snippet: "S1" }],
        meta: {},
      })
      .mockResolvedValueOnce({
        query: "b",
        results: [{ rank: 1, url: "https://dup.example/", title: "Second", snippet: "S2" }],
        meta: {},
      });
    const client = makeClient({
      search,
      // Funded, so the planner runs — but force the summarize path so the
      // material URLs are the deduplicated search URLs rather than whatever
      // /v1/extract echoes back.
      extract: vi.fn().mockRejectedValue(new Error("no extract")),
      fastGPT: vi
        .fn()
        .mockResolvedValueOnce({ answer: "1. a\n2. b" })
        .mockRejectedValue(new Error("no synth")),
    });

    const result = await runPipeline(
      client,
      makeState(),
      emit,
      makeAccessors({ allowApi: () => true, budgetCents: () => 100 }),
    );

    expect(result.citations).toHaveLength(1);
    expect(result.citations[0]).toMatchObject({ title: "First", snippet: "S1" });
  });

  it("widens the URL pool with depth", async () => {
    const urls = Array.from({ length: 9 }, (_, i) => `https://a.example/${i}`);
    const client = makeClient({
      search: vi.fn().mockResolvedValue(searchResult(urls)),
      summarize: vi.fn().mockResolvedValue({ summary: "s" }),
    });

    // depth 1 → 3 URLs; depth 3 → 9, but the scrape summarize path caps at 5.
    const shallow = await runPipeline(client, makeState({ depth: 1 }), emit, makeAccessors());
    const deep = await runPipeline(client, makeState({ depth: 3 }), emit, makeAccessors());

    expect(shallow.citations).toHaveLength(3);
    expect(deep.citations).toHaveLength(5);
  });

  it("clamps depth into 1..3", async () => {
    const urls = Array.from({ length: 20 }, (_, i) => `https://a.example/${i}`);
    const client = makeClient({ search: vi.fn().mockResolvedValue(searchResult(urls)) });

    // depth 0 is falsy → treated as 1 → 3 URLs; depth 99 clamps to 3 → 9 URLs,
    // then the summarize path caps at 5.
    const zero = await runPipeline(client, makeState({ depth: 0 }), emit, makeAccessors());
    const huge = await runPipeline(client, makeState({ depth: 99 }), emit, makeAccessors());

    expect(zero.citations).toHaveLength(3);
    expect(huge.citations).toHaveLength(5);
  });
});

describe("extracting", () => {
  it("uses /v1/extract and books its cost when the budget allows", async () => {
    const client = makeClient();

    const result = await runPipeline(
      client,
      makeState(),
      emit,
      makeAccessors({ allowApi: () => true, budgetCents: () => 100, spentCents: async () => 0 }),
    );

    expect(client.extract).toHaveBeenCalledWith({ urls: ["https://a.example/1"] });
    expect(emitted.find((e) => e.detail.includes("via /v1/extract"))?.cost).toBe(0.4);
    expect(result.report_markdown).toBeTruthy();
    expect(client.summarize).not.toHaveBeenCalled();
  });

  it("skips extract once spending has eaten into the 5c headroom", async () => {
    const client = makeClient();

    await runPipeline(
      client,
      makeState(),
      emit,
      makeAccessors({ allowApi: () => true, budgetCents: () => 10, spentCents: async () => 8 }),
    );

    expect(client.extract).not.toHaveBeenCalled();
    expect(client.summarize).toHaveBeenCalled();
  });

  it("falls back to the scrape summarizer when extract fails", async () => {
    const client = makeClient({
      extract: vi.fn().mockRejectedValue(new Error("extract exploded")),
    });

    await runPipeline(
      client,
      makeState(),
      emit,
      makeAccessors({ allowApi: () => true, budgetCents: () => 100 }),
    );

    expect(details()).toContain("Extract failed, falling back to summarize: extract exploded");
    expect(client.summarize).toHaveBeenCalledWith({
      kind: "url",
      ref: "https://a.example/1",
      language: "EN",
      style: "summary",
    });
  });

  it("counts only the URLs the summarizer managed to fetch", async () => {
    const client = makeClient({
      search: vi
        .fn()
        .mockResolvedValue(searchResult(["https://a.example/1", "https://a.example/2"])),
      summarize: vi
        .fn()
        .mockResolvedValueOnce({ summary: "ok" })
        .mockRejectedValueOnce(new Error("timeout")),
    });

    const result = await runPipeline(client, makeState(), emit, makeAccessors());

    expect(details()).toContain("Summarized 1/2 URLs via scrape summarizer");
    expect(result.citations).toHaveLength(1);
  });

  it("skips the extract stage entirely when no URLs were found", async () => {
    const client = makeClient({ search: vi.fn().mockResolvedValue(searchResult([])) });

    const result = await runPipeline(client, makeState(), emit, makeAccessors());

    expect(client.extract).not.toHaveBeenCalled();
    expect(client.summarize).not.toHaveBeenCalled();
    expect(result.report_markdown).toBe("No source material was gathered for this question.");
  });
});

describe("synthesizing", () => {
  it("asks FastGPT for the report when funded", async () => {
    const fastGPT = vi
      .fn()
      .mockResolvedValueOnce({ answer: "1. sub" })
      .mockResolvedValueOnce({ answer: "The final report." });
    const client = makeClient({ fastGPT });

    const result = await runPipeline(
      client,
      makeState(),
      emit,
      makeAccessors({ allowApi: () => true, budgetCents: () => 100 }),
    );

    expect(result.report_markdown).toBe("The final report.");
    const synthPrompt = fastGPT.mock.calls[1][0].query as string;
    expect(synthPrompt).toContain("Cite sources inline");
    expect(synthPrompt).toContain("why is the sky blue");
  });

  it("falls back to a deterministic markdown digest when FastGPT fails", async () => {
    const client = makeClient({
      fastGPT: vi
        .fn()
        .mockResolvedValueOnce({ answer: "1. sub" })
        .mockRejectedValueOnce(new Error("synth down")),
    });

    const result = await runPipeline(
      client,
      makeState(),
      emit,
      makeAccessors({ allowApi: () => true, budgetCents: () => 100 }),
    );

    expect(result.report_markdown).toContain("# Research: why is the sky blue");
    expect(result.report_markdown).toContain("## Source [1] —");
  });

  it("uses the deterministic digest in scrape-only mode", async () => {
    const client = makeClient();

    const result = await runPipeline(client, makeState(), emit, makeAccessors());

    expect(client.fastGPT).not.toHaveBeenCalled();
    expect(result.report_markdown).toContain("# Research: why is the sky blue");
    expect(result.report_markdown).toContain("a summary");
  });

  it("numbers citations from one and carries the snippet", async () => {
    const client = makeClient({
      search: vi
        .fn()
        .mockResolvedValue(searchResult(["https://a.example/1", "https://a.example/2"])),
    });

    const result = await runPipeline(client, makeState(), emit, makeAccessors());

    expect(result.citations).toEqual([
      { n: 1, title: "Title 0", url: "https://a.example/1", snippet: "Snippet 0" },
      { n: 2, title: "Title 1", url: "https://a.example/2", snippet: "Snippet 1" },
    ]);
  });
});

describe("cancellation", () => {
  const checkpoints = [
    ["before planning", 1],
    ["before searching", 2],
    ["before extracting", 3],
    ["before synthesizing", 4],
  ] as const;

  for (const [label, trueOnCall] of checkpoints) {
    it(`aborts ${label}`, async () => {
      let calls = 0;
      const client = makeClient();

      await expect(
        runPipeline(
          client,
          makeState(),
          emit,
          makeAccessors({ isCancelled: async () => ++calls >= trueOnCall }),
        ),
      ).rejects.toThrow("cancelled");
    });
  }

  it("does not search when cancelled before the first checkpoint", async () => {
    const client = makeClient();

    await expect(
      runPipeline(client, makeState(), emit, makeAccessors({ isCancelled: async () => true })),
    ).rejects.toThrow("cancelled");

    expect(client.search).not.toHaveBeenCalled();
    expect(emitted).toEqual([]);
  });
});

describe("stage ordering", () => {
  it("emits planning → searching → extracting → synthesizing", async () => {
    const client = makeClient();

    await runPipeline(client, makeState(), emit, makeAccessors());

    expect(stages()).toEqual([
      "planning",
      "planning",
      "searching",
      "extracting",
      "synthesizing",
    ]);
  });
});

describe("STEP_HELPERS", () => {
  it("stamps an ISO-8601 timestamp", () => {
    expect(STEP_HELPERS.now()).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  });

  it("builds a step without a cost field when no cost is given", () => {
    const step = STEP_HELPERS.step("planning", "thinking");

    expect(step).toMatchObject({ stage: "planning", detail: "thinking" });
    expect("cost_cents" in step).toBe(false);
  });

  it("includes the cost field when one is given, including zero", () => {
    expect(STEP_HELPERS.step("extracting", "done", 0).cost_cents).toBe(0);
    expect(STEP_HELPERS.step("extracting", "done", 1.5).cost_cents).toBe(1.5);
  });
});
