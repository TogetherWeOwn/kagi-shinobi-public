// ADR 0006's untested risk: the spend counter is a single serialization point
// for every billable call, and if it is unreachable those calls must "fail
// closed and refuse, never fall back to unmetered."
//
// That property was asserted in the ADR and in cost.ts's header comment, but
// nothing checked it. This file checks it, for every billable endpoint.
//
// The assertion that matters is NOT the rejection — it is `fetch` never being
// called. A billable request that escapes the worker has already cost money,
// whatever the caller is told afterwards. Rejecting *after* the round-trip
// would look identical to the caller and be exactly the bug.
//
// Runs in the `unit` project: an unreachable Meter is a stub that throws, so
// no real Durable Object is involved. The counterpart tests that need the real
// DO live in test/workers/cost.test.ts.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../src/env";
import { apiEnrichNews, apiEnrichWeb } from "../../../src/kagi/api/enrich";
import { apiExtract } from "../../../src/kagi/api/extract";
import { apiFastGPT } from "../../../src/kagi/api/fastgpt";
import { apiRank } from "../../../src/kagi/api/rank";
import { apiSearch } from "../../../src/kagi/api/search";
import { apiSmallWeb } from "../../../src/kagi/api/smallweb";
import { apiSummarize } from "../../../src/kagi/api/summarize";
import { KagiBudgetExceededError } from "../../../src/kagi/errors";
import { makeEnv, restoreFetch, stubFetch } from "../../_helpers";

afterEach(() => {
  restoreFetch();
});

const UNREACHABLE = "Durable Object unreachable";

/**
 * A METER namespace whose every method rejects — the shape of a Meter DO that
 * cannot be reached. Mirrors the broken-binding trick in
 * test/workers/refresh-lease.test.ts.
 */
function unreachableMeter(): Env["METER"] {
  const dead = async (): Promise<never> => {
    throw new Error(UNREACHABLE);
  };
  return {
    idFromName: (name: string) => name,
    get: () => ({
      reserveSpend: dead,
      settleSpend: dead,
      spendSnapshot: dead,
    }),
  } as unknown as Env["METER"];
}

/** Cap and API key are both generous, so any refusal is the Meter's doing. */
function meterlessEnv(): Env {
  return makeEnv({
    MAX_API_CENTS_PER_MONTH: "10000",
    KAGI_API_KEY: "k",
    METER: unreachableMeter(),
  });
}

interface BillableCall {
  readonly name: string;
  readonly call: (env: Env) => Promise<unknown>;
}

/**
 * Every entry point that spends money. apiSmallWeb and apiRank do not call the
 * network themselves — both delegate to apiSearch and inherit its guard, each
 * billing a full ~1.2¢ v1 search — but they are listed anyway. If either ever
 * grows its own `client.request`, that is precisely the drift that would
 * reintroduce an unmetered billable path, and this table is where it should
 * fail. Adding a new billable endpoint here is the point.
 */
const BILLABLE: readonly BillableCall[] = [
  { name: "apiSearch", call: (env) => apiSearch(env, { query: "q" }) },
  { name: "apiFastGPT", call: (env) => apiFastGPT(env, { query: "q" }) },
  {
    name: "apiExtract",
    call: (env) => apiExtract(env, { urls: ["https://example.test/a"] }),
  },
  {
    name: "apiSummarize",
    call: (env) =>
      apiSummarize(env, {
        kind: "url",
        ref: "https://example.test/a",
        language: "EN",
        style: "summary",
      }),
  },
  { name: "apiEnrichWeb", call: (env) => apiEnrichWeb(env, { q: "q" }) },
  { name: "apiEnrichNews", call: (env) => apiEnrichNews(env, { q: "q" }) },
  { name: "apiSmallWeb", call: (env) => apiSmallWeb(env, { q: "q" }) },
  { name: "apiRank", call: (env) => apiRank(env, { urls: ["https://example.test/a"], q: "q" }) },
];

describe("billable endpoints fail closed when the Meter is unreachable", () => {
  it.each(BILLABLE)("$name sends no request at all", async ({ call }) => {
    const fetchSpy = vi.fn(async () => new Response("{}"));
    stubFetch(fetchSpy);

    await expect(call(meterlessEnv())).rejects.toThrow();

    // The whole point. A rejection after the round-trip is not fail-closed.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(BILLABLE)("$name surfaces the Meter failure, not a budget verdict", async ({ call }) => {
    // Reporting "budget exceeded" for an unreachable counter would send an
    // operator to raise a cap that was never the problem.
    stubFetch(vi.fn(async () => new Response("{}")));

    const err: unknown = await call(meterlessEnv()).then(
      () => new Error("expected a refusal, got a result"),
      (reason: unknown) => reason,
    );

    expect(err).not.toBeInstanceOf(KagiBudgetExceededError);
    expect((err as Error).message).toBe(UNREACHABLE);
  });
});
