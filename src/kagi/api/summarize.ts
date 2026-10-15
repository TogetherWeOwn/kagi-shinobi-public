// POST /v0/summarize — Universal Summarizer over URL or raw text.
//
// Engines:
//   - cecil (default), agnes: $0.03/1k tokens, capped at $0.30 per summary
//     regardless of input length (docs: "any request over 10,000 tokens is
//     billed as 10,000 tokens").
//   - daphne: same tier as cecil/agnes per current docs.
//   - muriel: flat $1 per summary.
//
// Cache hits (cache: true, default) are free. Muriel is guarded behind an
// explicit confirm_muriel flag from the caller — see kagi_summarize_url tool.

import type { Env } from "../../env.js";
import { KagiApiClient } from "./client.js";
import { guardBillable } from "./cost.js";
import type { V0SummarizeData, V0SummarizeRequest } from "./types.js";
import { buildMeta } from "../../mcp/meta.js";
import type { SummarizeResponse, SummarizerEngine, SummaryStyle } from "../types.js";
import { KagiConfirmRequiredError, KagiError } from "../errors.js";

const SUMMARIZE_URL = "https://kagi.com/api/v0/summarize";
const CECIL_AGNES_CAP_CENTS = 30;
const MURIEL_CENTS = 100;

export interface ApiSummarizeArgs {
  kind: "url" | "text";
  ref: string;
  language: string;
  style: SummaryStyle;
  engine?: SummarizerEngine;
  cache?: boolean;
  confirm_muriel?: boolean;
}

export async function apiSummarize(
  env: Env,
  args: ApiSummarizeArgs,
): Promise<SummarizeResponse> {
  const engine = pickEngine(args.engine);
  if (engine === "muriel") requireMurielConfirm(env, args.confirm_muriel);

  // Validate before reserving. A body we reject ourselves never reaches Kagi
  // and costs nothing, but this path has no settle, so guarding first left the
  // projected charge on the books permanently.
  if (args.kind === "text" && args.ref.length > 1_000_000) {
    throw new KagiError("parse", "summarize text body exceeds 1MB request cap");
  }

  const cache = args.cache ?? true;
  const projected = engine === "muriel" ? MURIEL_CENTS : CECIL_AGNES_CAP_CENTS;

  const start_ms = Date.now();
  const guard = await guardBillable(env, projected);

  const req: V0SummarizeRequest = {
    engine,
    summary_type: args.style,
    target_language: args.language,
    cache,
  };
  if (args.kind === "url") req.url = args.ref;
  else req.text = args.ref;

  const client = new KagiApiClient(env);
  const wire = await client.request<V0SummarizeData>({
    method: "POST",
    url: SUMMARIZE_URL,
    body: req,
  });
  await guard.settle(projected);

  return {
    source: { kind: args.kind, ref: args.ref },
    summary: wire.data.output,
    engine_used: engine,
    target_language: args.language,
    tokens: wire.data.tokens,
    meta: buildMeta({
      impl: "api",
      start_ms,
      cost_cents: projected,
      trace_id: wire.trace_id,
    }),
  };
}

function pickEngine(engine: SummarizerEngine | undefined): "cecil" | "agnes" | "daphne" | "muriel" {
  if (engine === "cecil" || engine === "agnes" || engine === "daphne" || engine === "muriel") {
    return engine;
  }
  return "cecil";
}

function requireMurielConfirm(env: Env, confirm: boolean | undefined): void {
  const requiresConfirm = (env.SUMMARIZER_MURIEL_REQUIRES_CONFIRM ?? "true").toLowerCase() !== "false";
  if (requiresConfirm && confirm !== true) {
    throw new KagiConfirmRequiredError(
      "Muriel is $1 per summary. Set confirm_muriel=true to proceed, or use engine=cecil (default) / agnes / daphne (all capped at $0.30).",
      { cost_cents: MURIEL_CENTS, engine: "muriel" },
    );
  }
}
