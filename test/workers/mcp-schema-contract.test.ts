// The wire contract: the JSON Schema an MCP client actually receives.
//
// mcp-tools.test.ts captures the *zod* shapes handed to server.tool(). That
// proves what we declared, not what a client is told. Between the two sits the
// SDK's zod->JSON Schema conversion, which branches on the zod major version
// (zod-json-schema-compat.js: zod-to-json-schema for v3, zod/v4-mini's
// toJSONSchema for v4). A zod or SDK upgrade can therefore change every tool's
// advertised schema without touching a line of our source.
//
// So this file drives a real McpServer over a real client connection and
// snapshots what comes back from tools/list and prompts/list. A dependency bump
// that reshapes the contract fails here instead of failing in someone's agent.
//
// Runs in workerd: `agents/mcp` reaches cloudflare:workers.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createKagiClient, getResearchStub } = vi.hoisted(() => ({
  createKagiClient: vi.fn(),
  getResearchStub: vi.fn(),
}));
vi.mock("../../src/kagi/client.js", () => ({ createKagiClient }));
vi.mock("../../src/research/run.js", () => ({ getResearchStub }));

const { KagiMcpAgent } = await import("../../src/mcp");

interface ToolDescriptor {
  name: string;
  inputSchema: unknown;
  outputSchema?: unknown;
}

/**
 * Register the agent's tools into a real McpServer and read them back through
 * a real client, which is the only way to see the post-conversion schema.
 *
 * Object.create skips the DO constructor (see mcp-tools.test.ts); `server` and
 * `env` are defined on the instance so they shadow the prototype's.
 */
