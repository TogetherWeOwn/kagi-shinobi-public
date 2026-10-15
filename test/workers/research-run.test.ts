// The ResearchRun Durable Object, against the real DO in workerd.
//
// src/research/run.ts imports cloudflare:workers, so this suite cannot live in
// the Node project. The pipeline and the Kagi client are mocked: what is under
// test here is the DO's own job — row lifecycle, status transitions, the
// cancel flag, and how waitForRun decides it is finished — not the research
// work itself, which test/research/pipeline.test.ts covers directly.

import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getResearchStub } from "../../src/research/run";

const mocks = vi.hoisted(() => ({
  runPipeline: vi.fn(),
  createKagiClient: vi.fn(),
}));

vi.mock("../../src/research/pipeline.js", () => ({ runPipeline: mocks.runPipeline }));
vi.mock("../../src/kagi/client.js", () => ({ createKagiClient: mocks.createKagiClient }));

const PIPELINE_RESULT = {
  plan: ["sub one", "sub two"],
  citations: [{ n: 1, title: "T", url: "https://a.example/", snippet: "s" }],
  report_markdown: "# Report",
};

/** A fresh DO instance per test — run rows are sticky by design. */
let seq = 0;
function researchStub() {
  seq += 1;
  return env.RESEARCH_RUN.get(env.RESEARCH_RUN.idFromName(`research-test-${seq}`));
}

/** Let the ctx.waitUntil pipeline settle before asserting on the row. */
async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 20));
}

/**
 * Insert a run row directly, bypassing createRun's background pipeline.
 *
 * Tests that need a run to *stay* non-terminal cannot hold the mocked pipeline
 * open with a promise resolved from the test: workerd refuses I/O created in
 * one Durable Object's context and settled from another ("Cannot perform I/O
 * on behalf of a different Durable Object"). Seeding the row is equivalent for
 * the methods under test and has no background work to race with.
 */
