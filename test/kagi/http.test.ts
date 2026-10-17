// The vocabulary contract from ADR 0012.
//
// A REST error.code is the MCP error_kind with a `kagi-` prefix and dashes for
// underscores — for EVERY kind, not for a sampled few. That total property is
// the whole point: a client, or a person, can convert between the two front
// doors without a lookup table. One special case would destroy it, and one
// special case (`parse` -> `kagi-parse-failed`) is exactly how the old
// hand-maintained mapping drifted.
//
// Status is likewise a total function of kind. Before ADR 0012 it was a
// function of the error *class*, which is why `new KagiError("upstream", ...)`
// and `new KagiUpstreamError(...)` disagreed — same code, 500 versus 502.

import { describe, expect, it } from "vitest";
import { KAGI_ERROR_KINDS, type KagiErrorKind } from "../../src/kagi/errors";
import { KAGI_ERROR_STATUS, restErrorCode } from "../../src/kagi/http";

describe("restErrorCode", () => {
  it.each([...KAGI_ERROR_KINDS])("derives the REST code for %s mechanically", (kind) => {
    expect(restErrorCode(kind)).toBe(`kagi-${kind.replaceAll("_", "-")}`);
  });

  // Guards the direction the drift actually went: a REST code that kept an
  // underscore would read as an MCP kind and silently mismatch.
  it("leaves no underscore in any REST code", () => {
    for (const kind of KAGI_ERROR_KINDS) {
      expect(restErrorCode(kind)).not.toContain("_");
    }
  });

  it("produces a distinct code for every kind", () => {
    const codes = KAGI_ERROR_KINDS.map(restErrorCode);

    expect(new Set(codes).size).toBe(KAGI_ERROR_KINDS.length);
  });
});

describe("KAGI_ERROR_STATUS", () => {
  // If a kind is ever added without a status this fails here as well as at
  // typecheck, so the gap is visible even to someone skimming test output.
  it("covers every kind with no gaps and no strays", () => {
    expect(Object.keys(KAGI_ERROR_STATUS).sort()).toEqual([...KAGI_ERROR_KINDS].sort());
  });

  it.each([
    ["auth", 401],
    ["captcha", 503],
    ["parse", 502],
    ["markup_changed", 502],
    ["upstream", 502],
    ["rate_limit", 429],
    ["budget_exceeded", 402],
    ["unsupported_in_mode", 400],
    ["confirm_required", 400],
    ["not_configured", 503],
    ["timeout", 504],
  ] as Array<[KagiErrorKind, number]>)("maps %s to %i", (kind, status) => {
    expect(KAGI_ERROR_STATUS[kind]).toBe(status);
  });

  it("uses only 4xx and 5xx statuses", () => {
    for (const status of Object.values(KAGI_ERROR_STATUS)) {
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(600);
    }
  });

  // The two conditions ADR 0012 moved off the old blanket 500. Pinned by name
  // so a future edit back to 500 reads as the regression it would be.
  it("gives captcha and timeout deliberate statuses rather than 500", () => {
    expect(KAGI_ERROR_STATUS.captcha).not.toBe(500);
    expect(KAGI_ERROR_STATUS.timeout).toBe(504);
  });
});
