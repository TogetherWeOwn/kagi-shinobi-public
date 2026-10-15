// Typed JSON response helpers. Errors follow a small stable shape:
//   { error: { code, message, detail? } }
// so clients can key off `code` without parsing prose.
//
// `detail` and the header bag are both ADR 0012. Before them this helper could
// not express everything an error response needed, so the one response needing
// headers — the rate-limit 429 in src/index.ts — was hand-rolled alongside it.
// A builder that cannot say what a caller needs grows a second shape; that is
// the same failure ADR 0010 fixed on the MCP side. Every error Response in this
// worker is now built here.

export interface ErrorBody {
  error: { code: string; message: string; detail?: Record<string, unknown> };
}

export interface JsonErrorInit {
  /** Structured context. Omitted from the body entirely when empty. */
  detail?: Record<string, unknown>;
  headers?: Record<string, string>;
}

export function jsonOk(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

export function jsonError(
  status: number,
  code: string,
  message: string,
  init: JsonErrorInit = {},
): Response {
  // An empty bag is dropped rather than serialized as `"detail":{}`, so every
  // response that had no detail before ADR 0012 is still byte-identical.
  const hasDetail = init.detail !== undefined && Object.keys(init.detail).length > 0;
  const body: ErrorBody = {
    error: { code, message, ...(hasDetail ? { detail: init.detail } : {}) },
  };
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}
