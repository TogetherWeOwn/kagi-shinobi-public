// The global browser-refresh lease, against the real Meter Durable Object.
//
// The lease exists because `inflight` in src/token/refresh.ts only coalesces
// refreshes within one isolate. A token rotation is invisible to other
// isolates for up to KV's propagation window, and every one of them that sees
// the lingering `stale: true` would otherwise launch its own Browser
// Rendering session — billable, slow, and bounded by a small per-account
// concurrent-browser limit.
//
// Runs in workerd because the assertion that matters is that concurrent
// callers cannot both take the lease, which needs the DO's real serialization.

import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const LEASE_MS = 60_000;
const NOW = 1_800_000_000_000;

/** A fresh DO instance per test — lease state is sticky by design. */
let seq = 0;
function leaseStub() {
  seq += 1;
  return env.METER.get(env.METER.idFromName(`refresh-test-${seq}`));
}

describe("tryRefreshLease", () => {
  it("grants the lease when nobody holds it", async () => {
    const verdict = await leaseStub().tryRefreshLease(NOW, LEASE_MS);

    expect(verdict.acquired).toBe(true);
    expect(verdict.retry_after_ms).toBe(0);
  });

  it("refuses a second caller inside the lease window", async () => {
    const stub = leaseStub();
    await stub.tryRefreshLease(NOW, LEASE_MS);

    const verdict = await stub.tryRefreshLease(NOW + 1_000, LEASE_MS);

    expect(verdict.acquired).toBe(false);
    expect(verdict.retry_after_ms).toBe(LEASE_MS - 1_000);
  });

  it("grants it again once the lease has expired", async () => {
    const stub = leaseStub();
    await stub.tryRefreshLease(NOW, LEASE_MS);

    const verdict = await stub.tryRefreshLease(NOW + LEASE_MS, LEASE_MS);

    expect(verdict.acquired).toBe(true);
  });

  it("lets an operator force past a held lease", async () => {
    const stub = leaseStub();
    await stub.tryRefreshLease(NOW, LEASE_MS);

    const forced = await stub.tryRefreshLease(NOW + 1_000, LEASE_MS, true);

    expect(forced.acquired).toBe(true);
  });

  it("extends the window when an operator forces, so others still back off", async () => {
    const stub = leaseStub();
    await stub.tryRefreshLease(NOW, LEASE_MS);
    await stub.tryRefreshLease(NOW + 1_000, LEASE_MS, true);

    // Would have been free at NOW + LEASE_MS had the forced call not extended it.
    const verdict = await stub.tryRefreshLease(NOW + LEASE_MS, LEASE_MS);

    expect(verdict.acquired).toBe(false);
  });

  // The whole point of putting this in a DO. A lost update here would let two
  // isolates each conclude they hold the lease and each launch a browser.
  it("grants the lease to exactly one of many concurrent callers", async () => {
    const stub = leaseStub();

    const verdicts = await Promise.all(
      Array.from({ length: 20 }, () => stub.tryRefreshLease(NOW, LEASE_MS)),
    );

    expect(verdicts.filter((v) => v.acquired)).toHaveLength(1);
  });

  it("keeps the lease held after a failed refresh, so failures do not stampede", async () => {
    // Nothing in the DO knows whether the refresh succeeded — taking the lease
    // is the commitment. This pins that: a caller that took the lease and then
    // failed still blocks the next caller for the full window.
    const stub = leaseStub();
    await stub.tryRefreshLease(NOW, LEASE_MS);

    const verdict = await stub.tryRefreshLease(NOW + LEASE_MS - 1, LEASE_MS);

    expect(verdict.acquired).toBe(false);
  });

  it("stores the lease in the DO, not in the calling isolate", async () => {
    const stub = leaseStub();
    await stub.tryRefreshLease(NOW, LEASE_MS);

    await runInDurableObject(stub, (_instance, state) => {
      const rows = [...state.storage.sql.exec("SELECT until FROM lease WHERE name = 'refresh'")];
      expect(Number(rows[0].until)).toBe(NOW + LEASE_MS);
    });
  });
});
