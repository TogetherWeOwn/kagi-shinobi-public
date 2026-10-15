// MCP tool surface — registration matrix and handler behavior.
//
// KagiMcpAgent is a Durable Object, and its tool handlers are closures handed
// to an McpServer inside init(). Rather than stand up the DO, the prototype is
// instantiated directly and given a fake server that captures those closures,
// which the tests then call. That keeps the assertions on what the handlers do
// — formatting, error mapping, mode gating — instead of on the SDK's plumbing.
//
// Runs in workerd: `agents/mcp` reaches cloudflare:workers.

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ZodTypeAny } from "zod";
import {
  KagiAuthError,
  KagiBudgetExceededError,
  KagiConfirmRequiredError,
  KagiNotConfiguredError,
  KagiUnsupportedInModeError,
} from "../../src/kagi/errors";

const { createKagiClient, getResearchStub } = vi.hoisted(() => ({
  createKagiClient: vi.fn(),
  getResearchStub: vi.fn(),
}));
vi.mock("../../src/kagi/client.js", () => ({ createKagiClient }));
vi.mock("../../src/research/run.js", () => ({ getResearchStub }));

const { KagiMcpAgent } = await import("../../src/mcp");

interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}
type Handler = (args: Record<string, unknown>) => Promise<McpToolResult>;

function searchResponse(query: string, titles: string[]) {
  return {
    query,
    mode: "scrape",
    results: titles.map((title, i) => ({
      rank: i + 1,
      url: `https://example.test/${title.toLowerCase().replace(/\s+/g, "-")}`,
      title,
      snippet: `snippet for ${title}`,
      published_at: "2025-01-01",
      source_domain: "example.test",
      source_impl: "scrape" as const,
    })),
  };
}

function fakeClient(mode: string, overrides: Record<string, unknown> = {}) {
  return {
    mode,
    search: vi.fn().mockResolvedValue(searchResponse("q", ["A result"])),
    summarize: vi.fn().mockResolvedValue({ summary: "the summary" }),
    smallWeb: vi.fn().mockResolvedValue({ query: "", mode, results: [] }),
    fastGPT: vi.fn().mockResolvedValue({ answer: "the answer", references: [] }),
    extract: vi.fn().mockResolvedValue({ pages: [] }),
    enrichWeb: vi.fn().mockResolvedValue({ index: "teclis", results: [] }),
    enrichNews: vi.fn().mockResolvedValue({ index: "tinygem", results: [] }),
    rank: vi.fn().mockResolvedValue({ ranked: [] }),
    ...overrides,
  };
}

function researchStub(overrides: Record<string, unknown> = {}) {
  return {
    createRun: vi.fn().mockResolvedValue({ run_id: "run-1" }),
    waitForRun: vi.fn().mockResolvedValue({ run_id: "run-1", status: "running", cost_cents: 0 }),
    getOutput: vi
      .fn()
      .mockResolvedValue({ run_id: "run-1", status: "done", report_markdown: "# Report" }),
    cancelRun: vi.fn().mockResolvedValue({ cancelled: true }),
    ...overrides,
  };
}

/**
 * Build an agent whose init() has run, and hand back the captured handlers.
 * Object.create skips the DO constructor; `env` is defined on the instance so
 * it shadows whatever McpAgent exposes on the prototype.
 */
async function buildAgent(mode = "scrape", clientOverrides: Record<string, unknown> = {}) {
  const client = fakeClient(mode, clientOverrides);
  createKagiClient.mockReturnValue(client);

  const tools = new Map<string, Handler>();
  const schemas = new Map<string, Record<string, ZodTypeAny>>();
  const server = {
    tool: (
      name: string,
      _desc: string,
      schema: Record<string, ZodTypeAny>,
      handler: Handler,
    ) => {
      tools.set(name, handler);
      schemas.set(name, schema);
    },
    // kagi_search_fetch registers via server.registerTool() so its slim shape
    // is published as outputSchema (ADR 0013). The fake captures the handler
    // and the input schema the same way.
    registerTool: (
      name: string,
      config: { inputSchema: Record<string, ZodTypeAny> },
      handler: Handler,
    ) => {
      tools.set(name, handler);
      schemas.set(name, config.inputSchema);
    },
    resource: () => {},
    prompt: () => {},
  };

  const agent = Object.create(KagiMcpAgent.prototype) as {
    server: unknown;
    init: () => Promise<void>;
  };
  agent.server = server;
  Object.defineProperty(agent, "env", { value: env, configurable: true });
  const waitUntil = vi.fn();
  Object.defineProperty(agent, "ctx", { value: { waitUntil }, configurable: true });
  await agent.init();

  return { tools, schemas, client, waitUntil };
}

