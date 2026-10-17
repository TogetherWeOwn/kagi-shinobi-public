// The worker, booted for real by `wrangler dev`, talked to over a socket.
//
// Scope rule (see playwright.config.ts): every assertion here must be one that
// an in-process test cannot make. Routing, the bearer gate, /health's privacy
// split and rate limiting are all pinned by test/workers/routing.test.ts
// against a hand-built env — do not restate them. What is only true of a real
// boot is that wrangler.jsonc's bindings and vars resolved, that the HTTP layer
// emits the headers we think it does, and that an MCP client can complete a
// Streamable-HTTP session against the Durable Object.
//
// NO TEST HERE MAY REACH KAGI. The worker under test holds no Kagi credential
// and the suite must not depend on the public internet, so every path
// exercised below stops inside the worker. The one tool call in this file is
// chosen precisely because its guard rejects before the client is invoked.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { expect, test } from "@playwright/test";
import type { ErrorBody } from "../../src/util/errors";
import { E2E_ADMIN_TOKEN, E2E_BASE_URL } from "./_config";

const auth = { Authorization: `Bearer ${E2E_ADMIN_TOKEN}` };

/** The authenticated /health body. Shape owned by src/token/admin.ts. */
interface HealthBody {
  ok: boolean;
  autoRefresh: boolean;
  token: string;
  buildSha: string;
}

test.describe("the worker boots from wrangler.jsonc and answers on a socket", () => {
  test("serves the landing page with its security headers", async ({ request }) => {
    // Arrange / Act
    const res = await request.get("/");

    // Assert — the headers are set in landing.ts but only a real response
    // proves the runtime emits them rather than stripping or renaming them.
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/html");
    expect(res.headers()["x-content-type-options"]).toBe("nosniff");
    expect(res.headers()["cache-control"]).toBe("public, max-age=300");
    expect(await res.text()).toContain("kagi-shinobi");
  });

  test("answers an anonymous /health probe with liveness only", async ({ request }) => {
    // This is also the readiness probe playwright.config.ts polls, so a
    // regression here fails the run as a boot timeout. Asserting it explicitly
    // turns that into a readable failure.
    const res = await request.get("/health");

    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("rejects an unauthenticated request over real HTTP", async ({ request }) => {
    // routing.test.ts proves the gate is wired in front of every route. This
    // proves it survives the real request path — header casing, the socket,
    // and whatever the runtime does between them.
    const res = await request.post("/search", { data: {} });
    const body = (await res.json()) as ErrorBody;

    expect(res.status()).toBe(401);
    expect(body.error.code).toBe("missing-bearer");
  });

  test("runs with the vars declared in wrangler.jsonc, not a synthetic env", async ({
    request,
  }) => {
    // AUTO_REFRESH_ENABLED="true" lives in wrangler.jsonc and nowhere else in
    // this run. Every in-process suite hands worker.fetch an env it built
    // itself, so this is the only assertion in the repo that the config file
    // is what the running worker actually sees.
    const res = await request.get("/health", { headers: auth });
    const body = (await res.json()) as HealthBody;

    expect(res.status()).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.autoRefresh).toBe(true);
    // Shape, not state: whether a token is present depends on what the
    // persisted store holds, which is not this file's business.
    expect(["ok", "stale", "missing"]).toContain(body.token);
    // `wrangler dev` serves wrangler.jsonc's vars verbatim, so this is the
    // committed default — a deploy through deploy.yml injects the tag SHA.
    expect(body.buildSha).toBe("dev");
  });
});

test.describe("a real MCP client completes a Streamable-HTTP session", () => {
  // The tools in scrape mode. mcp-tools.test.ts owns the *rule* that api-only
  // tools are hidden, driving it with a mode string it passes in. This owns the
  // *path*: KAGI_MODE="scrape" in wrangler.jsonc reaching the agent inside a
  // Durable Object, and the resulting list surviving the wire.
  //
  // There is no exported source of truth to import — gating is implicit in the
  // `this.server.tool(...)` calls in src/mcp.ts, guarded by the capability
  // checks that KagiMcpAgent.init() applies per mode. When this list fails,
  // re-derive it from there and from mcp-tools.test.ts's "hides the api-only
  // tools in scrape mode" case. Do not loosen the assertion to make it pass:
  // an exact set is the only version of this test that catches a tool
  // silently appearing or vanishing for real clients.
  const SCRAPE_MODE_TOOLS = [
    "kagi_fastgpt",
    "kagi_personalized_rank",
    "kagi_research_cancel_run",
    "kagi_research_create_run",
    "kagi_research_get_output",
    "kagi_research_wait_for_run",
    "kagi_search_fetch",
    "kagi_small_web",
    "kagi_summarize_url",
    "kagi_summarizer",
  ];

  let client: Client;

  test.beforeEach(async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${E2E_BASE_URL}/mcp`), {
      requestInit: { headers: auth },
    });
    client = new Client({ name: "kagi-shinobi-e2e", version: "0" });
    // connect() is the initialize handshake: it negotiates the protocol
    // version, takes the Mcp-Session-Id off the response, and sends
    // notifications/initialized. Nothing in-process exercises any of it —
    // mcp-schema-contract.test.ts uses an InMemoryTransport with no session.
    await client.connect(transport);
  });

  test.afterEach(async () => {
    await client.close();
  });

  test("identifies the server it handshook with", async () => {
    expect(client.getServerVersion()?.name).toBe("kagi-shinobi");
  });

  test("is advertised exactly the tools the shipped KAGI_MODE allows", async () => {
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual(SCRAPE_MODE_TOOLS);
  });

  test("gets the ADR 0010 error envelope back from a real tool call", async () => {
    // kagi_summarize_url rejects an unsupported target_language before it
    // touches the Kagi client (src/mcp.ts, isSupportedLanguage), which is why
    // this is the tool call the suite can afford to make: it drives DO ->
    // agent -> handler -> mcpError -> SSE -> client with no outbound request.
    //
    // Scope: the envelope's *contents* are already pinned in-process by
    // test/workers/mcp-tools.test.ts (exact message, exact rendered text) —
    // do not restate them here. What only this layer can show is that the
    // payload survives the trip: that `structuredContent` arrives as a live
    // object rather than a JSON string or null, and that the content block
    // survives SSE framing. That is the carve-out in ADR 0011: same condition,
    // different transport, because the transport is what is under test.
    // Passing CallToolResultSchema makes the client validate the response
    // through zod, so a malformed envelope fails here rather than at the first
    // property access. It does not narrow the *type*: callTool is declared as
    // returning `CallToolResult | {toolResult: unknown, [x:string]: unknown}`
    // — the legacy compatibility shape — and that union collapses `content` to
    // `unknown`. Passing the schema is what makes the compatibility branch
    // unreachable, so this single cast is true by construction. Do not replace
    // it with a hand-written shape: `content` is a discriminated union and only
    // its `type: "text"` member carries `.text`.
    const result = (await client.callTool(
      {
        name: "kagi_summarize_url",
        arguments: { url: "https://example.test/a", target_language: "xx" },
      },
      CallToolResultSchema,
    )) as CallToolResult;

    expect(result.isError).toBe(true);
    // Reached as a structured object, not a string that merely looks like one.
    expect(result.structuredContent).toBeInstanceOf(Object);
    expect(result.structuredContent?.error_kind).toBe("invalid_language");

    // Assert the block exists before reading it: destructuring an empty array
    // and dereferencing it reports a bare TypeError instead of naming the
    // actual problem.
    expect(result.content, "tool call returned no content blocks").not.toHaveLength(0);
    expect(result.content[0]?.type).toBe("text");
  });
});
