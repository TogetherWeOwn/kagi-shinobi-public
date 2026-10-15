// Worker entry: routes requests to REST, MCP, or admin handlers.
// Every non-/health path requires a bearer: the ADMIN_TOKEN everywhere, or a
// scoped CLIENT_KEYS key on the search surfaces only (ADR 0013).

import type { Env } from "./env.js";
import { authenticate, isClientScopedPath } from "./util/auth.js";
import { jsonError } from "./util/errors.js";
import { handleSearch, handleSearchGet, handleSummarize } from "./rest.js";
import { handleAdminRefresh, handleAdminToken, handleHealth } from "./token/admin.js";
import { KagiMcpAgent } from "./mcp.js";
import { landingResponse } from "./landing.js";
import { checkAndIncrement, checkClientRate } from "./util/ratelimit.js";
import { ResearchRun } from "./research/run.js";
import { Meter } from "./meter/meter.js";
import { ResultCache } from "./cache/store.js";
import { resultCacheStub } from "./cache/read-through.js";

export { KagiMcpAgent, ResearchRun, Meter, ResultCache };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // Public routes — no bearer required. Landing page + health check are
    // safe to expose; everything else is gated below.
    if (path === "/" && method === "GET") {
      return landingResponse();
    }
    if (path === "/health" && method === "GET") {
      return handleHealth(request, env);
    }

    const principal = await authenticate(request, env);
    if (principal instanceof Response) return principal;

    if (principal.kind === "client") {
      if (!isClientScopedPath(path)) {
        return jsonError(403, "forbidden-scope", `client key "${principal.name}" may not call ${path}`);
      }
      const rl = await checkClientRate(env, principal.name);
      if (!rl.allowed) {
        return jsonError(429, "rate-limited", `client key limit reached (${rl.count}/${rl.limit_rpm})`, {
          headers: {
            "Retry-After": String(rl.retry_after_seconds ?? 60),
            "X-RateLimit-Limit": String(rl.limit_rpm),
            "X-RateLimit-Remaining": "0",
          },
        });
      }
    }

    // Per-bearer rate limit (PER_BEARER_RPM). Admin endpoints skip the limit
    // so operators can reset a runaway automation without eating quota.
    // Client keys also pass through this, so PER_BEARER_RPM stays a ceiling.
    if (!path.startsWith("/admin/")) {
      const bearer = request.headers.get("Authorization")!.slice("Bearer ".length).trim();
      const rl = await checkAndIncrement(env, bearer);
      if (!rl.allowed) {
        // Hand-rolled until ADR 0012 gave jsonError a header bag. It happened
        // to match the envelope; the next one would not have.
        return jsonError(429, "rate-limited", `${rl.count}/${rl.limit_rpm} requests this minute`, {
          headers: {
            "Retry-After": String(rl.retry_after_seconds ?? 60),
            "X-RateLimit-Limit": String(rl.limit_rpm),
            "X-RateLimit-Remaining": "0",
          },
        });
      }
    }

    if (path === "/mcp" || path.startsWith("/mcp/")) {
      // McpAgent.serve() handles both the SSE and Streamable HTTP wire
      // protocols; McpAgent.serveSSE is the SSE-only variant. Prefer serve().
      return KagiMcpAgent.serve("/mcp").fetch(request, env, ctx);
    }

    if (path === "/search" && method === "POST") {
      return handleSearch(request, env, ctx);
    }
    if (path === "/search" && method === "GET") {
      return handleSearchGet(request, env, ctx);
    }
    if (path === "/summarize" && method === "POST") {
      return handleSummarize(request, env, ctx);
    }
    if (path === "/admin/token" && method === "POST") {
      return handleAdminToken(request, env);
    }
    if (path === "/admin/refresh" && method === "POST") {
      return handleAdminRefresh(request, env);
    }

    return jsonError(404, "not-found", `${method} ${path} not routed`);
  },

  // Hourly cron (wrangler.jsonc triggers): drop expired result-cache entries
  // so Kagi results stay transient. ADR 0017.
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const stub = resultCacheStub(env);
    if (stub) ctx.waitUntil(stub.purge(Date.now()));
  },
} satisfies ExportedHandler<Env>;
