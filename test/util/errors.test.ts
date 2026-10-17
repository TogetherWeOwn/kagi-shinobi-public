// Coverage for the JSON response helpers. Distinct from test/kagi/errors.ts,
// which covers the KagiError taxonomy — this file covers the wire shape every
// handler in src/rest.ts and src/index.ts returns.

import { describe, expect, it } from "vitest";
import { jsonError, jsonOk, type ErrorBody } from "../../src/util/errors";

describe("jsonOk", () => {
  it("defaults to 200 with a JSON content type", async () => {
    const res = jsonOk({ hello: "world" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(await res.json()).toEqual({ hello: "world" });
  });

  it("honors an explicit status override", () => {
    expect(jsonOk({ ok: true }, { status: 201 }).status).toBe(201);
  });

  it("merges extra headers without dropping the content type", () => {
    const res = jsonOk({ ok: true }, { headers: { "X-Trace": "abc" } });
    expect(res.headers.get("X-Trace")).toBe("abc");
    expect(res.headers.get("Content-Type")).toBe("application/json");
  });

  it("lets a caller override the content type deliberately", () => {
    const res = jsonOk("text", { headers: { "Content-Type": "text/plain" } });
    expect(res.headers.get("Content-Type")).toBe("text/plain");
  });

  it("serializes null without throwing", async () => {
    expect(await jsonOk(null).json()).toBeNull();
  });
});

describe("jsonError", () => {
  it("wraps code and message in the stable { error } envelope", async () => {
    const res = jsonError(404, "not-found", "POST /nope not routed");
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect((await res.json()) as ErrorBody).toEqual({
      error: { code: "not-found", message: "POST /nope not routed" },
    });
  });

  it("preserves the status it is given", () => {
    expect(jsonError(429, "rate-limited", "slow down").status).toBe(429);
    expect(jsonError(503, "refresh-failed", "browser down").status).toBe(503);
  });

  it("keeps code machine-readable even when the message is empty", async () => {
    const body = (await jsonError(400, "invalid-json", "").json()) as ErrorBody;
    expect(body.error.code).toBe("invalid-json");
    expect(body.error.message).toBe("");
  });

  // ADR 0012: the init argument exists so no error Response has to be built by
  // hand. src/index.ts's rate-limit branch was the one that had been.
  it("attaches a detail bag when given one", async () => {
    const res = jsonError(429, "kagi-rate-limit", "slow down", { detail: { retry_after: 30 } });
    const body = (await res.json()) as ErrorBody;

    expect(body.error.detail).toEqual({ retry_after: 30 });
  });

  it("omits detail rather than serializing an empty bag", async () => {
    const body = (await jsonError(401, "kagi-auth", "nope", { detail: {} }).json()) as ErrorBody;

    expect(body.error).not.toHaveProperty("detail");
    expect(body).toEqual({ error: { code: "kagi-auth", message: "nope" } });
  });

  it("omits detail when no init is passed at all", async () => {
    const body = (await jsonError(404, "not-found", "gone").json()) as ErrorBody;

    expect(body).toEqual({ error: { code: "not-found", message: "gone" } });
  });

  it("merges extra headers without dropping the content type", () => {
    const res = jsonError(429, "rate-limited", "60/60 requests this minute", {
      headers: {
        "Retry-After": "60",
        "X-RateLimit-Limit": "60",
        "X-RateLimit-Remaining": "0",
      },
    });

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(res.headers.get("X-RateLimit-Limit")).toBe("60");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(res.headers.get("Content-Type")).toBe("application/json");
  });
});
