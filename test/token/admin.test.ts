// POST /admin/token and POST /admin/refresh.
//
// routing.test.ts proves both routes are bearer-gated and exempt from rate
// limiting; this file covers what the handlers do once a request gets past the
// gate. src/token/refresh.js is mocked, which also keeps the
// @cloudflare/puppeteer import chain out of the Node project.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeEnv } from "../_helpers";

const { refreshTokenViaBrowser } = vi.hoisted(() => ({
  refreshTokenViaBrowser: vi.fn(),
}));
vi.mock("../../src/token/refresh.js", () => ({ refreshTokenViaBrowser }));

const { handleAdminToken, handleAdminRefresh } = await import("../../src/token/admin");
const { loadToken } = await import("../../src/token/store");

function post(body: unknown): Request {
  return new Request("https://worker.test/admin/token", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  refreshTokenViaBrowser.mockResolvedValue({ ok: true, token: "tok-new" });
});

describe("handleAdminToken", () => {
  it("rejects a body that is not JSON", async () => {
    const res = await handleAdminToken(post("{not json"), makeEnv());

    expect(res.status).toBe(400);
    expect((await json(res)).error).toMatchObject({ code: "invalid-json" });
  });

  it("rejects a body with no token field", async () => {
    const res = await handleAdminToken(post({}), makeEnv());

    expect(res.status).toBe(400);
    expect((await json(res)).error).toMatchObject({ code: "missing-token" });
  });

  it("rejects a non-string token", async () => {
    const res = await handleAdminToken(post({ token: 12345 }), makeEnv());

    expect(res.status).toBe(400);
    expect((await json(res)).error).toMatchObject({ code: "missing-token" });
  });

  it("rejects a whitespace-only token", async () => {
    const res = await handleAdminToken(post({ token: "   " }), makeEnv());

    expect(res.status).toBe(400);
    expect((await json(res)).error).toMatchObject({ code: "missing-token" });
  });

  it("rejects a null body", async () => {
    const res = await handleAdminToken(post(null), makeEnv());

    expect(res.status).toBe(400);
    expect((await json(res)).error).toMatchObject({ code: "missing-token" });
  });

  it("stores a valid token and reports the admin source", async () => {
    const env = makeEnv();

    const res = await handleAdminToken(post({ token: "sess-injected" }), env);

    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ ok: true, source: "admin" });
    const stored = await loadToken(env);
    expect(stored).toMatchObject({
      token: "sess-injected",
      source: "admin",
      stale: false,
    });
  });

  it("trims surrounding whitespace before storing", async () => {
    const env = makeEnv();

    await handleAdminToken(post({ token: "  sess-padded\n" }), env);

    expect((await loadToken(env))?.token).toBe("sess-padded");
  });

  it("stamps updatedAt so /health can report token age", async () => {
    const env = makeEnv();
    const before = Date.now();

    await handleAdminToken(post({ token: "sess-x" }), env);

    const stored = await loadToken(env);
    expect(stored?.updatedAt).toBeGreaterThanOrEqual(before);
  });

  it("overwrites a previously stored token", async () => {
    const env = makeEnv();

    await handleAdminToken(post({ token: "first" }), env);
    await handleAdminToken(post({ token: "second" }), env);

    expect((await loadToken(env))?.token).toBe("second");
  });
});

describe("handleAdminRefresh", () => {
  it("forces past a held lease — an operator must not queue behind an automatic run", async () => {
    const env = makeEnv();

    await handleAdminRefresh(post({}), env);

    expect(refreshTokenViaBrowser).toHaveBeenCalledWith(env, { force: true });
  });

  it("reports the browser-refresh source on success", async () => {
    const res = await handleAdminRefresh(post({}), makeEnv());

    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ ok: true, source: "browser-refresh" });
  });

  it("returns 503 with the reason when the refresh fails", async () => {
    refreshTokenViaBrowser.mockResolvedValue({ ok: false, reason: "BROWSER binding missing" });

    const res = await handleAdminRefresh(post({}), makeEnv());

    expect(res.status).toBe(503);
    expect((await json(res)).error).toMatchObject({
      code: "refresh-failed",
      message: "BROWSER binding missing",
    });
  });

  it("falls back to a generic message when the refresh gives no reason", async () => {
    refreshTokenViaBrowser.mockResolvedValue({ ok: false });

    const res = await handleAdminRefresh(post({}), makeEnv());

    expect(res.status).toBe(503);
    expect((await json(res)).error).toMatchObject({
      message: "unknown refresh error",
    });
  });
});
