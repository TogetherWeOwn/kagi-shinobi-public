// /admin/token and /admin/refresh handlers.

import type { Env } from "../env.js";
import { requireBearer } from "../util/auth.js";
import { jsonError, jsonOk } from "../util/errors.js";
import { loadToken, saveToken } from "./store.js";
import { refreshTokenViaBrowser } from "./refresh.js";

export async function handleAdminToken(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "invalid-json", "Body must be JSON");
  }
  const token = (body as { token?: unknown })?.token;
  if (typeof token !== "string" || token.trim().length === 0) {
    return jsonError(400, "missing-token", "Body must be { token: string }");
  }

  await saveToken(env, {
    token: token.trim(),
    updatedAt: Date.now(),
    source: "admin",
    stale: false,
  });
  return jsonOk({ ok: true, source: "admin" });
}

export async function handleAdminRefresh(_request: Request, env: Env): Promise<Response> {
  // force: an operator asking for a refresh explicitly should not be turned
  // away because an automatic attempt holds the lease.
  const result = await refreshTokenViaBrowser(env, { force: true });
  if (!result.ok) {
    return jsonError(503, "refresh-failed", result.reason ?? "unknown refresh error");
  }
  return jsonOk({ ok: true, source: "browser-refresh" });
}

// /health is public so uptime probes can reach it without a credential, but
// token presence, staleness, the last-refresh timestamp, and the refresh
// source describe the operator's credential state — an anonymous caller gets
// liveness only. A valid bearer unlocks the detail. A wrong bearer is treated
// as anonymous rather than rejected, so the probe keeps working even if an
// operator misconfigures the token it sends.
export async function handleHealth(request: Request, env: Env): Promise<Response> {
  const isAuthenticated = requireBearer(request, env) === null;
  if (!isAuthenticated) {
    return jsonOk({ ok: true });
  }

  const envelope = await loadToken(env);
  const tokenStatus = !envelope
    ? "missing"
    : envelope.stale
    ? "stale"
    : "ok";
  return jsonOk({
    ok: true,
    token: tokenStatus,
    updatedAt: envelope?.updatedAt ?? null,
    source: envelope?.source ?? null,
    autoRefresh: env.AUTO_REFRESH_ENABLED === "true",
    // Behind the bearer like every other detail here: the SHA identifies the
    // deployed build, which is operator deployment state, not liveness.
    buildSha: env.BUILD_SHA ?? "dev",
  });
}
