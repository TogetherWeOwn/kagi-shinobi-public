import { describe, expect, it } from "vitest";
import { mcpError, mcpResult } from "../../src/mcp/result";

describe("mcpResult", () => {
  it("mirrors text into the content array", () => {
    const r = mcpResult({ text: "hello" });
    expect(r.content).toEqual([{ type: "text", text: "hello" }]);
    expect(r.structuredContent).toBeUndefined();
    expect(r.isError).toBeUndefined();
  });

  it("emits structuredContent when provided", () => {
    const r = mcpResult({ text: "ok", structured: { foo: 1 } });
    expect(r.structuredContent).toEqual({ foo: 1 });
  });

  // ADR 0010: mcpError is the only door to an error result. mcpResult cannot
  // produce one even when the payload looks like a failure, so a tool cannot
  // quietly invent a fourth shape the way kagi_summarizer did.
  it("never flags isError, whatever it is handed", () => {
    const r = mcpResult({ text: "Error: something went wrong", structured: { error_kind: "x" } });
    expect(r.isError).toBeUndefined();
  });
});

describe("mcpError", () => {
  it("produces a stable error_kind + message shape", () => {
    const r = mcpError({ kind: "auth", message: "token expired" });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({
      error_kind: "auth",
      message: "token expired",
    });
    expect(r.content[0].text).toContain("[auth]");
    expect(r.content[0].text).toContain("token expired");
  });

  it("merges optional detail into structuredContent", () => {
    const r = mcpError({
      kind: "budget_exceeded",
      message: "over cap",
      detail: { spent_cents: 200, cap_cents: 100 },
    });
    expect(r.structuredContent).toMatchObject({
      error_kind: "budget_exceeded",
      spent_cents: 200,
      cap_cents: 100,
    });
  });
});