async function connectAgent(
  mode: string,
  clientOverrides: Record<string, unknown> = {},
): Promise<Client> {
  createKagiClient.mockReturnValue({ mode, ...clientOverrides });

  const server = new McpServer({ name: "kagi-shinobi", version: "test" });
  const agent = Object.create(KagiMcpAgent.prototype) as {
    server: McpServer;
    init: () => Promise<void>;
  };
  agent.server = server;
  Object.defineProperty(agent, "env", { value: env, configurable: true });
  await agent.init();

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "contract-test", version: "test" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

/** tools/list, sorted by name so the snapshot does not track registration order. */
async function listTools(mode: string): Promise<ToolDescriptor[]> {
  const client = await connectAgent(mode);
  const { tools } = await client.listTools();
  return tools
    .map((tool) => ({
      name: tool.name,
      inputSchema: tool.inputSchema,
      // Only kagi_search_fetch publishes one (ADR 0013) — capturing it when
      // present keeps the published output contract under snapshot, while
      // tools without one keep their existing recorded shape untouched.
      ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Pull one tool's schema out of api mode, where every tool is registered. */
async function schemaFor(tool: string): Promise<Record<string, unknown>> {
  const tools = await listTools("api");
  const found = tools.find((t) => t.name === tool);
  if (!found) throw new Error(`tool ${tool} was not registered`);
  return found.inputSchema as Record<string, unknown>;
}

function propertyOf(schema: Record<string, unknown>, name: string): Record<string, unknown> {
  const properties = schema.properties as Record<string, Record<string, unknown>>;
  return properties[name];
}

/** Prompt message content is a union; narrow to the text arm before asserting. */
function promptText(content: { type: string }): string {
  if (content.type !== "text") throw new Error(`expected text content, got ${content.type}`);
  return (content as { type: "text"; text: string }).text;
}

beforeEach(() => {
  vi.clearAllMocks();
  getResearchStub.mockReturnValue({});
});

describe("advertised tool schemas", () => {
  // The full wire contract in api mode, which registers every tool. This is a
  // snapshot on purpose: the interesting failure is any unreviewed change.
  it("match the recorded wire contract in api mode", async () => {
    await expect(listTools("api")).resolves.toMatchSnapshot();
  });

  it("match the recorded wire contract in scrape mode", async () => {
    await expect(listTools("scrape")).resolves.toMatchSnapshot();
  });
});

// The properties below are the ones a schema conversion is most likely to drop
// silently. Each is asserted on its own so a failure names what was lost,
// rather than pointing at a 400-line snapshot diff.
describe("schema conversion preserves", () => {
  it("the fan-out ceiling on kagi_search_fetch.queries", async () => {
    const queries = propertyOf(await schemaFor("kagi_search_fetch"), "queries");

    expect(queries).toMatchObject({ type: "array", minItems: 1, maxItems: 20 });
  });

  it("the fan-out ceiling on kagi_personalized_rank.urls", async () => {
    const urls = propertyOf(await schemaFor("kagi_personalized_rank"), "urls");

    expect(urls).toMatchObject({ type: "array", minItems: 1, maxItems: 20 });
  });

  it("the fan-out ceiling on kagi_extract.urls", async () => {
    const urls = propertyOf(await schemaFor("kagi_extract"), "urls");

    expect(urls).toMatchObject({ type: "array", minItems: 1, maxItems: 10 });
  });

  it("numeric bounds", async () => {
    const timeout = propertyOf(await schemaFor("kagi_research_wait_for_run"), "timeout_seconds");

    expect(timeout).toMatchObject({ type: "integer", minimum: 1, maximum: 300 });
  });

  it("defaults", async () => {
    const summaryType = propertyOf(await schemaFor("kagi_summarizer"), "summary_type");

    expect(summaryType).toMatchObject({ default: "summary" });
  });

  it("enum members", async () => {
    const impl = propertyOf(await schemaFor("kagi_summarizer"), "impl");

    expect(impl).toMatchObject({ enum: ["scrape", "api"] });
  });

  it("descriptions", async () => {
    const budget = propertyOf(await schemaFor("kagi_research_create_run"), "budget_cents");

    expect(budget.description).toBe("Max API cents this run may spend. Default 0 (scrape-only).");
  });

  // ADR 0013: kagi_search_fetch publishes its slim structured shape so
  // clients can type the response. Only this tool publishes one — every other
  // tool must keep outputSchema absent.
  it("publishes the slim output schema on kagi_search_fetch and no other tool", async () => {
    const client = await connectAgent("api");
    const { tools } = await client.listTools();

    const search = tools.find((t) => t.name === "kagi_search_fetch");
    const output = search?.outputSchema as Record<string, unknown>;
    const properties = output.properties as Record<string, unknown>;
    expect(Object.keys(properties).sort()).toEqual([
      "dedup_dropped",
      "errors",
      "mode",
      "queries",
      "response_format",
    ]);

    for (const tool of tools) {
      if (tool.name === "kagi_search_fetch") continue;
      expect(tool.outputSchema, `${tool.name} should not publish an outputSchema`).toBeUndefined();
    }
  });

  it("advertises response_format on kagi_search_fetch", async () => {
    const format = propertyOf(await schemaFor("kagi_search_fetch"), "response_format");

    expect(format).toMatchObject({ type: "string", enum: ["concise", "detailed"] });
  });

  it("the required/optional split", async () => {
    const schema = await schemaFor("kagi_research_create_run");

    // question is the only field with neither .optional() nor .default().
    expect(schema.required).toEqual(["question"]);
  });

  it("string length bounds", async () => {
    const text = propertyOf(await schemaFor("kagi_summarize_text"), "text");

    expect(text).toMatchObject({ type: "string", minLength: 1, maxLength: 1_000_000 });
  });

  it("url formats", async () => {
    const url = propertyOf(await schemaFor("kagi_summarize_url"), "url");

    // zod v3 emits format: "uri"; zod v4 emits format: "uri" plus a pattern.
    // Either way the constraint must survive as *some* string format.
    expect(url).toMatchObject({ type: "string", format: "uri" });
  });
});

// Whether `additionalProperties: false` belongs in the advertised schema turns
// entirely on whether the server enforces it. zod's z.object *strips* unknown
// keys rather than rejecting them, and server.tool() only accepts a raw shape —
// the SDK wraps it in a plain z.object, never a strict one. So the constraint
// was never real. This measures that rather than assuming it.
describe("unknown arguments", () => {
  it("are accepted and stripped, not rejected", async () => {
    const summarize = vi.fn().mockResolvedValue({ summary: "the summary" });
    const client = await connectAgent("api", { summarize });

    const result = await client.callTool({
      name: "kagi_summarize_url",
      arguments: { url: "https://example.test/a", not_a_real_parameter: "ignored" },
    });

    expect(result.isError).toBeFalsy();
    // The handler ran, and the unknown key never reached the Kagi call.
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(summarize.mock.calls[0][0]).not.toHaveProperty("not_a_real_parameter");
  });
});

describe("advertised prompt arguments", () => {
  // deep_research_plan's budget_cents describes itself as an "Optional cap",
  // and its handler defends with `budget_cents ?? "0"`. Both are only true if
  // the schema says so.
  it("mark budget_cents optional, as its description and handler assume", async () => {
    const client = await connectAgent("api");
    const { prompts } = await client.listPrompts();

    const plan = prompts.find((prompt) => prompt.name === "deep_research_plan");
    const budget = plan?.arguments?.find((arg) => arg.name === "budget_cents");

    expect(budget?.required).toBe(false);
  });

  // The `budget_cents ?? "0"` fallback in prompts.ts was unreachable while the
  // argument was required. These two pin both sides of it now that it is not.
  it("let deep_research_plan be rendered without a budget", async () => {
    const client = await connectAgent("api");

    const { messages } = await client.getPrompt({
      name: "deep_research_plan",
      arguments: { question: "why is the sky blue" },
    });

    expect(promptText(messages[0].content)).toContain("Budget cap: 0 cents");
  });

  it("render the supplied budget when one is given", async () => {
    const client = await connectAgent("api");

    const { messages } = await client.getPrompt({
      name: "deep_research_plan",
      arguments: { question: "why is the sky blue", budget_cents: "25" },
    });

    expect(promptText(messages[0].content)).toContain("Budget cap: 25 cents");
  });

  it("match the recorded wire contract", async () => {
    const client = await connectAgent("api");
    const { prompts } = await client.listPrompts();

    const sorted = prompts
      .map((prompt) => ({ name: prompt.name, arguments: prompt.arguments }))
      .sort((a, b) => a.name.localeCompare(b.name));

    expect(sorted).toMatchSnapshot();
  });
});
