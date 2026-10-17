// Refresh diagnostics must not reach MCP tool result envelopes.
//
// Unlike mcp-tools.test.ts, this file does NOT mock src/kagi/client.js: the
// agent is given a test env (via the same Object.defineProperty seam that
// file uses) so the real facade -> real scrape client -> real token store
// -> real browser refresh chain runs, and the typed error it throws is
// converted by the real MCP error envelope. Only @cloudflare/puppeteer, the
// raw upstream summarize call and the research stub are mocked; the
// coordination source is driven through a throwing Meter lease stub in the
// env itself.
//
// Acceptance: for each tainted source (coordination exception, scraped
// sign-in text, browser exception) the serialized MCP result — text and
// structured content — contains no synthetic marker fragment, across
// missing-token and long-stale states; error_kind stays "not_configured";
// the missing-credential hint stays actionable; a successful refresh still
// serves a summary.
//
// Runs in workerd: src/mcp.ts reaches agents/mcp.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeEnv } from "../_helpers";
import type { Env } from "../../src/env";
import type { ZodTypeAny } from "zod";

const { launch } = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock("@cloudflare/puppeteer", () => ({ default: { launch } }));

const raw = vi.hoisted(() => ({ summarize: vi.fn() }));
vi.mock("../../src/kagi/summarize.js", () => ({ summarize: raw.summarize }));

const { getResearchStub } = vi.hoisted(() => ({ getResearchStub: vi.fn() }));
vi.mock("../../src/research/run.js", () => ({ getResearchStub }));

const { KagiMcpAgent } = await import("../../src/mcp");
const { clearMemoryCache } = await import("../../src/token/store");

const SYNTH_PASSWORD = "synthetic-password-value-63d8";
const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;

const COORD_FRAGMENTS = [
  "coord-diagnostic-41f0",
  "synthetic-session-41f0",
  "/private/coord-41f0",
  "stack-41f0",
];
const LOGIN_FRAGMENTS = [
  "login-page-diagnostic-87c3",
  "synthetic-session-87c3",
  "/private/login-87c3",
  "stack-87c3",
];
const BROWSER_FRAGMENTS = [
  "browser-diagnostic-5d19",
  "synthetic-session-5d19",
  "/private/browser-5d19",
  "stack-5d19",
];

function markerText(fragments: string[]): string {
  return `${fragments[0]} session=${fragments[1]} at ${fragments[2]} Error: ${fragments[3]}`;
}

function expectClean(serialized: string, fragments: string[]) {
  for (const fragment of fragments) {
    expect(serialized).not.toContain(fragment);
  }
  expect(serialized).not.toContain(SYNTH_PASSWORD);
  expect(serialized).not.toContain("tok-seeded-stale");
}

function fakePage(overrides: { url?: string; evaluate?: () => Promise<unknown> } = {}) {
  return {
    setUserAgent: vi.fn().mockResolvedValue(undefined),
    setExtraHTTPHeaders: vi.fn().mockResolvedValue(undefined),
    goto: vi.fn().mockResolvedValue(undefined),
    waitForSelector: vi.fn().mockResolvedValue(undefined),
    type: vi.fn().mockResolvedValue(undefined),
    waitForNavigation: vi.fn().mockResolvedValue(undefined),
    click: vi.fn().mockResolvedValue(undefined),
    url: vi.fn().mockReturnValue(overrides.url ?? "https://kagi.com/"),
    evaluate: overrides.evaluate ?? vi.fn().mockResolvedValue(""),
    cookies: vi.fn().mockResolvedValue([{ name: "kagi_session", value: "tok-live" }]),
  };
}

