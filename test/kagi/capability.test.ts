import { describe, expect, it } from "vitest";
import {
  CAPABILITY_MATRIX,
  capabilityFor,
  isToolAvailable,
  pickImpl,
  supportsMode,
} from "../../src/kagi/capability";

describe("supportsMode", () => {
  it("both is reachable from every mode", () => {
    expect(supportsMode("both", "scrape")).toBe(true);
    expect(supportsMode("both", "api")).toBe(true);
    expect(supportsMode("both", "hybrid")).toBe(true);
  });

  it("scrape-only is unavailable in api mode", () => {
    expect(supportsMode("scrape", "scrape")).toBe(true);
    expect(supportsMode("scrape", "hybrid")).toBe(true);
    expect(supportsMode("scrape", "api")).toBe(false);
  });

  it("api-only is unavailable in scrape mode", () => {
    expect(supportsMode("api", "api")).toBe(true);
    expect(supportsMode("api", "hybrid")).toBe(true);
    expect(supportsMode("api", "scrape")).toBe(false);
  });

  it("none is never supported", () => {
    expect(supportsMode("none", "scrape")).toBe(false);
    expect(supportsMode("none", "api")).toBe(false);
    expect(supportsMode("none", "hybrid")).toBe(false);
  });
});

describe("capability matrix", () => {
  it("has no duplicate tool names", () => {
    const names = CAPABILITY_MATRIX.map((c) => c.tool);
    expect(new Set(names).size).toBe(names.length);
  });

  it("every entry has a sane cents value if billable", () => {
    for (const cap of CAPABILITY_MATRIX) {
      if (cap.api_billable && cap.support !== "scrape") {
        expect(cap.api_cents_per_call).toBeGreaterThan(0);
      }
    }
  });

  it("hybrid_prefer is always reachable given support", () => {
    for (const cap of CAPABILITY_MATRIX) {
      if (cap.support === "scrape") expect(cap.hybrid_prefer).toBe("scrape");
      if (cap.support === "api") expect(cap.hybrid_prefer).toBe("api");
    }
  });
});

describe("isToolAvailable", () => {
  it("scrape-only tools are hidden from api mode", () => {
    expect(isToolAvailable("kagi_list_lenses", "api")).toBe(false);
    expect(isToolAvailable("kagi_list_lenses", "scrape")).toBe(true);
    expect(isToolAvailable("kagi_list_lenses", "hybrid")).toBe(true);
  });

  it("api-only tools are hidden from scrape mode", () => {
    expect(isToolAvailable("kagi_extract", "scrape")).toBe(false);
    expect(isToolAvailable("kagi_extract", "api")).toBe(true);
    expect(isToolAvailable("kagi_extract", "hybrid")).toBe(true);
    expect(isToolAvailable("kagi_enrich_web", "scrape")).toBe(false);
    expect(isToolAvailable("kagi_enrich_news", "scrape")).toBe(false);
    expect(isToolAvailable("kagi_summarize_text", "scrape")).toBe(false);
  });

  it("both-impl tools are visible everywhere", () => {
    expect(isToolAvailable("kagi_search_fetch", "scrape")).toBe(true);
    expect(isToolAvailable("kagi_search_fetch", "api")).toBe(true);
    expect(isToolAvailable("kagi_search_fetch", "hybrid")).toBe(true);
  });

  it("returns false for unknown tools", () => {
    expect(isToolAvailable("nonesuch", "hybrid")).toBe(false);
  });
});

describe("pickImpl", () => {
  it("scrape mode routes both-tools to scrape", () => {
    expect(pickImpl("kagi_search_fetch", "scrape")).toBe("scrape");
    expect(pickImpl("kagi_summarizer", "scrape")).toBe("scrape");
  });

  it("api mode routes both-tools to api", () => {
    expect(pickImpl("kagi_search_fetch", "api")).toBe("api");
    expect(pickImpl("kagi_summarizer", "api")).toBe("api");
  });

  it("hybrid honors the tool's hybrid_prefer", () => {
    expect(pickImpl("kagi_search_fetch", "hybrid")).toBe("scrape");
    expect(pickImpl("kagi_summarize_text", "hybrid")).toBe("api");
    expect(pickImpl("kagi_extract", "hybrid")).toBe("api");
    expect(pickImpl("kagi_list_lenses", "hybrid")).toBe("scrape");
    // kagi_fastgpt flipped from api-only to "both" once the scrape impl
    // landed (GET /stream_fastgpt SSE). Hybrid prefers scrape now.
    expect(pickImpl("kagi_fastgpt", "hybrid")).toBe("scrape");
  });

  it("hybrid respects a caller-supplied impl override", () => {
    expect(pickImpl("kagi_search_fetch", "hybrid", "api")).toBe("api");
    expect(pickImpl("kagi_search_fetch", "hybrid", "scrape")).toBe("scrape");
  });

  it("refuses override when it contradicts the mode", () => {
    expect(() => pickImpl("kagi_search_fetch", "scrape", "api")).toThrow(
      /Cannot force impl='api' in mode='scrape'/,
    );
    expect(() => pickImpl("kagi_search_fetch", "api", "scrape")).toThrow(
      /Cannot force impl='scrape' in mode='api'/,
    );
  });

  it("refuses override on fixed-impl tools", () => {
    expect(() => pickImpl("kagi_extract", "hybrid", "scrape")).toThrow(
      /fixed impl='api'/,
    );
    expect(() => pickImpl("kagi_list_lenses", "hybrid", "api")).toThrow(
      /fixed impl='scrape'/,
    );
  });

  it("throws on unsupported tool", () => {
    expect(() => pickImpl("nonesuch", "hybrid")).toThrow(/Unknown tool/);
  });

  it("throws when picking an impl for a tool unavailable in the mode", () => {
    expect(() => pickImpl("kagi_extract", "scrape")).toThrow(/not supported/);
    expect(() => pickImpl("kagi_list_lenses", "api")).toThrow(/not supported/);
  });
});

describe("capabilityFor", () => {
  it("returns undefined for unknown tools", () => {
    expect(capabilityFor("nonesuch")).toBeUndefined();
  });
  it("returns the row for known tools", () => {
    const cap = capabilityFor("kagi_search_fetch");
    expect(cap?.support).toBe("both");
    expect(cap?.api_billable).toBe(true);
  });
});
