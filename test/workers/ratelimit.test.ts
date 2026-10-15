// Rate limiter, against the real Meter Durable Object.
//
// These run in workerd rather than Node deliberately. The whole point of
// moving the counter into a DO was atomicity, and atomicity cannot be
// demonstrated against an in-memory stub — the concurrency test below is the
// regression guard for the KV read-then-write bug described in
// docs/adr/0006-serialize-rate-and-spend-counters.md.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { checkAndIncrement, checkClientRate, readClientLimits, readLimit } from "../../src/util/ratelimit";

function rlEnv(rpm: string | undefined) {
  return { ...env, PER_BEARER_RPM: rpm } as typeof env;
}

describe("readLimit", () => {
  it("defaults to 60 when unset", () => {
    expect(readLimit(rlEnv(undefined))).toBe(60);
  });

  it("parses positive values", () => {
    expect(readLimit(rlEnv("5"))).toBe(5);
  });

  it("treats negatives and garbage as disabled", () => {
    expect(readLimit(rlEnv("-1"))).toBe(0);
    expect(readLimit(rlEnv("nonsense"))).toBe(0);
  });
});

describe("checkAndIncrement", () => {
  it("PER_BEARER_RPM=0 disables enforcement", async () => {
    const e = rlEnv("0");
    for (let i = 0; i < 50; i++) {
      expect((await checkAndIncrement(e, "disabled-bearer")).allowed).toBe(true);
    }
  });

  it("allows up to the limit then blocks", async () => {
    const e = rlEnv("3");
    const t = new Date(0);
    for (let i = 1; i <= 3; i++) {
      const r = await checkAndIncrement(e, "sequential-bearer", t);
      expect(r.allowed).toBe(true);
      expect(r.count).toBe(i);
    }
    const blocked = await checkAndIncrement(e, "sequential-bearer", t);
    expect(blocked.allowed).toBe(false);
    expect(blocked.limit_rpm).toBe(3);
  });

  it("reports a Retry-After within the current minute", async () => {
    const e = rlEnv("1");
    const t = new Date(30_000); // 30s into minute 0
    await checkAndIncrement(e, "retry-bearer", t);
    const blocked = await checkAndIncrement(e, "retry-bearer", t);

    expect(blocked.retry_after_seconds).toBe(30);
  });

  it("keys separately per bearer", async () => {
    const e = rlEnv("1");
    const t = new Date(0);
    expect((await checkAndIncrement(e, "alice", t)).allowed).toBe(true);
    expect((await checkAndIncrement(e, "bob", t)).allowed).toBe(true);
  });

  it("rolls over into the next minute bucket", async () => {
    const e = rlEnv("1");
    await checkAndIncrement(e, "rollover-bearer", new Date(0));
    const blocked = await checkAndIncrement(e, "rollover-bearer", new Date(30_000));
    const nextMinute = await checkAndIncrement(e, "rollover-bearer", new Date(60_000));

    expect(blocked.allowed).toBe(false);
    expect(nextMinute.allowed).toBe(true);
  });

  it("never admits more than the limit under concurrent calls", async () => {
    // The regression guard. Against the previous KV read-then-write these 20
    // calls all read the same counter value and all passed the check, so
    // roughly 20 were admitted against a limit of 5. A DO method that does
    // its read and write without awaiting in between cannot interleave.
    const e = rlEnv("5");
    const t = new Date(0);

    const results = await Promise.all(
      Array.from({ length: 20 }, () => checkAndIncrement(e, "concurrent-bearer", t)),
    );

    expect(results.filter((r) => r.allowed)).toHaveLength(5);
  });

  it("counts every concurrent admission exactly once", async () => {
    const e = rlEnv("100");
    const t = new Date(0);

    const results = await Promise.all(
      Array.from({ length: 25 }, () => checkAndIncrement(e, "counting-bearer", t)),
    );

    // Every call was admitted, and the counts form 1..25 with no duplicates —
    // a lost update would show up as a repeated count.
    const counts = results.map((r) => r.count).sort((a, b) => a - b);
    expect(counts).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
  });
});

describe("client-key limits (ADR 0013)", () => {
  it("readClientLimits defaults to both windows disabled, and treats garbage as disabled", () => {
    expect(readClientLimits({ ...env, CLIENT_KEY_RPM: undefined, CLIENT_KEY_RPD: undefined } as unknown as typeof env)).toEqual({ rpm: 0, rpd: 0 });
    expect(readClientLimits({ ...env, CLIENT_KEY_RPM: "x", CLIENT_KEY_RPD: "-3" } as typeof env)).toEqual({ rpm: 0, rpd: 0 });
  });

  it("both windows disabled admits everything", async () => {
    const e = { ...env, CLIENT_KEY_RPM: "0", CLIENT_KEY_RPD: "0" } as typeof env;
    for (let i = 0; i < 5; i++) expect((await checkClientRate(e, "rl-client-off")).allowed).toBe(true);
  });

  it("the minute window resets on the next minute", async () => {
    const e = { ...env, CLIENT_KEY_RPM: "1", CLIENT_KEY_RPD: "0" } as typeof env;
    expect((await checkClientRate(e, "rl-client-min", new Date(0))).allowed).toBe(true);
    expect((await checkClientRate(e, "rl-client-min", new Date(1_000))).allowed).toBe(false);
    expect((await checkClientRate(e, "rl-client-min", new Date(61_000))).allowed).toBe(true);
  });

  it("the day window reports seconds until UTC midnight", async () => {
    const e = { ...env, CLIENT_KEY_RPM: "0", CLIENT_KEY_RPD: "1" } as typeof env;
    const noonDay0 = new Date(43_200_000);
    await checkClientRate(e, "rl-client-day", noonDay0);
    const blocked = await checkClientRate(e, "rl-client-day", noonDay0);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retry_after_seconds).toBe(43_200);
  });
});
