// Single source of truth for which impl(s) can serve each MCP tool.
//
// The dispatcher consults this matrix on every call to (a) pick an impl for
// hybrid mode, (b) reject calls that are impossible in the active mode, and
// (c) drive tools/list so unavailable tools never appear.
//
// Add a row here BEFORE adding a new tool. Ship the tool ONLY when the
// scrape and api columns match the real-world availability documented in
// docs/adr/0001-tri-mode-architecture.md's capability matrix.

import type { KagiMode } from "./mode.js";

export type ImplSupport =
  | "scrape"           // scrape impl works
  | "api"              // official API works
  | "both"             // both work — pick per user directive
  | "none";            // neither — reserved for tools that are pure compositions

export interface ToolCapability {
  tool: string;
  support: ImplSupport;
  /** In hybrid mode, if both work, prefer this impl unless the caller overrides. */
  hybrid_prefer: "scrape" | "api";
  /**
   * Whether tools/list should expose this tool for callers to override with the
   * `impl` param. False for tools with only one impl (unambiguous).
   */
  expose_impl_param: boolean;
  /** Whether calling this tool costs money on the API side. */
  api_billable: boolean;
  /** Optional per-tool billable rate in cents. Used by the cost cap. */
  api_cents_per_call?: number;
}

// Kagi's published rates (2026) inform api_cents_per_call defaults. See
// docs/adr/0001-tri-mode-architecture.md for citations.
export const CAPABILITY_MATRIX: ToolCapability[] = [
  // S1 base tools — supported by scrape today; API path lands in S3/S5.
  {
    tool: "kagi_search_fetch",
    support: "both",
    hybrid_prefer: "scrape",
    expose_impl_param: true,
    api_billable: true,
    api_cents_per_call: 1.2, // $12 / 1000
  },
  {
    tool: "kagi_summarizer",
    support: "both",
    hybrid_prefer: "scrape",
    expose_impl_param: true,
    api_billable: true,
    api_cents_per_call: 30, // Cecil/Agnes hard cap; Muriel is $1 (100¢) via engine=muriel
  },
  // Later sprints register additional rows. Declaring them up front so tests
  // can catch dispatcher regressions before the impls land.
  {
    tool: "kagi_search",
    support: "both",
    hybrid_prefer: "scrape",
    expose_impl_param: true,
    api_billable: true,
    api_cents_per_call: 1.2,
  },
  {
    tool: "kagi_small_web",
    support: "both",
    hybrid_prefer: "scrape",
    expose_impl_param: true,
    api_billable: true,
    api_cents_per_call: 1.2,
  },
  {
    tool: "kagi_list_lenses",
    support: "scrape",
    hybrid_prefer: "scrape",
    expose_impl_param: false,
    api_billable: false,
  },
  {
    // Scrape impl added via GET /stream_fastgpt (SSE) reverse-engineered
    // from the frontend JS bundle at /asset/*/js/k_fgpt.js. Hybrid default
    // is scrape (free) per the user directive: prefer the free path.
    tool: "kagi_fastgpt",
    support: "both",
    hybrid_prefer: "scrape",
    expose_impl_param: true,
    api_billable: true,
    api_cents_per_call: 1.5, // $15 / 1000 on the paid API path
  },
  {
    tool: "kagi_summarize_url",
    support: "both",
    hybrid_prefer: "scrape",
    expose_impl_param: true,
    api_billable: true,
    api_cents_per_call: 30,
  },
  {
    tool: "kagi_summarize_text",
    support: "api",
    hybrid_prefer: "api",
    expose_impl_param: false,
    api_billable: true,
    api_cents_per_call: 30,
  },
  {
    tool: "kagi_extract",
    support: "api",
    hybrid_prefer: "api",
    expose_impl_param: false,
    api_billable: true,
    api_cents_per_call: 0.4, // $4 / 1000 per URL
  },
  {
    tool: "kagi_enrich_web",
    support: "api",
    hybrid_prefer: "api",
    expose_impl_param: false,
    api_billable: true,
    api_cents_per_call: 0.2, // $2 / 1000 — billed only when non-zero results
  },
  {
    tool: "kagi_enrich_news",
    support: "api",
    hybrid_prefer: "api",
    expose_impl_param: false,
    api_billable: true,
    api_cents_per_call: 0.2,
  },
  {
    tool: "kagi_personalized_rank",
    support: "both",
    hybrid_prefer: "scrape",
    expose_impl_param: true,
    api_billable: true,
    api_cents_per_call: 1.2, // one v1 search call
  },
];

const BY_TOOL: Map<string, ToolCapability> = new Map(
  CAPABILITY_MATRIX.map((c) => [c.tool, c]),
);

export function capabilityFor(tool: string): ToolCapability | undefined {
  return BY_TOOL.get(tool);
}

/**
 * Whether the tool is callable at all in the given mode. Used to filter
 * tools/list and to reject early in the facade.
 */
export function isToolAvailable(tool: string, mode: KagiMode): boolean {
  const cap = BY_TOOL.get(tool);
  if (!cap) return false;
  return supportsMode(cap.support, mode);
}

export function supportsMode(support: ImplSupport, mode: KagiMode): boolean {
  if (support === "none") return false;
  if (support === "both") return true;
  if (mode === "hybrid") return true; // hybrid can reach either impl
  return support === mode;
}

/**
 * Pick which impl to use given the tool, mode, and an optional caller override.
 * Throws if the tool is not available in the mode at all — that's a bug in the
 * dispatcher (tools/list should have hidden the tool) or a caller cheating past
 * the schema.
 */
export function pickImpl(
  tool: string,
  mode: KagiMode,
  override?: "scrape" | "api",
): "scrape" | "api" {
  const cap = BY_TOOL.get(tool);
  if (!cap) throw new Error(`Unknown tool: ${tool}`);
  if (!supportsMode(cap.support, mode)) {
    throw new Error(`Tool '${tool}' not supported in mode='${mode}'`);
  }
  if (override) {
    // Override only honored when the tool actually supports both, and the
    // active mode can reach the requested impl.
    if (cap.support !== "both") {
      throw new Error(
        `Tool '${tool}' has fixed impl='${cap.support}'; ignoring override='${override}'`,
      );
    }
    if (mode === "scrape" && override === "api") {
      throw new Error("Cannot force impl='api' in mode='scrape'");
    }
    if (mode === "api" && override === "scrape") {
      throw new Error("Cannot force impl='scrape' in mode='api'");
    }
    return override;
  }
  if (mode === "scrape") return "scrape";
  if (mode === "api") return "api";
  // hybrid
  if (cap.support === "scrape") return "scrape";
  if (cap.support === "api") return "api";
  return cap.hybrid_prefer;
}