/** Run one registered tool and return its result envelope. */
async function call(
  tool: string,
  args: Record<string, unknown> = {},
  mode = "scrape",
  clientOverrides: Record<string, unknown> = {},
): Promise<McpToolResult> {
  const { tools } = await buildAgent(mode, clientOverrides);
  const handler = tools.get(tool);
  if (!handler) throw new Error(`tool ${tool} was not registered in mode=${mode}`);
  return handler(args);
}

function text(result: McpToolResult): string {
  return result.content[0].text;
}

beforeEach(() => {
  vi.clearAllMocks();
  getResearchStub.mockReturnValue(researchStub());
});

// tools/list is how a client discovers what it can call. Registering an
// api-only tool in scrape mode would advertise a call that can only ever fail.
describe("tool registration is gated by mode", () => {
  const ALWAYS = [
    "kagi_search_fetch",
    "kagi_summarizer",
    "kagi_small_web",
    "kagi_summarize_url",
    "kagi_fastgpt",
    "kagi_personalized_rank",
    "kagi_research_create_run",
    "kagi_research_wait_for_run",
    "kagi_research_get_output",
    "kagi_research_cancel_run",
  ];
  const API_ONLY = ["kagi_summarize_text", "kagi_extract", "kagi_enrich_web", "kagi_enrich_news"];

  it.each(["scrape", "api", "hybrid"])(
    "registers the always-available tools in %s mode",
    async (mode) => {
      const { tools } = await buildAgent(mode);

      for (const name of ALWAYS) {
        expect(tools.has(name), `${name} missing in ${mode}`).toBe(true);
      }
    },
  );

  it("hides the api-only tools in scrape mode", async () => {
    const { tools } = await buildAgent("scrape");

    for (const name of API_ONLY) {
      expect(tools.has(name), `${name} should be hidden in scrape`).toBe(false);
    }
  });

  it.each(["api", "hybrid"])("exposes the api-only tools in %s mode", async (mode) => {
    const { tools } = await buildAgent(mode);

    for (const name of API_ONLY) {
      expect(tools.has(name), `${name} missing in ${mode}`).toBe(true);
    }
  });
});

