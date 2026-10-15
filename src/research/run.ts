// ResearchRun Durable Object.
//
// One DO singleton holds all runs, keyed by run_id in SQLite. A single DO is
// enough because the KagiClient calls dominate wall-clock (each run yields
// often), and it keeps cost tracking centralized.
//
// The DO exposes four RPC-style methods that the MCP tools call:
//   createRun, getOutput, waitForRun, cancelRun
//
// The heavy work runs via ctx.waitUntil so the createRun response returns
// immediately with a run_id.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env.js";
import { createKagiClient, type KagiClient } from "../kagi/client.js";
import { runPipeline } from "./pipeline.js";
import type {
  CreateRunArgs,
  CreateRunResult,
  ResearchRunState,
  ResearchStatus,
  ResearchStep,
} from "./types.js";

const TABLE = "runs";

function newRunId(): string {
  // Workers: crypto.randomUUID() is available on the global crypto object.
  return crypto.randomUUID();
}

export class ResearchRun extends DurableObject<Env> {
  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS ${TABLE} (
          run_id TEXT PRIMARY KEY,
          question TEXT NOT NULL,
          depth INTEGER NOT NULL,
          budget_cents REAL NOT NULL,
          allow_api INTEGER NOT NULL,
          status TEXT NOT NULL,
          cost_cents REAL NOT NULL DEFAULT 0,
          plan_json TEXT NOT NULL DEFAULT '[]',
          steps_json TEXT NOT NULL DEFAULT '[]',
          citations_json TEXT NOT NULL DEFAULT '[]',
          report_markdown TEXT NOT NULL DEFAULT '',
          error TEXT,
          cancelled INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )`,
      );
    });
  }

  async createRun(args: CreateRunArgs): Promise<CreateRunResult> {
    const run_id = newRunId();
    const now = new Date().toISOString();
    const state: ResearchRunState = {
      run_id,
      question: args.question,
      depth: args.depth ?? 1,
      budget_cents: args.budget_cents ?? 0,
      allow_api: args.allow_api ?? true,
      status: "queued",
      cost_cents: 0,
      created_at: now,
      updated_at: now,
      plan: [],
      steps: [],
      citations: [],
      report_markdown: "",
    };
    this.ctx.storage.sql.exec(
      `INSERT INTO ${TABLE} (run_id, question, depth, budget_cents, allow_api, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      run_id,
      state.question,
      state.depth,
      state.budget_cents,
      state.allow_api ? 1 : 0,
      state.status,
      state.created_at,
      state.updated_at,
    );
    // Kick off the pipeline in the background so createRun returns fast.
    this.ctx.waitUntil(this.executePipeline(state));
    return { run_id };
  }

  async getOutput(run_id: string): Promise<ResearchRunState | null> {
    return this.readState(run_id);
  }

  async waitForRun(run_id: string, timeout_seconds: number): Promise<ResearchRunState | null> {
    const deadline = Date.now() + Math.max(1, Math.min(300, timeout_seconds)) * 1000;
    while (Date.now() < deadline) {
      const state = await this.readState(run_id);
      if (!state) return null;
      if (isTerminal(state.status)) return state;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return this.readState(run_id);
  }

  async cancelRun(run_id: string): Promise<{ cancelled: boolean }> {
    const state = await this.readState(run_id);
    if (!state) return { cancelled: false };
    if (isTerminal(state.status)) return { cancelled: false };
    this.ctx.storage.sql.exec(
      `UPDATE ${TABLE} SET cancelled = 1, updated_at = ? WHERE run_id = ?`,
      new Date().toISOString(),
      run_id,
    );
    return { cancelled: true };
  }

  // --- internals ---

  private async executePipeline(initial: ResearchRunState): Promise<void> {
    const client = createKagiClient(this.env);
    await this.updateStatus(initial.run_id, "planning");
    try {
      const result = await runPipeline(
        client,
        initial,
        (stage, detail, cost_cents) =>
          this.pushStep(initial.run_id, { ts: new Date().toISOString(), stage, detail, cost_cents }),
        {
          isCancelled: async () => (await this.readCancel(initial.run_id)) === 1,
          spentCents: async () => (await this.readState(initial.run_id))?.cost_cents ?? 0,
          budgetCents: () => initial.budget_cents,
          allowApi: () => initial.allow_api,
        },
      );
      this.ctx.storage.sql.exec(
        `UPDATE ${TABLE} SET plan_json = ?, citations_json = ?, report_markdown = ?, status = 'done', updated_at = ? WHERE run_id = ?`,
        JSON.stringify(result.plan),
        JSON.stringify(result.citations),
        result.report_markdown,
        new Date().toISOString(),
        initial.run_id,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const status: ResearchStatus = msg === "cancelled" ? "cancelled" : "failed";
      this.ctx.storage.sql.exec(
        `UPDATE ${TABLE} SET status = ?, error = ?, updated_at = ? WHERE run_id = ?`,
        status,
        msg,
        new Date().toISOString(),
        initial.run_id,
      );
    }
  }

  private async updateStatus(run_id: string, status: ResearchStatus): Promise<void> {
    this.ctx.storage.sql.exec(
      `UPDATE ${TABLE} SET status = ?, updated_at = ? WHERE run_id = ?`,
      status,
      new Date().toISOString(),
      run_id,
    );
  }

  private async pushStep(run_id: string, step: ResearchStep): Promise<void> {
    const state = await this.readState(run_id);
    if (!state) return;
    const steps = [...state.steps, step];
    const nextCost = state.cost_cents + (step.cost_cents ?? 0);
    this.ctx.storage.sql.exec(
      `UPDATE ${TABLE} SET steps_json = ?, cost_cents = ?, status = ?, updated_at = ? WHERE run_id = ?`,
      JSON.stringify(steps),
      nextCost,
      step.stage,
      new Date().toISOString(),
      run_id,
    );
  }

  private async readState(run_id: string): Promise<ResearchRunState | null> {
    type Row = {
      [key: string]: SqlStorageValue;
      run_id: string;
      question: string;
      depth: number;
      budget_cents: number;
      allow_api: number;
      status: string;
      cost_cents: number;
      plan_json: string;
      steps_json: string;
      citations_json: string;
      report_markdown: string;
      error: string | null;
      cancelled: number;
      created_at: string;
      updated_at: string;
    };
    const rows = this.ctx.storage.sql
      .exec<Row>(`SELECT * FROM ${TABLE} WHERE run_id = ?`, run_id)
      .toArray();
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      run_id: r.run_id,
      question: r.question,
      depth: r.depth,
      budget_cents: r.budget_cents,
      allow_api: r.allow_api === 1,
      status: r.status as ResearchStatus,
      cost_cents: r.cost_cents,
      created_at: r.created_at,
      updated_at: r.updated_at,
      plan: JSON.parse(r.plan_json) as string[],
      steps: JSON.parse(r.steps_json) as ResearchStep[],
      citations: JSON.parse(r.citations_json) as ResearchRunState["citations"],
      report_markdown: r.report_markdown,
      error: r.error ?? undefined,
    };
  }

  private async readCancel(run_id: string): Promise<number> {
    type CancelRow = { [key: string]: SqlStorageValue; cancelled: number };
    const rows = this.ctx.storage.sql
      .exec<CancelRow>(`SELECT cancelled FROM ${TABLE} WHERE run_id = ?`, run_id)
      .toArray();
    return rows[0]?.cancelled ?? 0;
  }
}

function isTerminal(status: ResearchStatus): boolean {
  return status === "done" || status === "cancelled" || status === "failed";
}

/**
 * Get the singleton DO stub. All runs share one instance so cost tracking
 * and cross-run lookups are trivial.
 */
export function getResearchStub(env: Env): DurableObjectStub<ResearchRun> {
  const id = env.RESEARCH_RUN.idFromName("singleton");
  return env.RESEARCH_RUN.get(id) as DurableObjectStub<ResearchRun>;
}

// suppress client-unused compiler complaint for now
export type { KagiClient };
