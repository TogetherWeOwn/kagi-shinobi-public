// Monthly cost cap, against the real Meter Durable Object.
//
// The concurrency case is the reason this file lives in test/workers/. The
// previous implementation read spend, checked the cap, made the network call,
// then debited — so N concurrent callers all admitted against the same stale
// total and the cap could be blown by roughly N times the projected charge.
// Reserve-at-admission inside a serialized DO method is what closes that.
// See docs/adr/0006-serialize-rate-and-spend-counters.md.

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { budgetSnapshot, guardBillable, readCap, readSpend } from "../../src/kagi/api/cost";
import { KagiBudgetExceededError } from "../../src/kagi/errors";

function capEnv(cents: string | undefined) {
  return { ...env, MAX_API_CENTS_PER_MONTH: cents } as typeof env;
}

function currentMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

// The spend counter is a single global DO instance and vitest-pool-workers'
// isolatedStorage does not roll back Durable Object SQL storage, so reservations
// would otherwise leak between tests and the suite would depend on declaration
// order. settleSpend clamps at zero, so a large negative delta is a reset.
beforeEach(async () => {
  await env.METER.get(env.METER.idFromName("spend")).settleSpend(currentMonth(), -1_000_000);
});

describe("readCap", () => {
  it("defaults to 0 — billable calls refuse until the operator opts in", () => {
    expect(readCap(capEnv(undefined))).toBe(0);
  });

  it("parses fractional cents", () => {
    expect(readCap(capEnv("12.5"))).toBe(12.5);
  });

  it("treats negatives and garbage as 0", () => {
    expect(readCap(capEnv("-5"))).toBe(0);
    expect(readCap(capEnv("nonsense"))).toBe(0);
  });
});

describe("guardBillable", () => {
  it("refuses everything when the cap is 0", async () => {
    await expect(guardBillable(capEnv("0"), 1)).rejects.toBeInstanceOf(KagiBudgetExceededError);
  });

  it("refuses when the cap is unset", async () => {
    await expect(guardBillable(capEnv(undefined), 1)).rejects.toBeInstanceOf(
      KagiBudgetExceededError,
    );
  });

  it("admits a call that fits under the cap", async () => {
    const e = capEnv("100");
    const guard = await guardBillable(e, 10);
    expect(guard).toHaveProperty("settle");
  });

  it("reserves at admission, before the call settles", async () => {
    // A reservation must be visible immediately — that is what stops a
    // concurrent caller from admitting against a stale total.
    const e = capEnv("100");
    await guardBillable(e, 30);

    expect(await readSpend(e)).toBe(30);
  });

  it("refuses once reservations would breach the cap", async () => {
    const e = capEnv("10");
    await guardBillable(e, 6);
    await expect(guardBillable(e, 6)).rejects.toBeInstanceOf(KagiBudgetExceededError);
  });

  it("admits a call that exactly reaches the cap", async () => {
    const e = capEnv("10");
    const guard = await guardBillable(e, 10);
    expect(guard).toHaveProperty("settle");
    expect(await readSpend(e)).toBe(10);
  });

  it("settling a lower actual cost refunds the difference", async () => {
    const e = capEnv("100");
    const guard = await guardBillable(e, 25);
    await guard.settle(10);

    expect(await readSpend(e)).toBe(10);
  });

  it("settling zero refunds the whole reservation", async () => {
    // /enrich is only billed on non-zero results.
    const e = capEnv("100");
    const guard = await guardBillable(e, 25);
    await guard.settle(0);

    expect(await readSpend(e)).toBe(0);
  });

  it("settling a higher actual cost charges the difference", async () => {
    const e = capEnv("100");
    const guard = await guardBillable(e, 5);
    await guard.settle(12);

    expect(await readSpend(e)).toBe(12);
  });

  it("never drives spend negative", async () => {
    const e = capEnv("100");
    const guard = await guardBillable(e, 5);
    await guard.settle(-999);

    expect(await readSpend(e)).toBe(0);
  });

  it("leaves the reservation in place if settle is never called", async () => {
    // Failing to settle must bias toward over-throttling, never under.
    const e = capEnv("100");
    await guardBillable(e, 40);

    expect(await readSpend(e)).toBe(40);
  });

  it("never admits past the cap under concurrent reservations", async () => {
    // The regression guard. Twenty callers each reserving 1 cent against a
    // 10 cent cap must yield exactly 10 admissions, not 20.
    const e = capEnv("10");

    const outcomes = await Promise.allSettled(
      Array.from({ length: 20 }, () => guardBillable(e, 1)),
    );

    const admitted = outcomes.filter((o) => o.status === "fulfilled");
    expect(admitted).toHaveLength(10);
    expect(await readSpend(e)).toBe(10);
  });
});