describe("kagi_search_fetch", () => {
  it("numbers results continuously across queries in detailed mode", async () => {
    const search = vi
      .fn()
      .mockResolvedValueOnce(searchResponse("first", ["One", "Two"]))
      .mockResolvedValueOnce(searchResponse("second", ["Three"]));

    const result = await call(
      "kagi_search_fetch",
      { queries: ["first", "second"], response_format: "detailed" },
      "scrape",
      { search },
    );

    expect(text(result)).toContain("1: One");
    expect(text(result)).toContain("2: Two");
    // Continues from the previous query rather than restarting at 1.
    expect(text(result)).toContain("3: Three");
  });

  // Concise is the default (ADR 0013): citation ids, no date filler line.
  it("defaults to concise citation ids without the published-date filler", async () => {
    const search = vi.fn().mockResolvedValueOnce(searchResponse("q", ["One", "Two"]));

    const result = await call("kagi_search_fetch", { queries: ["q"] }, "scrape", { search });

    expect(text(result)).toContain("[S1]");
    expect(text(result)).toContain("[S2]");
    expect(text(result)).not.toContain("Published Date");
    expect(result.structuredContent?.response_format).toBe("concise");
    expect(result.structuredContent?.dedup_dropped).toBe(0);
  });

  it("emits stable refs in the slim structured channel", async () => {
    const result = await call("kagi_search_fetch", { queries: ["q"] }, "scrape");

    const queries = result.structuredContent?.queries as Array<{
      results: Array<{ id: string; ref: string; url: string; rank: number }>;
    }>;
    expect(queries).toHaveLength(1);
    expect(queries[0].results[0]).toMatchObject({ id: "S1", rank: 1 });
    expect(queries[0].results[0].ref).toMatch(/^[0-9a-f]{10}$/);
    // Slim: no snippets ride along.
    expect(JSON.stringify(result.structuredContent)).not.toContain("snippet for");
  });

  it("dedupes a repeated url across queries and reports the drop", async () => {
    const dup = "https://example.test/same";
    const search = vi
      .fn()
      .mockResolvedValueOnce({
        query: "first",
        mode: "scrape",
        results: [
          {
            rank: 1,
            url: dup,
            title: "First seen",
            snippet: "s",
            source_domain: "example.test",
            source_impl: "scrape" as const,
          },
        ],
      })
      .mockResolvedValueOnce({
        query: "second",
        mode: "scrape",
        results: [
          {
            rank: 1,
            url: `${dup}?utm_source=x`,
            title: "Second seen",
            snippet: "s",
            source_domain: "example.test",
            source_impl: "scrape" as const,
          },
        ],
      });

    const result = await call("kagi_search_fetch", { queries: ["first", "second"] }, "scrape", {
      search,
    });

    expect(result.structuredContent?.dedup_dropped).toBe(1);
    expect(text(result)).not.toContain("[S2]");
  });

  it("defaults the per-query limit to 10", async () => {
    const search = vi.fn().mockResolvedValue(searchResponse("q", []));

    await call("kagi_search_fetch", { queries: ["q"] }, "scrape", { search });

    expect(search).toHaveBeenCalledWith(expect.objectContaining({ limit: 10 }));
  });

  it("passes an explicit limit through", async () => {
    const search = vi.fn().mockResolvedValue(searchResponse("q", []));

    await call("kagi_search_fetch", { queries: ["q"], limit: 25 }, "scrape", { search });

    expect(search).toHaveBeenCalledWith(expect.objectContaining({ limit: 25 }));
  });

  // allSettled, not all: a failing query is reported inline and the others
  // still come back.
  it("appends an error section for a failed query without dropping the rest", async () => {
    const search = vi
      .fn()
      .mockResolvedValueOnce(searchResponse("good", ["Fine"]))
      .mockRejectedValueOnce(new KagiAuthError("token expired"));

    const result = await call("kagi_search_fetch", { queries: ["good", "bad"] }, "scrape", {
      search,
    });

    expect(text(result)).toContain("[S1]");
    expect(text(result)).toContain("Fine");
    expect(text(result)).toContain("Errors encountered:");
    expect(text(result)).toContain('Query "bad": token expired');
    expect(result.structuredContent?.errors).toHaveLength(1);
    // Only the successful response survives into the structured channel.
    expect(result.structuredContent?.queries).toHaveLength(1);
  });

  it("reports the active mode in the structured channel", async () => {
    const result = await call("kagi_search_fetch", { queries: ["q"] }, "hybrid");

    expect(result.structuredContent?.mode).toBe("hybrid");
  });

  it("renders placeholders for a result missing a title or snippet in detailed mode", async () => {
    const search = vi.fn().mockResolvedValue({
      query: "q",
      mode: "scrape",
      results: [{ rank: 1, url: "https://example.test/x", title: "", snippet: "" }],
    });

    const result = await call(
      "kagi_search_fetch",
      { queries: ["q"], response_format: "detailed" },
      "scrape",
      { search },
    );

    expect(text(result)).toContain("No Title");
    expect(text(result)).toContain("Published Date: Not Available");
    expect(text(result)).toContain("No snippet available");
  });

  it("omits filler for a result missing a date or snippet in concise mode", async () => {
    const search = vi.fn().mockResolvedValue({
      query: "q",
      mode: "scrape",
      results: [
        {
          rank: 1,
          url: "https://example.test/x",
          title: "",
          snippet: "",
          source_domain: "example.test",
          source_impl: "scrape" as const,
        },
      ],
    });

    const result = await call("kagi_search_fetch", { queries: ["q"] }, "scrape", { search });

    expect(text(result)).toContain("[S1] No Title — example.test");
    expect(text(result)).not.toContain("Not Available");
  });

  it("stringifies a non-Error rejection", async () => {
    const search = vi.fn().mockRejectedValue("just a string");

    const result = await call("kagi_search_fetch", { queries: ["q"] }, "scrape", { search });

    expect(text(result)).toContain("just a string");
  });

  it("passes engine through to the facade", async () => {
    const search = vi.fn().mockResolvedValue(searchResponse("q", []));

    await call("kagi_search_fetch", { queries: ["q"], engine: "auto" }, "scrape", { search });

    expect(search).toHaveBeenCalledWith(expect.objectContaining({ engine: "auto" }));
  });

  it("leaves engine undefined when omitted, so the facade defaults to kagi", async () => {
    const search = vi.fn().mockResolvedValue(searchResponse("q", []));

    await call("kagi_search_fetch", { queries: ["q"] }, "scrape", { search });

    expect(search).toHaveBeenCalledWith(expect.objectContaining({ engine: undefined }));
  });
});

