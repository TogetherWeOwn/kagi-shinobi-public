// The network half of src/kagi/search.ts. test/scrape/search-parser.test.ts
// covers parseSearchResults() against fixed HTML; this file covers everything
// around it — argument validation, the request the scraper actually sends, and
// the HTTP status → error taxonomy.

import { afterEach, describe, expect, it, vi } from "vitest";
import { search } from "../../src/kagi/search";
import { KagiAuthError, KagiUpstreamError } from "../../src/kagi/errors";
import { CHROME_VERSION } from "../../src/kagi/headers";
import { restoreFetch, stubFetch } from "../_helpers";

afterEach(() => {
  restoreFetch();
});

const TOKEN = "sess-abc";

const RESULT_BLOCK = `
  <div class="search-result">
    <div class="__sri-title">
      <a class="__sri_title_link" href="https://example.com/one">First Result</a>
    </div>
    <div class="__sri-desc">A snippet.</div>
  </div>`;

const HTML = `<!doctype html><html><body>${RESULT_BLOCK}</body></html>`;

function htmlFetch(body = HTML, status = 200) {
  return async () =>
    new Response(body, { status, statusText: status === 200 ? "OK" : "Bad" });
}

describe("search argument validation", () => {
  it("rejects an empty query", async () => {
    await expect(search("", TOKEN)).rejects.toThrow(/Search query is required/);
  });

  it("rejects a non-string query", async () => {
    await expect(search(7 as unknown as string, TOKEN)).rejects.toThrow(
      /Search query is required/,
    );
  });

  it("rejects a missing token", async () => {
    await expect(search("q", "")).rejects.toThrow(/Session token is required/);
  });

  it("rejects a non-string token", async () => {
    await expect(search("q", null as unknown as string)).rejects.toThrow(
      /Session token is required/,
    );
  });

  it("rejects a non-integer limit", async () => {
    await expect(search("q", TOKEN, 2.5)).rejects.toThrow(/Limit must be a positive integer/);
  });

  it("rejects a zero or negative limit", async () => {
    await expect(search("q", TOKEN, 0)).rejects.toThrow(/Limit must be a positive integer/);
  });

  it("validates before touching the network", async () => {
    const spy = vi.fn(htmlFetch());
    stubFetch(spy);

    await expect(search("q", TOKEN, -1)).rejects.toThrow();

    expect(spy).not.toHaveBeenCalled();
  });
});

describe("search request shape", () => {
  it("GETs /html/search with the query percent-encoded", async () => {
    const seen: { url?: string; headers?: Record<string, string> } = {};
    stubFetch(async (input, init) => {
      seen.url = String(input);
      seen.headers = init?.headers as Record<string, string>;
      return new Response(HTML);
    });

    await search("rust & c++", TOKEN);

    expect(seen.url).toBe("https://kagi.com/html/search?q=rust%20%26%20c%2B%2B");
    expect(seen.headers?.Cookie).toBe(`kagi_session=${TOKEN}`);
  });

  it("sends the document-navigation Chrome header set", async () => {
    const seen: { headers?: Record<string, string> } = {};
    stubFetch(async (_input, init) => {
      seen.headers = init?.headers as Record<string, string>;
      return new Response(HTML);
    });

    await search("q", TOKEN);

    // kind: "document" — the branch the XHR/form callers never take.
    expect(seen.headers?.["Sec-Fetch-Dest"]).toBe("document");
    expect(seen.headers?.["Sec-Fetch-Mode"]).toBe("navigate");
    expect(seen.headers?.["Sec-Fetch-Site"]).toBe("none");
    expect(seen.headers?.["Sec-Fetch-User"]).toBe("?1");
    expect(seen.headers?.["Upgrade-Insecure-Requests"]).toBe("1");
    expect(seen.headers?.["User-Agent"]).toContain(`Chrome/${CHROME_VERSION}`);
  });
});

describe("search response handling", () => {
  it("returns parsed results on 200", async () => {
    stubFetch(htmlFetch());

    const resp = await search("q", TOKEN);

    expect(resp.data).toEqual([
      {
        t: 0,
        url: "https://example.com/one",
        title: "First Result",
        snippet: "A snippet.",
      },
    ]);
  });

  it("honors the limit when trimming results", async () => {
    stubFetch(
      htmlFetch(`<!doctype html><html><body>${RESULT_BLOCK}${RESULT_BLOCK}</body></html>`),
    );

    const resp = await search("q", TOKEN, 1);

    expect(resp.data).toHaveLength(1);
  });

  it("maps 401 to KagiAuthError", async () => {
    stubFetch(htmlFetch("denied", 401));

    await expect(search("q", TOKEN)).rejects.toBeInstanceOf(KagiAuthError);
  });

  it("maps 403 to KagiAuthError", async () => {
    stubFetch(htmlFetch("denied", 403));

    await expect(search("q", TOKEN)).rejects.toBeInstanceOf(KagiAuthError);
  });

  it("maps any other non-2xx to KagiUpstreamError", async () => {
    stubFetch(htmlFetch("boom", 500));

    await expect(search("q", TOKEN)).rejects.toBeInstanceOf(KagiUpstreamError);
  });
});
