// Typed fetch wrapper for the official Kagi API.
//
// Kagi's docs specify `Authorization: Bot $TOKEN` on every request. Every
// response body is a `{ meta, data }` envelope; the client unwraps it and
// returns `data` directly so endpoint modules don't repeat the pattern.
// Trace IDs come from `X-Kagi-Trace` (header) or `meta.trace` (body) — the
// header is preferred but we fall back so operators can still correlate.

import type { Env } from "../../env.js";
import { KagiError, KagiNotConfiguredError, KagiUpstreamError } from "../errors.js";
import { takeKagiCall } from "../budget.js";

export interface KagiApiRequest {
  method: "GET" | "POST";
  url: string;
  body?: unknown;
  timeout_ms?: number;
  headers?: Record<string, string>;
}

/** Kagi's envelope shape. `data` is the interesting payload. */
interface Envelope<T> {
  meta?: { trace?: string; node?: string; ms?: number };
  data: T;
}

export interface KagiApiResponse<T> {
  /** Unwrapped payload (envelope.data). */
  data: T;
  /** Header-first, body-fallback trace ID for support/log correlation. */
  trace_id?: string;
  /** Node the request landed on (from envelope.meta.node). */
  node?: string;
  /** Server-reported latency in ms (from envelope.meta.ms). */
  server_ms?: number;
  http_status: number;
}

export class KagiApiClient {
  constructor(private env: Env) {}

  isConfigured(): boolean {
    return Boolean(this.env.KAGI_API_KEY && this.env.KAGI_API_KEY.length > 0);
  }

  requireConfigured(): void {
    if (!this.isConfigured()) {
      throw new KagiNotConfiguredError(
        "KAGI_API_KEY is not set — cannot use official API. " +
          "Set the secret via `wrangler secret put KAGI_API_KEY`.",
      );
    }
  }

  async request<T>(req: KagiApiRequest): Promise<KagiApiResponse<T>> {
    this.requireConfigured();
    await takeKagiCall(this.env);
    const controller = new AbortController();
    const timeout_ms = req.timeout_ms ?? 30_000;
    const timer = setTimeout(() => controller.abort(), timeout_ms);
    try {
      const init: RequestInit = {
        method: req.method,
        signal: controller.signal,
        headers: {
          Authorization: `Bot ${this.env.KAGI_API_KEY}`,
          "User-Agent": "kagi-shinobi/0.2 (+https://github.com/TogetherWeOwn/kagi-shinobi)",
          ...(req.headers ?? {}),
        },
      };
      if (req.method === "POST" && req.body !== undefined) {
        (init.headers as Record<string, string>)["Content-Type"] ??=
          "application/json";
        init.body =
          typeof req.body === "string" ? req.body : JSON.stringify(req.body);
      }
      const response = await fetch(req.url, init);
      const headerTrace =
        response.headers.get("X-Kagi-Trace") ??
        response.headers.get("x-kagi-trace") ??
        undefined;
      if (!response.ok) {
        const text = await response.text().catch(() => response.statusText);
        throw new KagiUpstreamError(response.status, text.slice(0, 500));
      }
      const envelope = (await response.json()) as Envelope<T>;
      return {
        data: envelope.data,
        trace_id: headerTrace ?? envelope.meta?.trace,
        node: envelope.meta?.node,
        server_ms: envelope.meta?.ms,
        http_status: response.status,
      };
    } catch (err) {
      if (err instanceof KagiError) throw err;
      if ((err as { name?: string }).name === "AbortError") {
        throw new KagiError("timeout", `Kagi API request timed out after ${timeout_ms}ms`, {
          ms: timeout_ms,
        });
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
