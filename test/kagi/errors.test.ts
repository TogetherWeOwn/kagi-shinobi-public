import { describe, expect, it } from "vitest";
import {
  KagiAuthError,
  KagiBudgetExceededError,
  KagiConfirmRequiredError,
  KagiError,
  KagiMarkupChangedError,
  KagiParseError,
  KagiRateLimitError,
  KagiUnsupportedInModeError,
  KagiUpstreamError,
} from "../../src/kagi/errors";

describe("KagiError taxonomy", () => {
  it("KagiAuthError.kind === 'auth'", () => {
    const e = new KagiAuthError();
    expect(e).toBeInstanceOf(KagiError);
    expect(e.kind).toBe("auth");
  });

  it("KagiUpstreamError carries status + status_text", () => {
    const e = new KagiUpstreamError(502, "Bad Gateway");
    expect(e.kind).toBe("upstream");
    expect(e.status).toBe(502);
    expect(e.detail.status).toBe(502);
    expect(e.detail.status_text).toBe("Bad Gateway");
  });

  it("KagiRateLimitError carries retry_after", () => {
    const e = new KagiRateLimitError(30);
    expect(e.kind).toBe("rate_limit");
    expect(e.detail.retry_after).toBe(30);
  });

  it("KagiBudgetExceededError carries spent + cap", () => {
    const e = new KagiBudgetExceededError(150, 100);
    expect(e.kind).toBe("budget_exceeded");
    expect(e.detail.spent_cents).toBe(150);
    expect(e.detail.cap_cents).toBe(100);
    expect(e.message).toContain("150¢");
    expect(e.message).toContain("100¢");
  });

  it("KagiUnsupportedInModeError names the tool + mode", () => {
    const e = new KagiUnsupportedInModeError("kagi_enrich_web", "scrape");
    expect(e.kind).toBe("unsupported_in_mode");
    expect(e.detail.tool).toBe("kagi_enrich_web");
    expect(e.detail.mode).toBe("scrape");
  });

  it("KagiConfirmRequiredError preserves detail", () => {
    const e = new KagiConfirmRequiredError("$1 flat rate", { cost_cents: 100 });
    expect(e.kind).toBe("confirm_required");
    expect(e.detail.cost_cents).toBe(100);
  });

  it("KagiParseError.kind === 'parse'", () => {
    const e = new KagiParseError("bad markup");
    expect(e.kind).toBe("parse");
  });

  it("KagiMarkupChangedError is a KagiParseError with kind 'markup_changed'", () => {
    // A subclass, not a sibling: existing `instanceof KagiParseError` guards
    // keep catching it, while the kind routes "fix the parser" separately.
    const e = new KagiMarkupChangedError("markup moved");
    expect(e).toBeInstanceOf(KagiError);
    expect(e).toBeInstanceOf(KagiParseError);
    expect(e.kind).toBe("markup_changed");
  });

  it("all subclasses are catchable as KagiError", () => {
    const es: KagiError[] = [
      new KagiAuthError(),
      new KagiUpstreamError(500, "x"),
      new KagiParseError("x"),
      new KagiRateLimitError(1),
      new KagiBudgetExceededError(1, 1),
      new KagiUnsupportedInModeError("x", "y"),
      new KagiConfirmRequiredError("x"),
    ];
    for (const e of es) expect(e).toBeInstanceOf(KagiError);
  });
});
