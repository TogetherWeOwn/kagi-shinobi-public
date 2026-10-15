// Coverage for the bearer gate. This is the single control standing between
// the public internet and every billable/privileged route in src/index.ts,
// so the error *codes* are asserted too — callers key off them, and a silent
// code change is a contract break.

import { describe, expect, it } from "vitest";
import {
  authenticate,
  isClientScopedPath,
  parseClientKeys,
  requireBearer,
  sha256Hex,
} from "../../src/util/auth";
import { makeEnv } from "../_helpers";

/** Build a Request carrying an arbitrary Authorization header. */
function req(authorization?: string): Request {
  return new Request("https://example.com/search", {
    method: "POST",
    headers: authorization ? { Authorization: authorization } : {},
  });
}

async function bodyOf(res: Response): Promise<{ error: { code: string; message: string } }> {
  return (await res.json()) as { error: { code: string; message: string } };
}

describe("requireBearer — accepts", () => {
  it("returns null (pass) when the token matches exactly", () => {
    const env = makeEnv({ ADMIN_TOKEN: "s3cret" });
    expect(requireBearer(req("Bearer s3cret"), env)).toBeNull();
  });

  it("tolerates surrounding whitespace on the token", () => {
    const env = makeEnv({ ADMIN_TOKEN: "s3cret" });
    expect(requireBearer(req("Bearer   s3cret  "), env)).toBeNull();
  });
});

describe("requireBearer — rejects", () => {
  it("401 missing-bearer when the Authorization header is absent", async () => {
    const res = requireBearer(req(), makeEnv())!;
    expect(res.status).toBe(401);
    expect((await bodyOf(res)).error.code).toBe("missing-bearer");
  });

  it("401 missing-bearer for a non-Bearer scheme", async () => {
    const res = requireBearer(req("Basic czNjcmV0"), makeEnv())!;
    expect(res.status).toBe(401);
    expect((await bodyOf(res)).error.code).toBe("missing-bearer");
  });

  it("401 missing-bearer when the scheme case does not match", async () => {
    // The check is `startsWith("Bearer ")` — deliberately case-sensitive.
    const res = requireBearer(req("bearer test-admin"), makeEnv())!;
    expect(res.status).toBe(401);
    expect((await bodyOf(res)).error.code).toBe("missing-bearer");
  });

  it("401 invalid-bearer on a wrong token of equal length", async () => {
    const env = makeEnv({ ADMIN_TOKEN: "aaaaaa" });
    const res = requireBearer(req("Bearer bbbbbb"), env)!;
    expect(res.status).toBe(401);
    expect((await bodyOf(res)).error.code).toBe("invalid-bearer");
  });

  it("401 invalid-bearer on a wrong token of different length", async () => {
    // Exercises the length-mismatch short-circuit in timingSafeEqual.
    const env = makeEnv({ ADMIN_TOKEN: "aaaaaa" });
    const res = requireBearer(req("Bearer a"), env)!;
    expect(res.status).toBe(401);
    expect((await bodyOf(res)).error.code).toBe("invalid-bearer");
  });

  it("401 invalid-bearer when the token is a prefix of the real one", async () => {
    const env = makeEnv({ ADMIN_TOKEN: "s3cret-long" });
    const res = requireBearer(req("Bearer s3cret"), env)!;
    expect(res.status).toBe(401);
    expect((await bodyOf(res)).error.code).toBe("invalid-bearer");
  });

  it("401 missing-bearer when the scheme is followed only by whitespace", async () => {
    // Header values are whitespace-normalized on the way in, so "Bearer   "
    // reaches the handler as "Bearer" and fails startsWith("Bearer ") before
    // any token comparison. An empty `provided` is therefore unreachable over
    // HTTP — the trim() in requireBearer only ever strips *interior* padding.
    const env = makeEnv({ ADMIN_TOKEN: "s3cret" });
    const res = requireBearer(req("Bearer    "), env)!;
    expect(res.status).toBe(401);
    expect((await bodyOf(res)).error.code).toBe("missing-bearer");
  });
});

