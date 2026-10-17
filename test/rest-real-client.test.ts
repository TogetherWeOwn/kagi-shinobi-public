// F1 regression: a raw upstream error body must not leak to REST callers.
//
// Unlike test/rest.test.ts, this file deliberately does NOT mock the
// KagiClient facade: the leak lives in the real API wrapper, which copies the
// first chars of an unsuccessful upstream body into the typed error that
// rest.ts then returns verbatim. A mocked facade throwing an untyped Error
// cannot reproduce it (that path is already genericized), so this test drives
// the real handleSummarize in api mode with only global fetch stubbed.

import { afterEach, describe, expect, it } from "vitest";
import { handleSummarize } from "../src/rest";
import { makeEnv, restoreFetch, stubFetch } from "./_helpers";

afterEach(() => {
  restoreFetch();
});

const MARKER = "synthetic-upstream-secret-9e2b";
const UPSTREAM_BODY = `${MARKER} /private/synthetic-path Error: stack-marker-9e2b`;

describe("handleSummarize with the real API wrapper (F1)", () => {
  it("answers 502 without any of the raw upstream error body in the response", async () => {
    stubFetch(
      async () =>
        new Response(UPSTREAM_BODY, {
          status: 502,
          headers: { "Content-Type": "text/plain" },
        }),
    );
    const env = makeEnv({
      KAGI_MODE: "api",
      KAGI_API_KEY: "synthetic-key",
      // Synthetic in-memory cap only; the checked-in cap stays "0".
      MAX_API_CENTS_PER_MONTH: "10000",
    });

    const res = await handleSummarize(
      new Request("https://worker.test/summarize", {
        method: "POST",
        body: JSON.stringify({ url: "https://example.test" }),
      }),
      env,
    );

    expect(res.status).toBe(502);
    const body = await res.text();
    expect(body).not.toContain(MARKER);
    expect(body).not.toContain("/private/synthetic-path");
    expect(body).not.toContain("stack-marker-9e2b");
  });
});