describe("kagi_summarizer", () => {
  it("returns the summary text", async () => {
    const result = await call("kagi_summarizer", { url: "https://example.test/a" });

    expect(text(result)).toBe("the summary");
  });

  it("defaults the language to EN", async () => {
    const { tools, client } = await buildAgent("scrape");
    await tools.get("kagi_summarizer")!({ url: "https://example.test/a" });

    expect(client.summarize).toHaveBeenCalledWith(expect.objectContaining({ language: "EN" }));
  });

  // This branch used to hand-roll its own result shape while the tool's own
  // catch block already used the mcpError envelope — so a caller parsed one
  // shape for a rejected language and another for an expired token. ADR 0010.
  it("rejects an unsupported target_language with the same envelope as every other tool", async () => {
    const result = await call("kagi_summarizer", {
      url: "https://example.test/a",
      target_language: "XX",
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.error_kind).toBe("invalid_language");
    // The field the hand-rolled shape dropped.
    expect(result.structuredContent?.message).toContain("unsupported target_language 'XX'");
    expect(result.structuredContent?.supported).toBeDefined();
    expect(text(result)).toBe("Error [invalid_language]: unsupported target_language 'XX'");
  });

  it("reports a rejected language and a failed call through the same shape", async () => {
    // The inconsistency ADR 0010 removes was internal to this one tool.
    const rejected = await call("kagi_summarizer", {
      url: "https://example.test/a",
      target_language: "XX",
    });
    const failed = await call("kagi_summarizer", { url: "https://example.test/a" }, "scrape", {
      summarize: vi.fn().mockRejectedValue(new KagiAuthError("token expired")),
    });

    for (const result of [rejected, failed]) {
      expect(result.isError).toBe(true);
      expect(typeof result.structuredContent?.error_kind).toBe("string");
      expect(typeof result.structuredContent?.message).toBe("string");
      expect(text(result)).toMatch(/^Error \[[a-z_]+\]: /);
    }
  });

  it("maps a client error onto the MCP error envelope", async () => {
    const result = await call("kagi_summarizer", { url: "https://example.test/a" }, "scrape", {
      summarize: vi.fn().mockRejectedValue(new KagiAuthError("token expired")),
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.error_kind).toBe("auth");
  });
});

describe("kagi_summarize_url", () => {
  it("rejects an unsupported target_language with the error envelope", async () => {
    const result = await call("kagi_summarize_url", {
      url: "https://example.test/a",
      target_language: "XX",
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.error_kind).toBe("invalid_language");
    expect(result.structuredContent?.supported).toBeDefined();
  });

  it("forwards the engine and the muriel confirmation", async () => {
    const { tools, client } = await buildAgent("scrape");

    await tools.get("kagi_summarize_url")!({
      url: "https://example.test/a",
      engine: "muriel",
      confirm_muriel: true,
      summary_type: "takeaway",
    });

    expect(client.summarize).toHaveBeenCalledWith(
      expect.objectContaining({ engine: "muriel", confirm_muriel: true, style: "takeaway" }),
    );
  });

  it("surfaces a confirmation requirement as confirm_required", async () => {
    const result = await call("kagi_summarize_url", { url: "https://example.test/a" }, "scrape", {
      summarize: vi
        .fn()
        .mockRejectedValue(new KagiConfirmRequiredError("muriel costs $1", { engine: "muriel" })),
    });

    expect(result.structuredContent?.error_kind).toBe("confirm_required");
    expect(result.structuredContent?.engine).toBe("muriel");
  });
});

describe("kagi_small_web", () => {
  it("says so plainly when the feed is empty", async () => {
    const result = await call("kagi_small_web", {});

    expect(text(result)).toBe("(no Small Web results)");
  });

  it("formats each post with its title and url", async () => {
    const result = await call("kagi_small_web", {}, "scrape", {
      smallWeb: vi.fn().mockResolvedValue(searchResponse("", ["A post"])),
    });

    expect(text(result)).toContain("1. A post");
    expect(text(result)).toContain("https://example.test/a-post");
  });
});

describe("kagi_fastgpt", () => {
  it("returns the bare answer when there are no references", async () => {
    const result = await call("kagi_fastgpt", { query: "why" });

    expect(text(result)).toBe("the answer");
    expect(text(result)).not.toContain("References:");
  });

  it("appends numbered references when present", async () => {
    const result = await call("kagi_fastgpt", { query: "why" }, "scrape", {
      fastGPT: vi.fn().mockResolvedValue({
        answer: "the answer",
        references: [{ title: "Source", url: "https://example.test/src" }],
      }),
    });

    expect(text(result)).toContain("References:");
    expect(text(result)).toContain("1. Source — https://example.test/src");
  });
});

describe("api-only tools", () => {
  it("kagi_extract labels each page with its url", async () => {
    const result = await call("kagi_extract", { urls: ["https://example.test/a"] }, "api", {
      extract: vi
        .fn()
        .mockResolvedValue({ pages: [{ url: "https://example.test/a", markdown: "# Body" }] }),
    });

    expect(text(result)).toContain("--- Page 1: https://example.test/a ---");
    expect(text(result)).toContain("# Body");
  });

  // "no charge" is the important half — enrich is billed only on non-zero
  // results, and the text says so.
  it("kagi_enrich_web notes that an empty result set is free", async () => {
    const result = await call("kagi_enrich_web", { q: "topic" }, "api");

    expect(text(result)).toBe("(no teclis results — no charge)");
  });

  it("kagi_enrich_news formats results with the published date", async () => {
    const result = await call("kagi_enrich_news", { q: "topic" }, "api", {
      enrichNews: vi.fn().mockResolvedValue({
        index: "tinygem",
        results: [
          {
            url: "https://news.example.test/a",
            title: "Headline",
            snippet: "body",
            published_at: "2025-02-02",
          },
        ],
      }),
    });

    expect(text(result)).toContain("1. Headline");
    expect(text(result)).toContain("2025-02-02");
  });

  it("kagi_summarize_text passes the raw text as a text-kind reference", async () => {
    const { tools, client } = await buildAgent("api");

    await tools.get("kagi_summarize_text")!({ text: "raw body", summary_type: "summary" });

    expect(client.summarize).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "text", ref: "raw body" }),
    );
  });
});

