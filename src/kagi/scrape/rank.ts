// Personalized rank via scrape: for each URL, run a `site:<domain>` query
// and see where (if at all) the URL surfaces in the user's Kagi results.
// This automatically reflects the account's blocklist / promotelist / pins
// without any explicit rules being passed — the scraper IS the user.
//
// Trade-off: N queries per rank call. Cap at 5 URLs per call by default.

import { search as rawSearch } from "../search.js";
import { buildMeta } from "../../mcp/meta.js";
import type { PersonalizationAction, RankedUrl, RankResponse } from "../types.js";
import { KagiAuthError } from "../errors.js";
import { domainFromUrl } from "../../util/url.js";

export interface ScrapeRankArgs {
  urls: string[];
  q?: string;
  probe_limit?: number; // per-URL probe cap; higher = more discriminating
}

export async function scrapeRank(
  args: ScrapeRankArgs,
  sessionToken: string | undefined,
  /** Called before each upstream probe — the global call budget (ADR 0013). */
  beforeCall: () => Promise<void> = async () => {},
): Promise<RankResponse> {
  if (!sessionToken) throw new KagiAuthError("Personalized rank requires a session token");
  const start_ms = Date.now();
  const probeLimit = args.probe_limit ?? 10;
  const ranked: RankedUrl[] = [];
  for (const url of args.urls) {
    const domain = domainFromUrl(url);
    const q = args.q ? `${args.q} site:${domain}` : `site:${domain}`;
    let position = -1;
    // Outside the try: a budget refusal must abort the whole rank, not be
    // scored as "URL not found".
    await beforeCall();
    try {
      const resp = await rawSearch(q, sessionToken, probeLimit);
      const items = resp.data.filter((it) => it.t === 0);
      const i = items.findIndex((it) => it.url === url || sameDoc(it.url, url));
      position = i;
    } catch (err) {
      // A parse or upstream error on one probe shouldn't kill the whole call.
      if (err instanceof KagiAuthError) throw err;
      position = -1;
    }
    ranked.push(scoreFromPosition(url, position, probeLimit));
  }
  return {
    query: args.q,
    ranked,
    meta: buildMeta({ impl: "scrape", start_ms }),
  };
}

function scoreFromPosition(url: string, position: number, cap: number): RankedUrl {
  if (position < 0) {
    // URL didn't surface at all — could be blocked, or just not indexed at
    // this depth. Downstream callers should treat as "not preferred" not
    // "definitely blocked."
    return {
      url,
      score: 0,
      action: "block" as PersonalizationAction,
      rationale: "no appearance in probe results — may be blocked or de-ranked",
    };
  }
  // rank 0 → 1.0; rank cap-1 → 1/cap.
  const score = Math.max(0, 1 - position / cap);
  return {
    url,
    score,
    action: score > 0.7 ? "pin" : score > 0.4 ? "raise" : "neutral",
    rationale: `probe position ${position + 1}/${cap}`,
  };
}

function sameDoc(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.host === ub.host && ua.pathname === ub.pathname;
  } catch {
    return false;
  }
}
