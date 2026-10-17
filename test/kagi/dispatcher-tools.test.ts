// Facade dispatch for the tools that dispatcher.test.ts does not reach.
//
// dispatcher.test.ts pins search + summarize; this file pins the remaining
// seven methods on KagiClient — the api-only ones (extract, enrich*) and the
// both-impl ones (fastGPT, smallWeb, rank) — plus the two guards the facade
// enforces itself rather than delegating to capability.ts.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createKagiClient, KagiClient } from "../../src/kagi/client";
import { KagiScrapeClient } from "../../src/kagi/scrape/index";
import { KagiApiImpl } from "../../src/kagi/api/index";
import type { Env } from "../../src/env";

afterEach(() => {
  vi.restoreAllMocks();
});

function makeClient(mode: "scrape" | "api" | "hybrid") {
  const env = {
    ADMIN_TOKEN: "x",
    KAGI_MODE: mode,
    KAGI_SESSION_TOKEN: "s",
    KAGI_API_KEY: "k",
  } as Env;
  return new KagiClient(env);
}

/** Prototype seen as a plain method bag, so one helper can spy on any tool. */
type MethodBag = Record<string, (...args: never[]) => unknown>;

const scrapeProto = KagiScrapeClient.prototype as unknown as MethodBag;
const apiProto = KagiApiImpl.prototype as unknown as MethodBag;

/**
 * Stub one method on each impl prototype and hand back both spies. The scrape
 * impl deliberately has no extract/enrich* methods — those tools are api-only
 * in capability.ts — so the scrape spy is undefined for them.
 */
function spyPair(method: string) {
  const scrape =
    method in scrapeProto
      ? vi.spyOn(scrapeProto, method).mockImplementation(async () => ({ via: "scrape" }))
      : undefined;
  const api = vi
    .spyOn(apiProto, method)
    .mockImplementation(async () => ({ via: "api" }));
  return { scrape, api };
}

describe("createKagiClient", () => {
  it("builds a client with the mode resolved from env", () => {
    const client = createKagiClient({
      ADMIN_TOKEN: "x",
      KAGI_MODE: "hybrid",
      KAGI_SESSION_TOKEN: "s",
      KAGI_API_KEY: "k",
    } as Env);

    expect(client).toBeInstanceOf(KagiClient);
    expect(client.mode).toBe("hybrid");
  });
});

describe("mode exposure", () => {
  it("exposes the resolved mode and the reason behind it", () => {
    const client = makeClient("hybrid");

    expect(client.mode).toBe("hybrid");
    expect(client.modeInfo).toMatchObject({
      mode: "hybrid",
      reason: "KAGI_MODE=hybrid",
      has_session: true,
      has_api_key: true,
    });
  });
});

describe("fastGPT dispatch", () => {
  it("prefers the free scrape path in hybrid mode", async () => {
    const { scrape, api } = spyPair("fastGPT");

    await makeClient("hybrid").fastGPT({ query: "why" });

    expect(scrape).toHaveBeenCalledWith({ query: "why" });
    expect(api).not.toHaveBeenCalled();
  });

  it("honors an impl=api override and forwards the cache flag", async () => {
    const { scrape, api } = spyPair("fastGPT");

    await makeClient("hybrid").fastGPT({ query: "why", cache: false, impl: "api" });

    expect(api).toHaveBeenCalledWith({ query: "why", cache: false });
    expect(scrape).not.toHaveBeenCalled();
  });
});

