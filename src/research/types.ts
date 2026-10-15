// Shared shapes for the deep-research pipeline.

export type ResearchStatus =
  | "queued"
  | "planning"
  | "searching"
  | "extracting"
  | "synthesizing"
  | "done"
  | "cancelled"
  | "failed";

export interface ResearchStep {
  ts: string;
  stage: ResearchStatus;
  detail: string;
  cost_cents?: number;
}

export interface ResearchCitation {
  n: number;
  title: string;
  url: string;
  snippet?: string;
}

export interface ResearchRunState {
  run_id: string;
  question: string;
  depth: number;
  budget_cents: number;
  allow_api: boolean;
  status: ResearchStatus;
  cost_cents: number;
  created_at: string;
  updated_at: string;
  plan: string[]; // subqueries chosen by the planner
  steps: ResearchStep[];
  citations: ResearchCitation[];
  report_markdown: string;
  error?: string;
}

export interface CreateRunArgs {
  question: string;
  depth?: number;
  budget_cents?: number;
  allow_api?: boolean;
}

export interface CreateRunResult {
  run_id: string;
}
