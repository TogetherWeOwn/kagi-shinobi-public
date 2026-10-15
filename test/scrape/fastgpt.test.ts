// Tests for the /stream_fastgpt SSE parser. Fixtures modeled on the
// EventSource frames the frontend consumes at kagi.com/fastgpt (per the
// k_fgpt.js bundle) — each `data:` line is a JSON-encoded string that is
// either "[DONE]", "[ERROR]", or the accumulated HTML answer content.
import { afterEach, describe, expect, it } from "vitest";
import {
  extractAnswerAndReferences,
  parseSseFinalPayload,
  scrapeFastGPT,
} from "../../src/kagi/scrape/fastgpt";
import {
  KagiAuthError,
  KagiCaptchaError,
  KagiParseError,
  KagiUpstreamError,
} from "../../src/kagi/errors";
import { fakeFetch, restoreFetch, stubFetch } from "../_helpers";

// Helper: build an SSE body from a list of JSON-encodable messages.
function sse(messages: unknown[]): string {
  return messages.map((m) => `data: ${JSON.stringify(m)}\n`).join("\n") + "\n";
}

afterEach(() => restoreFetch());

describe("parseSseFinalPayload", () => {
  it("returns the last non-sentinel payload before [DONE]", () => {
    const body = sse([
      "<p>Rust is</p>",
      "<p>Rust is a systems programming language.</p>",
      "[DONE]",
    ]);
    expect(parseSseFinalPayload(body)).toBe(
      "<p>Rust is a systems programming language.</p>",
    );
  });

  it("returns null when no non-sentinel payload arrived", () => {
    expect(parseSseFinalPayload(sse(["[DONE]"]))).toBeNull();
    expect(parseSseFinalPayload("")).toBeNull();
  });

  it("throws KagiUpstreamError on [ERROR]", () => {
    expect(() => parseSseFinalPayload(sse(["<p>partial</p>", "[ERROR]"]))).toThrow(
      KagiUpstreamError,
    );
  });

  it("throws KagiCaptchaError when a Turnstile challenge is served", () => {
    const body = sse([
      "<div class='cf-turnstile' data-sitekey='xxx'></div>",
    ]);
    expect(() => parseSseFinalPayload(body)).toThrow(KagiCaptchaError);
  });

  it("tolerates unparseable frames", () => {
    // A real stream sometimes injects `event: ping` / heartbeat frames
    // between JSON `data:` payloads. Those must not derail parsing.
    const body =
      `event: ping\ndata: keepalive\n\n` +
      `data: ${JSON.stringify("<p>hello</p>")}\n\n` +
      `data: "[DONE]"\n\n`;
    expect(parseSseFinalPayload(body)).toBe("<p>hello</p>");
  });
});