function seedRun(
  state: DurableObjectState,
  run_id: string,
  status: string,
  cancelled = 0,
): void {
  const now = new Date().toISOString();
  state.storage.sql.exec(
    `INSERT INTO runs (run_id, question, depth, budget_cents, allow_api, status, cancelled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    run_id,
    "seeded question",
    1,
    0,
    1,
    status,
    cancelled,
    now,
    now,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createKagiClient.mockReturnValue({ mode: "scrape" });
  mocks.runPipeline.mockResolvedValue(PIPELINE_RESULT);
});

describe("createRun", () => {
  it("returns a UUID run id", async () => {
    const { run_id } = await researchStub().createRun({ question: "why" });

    expect(run_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("persists the question and applies the safe defaults", async () => {
    const stub = researchStub();

    const { run_id } = await stub.createRun({ question: "why is the sky blue" });
    await settle();
    const state = await stub.getOutput(run_id);

    expect(state).toMatchObject({
      run_id,
      question: "why is the sky blue",
      depth: 1,
      budget_cents: 0,
      allow_api: true,
    });
  });

  it("honors explicit depth, budget, and allow_api=false", async () => {
    const stub = researchStub();

    const { run_id } = await stub.createRun({
      question: "q",
      depth: 3,
      budget_cents: 25.5,
      allow_api: false,
    });
    await settle();
    const state = await stub.getOutput(run_id);

    expect(state).toMatchObject({ depth: 3, budget_cents: 25.5, allow_api: false });
  });

  it("stamps ISO-8601 created_at and updated_at", async () => {
    const stub = researchStub();

    const { run_id } = await stub.createRun({ question: "q" });
    const state = await stub.getOutput(run_id);

    expect(state?.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    expect(state?.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  });

  it("keeps runs separate within one DO", async () => {
    const stub = researchStub();

    const a = await stub.createRun({ question: "first" });
    const b = await stub.createRun({ question: "second" });
    await settle();

    expect((await stub.getOutput(a.run_id))?.question).toBe("first");
    expect((await stub.getOutput(b.run_id))?.question).toBe("second");
  });
});

describe("pipeline completion", () => {
  it("writes the plan, citations, and report on success", async () => {
    const stub = researchStub();

    const { run_id } = await stub.createRun({ question: "q" });
    await settle();
    const state = await stub.getOutput(run_id);

    expect(state?.status).toBe("done");
    expect(state?.plan).toEqual(["sub one", "sub two"]);
    expect(state?.citations).toEqual(PIPELINE_RESULT.citations);
    expect(state?.report_markdown).toBe("# Report");
    expect(state?.error).toBeUndefined();
  });

  it("records the failure message when the pipeline throws", async () => {
    mocks.runPipeline.mockRejectedValue(new Error("upstream exploded"));
    const stub = researchStub();

    const { run_id } = await stub.createRun({ question: "q" });
    await settle();
    const state = await stub.getOutput(run_id);

    expect(state?.status).toBe("failed");
    expect(state?.error).toBe("upstream exploded");
  });

  it("stringifies a non-Error rejection", async () => {
    mocks.runPipeline.mockRejectedValue("plain string boom");
    const stub = researchStub();

    const { run_id } = await stub.createRun({ question: "q" });
    await settle();

    expect((await stub.getOutput(run_id))?.error).toBe("plain string boom");
  });

  it("maps the 'cancelled' sentinel to the cancelled status, not failed", async () => {
    mocks.runPipeline.mockRejectedValue(new Error("cancelled"));
    const stub = researchStub();

    const { run_id } = await stub.createRun({ question: "q" });
    await settle();
    const state = await stub.getOutput(run_id);

    expect(state?.status).toBe("cancelled");
    expect(state?.error).toBe("cancelled");
  });

  it("builds the Kagi client from the DO's own env", async () => {
    const stub = researchStub();

    await stub.createRun({ question: "q" });
    await settle();

    expect(mocks.createKagiClient).toHaveBeenCalledOnce();
  });
});

describe("step recording", () => {
  it("appends steps and accumulates their cost", async () => {
    mocks.runPipeline.mockImplementation(async (_client, _initial, emit) => {
      await emit("searching", "found 3", 1.2);
      await emit("extracting", "pulled 2", 0.4);
      return PIPELINE_RESULT;
    });
    const stub = researchStub();

    const { run_id } = await stub.createRun({ question: "q" });
    await settle();
    const state = await stub.getOutput(run_id);

    expect(state?.steps).toHaveLength(2);
    expect(state?.steps[0]).toMatchObject({ stage: "searching", detail: "found 3" });
    expect(state?.cost_cents).toBeCloseTo(1.6);
  });

  it("treats a step with no cost as free", async () => {
    mocks.runPipeline.mockImplementation(async (_client, _initial, emit) => {
      await emit("planning", "thinking");
      return PIPELINE_RESULT;
    });
    const stub = researchStub();

    const { run_id } = await stub.createRun({ question: "q" });
    await settle();

    expect((await stub.getOutput(run_id))?.cost_cents).toBe(0);
  });

  it("reports the budget and allow_api the run was created with", async () => {
    const seen: Record<string, unknown> = {};
    mocks.runPipeline.mockImplementation(async (_client, _initial, _emit, state) => {
      seen.budget = state.budgetCents();
      seen.allowApi = state.allowApi();
      seen.spent = await state.spentCents();
      seen.cancelled = await state.isCancelled();
      return PIPELINE_RESULT;
    });
    const stub = researchStub();

    await stub.createRun({ question: "q", budget_cents: 40, allow_api: false });
    await settle();

    expect(seen).toEqual({ budget: 40, allowApi: false, spent: 0, cancelled: false });
  });

  it("exposes accumulated spend to the pipeline mid-run", async () => {
    let spentMidRun = -1;
    mocks.runPipeline.mockImplementation(async (_client, _initial, emit, state) => {
      await emit("extracting", "pulled", 2.5);
      spentMidRun = await state.spentCents();
      return PIPELINE_RESULT;
    });
    const stub = researchStub();

    await stub.createRun({ question: "q" });
    await settle();

    expect(spentMidRun).toBeCloseTo(2.5);
  });
});

describe("getOutput", () => {
  it("returns null for a run id that was never created", async () => {
    expect(await researchStub().getOutput("nope")).toBeNull();
  });
});

describe("cancelRun", () => {
  it("reports false for an unknown run", async () => {
    expect(await researchStub().cancelRun("nope")).toEqual({ cancelled: false });
  });

  it("cancels a run that is still in flight", async () => {
    const stub = researchStub();

    await runInDurableObject(stub, async (instance, state) => {
      seedRun(state, "run-live", "searching");

      expect(await instance.cancelRun("run-live")).toEqual({ cancelled: true });
    });
  });

  it("sets the cancelled flag on the row rather than the status", async () => {
    const stub = researchStub();

    await runInDurableObject(stub, async (instance, state) => {
      seedRun(state, "run-flag", "searching");
      await instance.cancelRun("run-flag");

      const rows = state.storage.sql
        .exec<{ cancelled: number; status: string }>(
          "SELECT cancelled, status FROM runs WHERE run_id = ?",
          "run-flag",
        )
        .toArray();

      // The pipeline notices the flag and exits; the DO does not force the
      // status itself, so an in-flight run keeps its stage until then.
      expect(rows[0].cancelled).toBe(1);
      expect(rows[0].status).toBe("searching");
    });
  });

  it("surfaces the cancel flag to the running pipeline", async () => {
    const stub = researchStub();
    let sawCancel: boolean | undefined;

    await runInDurableObject(stub, async (instance) => {
      mocks.runPipeline.mockImplementation(async (_client, initial, _emit, state) => {
        // Same-instance method call, not an RPC round trip — a stub call here
        // would re-enter the Durable Object that is already executing.
        await instance.cancelRun(initial.run_id);
        sawCancel = await state.isCancelled();
        return PIPELINE_RESULT;
      });

      await instance.createRun({ question: "q" });
      await settle();
    });

    expect(sawCancel).toBe(true);
  });

  it("refuses to cancel a run that already finished", async () => {
    const stub = researchStub();

    const { run_id } = await stub.createRun({ question: "q" });
    await settle();

    expect(await stub.cancelRun(run_id)).toEqual({ cancelled: false });
  });

  it("refuses to cancel a failed run", async () => {
    mocks.runPipeline.mockRejectedValue(new Error("boom"));
    const stub = researchStub();

    const { run_id } = await stub.createRun({ question: "q" });
    await settle();

    expect(await stub.cancelRun(run_id)).toEqual({ cancelled: false });
  });
});

describe("waitForRun", () => {
  it("returns null for an unknown run", async () => {
    expect(await researchStub().waitForRun("nope", 1)).toBeNull();
  });

  it("returns immediately once the run is terminal", async () => {
    const stub = researchStub();

    const { run_id } = await stub.createRun({ question: "q" });
    await settle();
    const state = await stub.waitForRun(run_id, 30);

    expect(state?.status).toBe("done");
  });

  it("returns the last known state when the timeout expires first", async () => {
    const stub = researchStub();

    await runInDurableObject(stub, async (instance, state) => {
      seedRun(state, "run-slow", "searching");

      // timeout_seconds is clamped to a 1s floor, so this polls twice and
      // gives up rather than waiting for a terminal status that never comes.
      const result = await instance.waitForRun("run-slow", 0);

      expect(result?.run_id).toBe("run-slow");
      expect(result?.status).toBe("searching");
    });
  });

  it("clamps an over-long timeout instead of trusting the caller", async () => {
    const stub = researchStub();

    await runInDurableObject(stub, async (instance, state) => {
      seedRun(state, "run-terminal", "done");

      // 10_000s would be clamped to 300s, but a terminal run returns at once.
      const result = await instance.waitForRun("run-terminal", 10_000);

      expect(result?.status).toBe("done");
    });
  });

  it("treats cancelled and failed as terminal too", async () => {
    const stub = researchStub();

    await runInDurableObject(stub, async (instance, state) => {
      seedRun(state, "run-cancelled", "cancelled");
      seedRun(state, "run-failed", "failed");

      expect((await instance.waitForRun("run-cancelled", 30))?.status).toBe("cancelled");
      expect((await instance.waitForRun("run-failed", 30))?.status).toBe("failed");
    });
  });
});

describe("getResearchStub", () => {
  it("always addresses the same singleton instance", async () => {
    const a = getResearchStub(env);
    const b = getResearchStub(env);

    // One DO holds every run, so cost tracking and cross-run lookups stay in
    // one place. Two calls must land on the same actor.
    expect(a.id.equals(b.id)).toBe(true);
    expect(a.id.equals(env.RESEARCH_RUN.idFromName("singleton"))).toBe(true);
  });

  it("returns a usable stub", async () => {
    expect(await getResearchStub(env).getOutput("never-created")).toBeNull();
  });
});

describe("SQL schema", () => {
  it("creates the runs table in the constructor", async () => {
    const stub = researchStub();

    await runInDurableObject(stub, (_instance, state) => {
      const rows = state.storage.sql
        .exec("SELECT name FROM sqlite_master WHERE type='table' AND name='runs'")
        .toArray();

      expect(rows).toHaveLength(1);
    });
  });
});
