// Meter.takeKagiCall against the real Durable Object (ADR 0013). Each test
// uses its own instance name so counters cannot leak between cases.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

function meter(name: string) {
  return env.METER.get(env.METER.idFromName(name));
}

const T0 = Date.UTC(2026, 9, 1, 12, 0, 0); // 2026-10-01T12:00:00Z

describe("Meter.takeKagiCall", () => {
  it("refuses the third call inside one second at 2/s, then admits next second", async () => {
    const m = meter("kb-second");
    expect((await m.takeKagiCall(T0, 2, 0, 0)).ok).toBe(true);
    expect((await m.takeKagiCall(T0 + 100, 2, 0, 0)).ok).toBe(true);
    const refused = await m.takeKagiCall(T0 + 200, 2, 0, 0);
    expect(refused).toMatchObject({ ok: false, window: "second", count: 2, limit: 2 });
    expect(refused.retry_after_ms).toBe(800);
    expect((await m.takeKagiCall(T0 + 1_000, 2, 0, 0)).ok).toBe(true);
  });

  it("refuses past the day cap with retry until UTC midnight", async () => {
    const m = meter("kb-day");
    expect((await m.takeKagiCall(T0, 0, 1, 0)).ok).toBe(true);
    const refused = await m.takeKagiCall(T0 + 5_000, 0, 1, 0);
    expect(refused).toMatchObject({ ok: false, window: "day" });
    expect(refused.retry_after_ms).toBe(12 * 3_600_000 - 5_000);
    expect((await m.takeKagiCall(T0 + 12 * 3_600_000, 0, 1, 0)).ok).toBe(true);
  });

  it("refuses past the month cap until the 1st", async () => {
    const m = meter("kb-month");
    expect((await m.takeKagiCall(T0, 0, 0, 1)).ok).toBe(true);
    const refused = await m.takeKagiCall(T0, 0, 0, 1);
    expect(refused).toMatchObject({ ok: false, window: "month" });
    expect(refused.retry_after_ms).toBe(Date.UTC(2026, 10, 1) - T0);
  });

  it("a refusal consumes nothing in the other windows", async () => {
    const m = meter("kb-noconsume");
    expect((await m.takeKagiCall(T0, 1, 10, 0)).ok).toBe(true);
    // Refused on the second window; the day counter must stay at 1.
    for (let i = 0; i < 5; i++) expect((await m.takeKagiCall(T0, 1, 10, 0)).ok).toBe(false);
    for (let s = 1; s <= 9; s++) expect((await m.takeKagiCall(T0 + s * 1_000, 1, 10, 0)).ok).toBe(true);
    expect(await m.takeKagiCall(T0 + 10_000, 1, 10, 0)).toMatchObject({ ok: false, window: "day", count: 10 });
  });

  it("serializes concurrent callers (no under-count)", async () => {
    const m = meter("kb-concurrent");
    const verdicts = await Promise.all(Array.from({ length: 20 }, () => m.takeKagiCall(T0, 0, 5, 0)));
    expect(verdicts.filter((v) => v.ok)).toHaveLength(5);
  });

  it("all windows disabled admits", async () => {
    const m = meter("kb-off");
    for (let i = 0; i < 3; i++) expect((await m.takeKagiCall(T0, 0, 0, 0)).ok).toBe(true);
  });
});
