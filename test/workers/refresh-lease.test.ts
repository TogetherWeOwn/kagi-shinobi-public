// refreshTokenViaBrowser's use of the global lease.
//
// The unit under test is the decision to launch a browser at all, not the
// Puppeteer login flow — so the BROWSER binding here is a stub that fails
// immediately. A test that reaches it has already proved the interesting
// part: the lease let it through.
//
// Runs in workerd because the lease lives in the Meter Durable Object.

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { refreshTokenViaBrowser } from "../../src/token/refresh";

const LEASE_MS = 60_000;

/** The one instance the production code addresses. */
function leaseStub() {
  return env.METER.get(env.METER.idFromName("refresh"));
}

/**
 * Free the lease. Forcing it to expire at epoch 0 is the reset — the same
 * trick the spend tests use, because DO SQL storage is not rolled back
 * between tests by isolatedStorage.
 */
beforeEach(async () => {
  await leaseStub().tryRefreshLease(0, 0, true);
});

/** Config that gets past the cheap guards and reaches the lease check. */
function refreshableEnv(overrides: Record<string, unknown> = {}) {
  return {
    ...env,
    AUTO_REFRESH_ENABLED: "true",
    KAGI_EMAIL: "operator@example.test",
    KAGI_PASSWORD: "not-a-real-password",
    BROWSER: {
      fetch: async () => {
        throw new Error("stub browser binding");
      },
    },
    ...overrides,
  } as unknown as typeof env;
}

describe("refreshTokenViaBrowser and the global lease", () => {
  it("does not touch the lease when auto-refresh is disabled", async () => {
    const result = await refreshTokenViaBrowser(refreshableEnv({ AUTO_REFRESH_ENABLED: "false" }));

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("auto-refresh disabled");

    // Still free — the cheap guards must run before the DO round-trip.
    const after = await leaseStub().tryRefreshLease(Date.now(), LEASE_MS);
    expect(after.acquired).toBe(true);
  });

  it("does not touch the lease when credentials are missing", async () => {
    const result = await refreshTokenViaBrowser(refreshableEnv({ KAGI_EMAIL: undefined }));

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("KAGI_EMAIL/KAGI_PASSWORD not set");

    const after = await leaseStub().tryRefreshLease(Date.now(), LEASE_MS);
    expect(after.acquired).toBe(true);
  });

  // The finding this whole change exists for: without the lease, every isolate
  // holding a superseded `stale: true` envelope launches its own browser.
  it("refuses to launch a browser while another isolate holds the lease", async () => {
    await leaseStub().tryRefreshLease(Date.now(), LEASE_MS, true);

    const result = await refreshTokenViaBrowser(refreshableEnv());

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/another refresh/i);
    // Not the browser's failure — we never got there.
    expect(result.reason).not.toMatch(/stub browser/);
  });

  it("takes the lease when it is free, so the next isolate backs off", async () => {
    const result = await refreshTokenViaBrowser(refreshableEnv());

    // Reached the browser stub, which is as far as this test cares.
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/refresh failed/i);

    const next = await leaseStub().tryRefreshLease(Date.now(), LEASE_MS);
    expect(next.acquired).toBe(false);
  });

  it("lets an operator's forced refresh through a held lease", async () => {
    await leaseStub().tryRefreshLease(Date.now(), LEASE_MS, true);

    const result = await refreshTokenViaBrowser(refreshableEnv(), { force: true });

    expect(result.reason).not.toMatch(/another refresh/i);
    expect(result.reason).toMatch(/refresh failed/i);
  });

  // Browser Rendering is billable, and ADR 0006 already established that the
  // protective counters fail closed. Losing the coordination point must not
  // silently re-enable the stampede it exists to prevent.
  it("fails closed when the Meter is unreachable", async () => {
    const brokenMeter = {
      idFromName: (name: string) => name,
      get: () => ({
        tryRefreshLease: async () => {
          throw new Error("Durable Object unreachable");
        },
      }),
    };

    const result = await refreshTokenViaBrowser(refreshableEnv({ METER: brokenMeter }));

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/coordinat/i);
    expect(result.reason).not.toMatch(/stub browser/);
  });
});
