// POST /v1/extract — clean-markdown extraction of up to 10 URLs per request.
// Priced at $4 / 1000 pages.

import type { Env } from "../../env.js";
import { KagiApiClient } from "./client.js";
import { guardBillable } from "./cost.js";
import type { V1ExtractData, V1ExtractRequest } from "./types.js";
import { buildMeta } from "../../mcp/meta.js";
import type { ExtractResponse } from "../types.js";
import { KagiError } from "../errors.js";

const EXTRACT_URL = "https://kagi.com/api/v1/extract";
const CENTS_PER_URL = 0.4; // $4 / 1000

export interface ApiExtractArgs {
  urls: string[];
  format?: "markdown" | "text";
  timeout_ms?: number;
}

export async function apiExtract(env: Env, args: ApiExtractArgs): Promise<ExtractResponse> {
  if (args.urls.length === 0) {
    throw new KagiError("parse", "extract requires at least one url");
  }
  if (args.urls.length > 10) {
    throw new KagiError(
      "parse",
      `extract accepts up to 10 URLs per request; got ${args.urls.length}`,
    );
  }
  const start_ms = Date.now();
  const projected = CENTS_PER_URL * args.urls.length;
  const guard = await guardBillable(env, projected);
  const req: V1ExtractRequest = {
    urls: args.urls,
    format: args.format ?? "markdown",
    timeout: args.timeout_ms ? Math.round(args.timeout_ms / 1000) : undefined,
  };
  const client = new KagiApiClient(env);
  const wire = await client.request<V1ExtractData>({
    method: "POST",
    url: EXTRACT_URL,
    body: req,
    timeout_ms: args.timeout_ms ?? 30_000,
  });
  await guard.settle(projected);
  return {
    pages: wire.data.pages.map((p) => ({
      url: p.url,
      markdown: p.content ?? "",
      title: p.title,
      word_count: p.word_count,
      props: p.props,
    })),
    meta: buildMeta({
      impl: "api",
      start_ms,
      cost_cents: projected,
      trace_id: wire.trace_id,
    }),
  };
}