describe("kagi_personalized_rank", () => {
  it("formats each ranked url with its action and score", async () => {
    const result = await call(
      "kagi_personalized_rank",
      { urls: ["https://example.test/a"] },
      "scrape",
      {
        rank: vi.fn().mockResolvedValue({
          ranked: [
            { url: "https://example.test/a", action: "raise", score: 0.875, rationale: "on topic" },
          ],
        }),
      },
    );

    expect(text(result)).toBe("1. [raise] score=0.88 https://example.test/a — on topic");
  });

  it("omits the rationale when the impl does not supply one", async () => {
    const result = await call(
      "kagi_personalized_rank",
      { urls: ["https://example.test/a"] },
      "scrape",
      {
        rank: vi.fn().mockResolvedValue({
          ranked: [{ url: "https://example.test/a", action: "pin", score: 1 }],
        }),
      },
    );

    expect(text(result)).toBe("1. [pin] score=1.00 https://example.test/a");
  });
});

describe("the research trio", () => {
  it("create returns the run id and tells the caller how to poll", async () => {
    const result = await call("kagi_research_create_run", { question: "why" });

    expect(text(result)).toContain("Started run run-1");
    expect(text(result)).toContain("kagi_research_wait_for_run");
    expect(result.structuredContent?.run_id).toBe("run-1");
  });

  // budget_cents defaults to 0, which is what keeps a research run on the free
  // scrape path unless the caller opts in.
  it("create defaults to depth 1 and a zero budget", async () => {
    const stub = researchStub();
    getResearchStub.mockReturnValue(stub);

    await call("kagi_research_create_run", { question: "why" });

    expect(stub.createRun).toHaveBeenCalledWith(
      expect.objectContaining({ depth: 1, budget_cents: 0, allow_api: true }),
    );
  });

  it("wait reports the status and the spend so far", async () => {
    getResearchStub.mockReturnValue(
      researchStub({
        waitForRun: vi.fn().mockResolvedValue({ status: "running", cost_cents: 1.5 }),
      }),
    );

    const result = await call("kagi_research_wait_for_run", { run_id: "run-1" });

    expect(text(result)).toBe("Status: running (1.50¢ spent)");
  });

  it("wait reports an unknown run as not_found", async () => {
    getResearchStub.mockReturnValue(researchStub({ waitForRun: vi.fn().mockResolvedValue(null) }));

    const result = await call("kagi_research_wait_for_run", { run_id: "nope" });

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.error_kind).toBe("not_found");
  });

  it("output returns the report once the run is done", async () => {
    const result = await call("kagi_research_get_output", { run_id: "run-1" });

    expect(text(result)).toBe("# Report");
  });

  it("output reports the status instead while the run is unfinished", async () => {
    getResearchStub.mockReturnValue(
      researchStub({
        getOutput: vi.fn().mockResolvedValue({ status: "failed", error: "upstream died" }),
      }),
    );

    const result = await call("kagi_research_get_output", { run_id: "run-1" });

    expect(text(result)).toBe("Status: failed — upstream died");
  });

  it("output reports an unknown run as not_found", async () => {
    getResearchStub.mockReturnValue(researchStub({ getOutput: vi.fn().mockResolvedValue(null) }));

    const result = await call("kagi_research_get_output", { run_id: "nope" });

    expect(result.structuredContent?.error_kind).toBe("not_found");
  });

  it("cancel confirms a cancellation", async () => {
    const result = await call("kagi_research_cancel_run", { run_id: "run-1" });

    expect(text(result)).toBe("Cancelled.");
  });

  it("cancel distinguishes an already-terminal run", async () => {
    getResearchStub.mockReturnValue(
      researchStub({ cancelRun: vi.fn().mockResolvedValue({ cancelled: false }) }),
    );

    const result = await call("kagi_research_cancel_run", { run_id: "run-1" });

    expect(text(result)).toBe("Run was already terminal or not found.");
  });

  it("maps a thrown error from the research DO", async () => {
    getResearchStub.mockReturnValue(
      researchStub({ createRun: vi.fn().mockRejectedValue(new Error("DO unreachable")) }),
    );

    const result = await call("kagi_research_create_run", { question: "why" });

    expect(result.structuredContent?.error_kind).toBe("internal");
    expect(result.structuredContent?.message).toBe("DO unreachable");
  });
});

