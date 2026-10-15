// Structured JSON logging.
//
// The shape matters more than it looks: these lines are what `wrangler tail`
// and the observability tab parse, so a level landing on the wrong console
// method or a field colliding with `level`/`msg` degrades production
// debugging silently.

import { afterEach, describe, expect, it, vi } from "vitest";
import { logError, logInfo, logWarn } from "../../src/util/log";

afterEach(() => {
  vi.restoreAllMocks();
});

/** Spy on one console method and return the parsed payload it received. */
function capture(method: "log" | "warn" | "error", emit: () => void): Record<string, unknown> {
  const spy = vi.spyOn(console, method).mockImplementation(() => {});
  emit();
  expect(spy).toHaveBeenCalledTimes(1);
  return JSON.parse(spy.mock.calls[0][0] as string) as Record<string, unknown>;
}

describe("log levels route to the matching console method", () => {
  it("sends info to console.log", () => {
    const payload = capture("log", () => logInfo("started"));

    expect(payload).toEqual({ level: "info", msg: "started" });
  });

  it("sends warn to console.warn", () => {
    const payload = capture("warn", () => logWarn("degraded"));

    expect(payload).toEqual({ level: "warn", msg: "degraded" });
  });

  it("sends error to console.error", () => {
    const payload = capture("error", () => logError("broke"));

    expect(payload).toEqual({ level: "error", msg: "broke" });
  });
});

describe("structured fields", () => {
  it("merges extra fields alongside level and msg", () => {
    const payload = capture("log", () => logInfo("request", { requestId: "abc-123", ms: 12 }));

    expect(payload).toEqual({ level: "info", msg: "request", requestId: "abc-123", ms: 12 });
  });

  it("emits a single line of valid JSON", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    logInfo("one line", { nested: { a: 1 } });

    const line = spy.mock.calls[0][0] as string;
    expect(line).not.toContain("\n");
    expect(() => JSON.parse(line)).not.toThrow();
  });

  it("lets a caller field override the reserved keys, rather than dropping it", () => {
    // Spread order puts fields last. Worth pinning so a caller passing
    // {msg: ...} sees a predictable result instead of a silent mystery.
    const payload = capture("log", () => logInfo("original", { msg: "overridden" }));

    expect(payload.msg).toBe("overridden");
  });
});
