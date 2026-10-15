// Raw scrape summarizer (src/kagi/summarize.ts) — the kagi.com/mother/summary_labs
// session flow. Covers argument validation, the URL-vs-text request split, the
// HTTP error taxonomy, and the \x00-delimited streaming envelope parser.

import { afterEach, describe, expect, it, vi } from "vitest";
import { summarize } from "../../src/kagi/summarize";
import {
  KagiAuthError,
  KagiParseError,
  KagiUpstreamError,
} from "../../src/kagi/errors";
import { restoreFetch, stubFetch } from "../_helpers";

afterEach(() => {
  restoreFetch();
});

const TOKEN = "sess-abc";

/** Build a fake upstream that returns raw text (not the JSON envelope). */
function textFetch(body: string, status = 200) {
  return async () =>
    new Response(body, { status, statusText: status === 200 ? "OK" : "Boom" });
}

/** One well-formed streaming envelope terminated the way Kagi terminates it. */
function stream(payload: unknown, prefix = "final:"): string {
  return `\x00${prefix}${JSON.stringify(payload)}`;
}

describe("summarize argument validation", () => {
  it("rejects an empty input", async () => {
    await expect(summarize("", TOKEN)).rejects.toThrow(/Input is required/);
  });

  it("rejects a non-string input", async () => {
    await expect(summarize(42 as unknown as string, TOKEN)).rejects.toThrow(
      /Input is required/,
    );
  });

  it("rejects a missing token", async () => {
    await expect(summarize("hello", "")).rejects.toThrow(/Session token is required/);
  });

  it("rejects a non-string token", async () => {
    await expect(
      summarize("hello", {} as unknown as string),
    ).rejects.toThrow(/Session token is required/);
  });

  it("rejects a summary type outside summary|takeaway", async () => {
    await expect(
      summarize("hello", TOKEN, { type: "essay" as never }),
    ).rejects.toThrow(/Type must be 'summary' or 'takeaway'/);
  });

  it("rejects an unsupported language and names the supported set", async () => {
    await expect(
      summarize("hello", TOKEN, { language: "KLINGON" }),
    ).rejects.toThrow(/Unsupported language code 'KLINGON'[\s\S]*ZH-HANT/);
  });

  it("validates before touching the network", async () => {
    const spy = vi.fn(textFetch(stream({ md: "x" })));
    stubFetch(spy);

    await expect(summarize("", TOKEN)).rejects.toThrow();

    expect(spy).not.toHaveBeenCalled();
  });
});

describe("summarize request shape", () => {
  it("GETs /mother/summary_labs with query params when isUrl", async () => {
    const seen: { url?: string; method?: string; headers?: Record<string, string> } = {};
    stubFetch(async (input, init) => {
      seen.url = String(input);
      seen.method = init?.method;
      seen.headers = init?.headers as Record<string, string>;
      return new Response(stream({ output_data: { markdown: "# ok" } }));
    });

    await summarize("https://example.com/post", TOKEN, {
      isUrl: true,
      language: "DE",
      type: "takeaway",
    });

    const url = new URL(seen.url as string);
    expect(url.origin + url.pathname).toBe("https://kagi.com/mother/summary_labs");
    expect(seen.method).toBe("GET");
    expect(url.searchParams.get("url")).toBe("https://example.com/post");
    expect(url.searchParams.get("stream")).toBe("1");
    expect(url.searchParams.get("target_language")).toBe("DE");
    expect(url.searchParams.get("summary_type")).toBe("takeaway");
    expect(seen.headers?.Cookie).toBe(`kagi_session=${TOKEN}`);
    expect(seen.headers?.Accept).toBe("application/vnd.kagi.stream");
  });

  it("POSTs a urlencoded body to /mother/summary_labs/ for raw text", async () => {
    const seen: {
      url?: string;
      method?: string;
      body?: string;
      headers?: Record<string, string>;
    } = {};
    stubFetch(async (input, init) => {
      seen.url = String(input);
      seen.method = init?.method;
      seen.body = String(init?.body);
      seen.headers = init?.headers as Record<string, string>;
      return new Response(stream({ md: "ok" }));
    });

    await summarize("some long text", TOKEN);

    expect(seen.url).toBe("https://kagi.com/mother/summary_labs/");
    expect(seen.method).toBe("POST");
    const body = new URLSearchParams(seen.body as string);
    expect(body.get("text")).toBe("some long text");
    expect(body.get("stream")).toBe("1");
    expect(body.get("target_language")).toBe("EN");
    expect(body.get("summary_type")).toBe("summary");
    expect(seen.headers?.["Content-Type"]).toBe(
      "application/x-www-form-urlencoded;charset=UTF-8",
    );
  });
});

describe("summarize HTTP error mapping", () => {
  it("maps 401 to KagiAuthError", async () => {
    stubFetch(textFetch("nope", 401));

    await expect(summarize("hi", TOKEN)).rejects.toBeInstanceOf(KagiAuthError);
  });

  it("maps 403 to KagiAuthError", async () => {
    stubFetch(textFetch("nope", 403));

    await expect(summarize("hi", TOKEN)).rejects.toBeInstanceOf(KagiAuthError);
  });

  it("maps any other non-2xx to KagiUpstreamError", async () => {
    stubFetch(textFetch("nope", 503));

    await expect(summarize("hi", TOKEN)).rejects.toBeInstanceOf(KagiUpstreamError);
  });
});

describe("streaming envelope parser", () => {
  it("reads output_data.markdown from a final: message", async () => {
    stubFetch(textFetch(stream({ output_data: { markdown: "# Title" } })));

    const resp = await summarize("hi", TOKEN);

    expect(resp.data.output).toBe("# Title");
  });

  it("strips a new_message.json: prefix", async () => {
    stubFetch(textFetch(stream({ md: "plain" }, "new_message.json:")));

    const resp = await summarize("hi", TOKEN);

    expect(resp.data.output).toBe("plain");
  });

  it("falls back to md when output_data is absent", async () => {
    stubFetch(textFetch(stream({ md: "fallback" })));

    const resp = await summarize("hi", TOKEN);

    expect(resp.data.output).toBe("fallback");
  });

  it("returns an empty output when neither field is present", async () => {
    stubFetch(textFetch(stream({ unrelated: true })));

    const resp = await summarize("hi", TOKEN);

    expect(resp.data.output).toBe("");
  });

  it("uses the LAST message, not the first", async () => {
    const body = [
      "new_message.json:" + JSON.stringify({ md: "partial" }),
      "final:" + JSON.stringify({ md: "complete" }),
    ].join("\x00");
    stubFetch(textFetch(body));

    const resp = await summarize("hi", TOKEN);

    expect(resp.data.output).toBe("complete");
  });

  it("throws KagiParseError when the stream carries no messages", async () => {
    stubFetch(textFetch("   \x00  \x00 "));

    await expect(summarize("hi", TOKEN)).rejects.toThrow(
      new KagiParseError("No summary data received"),
    );
  });

  it("throws KagiParseError when the message is only a prefix", async () => {
    stubFetch(textFetch("\x00final:"));

    await expect(summarize("hi", TOKEN)).rejects.toThrow(
      new KagiParseError("Empty summary received"),
    );
  });

  it("throws KagiParseError on malformed JSON", async () => {
    stubFetch(textFetch("\x00final:{not-json"));

    await expect(summarize("hi", TOKEN)).rejects.toThrow(
      new KagiParseError("Failed to parse summary JSON response"),
    );
  });
});
