// Exercise the real adapter's acquisition failure boundary without a browser.
import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshTokenViaBrowser } from "../../src/token/refresh";
import type { Env } from "../../src/env";
import { makeEnv } from "../_helpers";

const SENTINEL = "synthetic-browser-diagnostic";

function fixture(enabled: boolean) {
  const requests: { method: string; pathname: string }[] = [];
  const browser = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push({ method: request.method, pathname: new URL(request.url).pathname });
      return new Response(SENTINEL, { status: 503 });
    },
  };
  const env = makeEnv({
    AUTO_REFRESH_ENABLED: enabled ? "true" : "false",
    KAGI_EMAIL: "synthetic@example.test",
    KAGI_PASSWORD: "synthetic-password",
    BROWSER: browser as unknown as Env["BROWSER"],
  });
  return { env, requests };
}

afterEach(() => vi.unstubAllGlobals());

describe("browser refresh adapter contract", () => {
  it("fails closed when adapter acquisition is rejected", async () => {
    const network = vi.fn(async () => { throw new Error("unexpected network request"); });
    vi.stubGlobal("fetch", network);
    const { env, requests } = fixture(true);

    const result = await refreshTokenViaBrowser(env);

    expect(requests).toEqual([{ method: "POST", pathname: "/v1/devtools/browser" }]);
    expect(result).toEqual({ ok: false, reason: "refresh failed" });
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
    expect(env.TOKEN_KV.snapshot()).toEqual({});
    expect(network).not.toHaveBeenCalled();
  });

  it("does not acquire when refresh is disabled", async () => {
    const network = vi.fn(async () => { throw new Error("unexpected network request"); });
    vi.stubGlobal("fetch", network);
    const { env, requests } = fixture(false);

    const result = await refreshTokenViaBrowser(env);

    expect(result).toEqual({ ok: false, reason: "auto-refresh disabled" });
    expect(requests).toEqual([]);
    expect(env.TOKEN_KV.snapshot()).toEqual({});
    expect(network).not.toHaveBeenCalled();
  });
});