// ADR 0006 lists this as a risk and asserts the behavior, but until now nothing
// verified it: "if it is unreachable, billable calls must fail closed and
// refuse, never fall back to unmetered." The endpoint-level counterpart — that
// no billable request escapes the worker — lives in
// test/kagi/api/billable-fail-closed.test.ts.
describe("the Meter being unreachable", () => {
  const UNREACHABLE = "Durable Object unreachable";

  /** Every method rejects, as if the DO could not be reached at all. */
  function deadMeterEnv(cents: string) {
    const dead = async (): Promise<never> => {
      throw new Error(UNREACHABLE);
    };
    return {
      ...env,
      MAX_API_CENTS_PER_MONTH: cents,
      METER: {
        idFromName: (name: string) => name,
        get: () => ({ reserveSpend: dead, settleSpend: dead, spendSnapshot: dead }),
      },
    } as unknown as typeof env;
  }

  /**
   * Reserve reaches the real DO; settle does not. This is the realistic flake —
   * the Meter is there at admission and gone by the time the call comes back.
   */
  function settleFailsEnv(cents: string) {
    return {
      ...env,
      MAX_API_CENTS_PER_MONTH: cents,
      METER: {
        idFromName: (name: string) => env.METER.idFromName(name),
        get: (id: DurableObjectId) => {
          const real = env.METER.get(id);
          return {
            reserveSpend: (month: string, projected: number, cap: number) =>
              real.reserveSpend(month, projected, cap),
            spendSnapshot: (month: string) => real.spendSnapshot(month),
            settleSpend: async (): Promise<never> => {
              throw new Error(UNREACHABLE);
            },
          };
        },
      },
    } as unknown as typeof env;
  }

  it("refuses admission rather than letting an unmetered call through", async () => {
    await expect(guardBillable(deadMeterEnv("100"), 1)).rejects.toThrow(UNREACHABLE);
  });

  it("does not disguise the outage as a budget refusal", async () => {
    // "Budget exceeded" would send an operator to raise a cap that was fine.
    await expect(guardBillable(deadMeterEnv("100"), 1)).rejects.not.toBeInstanceOf(
      KagiBudgetExceededError,
    );
  });

  it("still refuses when the cap is 0 and the Meter is down", async () => {
    // Worth knowing: there is no local short-circuit for a 0 cap. readCap is
    // local, but the cap is passed INTO reserveSpend and the refusal is decided
    // inside the DO, so even the default deny-everything config pays the round
    // trip. With the Meter down the error is the transport failure rather than
    // KagiBudgetExceededError — different message, same refusal, which is all
    // the safety property requires.
    await expect(guardBillable(deadMeterEnv("0"), 1)).rejects.toThrow(UNREACHABLE);
  });

  it("keeps the reservation on the books when settle cannot reach the Meter", async () => {
    // A lost settle must bias toward over-throttling, never under. The money is
    // already spent upstream at this point; forgetting the reservation would
    // hand the next caller budget that no longer exists.
    const guard = await guardBillable(settleFailsEnv("100"), 30);
    await expect(guard.settle(0)).rejects.toThrow(UNREACHABLE);

    expect(await readSpend(capEnv("100"))).toBe(30);
  });

  it("budgetSnapshot rejects instead of reporting a reassuring zero", async () => {
    // Swallowing this would report spent_cents: 0 — full budget remaining —
    // at exactly the moment nobody can tell what has been spent.
    await expect(budgetSnapshot(deadMeterEnv("100"))).rejects.toThrow(UNREACHABLE);
  });
});

describe("budgetSnapshot", () => {
  it("reports cap, spend, and remaining for the current month", async () => {
    const e = capEnv("50");
    await guardBillable(e, 20);

    const snap = await budgetSnapshot(e);
    expect(snap.cap_cents).toBe(50);
    expect(snap.spent_cents).toBe(20);
    expect(snap.remaining_cents).toBe(30);
    expect(snap.month).toMatch(/^\d{4}-\d{2}$/);
  });

  it("clamps remaining at 0 rather than reporting a negative budget", async () => {
    const e = capEnv("0");
    const snap = await budgetSnapshot(e);
    expect(snap.remaining_cents).toBe(0);
  });
});
