// Personalized rank via /v1/search: pass caller-supplied `personalizations{}`
// rules and check where each input URL surfaces in the returned results.
// One search call per rank, regardless of how many URLs are being ranked.

import type { Env } from "../../env.js";
import { apiSearch } from "./search.js";
import type {
  PersonalizationAction,
  PersonalizationRule,
  RankResponse,
  RankedUrl,
} from "../types.js";
import { KagiError } from "../errors.js";

export interface ApiRankArgs {
  urls: string[];
  q: string;
  rules?: PersonalizationRule[];
  limit?: number;
}

export async function apiRank(env: Env, args: ApiRankArgs): Promise<RankResponse> {
  if (!args.q) {
    throw new KagiError("parse", "api rank requires a query `q`");
  }
  const domains = (args.rules ?? [])
    .filter((r) => r.domain)
    .map((r) => ({ domain: r.domain as string, kind: r.action }));
  const regexes = (args.rules ?? [])
    .filter((r) => r.regex)
    .map((r) => ({ regex: r.regex as string }));
  const search = await apiSearch(env, {
    query: args.q,
    limit: args.limit ?? 20,
    personalizations:
      domains.length > 0 || regexes.length > 0
        ? { domains, regexes }
        : undefined,
  });
  const foundRank = new Map<string, number>();
  for (const r of search.results) {
    foundRank.set(r.url, r.rank);
  }
  const cap = search.results.length || 1;
  const ranked: RankedUrl[] = args.urls.map((u) => {
    const rank = foundRank.get(u);
    if (rank === undefined) {
      return {
        url: u,
        score: 0,
        action: "block" as PersonalizationAction,
        rationale: "no appearance in personalized results",
      };
    }
    const score = Math.max(0, 1 - (rank - 1) / cap);
    return {
      url: u,
      score,
      action: score > 0.7 ? "pin" : score > 0.4 ? "raise" : "neutral",
      rationale: `rank ${rank}/${cap}`,
    };
  });
  return {
    query: args.q,
    ranked,
    meta: search.meta,
  };
}
