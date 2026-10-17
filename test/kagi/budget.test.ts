// takeKagiCall — the caller side of the global Kagi call budget (ADR 0013).
// The Meter is a scripted stub here so pacing, refusal, and fail-open can be
// driven precisely; the DO's own windows are pinned in
// test/workers/kagi-budget.test.ts.

import { describe, expect, it, vi } from "vitest";
import { readKagiCallLimits, takeKagiCall } from "../../src/kagi/budget";
import { KagiRateLimitError } from "../../src/kagi/errors";
import type { Env } from "../../src/env";

type Verdict = { ok: boolean; window?: string; count?: number; limit?: number; retry_after_ms: number };

function envWith(verdicts: Verdict[] | Error, vars: Record<string, string> = {}) {
  const takeKagiCall = vi.fn(async () => {
    if (verdicts instanceof Error) throw verdicts;
    return verdicts.shift() ?? { ok: true, retry_after_ms: 0 };
  });
  const env = {
    METER: { idFromName: (n: string) => n, get: () => ({ takeKagiCall }) },
    ...vars,
  } as unknown as Env;
  return { env, takeKagiCall };
}

describe("readKagiCallLimits", () => {
  it("defaults to 2/s with day/month volume caps disabled", () => {
    expect(readKagiCallLimits({} as Env)).toEqual({ perSecond: 2, perDay: 0, perMonth: 0 });
  });
  it("treats garbage and negatives as disabled", () => {
    const env = { KAGI_CALLS_PER_SECOND: "x", KAGI_CALLS_PER_DAY: "-1", KAGI_CALLS_PER_MONTH: "7" } as unknown as Env;
    expect(readKagiCallLimits(env)).toEqual({ perSecond: 0, perDay: 0, perMonth: 7 });
  });
});

describe("takeKagiCall", () => {
  it("skips the Meter entirely when every window is disabled", async () => {
    const { env, takeKagiCall: stub } = envWith([], {
      KAGI_CALLS_PER_SECOND: "0",
      KAGI_CALLS_PER_DAY: "0",
      KAGI_CALLS_PER_MONTH: "0",
    });
    await takeKagiCall(env);
    expect(stub).not.toHaveBeenCalled();
  });

  it("admits when the Meter admits", async () => {
    const { env, takeKagiCall: stub } = envWith([{ ok: true, retry_after_ms: 0 }]);
    await expect(takeKagiCall(env)).resolves.toBeUndefined();
    expect(stub).toHaveBeenCalledWith(expect.any(Number), 2, 0, 0);
  });

  it("paces through a full second, then admits", async () => {
    const { env, takeKagiCall: stub } = envWith([
      { ok: false, window: "second", count: 2, limit: 2, retry_after_ms: 5 },
      { ok: true, retry_after_ms: 0 },
    ]);
    await takeKagiCall(env);
    expect(stub).toHaveBeenCalledTimes(2);
  });

  it("refuses once pacing would exceed the wait bound", async () => {
    const { env } = envWith([{ ok: false, window: "second", count: 2, limit: 2, retry_after_ms: 5_000 }]);
    await expect(takeKagiCall(env)).rejects.toBeInstanceOf(KagiRateLimitError);
  });

  it("refuses a full day with Retry-After in seconds", async () => {
    const { env } = envWith([{ ok: false, window: "day", count: 600, limit: 600, retry_after_ms: 3_600_500 }]);
    const err = (await takeKagiCall(env).catch((e) => e)) as KagiRateLimitError;
    expect(err).toBeInstanceOf(KagiRateLimitError);
    expect(err.detail.retry_after).toBe(3_601);
    expect(err.message).toContain("day: 600/600");
  });

  it("fails open when the Meter is unreachable", async () => {
    const { env, takeKagiCall: stub } = envWith(new Error("DO down"));
    await expect(takeKagiCall(env)).resolves.toBeUndefined();
    expect(stub).toHaveBeenCalledTimes(1);
  });

  it("spreads concurrent fail-open admissions across pacer slots", async () => {
    const { env } = envWith(new Error("DO down"), { KAGI_CALLS_PER_SECOND: "10" });
    const admitTimes: number[] = [];
    const N = 5;
    await Promise.all(
      Array.from({ length: N }, () =>
        takeKagiCall(env).then(() => {
          admitTimes.push(Date.now());
        }),
      ),
    );
    expect(admitTimes).toHaveLength(N);
    const span = Math.max(...admitTimes) - Math.min(...admitTimes);
    // 5 slots 100ms apart admit over ~400ms; a flat pause admits all at once.
    expect(span).toBeGreaterThanOrEqual(200);
  });

  it("fails open with a flat pause when no per-second rate is configured", async () => {
    const { env, takeKagiCall: stub } = envWith(new Error("DO down"), {
      KAGI_CALLS_PER_SECOND: "0",
      KAGI_CALLS_PER_DAY: "5",
    });
    await expect(takeKagiCall(env)).resolves.toBeUndefined();
    expect(stub).toHaveBeenCalledTimes(1);
  });

  it("refuses fail-open calls once the pacer wait would pass the bound", async () => {
    const { env } = envWith(new Error("DO down"), { KAGI_CALLS_PER_SECOND: "10" });
    const N = 40;
    const results = await Promise.allSettled(Array.from({ length: N }, () => takeKagiCall(env)));
    const refused = results.filter((r) => r.status === "rejected");
    const admitted = results.filter((r) => r.status === "fulfilled");
    expect(admitted.length).toBeGreaterThan(0);
    expect(refused.length).toBeGreaterThan(0);
    for (const r of refused) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(KagiRateLimitError);
    }
  });

  it("still refuses a configured day window past its cap", async () => {
    const { env } = envWith([{ ok: false, window: "day", count: 5, limit: 5, retry_after_ms: 3_600_500 }], {
      KAGI_CALLS_PER_DAY: "5",
    });
    const err = (await takeKagiCall(env).catch((e) => e)) as KagiRateLimitError;
    expect(err).toBeInstanceOf(KagiRateLimitError);
    expect(err.message).toContain("day: 5/5");
  });
});