// The SDK validates tool input against the registered schema before the
// handler runs, so a fan-out ceiling declared here is the thing that actually
// enforces it — asserting on the handler would sail straight past the bound.
describe("fan-out ceilings are declared in the tool schemas", () => {
  async function schemaFor(tool: string, mode = "scrape") {
    const { schemas } = await buildAgent(mode);
    const schema = schemas.get(tool);
    if (!schema) throw new Error(`tool ${tool} was not registered in mode=${mode}`);
    return schema;
  }

  it("kagi_search_fetch accepts 20 queries and refuses 21", async () => {
    const schema = await schemaFor("kagi_search_fetch");

    expect(schema.queries.safeParse(Array(20).fill("q")).success).toBe(true);
    expect(schema.queries.safeParse(Array(21).fill("q")).success).toBe(false);
  });

  it("kagi_search_fetch still requires at least one query", async () => {
    const schema = await schemaFor("kagi_search_fetch");

    expect(schema.queries.safeParse([]).success).toBe(false);
  });

  // ADR 0013: response_format is optional and closed to the two known values.
  it("kagi_search_fetch accepts concise/detailed response_format and refuses anything else", async () => {
    const schema = await schemaFor("kagi_search_fetch");

    expect(schema.response_format.safeParse(undefined).success).toBe(true);
    expect(schema.response_format.safeParse("concise").success).toBe(true);
    expect(schema.response_format.safeParse("detailed").success).toBe(true);
    expect(schema.response_format.safeParse("verbose").success).toBe(false);
  });

  it("kagi_personalized_rank keeps its own 20-url ceiling", async () => {
    const schema = await schemaFor("kagi_personalized_rank");
    const urls = (n: number) => Array.from({ length: n }, (_, i) => `https://e.test/${i}`);

    expect(schema.urls.safeParse(urls(20)).success).toBe(true);
    expect(schema.urls.safeParse(urls(21)).success).toBe(false);
  });
});