function fakeBrowser(page: ReturnType<typeof fakePage>) {
  return {
    newPage: vi.fn().mockResolvedValue(page),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function brokenCoordinationMeter() {
  return {
    idFromName: (name: string) => name,
    get: (id: string) =>
      id === "refresh"
        ? {
            tryRefreshLease: async () => {
              throw new Error(markerText(COORD_FRAGMENTS));
            },
          }
        : { takeKagiCall: () => ({ ok: true, retry_after_ms: 0 }) },
  } as unknown as Env["METER"];
}

function refreshableEnv(overrides: Partial<Env> = {}) {
  return makeEnv({
    AUTO_REFRESH_ENABLED: "true",
    BROWSER: {} as Env["BROWSER"],
    KAGI_MODE: "scrape",
    KAGI_EMAIL: "operator@example.test",
    KAGI_PASSWORD: SYNTH_PASSWORD,
    ...overrides,
  });
}

type SourceName = "coordination" | "login-page" | "browser";

const SOURCES: Array<{ name: SourceName; fragments: string[] }> = [
  { name: "coordination", fragments: COORD_FRAGMENTS },
  { name: "login-page", fragments: LOGIN_FRAGMENTS },
  { name: "browser", fragments: BROWSER_FRAGMENTS },
];

function envForSource(source: SourceName) {
  if (source === "coordination") {
    return refreshableEnv({ METER: brokenCoordinationMeter() });
  }
  if (source === "browser") {
    launch.mockRejectedValue(new Error(markerText(BROWSER_FRAGMENTS)));
    return refreshableEnv();
  }
  const page = fakePage({
    url: "https://kagi.com/signin?error=1",
    evaluate: vi.fn().mockResolvedValue(markerText(LOGIN_FRAGMENTS)),
  });
  launch.mockResolvedValue(fakeBrowser(page));
  return refreshableEnv();
}

interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}
type Handler = (args: Record<string, unknown>) => Promise<McpToolResult>;

/** Build an agent on `agentEnv` and return its kagi_summarizer handler. */
async function summarizer(agentEnv: Env): Promise<Handler> {
  const tools = new Map<string, Handler>();
  const server = {
    tool: (
      name: string,
      _desc: string,
      _schema: Record<string, ZodTypeAny>,
      handler: Handler,
    ) => {
      tools.set(name, handler);
    },
    registerTool: (
      name: string,
      _config: { inputSchema: Record<string, ZodTypeAny> },
      handler: Handler,
    ) => {
      tools.set(name, handler);
    },
    resource: () => {},
    prompt: () => {},
  };

  const agent = Object.create(KagiMcpAgent.prototype) as {
    server: unknown;
    init: () => Promise<void>;
  };
  agent.server = server;
  Object.defineProperty(agent, "env", { value: agentEnv, configurable: true });
  Object.defineProperty(agent, "ctx", { value: { waitUntil: vi.fn() }, configurable: true });
  await agent.init();

  const handler = tools.get("kagi_summarizer");
  if (!handler) throw new Error("kagi_summarizer was not registered in scrape mode");
  return handler;
}

async function callSummarizer(agentEnv: Env): Promise<McpToolResult> {
  const handler = await summarizer(agentEnv);
  return handler({ url: "https://example.test/a" });
}

beforeEach(() => {
  vi.clearAllMocks();
  clearMemoryCache();
  raw.summarize.mockResolvedValue({ data: { output: "a summary" } });
  getResearchStub.mockReturnValue({});
});

describe("kagi_summarizer with no session token", () => {
  for (const { name, fragments } of SOURCES) {
    it(`returns a clean error envelope when refresh fails via ${name}`, async () => {
      const result = await callSummarizer(envForSource(name));

      expect(result.isError).toBe(true);
      expect(result.structuredContent?.error_kind).toBe("not_configured");
      expectClean(JSON.stringify(result), fragments);
    });
  }
});

describe("kagi_summarizer with a long-stale session token", () => {
  it("returns a clean error envelope when refresh cannot coordinate", async () => {
    const env = envForSource("coordination");
    const staleAt = Date.now() - TWELVE_HOURS_MS - 60_000;
    await env.TOKEN_KV.put(
      env.TOKEN_KV_KEY,
      JSON.stringify({
        token: "tok-seeded-stale",
        updatedAt: staleAt,
        source: "admin",
        stale: true,
        staleAt,
      }),
    );

    const result = await callSummarizer(env);

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.error_kind).toBe("not_configured");
    expectClean(JSON.stringify(result), COORD_FRAGMENTS);
  });
});

describe("controls that must keep passing", () => {
  it("keeps the missing-credential hint in the envelope message", async () => {
    const result = await callSummarizer(
      refreshableEnv({ KAGI_EMAIL: undefined as unknown as string }),
    );

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.error_kind).toBe("not_configured");
    expect(JSON.stringify(result)).toContain("KAGI_EMAIL/KAGI_PASSWORD not set");
    expect(JSON.stringify(result)).not.toContain(SYNTH_PASSWORD);
  });

  it("still serves a summary after a successful refresh", async () => {
    launch.mockResolvedValue(fakeBrowser(fakePage()));

    const result = await callSummarizer(refreshableEnv());

    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result)).toContain("a summary");
  });
});