describe("api-only tools", () => {
  it("extract always goes to the api impl", async () => {
    const { api } = spyPair("extract");

    await makeClient("hybrid").extract({ urls: ["https://a"], format: "markdown" });

    expect(api).toHaveBeenCalledWith({ urls: ["https://a"], format: "markdown" });
  });

  it("enrichWeb always goes to the api impl", async () => {
    const { api } = spyPair("enrichWeb");

    await makeClient("hybrid").enrichWeb({ q: "hi" });

    expect(api).toHaveBeenCalledWith({ q: "hi" });
  });

  it("enrichNews always goes to the api impl", async () => {
    const { api } = spyPair("enrichNews");

    await makeClient("hybrid").enrichNews({ q: "hi" });

    expect(api).toHaveBeenCalledWith({ q: "hi" });
  });

  it("extract is refused in scrape mode — no api impl is reachable", async () => {
    spyPair("extract");

    await expect(makeClient("scrape").extract({ urls: ["https://a"] })).rejects.toThrow(
      /not supported in mode='scrape'/,
    );
  });

  it("enrichWeb is refused in scrape mode", async () => {
    spyPair("enrichWeb");

    await expect(makeClient("scrape").enrichWeb({ q: "hi" })).rejects.toThrow(
      /not supported in mode='scrape'/,
    );
  });

  it("enrichNews is refused in scrape mode", async () => {
    spyPair("enrichNews");

    await expect(makeClient("scrape").enrichNews({ q: "hi" })).rejects.toThrow(
      /not supported in mode='scrape'/,
    );
  });
});

describe("summarize kind routing", () => {
  it("raw text is api-only even in a scrape-preferring hybrid", async () => {
    const { scrape, api } = spyPair("summarize");

    await makeClient("hybrid").summarize({
      kind: "text",
      ref: "a long passage",
      language: "EN",
      style: "summary",
    });

    expect(api).toHaveBeenCalledOnce();
    expect(scrape).not.toHaveBeenCalled();
  });

  it("raw text is refused outright in scrape mode", async () => {
    spyPair("summarize");

    await expect(
      makeClient("scrape").summarize({
        kind: "text",
        ref: "a long passage",
        language: "EN",
        style: "summary",
      }),
    ).rejects.toThrow(/not supported in mode='scrape'/);
  });

  it("forwards engine and confirm_muriel only on the api path", async () => {
    const { api } = spyPair("summarize");

    await makeClient("api").summarize({
      kind: "url",
      ref: "https://x",
      language: "EN",
      style: "takeaway",
      engine: "muriel",
      confirm_muriel: true,
    });

    expect(api).toHaveBeenCalledWith({
      kind: "url",
      ref: "https://x",
      language: "EN",
      style: "takeaway",
      engine: "muriel",
      confirm_muriel: true,
    });
  });
});

describe("smallWeb dispatch", () => {
  it("prefers the free RSS scrape path in hybrid mode", async () => {
    const { scrape, api } = spyPair("smallWeb");

    await makeClient("hybrid").smallWeb({ limit: 5 });

    expect(scrape).toHaveBeenCalledWith({ q: undefined, limit: 5 });
    expect(api).not.toHaveBeenCalled();
  });

  it("uses the billable api path when forced", async () => {
    const { scrape, api } = spyPair("smallWeb");

    await makeClient("hybrid").smallWeb({ q: "handmade", impl: "api" });

    expect(api).toHaveBeenCalledWith({ q: "handmade", limit: undefined });
    expect(scrape).not.toHaveBeenCalled();
  });
});

describe("rank dispatch", () => {
  it("prefers scrape in hybrid and passes urls plus the optional query", async () => {
    const { scrape, api } = spyPair("rank");

    await makeClient("hybrid").rank({ urls: ["https://a"], q: "widgets" });

    expect(scrape).toHaveBeenCalledWith({ urls: ["https://a"], q: "widgets" });
    expect(api).not.toHaveBeenCalled();
  });

  it("scrape-mode rank works without a query — the account IS the ruleset", async () => {
    const { scrape } = spyPair("rank");

    await makeClient("scrape").rank({ urls: ["https://a"] });

    expect(scrape).toHaveBeenCalledWith({ urls: ["https://a"], q: undefined });
  });

  it("api-mode rank requires q, because it is a stateless server-side run", async () => {
    const { api } = spyPair("rank");

    await expect(makeClient("api").rank({ urls: ["https://a"] })).rejects.toThrow(
      "api-mode rank requires q",
    );
    expect(api).not.toHaveBeenCalled();
  });

  it("api-mode rank forwards personalization rules once q is present", async () => {
    const { api } = spyPair("rank");
    const rules = [{ domain: "good.example", action: "raise" as const }];

    await makeClient("api").rank({ urls: ["https://a"], q: "widgets", rules });

    expect(api).toHaveBeenCalledWith({ urls: ["https://a"], q: "widgets", rules });
  });
});
