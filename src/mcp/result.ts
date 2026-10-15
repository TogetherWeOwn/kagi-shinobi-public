// MCP CallToolResult builder.
//
// The 2025-06-18 MCP spec allows tools to return `structuredContent` alongside
// the usual `content` array. Clients that understand structured output can
// parse the typed JSON directly; older clients still render the text block.
// Every kagi-shinobi tool routes through here so the two channels stay in sync.

// structuredContent per MCP spec must be a JSON object (Record<string, unknown>).
// Passing arrays / primitives at the top level is rejected by the SDK — nest
// them under a key (e.g. `{queries: [...]}` rather than `[...]`).
type Structured = Record<string, unknown>;

// No `isError` here on purpose. Errors go through mcpError() so every failure
// carries the same envelope; an opt-in flag on the success builder is how
// kagi_summarizer ended up with a shape of its own. See ADR 0010.
export interface McpResultInit {
  text: string;
  structured?: Structured;
}

// Index signature required by @modelcontextprotocol/sdk's CallToolResult:
// its type is defined as `{ [x: string]: unknown; content: ...; ... }`, so
// any structural subtype must be compatible with the wildcard.
export interface McpResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Structured;
  isError?: boolean;
}

export function mcpResult(init: McpResultInit): McpResult {
  const result: McpResult = {
    content: [{ type: "text", text: init.text }],
  };
  if (init.structured !== undefined) result.structuredContent = init.structured;
  return result;
}

/**
 * Coerce a canonical typed response (SearchResponse, SummarizeResponse, ...)
 * into the Record shape structuredContent requires. Canonical types don't
 * carry an index signature in TypeScript, but the runtime shape is always a
 * plain JSON object, so this widening cast is safe at the boundary.
 */
export function asStructured<T extends object>(value: T): Record<string, unknown> {
  return value as unknown as Record<string, unknown>;
}

export interface McpErrorInit {
  kind: string;
  message: string;
  detail?: Record<string, unknown>;
}

export function mcpError(init: McpErrorInit): McpResult {
  const structured: Structured = {
    error_kind: init.kind,
    message: init.message,
    ...(init.detail ?? {}),
  };
  return {
    content: [{ type: "text", text: `Error [${init.kind}]: ${init.message}` }],
    structuredContent: structured,
    isError: true,
  };
}
