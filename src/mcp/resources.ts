// MCP resources — read-only URIs the client can browse or subscribe to.
//
// S9 registers the fixed URIs. Templated URIs (search://run/{id}) require
// a resource template registration which the SDK exposes as `.resource()`
// with a template arg — noted as a follow-up if needed.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Env } from "../env.js";
import { budgetSnapshot } from "../kagi/api/cost.js";
import { KagiNotConfiguredError, safeErrorMessage } from "../kagi/errors.js";
import { readLimit } from "../util/ratelimit.js";
import { fetchSmallWebRss } from "../kagi/scrape/smallweb.js";
import { resolveMode } from "../kagi/mode.js";
import { loadToken } from "../token/store.js";
import { resultCacheStub } from "../cache/read-through.js";

interface ResourceContent {
  uri: string;
  mimeType: string;
  text: string;
}

export function registerResources(server: McpServer, env: Env): void {
  server.resource(
    "kagi_budget",
    "kagi://budget",
    {
      description: "Current-month API cost cap and spend.",
      mimeType: "application/json",
    },
    async (uri) => ({ contents: [await readBudget(env, uri.href)] }),
  );

  server.resource(
    "kagi_api_status",
    "kagi://api-status",
    {
      description: "Mode + credential + session-token health snapshot.",
      mimeType: "application/json",
    },
    async (uri) => ({ contents: [await readApiStatus(env, uri.href)] }),
  );

  server.resource(
    "kagi_smallweb_recent",
    "kagi://smallweb/recent",
    {
      description: "Recent Small Web posts via the free Kagi RSS feed.",
      mimeType: "application/json",
    },
    async (uri) => ({ contents: [await readSmallWebRecent(uri.href)] }),
  );

  server.resource(
    "kagi_cache_stats",
    "kagi://cache-stats",
    {
      description:
        "Result-cache counters: hits, misses (upstream fetches), stores, live entries, hit_rate, per domain.",
      mimeType: "application/json",
    },
    async (uri) => ({ contents: [await readCacheStats(env, uri.href)] }),
  );
}

async function readBudget(env: Env, uri: string): Promise<ResourceContent> {
  try {
    const snap = await budgetSnapshot(env);
    return { uri, mimeType: "application/json", text: JSON.stringify(snap, null, 2) };
  } catch (err) {
    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify({ error: safeErrorMessage(err) }),
    };
  }
}

// ADR 0017: the hit rate the card's acceptance is measured by. Counters are
// cumulative — the hourly purge removes entries, never counts.
async function readCacheStats(env: Env, uri: string): Promise<ResourceContent> {
  try {
    const stub = resultCacheStub(env);
    // Typed, not a plain Error: this setup message is written for clients,
    // and safeErrorMessage only lets typed vocabulary through verbatim.
    if (!stub) throw new KagiNotConfiguredError("RESULT_CACHE binding not configured; the cache is off");
    const stats = await stub.stats();
    return { uri, mimeType: "application/json", text: JSON.stringify(stats, null, 2) };
  } catch (err) {
    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify({ error: safeErrorMessage(err) }),
    };
  }
}

async function readApiStatus(env: Env, uri: string): Promise<ResourceContent> {
  const body: Record<string, unknown> = {};
  try {
    const info = resolveMode(env);
    body.mode = info.mode;
    body.has_session = info.has_session;
    body.has_api_key = info.has_api_key;
    body.per_bearer_rpm = readLimit(env);
    const envelope = await loadToken(env);
    body.session_token = envelope
      ? { status: envelope.stale ? "stale" : "ok", updatedAt: envelope.updatedAt, source: envelope.source }
      : { status: "missing" };
  } catch (err) {
    body.error = safeErrorMessage(err);
  }
  return { uri, mimeType: "application/json", text: JSON.stringify(body, null, 2) };
}

async function readSmallWebRecent(uri: string): Promise<ResourceContent> {
  try {
    const feed = await fetchSmallWebRss(15);
    return { uri, mimeType: "application/json", text: JSON.stringify(feed, null, 2) };
  } catch (err) {
    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify({ error: safeErrorMessage(err) }),
    };
  }
}