describe("extractAnswerAndReferences", () => {
  it("prefers an explicit .references section", () => {
    const html = `
      <div class="answer">
        <p>Rust is memory-safe because its ownership system enforces
           borrowing rules at compile time.</p>
      </div>
      <div class="references">
        <ol>
          <li><a href="https://rust-lang.org/">The Rust Programming Language</a></li>
          <li><a href="https://doc.rust-lang.org/nomicon/">Rustonomicon</a></li>
        </ol>
      </div>`;
    const out = extractAnswerAndReferences(html, "why is rust memory-safe?");
    expect(out.references).toHaveLength(2);
    expect(out.references[0].url).toBe("https://rust-lang.org/");
    expect(out.references[0].title).toBe("The Rust Programming Language");
    expect(out.answer).toContain("memory-safe");
  });

  it("falls back to inline citation markers (sup > a)", () => {
    const html = `
      <p>Cheetahs reach 70 mph<sup><a href="https://natgeo.example/cheetah">1</a></sup>
         and accelerate faster than a Porsche<sup><a href="https://autoweek.example/cheetah">2</a></sup>.</p>`;
    const out = extractAnswerAndReferences(html, "");
    expect(out.references).toHaveLength(2);
    expect(out.references[0].url).toBe("https://natgeo.example/cheetah");
    expect(out.references[1].url).toBe("https://autoweek.example/cheetah");
  });

  it("falls back to any external anchor if no citation markup is present", () => {
    const html = `
      <p>Vitest is a next-generation testing framework — see
         <a href="https://vitest.dev/">vitest.dev</a> and
         <a href="https://github.com/vitest-dev/vitest">the repo</a>.</p>`;
    const out = extractAnswerAndReferences(html, "");
    expect(out.references.map((r) => r.url)).toEqual([
      "https://vitest.dev/",
      "https://github.com/vitest-dev/vitest",
    ]);
  });

  it("skips kagi-internal links in the fallback pass", () => {
    const html = `
      <p>See <a href="https://kagi.com/settings">settings</a> and
         <a href="https://external.example/x">external</a>.</p>`;
    const out = extractAnswerAndReferences(html, "");
    expect(out.references).toHaveLength(1);
    expect(out.references[0].url).toBe("https://external.example/x");
  });

  it("de-duplicates repeated citation URLs", () => {
    const html = `
      <p>Fact one<sup><a href="https://src.example/a">1</a></sup>.</p>
      <p>Fact two<sup><a href="https://src.example/a">1</a></sup>.</p>`;
    const out = extractAnswerAndReferences(html, "");
    expect(out.references).toHaveLength(1);
  });

  it("returns a graceful placeholder when the answer is empty", () => {
    const out = extractAnswerAndReferences("", "moon phases");
    expect(out.answer).toContain("no answer text");
    expect(out.references).toHaveLength(0);
  });
});

describe("scrapeFastGPT end-to-end (mocked fetch)", () => {
  it("sends GET /stream_fastgpt with cookie + SSE Accept", async () => {
    const seen: { url?: string; method?: string; accept?: string; cookie?: string; referer?: string } = {};
    stubFetch(async (input, init) => {
      seen.url = String(input);
      seen.method = init?.method;
      const h = init?.headers as Record<string, string> | undefined;
      seen.accept = h?.["Accept"];
      seen.cookie = h?.["Cookie"];
      seen.referer = h?.["Referer"];
      const body = sse([
        `<div><p>A rocket engine burns fuel and oxidizer.</p>
          <div class="references"><ol>
            <li><a href="https://nasa.example/rockets">NASA — Rockets 101</a></li>
          </ol></div></div>`,
        "[DONE]",
      ]);
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    });
    const resp = await scrapeFastGPT({ query: "how does a rocket work?" }, "TOK");
    expect(seen.method ?? "GET").toBe("GET");
    expect(seen.url).toContain("https://kagi.com/stream_fastgpt");
    expect(seen.url).toContain("query=how+does+a+rocket+work");
    expect(seen.accept).toBe("text/event-stream");
    expect(seen.cookie).toBe("kagi_session=TOK");
    expect(seen.referer).toBe("https://kagi.com/fastgpt");
    expect(resp.query).toBe("how does a rocket work?");
    expect(resp.answer).toContain("rocket engine");
    expect(resp.references).toHaveLength(1);
    expect(resp.references[0].url).toBe("https://nasa.example/rockets");
    expect(resp.meta.impl).toBe("scrape");
  });

  it("throws KagiAuthError on 401", async () => {
    stubFetch(async () => new Response("Unauthorized", { status: 401 }));
    await expect(scrapeFastGPT({ query: "x" }, "TOK")).rejects.toBeInstanceOf(
      KagiAuthError,
    );
  });

  it("throws KagiParseError when the stream never yields a payload", async () => {
    stubFetch(fakeFetch("", { status: 200 }));
    // Not JSON, just empty body — no frames at all.
    await expect(scrapeFastGPT({ query: "x" }, "TOK")).rejects.toBeInstanceOf(
      KagiParseError,
    );
  });

  it("propagates [ERROR] as KagiUpstreamError", async () => {
    stubFetch(async () =>
      new Response(sse(["<p>partial</p>", "[ERROR]"]), { status: 200 }),
    );
    await expect(scrapeFastGPT({ query: "x" }, "TOK")).rejects.toBeInstanceOf(
      KagiUpstreamError,
    );
  });
});