describe("requireBearer — misconfiguration", () => {
  it("500 server-misconfigured when ADMIN_TOKEN is unset", async () => {
    const env = makeEnv({ ADMIN_TOKEN: undefined });
    const res = requireBearer(req("Bearer anything"), env)!;
    expect(res.status).toBe(500);
    expect((await bodyOf(res)).error.code).toBe("server-misconfigured");
  });

  it("500 server-misconfigured when ADMIN_TOKEN is empty", async () => {
    // An empty secret must never become an open door: without this branch an
    // empty ADMIN_TOKEN and an empty bearer would compare equal.
    const env = makeEnv({ ADMIN_TOKEN: "" });
    const res = requireBearer(req("Bearer anything"), env)!;
    expect(res.status).toBe(500);
    expect((await bodyOf(res)).error.code).toBe("server-misconfigured");
  });

  it("never echoes the configured token back in the error body", async () => {
    const env = makeEnv({ ADMIN_TOKEN: "super-secret-value" });
    const res = requireBearer(req("Bearer wrong"), env)!;
    expect(await res.text()).not.toContain("super-secret-value");
  });
});

// ---------------------------------------------------------------------------
// Scoped client keys (ADR 0013).


const KEY = "client-key-for-tests";

async function clientEnv(extra: Record<string, unknown> = {}) {
  const digest = await sha256Hex(KEY);
  return makeEnv({ ADMIN_TOKEN: "s3cret", CLIENT_KEYS: JSON.stringify({ searxng: digest }), ...extra });
}

describe("parseClientKeys", () => {
  it("returns [] for unset, blank, invalid JSON, arrays and non-objects", () => {
    expect(parseClientKeys(undefined)).toEqual([]);
    expect(parseClientKeys("  ")).toEqual([]);
    expect(parseClientKeys("{nope")).toEqual([]);
    expect(parseClientKeys("[]")).toEqual([]);
    expect(parseClientKeys("42")).toEqual([]);
    expect(parseClientKeys("null")).toEqual([]);
  });

  it("keeps valid hex digests (case-normalised) and drops malformed entries", () => {
    const good = "A".repeat(64);
    const out = parseClientKeys(
      JSON.stringify({ ok: good, short: "abc", notString: 5, "": "b".repeat(64) }),
    );
    expect(out).toEqual([["ok", "a".repeat(64)]]);
  });
});

describe("sha256Hex", () => {
  it("matches the known digest of 'abc'", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("authenticate", () => {
  it("resolves the admin token to the admin principal", async () => {
    expect(await authenticate(req("Bearer s3cret"), await clientEnv())).toEqual({ kind: "admin" });
  });

  it("resolves a listed client key to its name", async () => {
    expect(await authenticate(req(`Bearer ${KEY}`), await clientEnv())).toEqual({
      kind: "client",
      name: "searxng",
    });
  });

  it("rejects an unknown key with invalid-bearer", async () => {
    const res = (await authenticate(req("Bearer nope"), await clientEnv())) as Response;
    expect(res.status).toBe(401);
    expect((await bodyOf(res)).error.code).toBe("invalid-bearer");
  });

  it("rejects a client key when CLIENT_KEYS is unset", async () => {
    const res = (await authenticate(req(`Bearer ${KEY}`), makeEnv({ ADMIN_TOKEN: "s3cret" }))) as Response;
    expect(res.status).toBe(401);
  });

  it("keeps missing-bearer and server-misconfigured as final", async () => {
    const missing = (await authenticate(req(), await clientEnv())) as Response;
    expect((await bodyOf(missing)).error.code).toBe("missing-bearer");
    const misconf = (await authenticate(
      req(`Bearer ${KEY}`),
      await clientEnv({ ADMIN_TOKEN: "" }),
    )) as Response;
    expect(misconf.status).toBe(500);
  });
});

describe("isClientScopedPath", () => {
  it.each([
    ["/search", true],
    ["/mcp", true],
    ["/mcp/message", true],
    ["/summarize", false],
    ["/admin/token", false],
    ["/admin/refresh", false],
    ["/searchx", false],
  ])("%s -> %s", (path, expected) => {
    expect(isClientScopedPath(path)).toBe(expected);
  });
});
