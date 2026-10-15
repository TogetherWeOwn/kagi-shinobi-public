// The fingerprint in src/kagi/headers.ts is one table, not three literals.
// These pin that the UA and both sec-ch-ua version slots agree — a bump that
// updates only half the table is the incoherence anti-bot systems flag.

import { describe, expect, it } from "vitest";
import {
  CHROME_UA,
  CHROME_VERSION,
  chromeHeaders,
} from "../../src/kagi/headers";

describe("Chrome fingerprint coherence", () => {
  it("UA carries the pinned major", () => {
    expect(CHROME_UA).toContain(`Chrome/${CHROME_VERSION}.0.0.0`);
  });

  it("sec-ch-ua brand versions match the UA major", () => {
    const headers = chromeHeaders() as Record<string, string>;
    const brands = headers["sec-ch-ua"];

    expect(brands).toContain(`"Chromium";v="${CHROME_VERSION}"`);
    expect(brands).toContain(`"Google Chrome";v="${CHROME_VERSION}"`);
    expect(brands).not.toContain("131");
  });

  it("the pinned major is a current stable, not a stale one", () => {
    // Bumping the table is a deliberate act (see the header comment in
    // headers.ts); this floors it so staleness fails loudly instead of
    // drifting. Raise alongside CHROME_VERSION — never lower to pass.
    expect(Number(CHROME_VERSION)).toBeGreaterThanOrEqual(154);
  });
});