// The mapping is proved against one tool below. This block proves every other
// handler is actually wrapped — an unguarded tool would reject the MCP call
// instead of returning a structured error the client can branch on.
describe("every tool wraps its failure in the MCP error envelope", () => {
  const boom = () => vi.fn().mockRejectedValue(new KagiAuthError());

  // kagi_search_fetch is deliberately absent: it settles each query
  // independently and reports per-query failures inside a normal result, so a
  // rejecting client never reaches its catch. That contract has its own test
  // ("appends an error section for a failed query without dropping the rest").
  it.each([
    [
      "kagi_summarizer",
      { url: "https://example.test/a" },
      "scrape",
      () => ({ summarize: boom() }),
    ],
    [
      "kagi_summarize_url",
      { url: "https://example.test/a" },
      "scrape",
      () => ({ summarize: boom() }),
    ],
    ["kagi_summarize_text", { text: "a passage" }, "api", () => ({ summarize: boom() })],
    ["kagi_small_web", {}, "scrape", () => ({ smallWeb: boom() })],
    [
      "kagi_personalized_rank",
      { urls: ["https://example.test/a"] },
      "scrape",
      () => ({ rank: boom() }),
    ],
    ["kagi_extract", { urls: ["https://example.test/a"] }, "api", () => ({ extract: boom() })],
    ["kagi_enrich_web", { q: "topic" }, "api", () => ({ enrichWeb: boom() })],
    ["kagi_enrich_news", { q: "topic" }, "api", () => ({ enrichNews: boom() })],
  ] as Array<[string, Record<string, unknown>, string, () => Record<string, unknown>]>)(
    "%s",
    async (tool, args, mode, overrides) => {
      const result = await call(tool, args, mode, overrides());

      expect(result.isError).toBe(true);
      expect(result.structuredContent?.error_kind).toBe("auth");
    },
  );
});

describe("kagi_summarize_text language validation", () => {
  it("refuses an unsupported target_language before spending anything", async () => {
    const summarize = vi.fn();

    const result = await call(
      "kagi_summarize_text",
      { text: "a passage", target_language: "KLINGON" },
      "api",
      { summarize },
    );

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.error_kind).toBe("invalid_language");
    expect(summarize).not.toHaveBeenCalled();
  });

  it("lists the supported codes so the caller can retry", async () => {
    const result = await call(
      "kagi_summarize_text",
      { text: "a passage", target_language: "KLINGON" },
      "api",
    );

    // mcpError spreads `detail` flat into structuredContent, so the supported
    // list sits alongside error_kind rather than nested under it.
    const supported = result.structuredContent?.supported as string[];
    expect(supported).toContain("EN");
    expect(supported).toContain("ZH-HANT");
  });

  it("defaults to EN when target_language is omitted", async () => {
    const summarize = vi.fn().mockResolvedValue({ summary: "s" });

    await call("kagi_summarize_text", { text: "a passage" }, "api", { summarize });

    expect(summarize).toHaveBeenCalledWith(expect.objectContaining({ language: "EN" }));
  });
});

describe("the research tools wrap Durable Object failures too", () => {
  it.each([
    ["kagi_research_create_run", { question: "why" }, "createRun"],
    ["kagi_research_wait_for_run", { run_id: "run-1", timeout_seconds: 1 }, "waitForRun"],
    ["kagi_research_get_output", { run_id: "run-1" }, "getOutput"],
    ["kagi_research_cancel_run", { run_id: "run-1" }, "cancelRun"],
  ])("%s", async (tool, args, method) => {
    getResearchStub.mockReturnValue(
      researchStub({ [method]: vi.fn().mockRejectedValue(new Error("DO unreachable")) }),
    );

    const result = await call(tool, args);

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.error_kind).toBe("internal");
  });
});

