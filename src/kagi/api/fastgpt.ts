// POST /v0/fastgpt — Kagi's cited-answer endpoint.
// Priced at $15 / 1000 non-cached queries; cache hits are free.

import type { Env } from "../../env.js";
import { KagiApiClient } from "./client.js";
import { guardBillable } from "./cost.js";
import type { V0FastGPTData, V0FastGPTRequest } from "./types.js";
import { buildMeta } from "../../mcp/meta.js";
import { KagiParseError, withChargedCost } from "../errors.js";
import type { FastGPTResponse } from "../types.js";

const FASTGPT_URL = "https://kagi.com/api/v0/fastgpt";
const CENTS_PER_CALL = 1.5; // $15 / 1000

export interface ApiFastGPTArgs {
  query: string;
  cache?: boolean;
}

export async function apiFastGPT(env: Env, args: ApiFastGPTArgs): Promise<FastGPTResponse> {
  const start_ms = Date.now();
  const cache = args.cache ?? true;
  // We can't know upfront whether the call will hit cache, so guard the full
  // projected charge; settle with 0 later if we can detect a cache hit.
  const guard = await guardBillable(env, CENTS_PER_CALL);
  // Past the guard the projected charge is reserved; any throw from here —
  // dispatch, decode or mapping — must carry it so budget-keeping callers
  // book the debit (see withChargedCost).
  try {
    const req: V0FastGPTRequest = { query: args.query, cache };
    const client = new KagiApiClient(env);
    const wire = await client.request<V0FastGPTData>({
      method: "POST",
      url: FASTGPT_URL,
      body: req,
    });
    // The docs don't currently return an explicit cache-hit flag on FastGPT.
    // Bill conservatively: charge the full amount and let the operator reconcile
    // via Kagi's monthly usage report if desired.
    await guard.settle(CENTS_PER_CALL);
    // A non-string `output` is a malformed paid response, not an answer:
    // returning it as one would hand callers a "successful" value that
    // throws in their hands, past every charge tag. Fail here, inside the
    // tagged region, so the settled charge stays attached to the error.
    if (typeof wire.data.output !== "string") {
      throw new KagiParseError("FastGPT response did not include an answer");
    }
    return {
      query: args.query,
      answer: wire.data.output,
      references: (wire.data.references ?? []).map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.snippet,
      })),
      tokens: wire.data.tokens,
      meta: buildMeta({
        impl: "api",
        start_ms,
        cost_cents: CENTS_PER_CALL,
        trace_id: wire.trace_id,
      }),
    };
  } catch (err) {
    throw withChargedCost(err, CENTS_PER_CALL);
  }
}