// The error_kind field is what an MCP client branches on, so the mapping is a
// contract in its own right.
describe("kagiErrorMcp", () => {
  it.each([
    [new KagiNotConfiguredError("no token"), "not_configured"],
    [new KagiUnsupportedInModeError("kagi_extract", "scrape"), "unsupported_in_mode"],
    [new KagiAuthError(), "auth"],
    [new KagiBudgetExceededError(1, 0), "budget_exceeded"],
    [new Error("something else"), "internal"],
  ])("maps %s", async (err, kind) => {
    const result = await call("kagi_fastgpt", { query: "q" }, "scrape", {
      fastGPT: vi.fn().mockRejectedValue(err),
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.error_kind).toBe(kind);
  });

  it("carries the detail payload through for a typed error", async () => {
    const result = await call("kagi_fastgpt", { query: "q" }, "scrape", {
      fastGPT: vi.fn().mockRejectedValue(new KagiUnsupportedInModeError("kagi_extract", "scrape")),
    });

    expect(result.structuredContent).toMatchObject({ tool: "kagi_extract", mode: "scrape" });
  });

  it("stringifies a thrown non-Error", async () => {
    const result = await call("kagi_fastgpt", { query: "q" }, "scrape", {
      fastGPT: vi.fn().mockRejectedValue("a bare string"),
    });

    expect(result.structuredContent?.message).toBe("a bare string");
  });

  // ADR 0012 deleted three per-class branches in kagiErrorMcp on the claim they
  // were byte-identical to the generic KagiError fallback. These pin the whole
  // envelope for exactly those three classes, and were written and run GREEN
  // against the branches still in place — so if the claim had been wrong, the
  // deletion would have turned them red. That is the measurement, not the
  // argument. Do not relax them to toMatchObject.
  it.each([
    [
      new KagiConfirmRequiredError("say please", { engine: "muriel" }),
      {
        error_kind: "confirm_required",
        message: "say please",
        engine: "muriel",
      },
    ],
    [
      new KagiUnsupportedInModeError("kagi_extract", "scrape"),
      {
        error_kind: "unsupported_in_mode",
        message: "Tool 'kagi_extract' is not available in mode='scrape'",
        tool: "kagi_extract",
        mode: "scrape",
      },
    ],
    [
      new KagiNotConfiguredError("no API key"),
      { error_kind: "not_configured", message: "no API key" },
    ],
  ])("derives the whole envelope from kind and detail for %s", async (err, structured) => {
    const result = await call("kagi_fastgpt", { query: "q" }, "scrape", {
      fastGPT: vi.fn().mockRejectedValue(err),
    });

    expect(result).toEqual({
      content: [{ type: "text", text: `Error [${structured.error_kind}]: ${structured.message}` }],
      structuredContent: structured,
      isError: true,
    });
  });
});

// ADR 0017: the five cached tools accept max_age_s and forward it, and the
// cache's background work rides the Durable Object's waitUntil.
describe("result cache wiring", () => {
  it.each([
    ["kagi_search_fetch", { queries: ["q"] }, "search"],
    ["kagi_summarizer", { url: "https://example.test" }, "summarize"],
    ["kagi_summarize_url", { url: "https://example.test" }, "summarize"],
    ["kagi_summarize_text", { text: "some text" }, "summarize"],
    ["kagi_fastgpt", { query: "q" }, "fastGPT"],
  ])("%s forwards max_age_s to the client", async (tool, args, method) => {
    const { tools, client } = await buildAgent("hybrid");

    await tools.get(tool)!({ ...args, max_age_s: 0 });

    expect(client[method as keyof typeof client]).toHaveBeenCalledWith(
      expect.objectContaining({ max_age_s: 0 }),
    );
  });

  it("builds the client with the agent's waitUntil", async () => {
    const { waitUntil } = await buildAgent();
    const opts = createKagiClient.mock.calls.at(-1)![1] as {
      waitUntil: (p: Promise<unknown>) => void;
    };
    const work = Promise.resolve();

    opts.waitUntil(work);

    expect(waitUntil).toHaveBeenCalledWith(work);
  });
});
