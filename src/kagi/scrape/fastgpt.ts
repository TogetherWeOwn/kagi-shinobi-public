// FastGPT scrape implementation.
//
// Reverse-engineered from the JS bundle at
// https://kagi.com/asset/1cfde95/js/k_fgpt.js — the frontend uses
// `new EventSource("/stream_fastgpt?query=...&turnstile_key=...", {withCredentials:true})`.
// Each SSE `data:` frame is JSON — a string that's either "[DONE]", "[ERROR]",
// or the accumulated HTML answer content (the frontend does
// `.innerHTML=data` on each frame, overwriting rather than appending). We
// read the full stream server-side and pull the last non-sentinel frame as
// the completed answer, then extract citations from the HTML.
//
// The turnstile_key param is empty for authenticated users — the frontend
// only fills it when Cloudflare Turnstile challenges the request. We don't
// have a browser to solve one, so if Kagi ever gates authenticated FastGPT
// behind Turnstile we'll surface KagiCaptchaError and fall back to the API
// path (hybrid mode) or fail cleanly (scrape-only mode).

import * as cheerio from "cheerio";
import { chromeHeaders } from "../headers.js";
import { buildMeta } from "../../mcp/meta.js";
import {
  KagiAuthError,
  KagiCaptchaError,
  KagiParseError,
  KagiUpstreamError,
} from "../errors.js";
import type { FastGPTReference, FastGPTResponse } from "../types.js";

const STREAM_URL = "https://kagi.com/stream_fastgpt";

export interface ScrapeFastGPTArgs {
  query: string;
}

export async function scrapeFastGPT(
  args: ScrapeFastGPTArgs,
  sessionToken: string,
): Promise<FastGPTResponse> {
  const start_ms = Date.now();
  const url = new URL(STREAM_URL);
  url.searchParams.set("query", args.query);
  // turnstile_key intentionally empty — filled only when a challenge fires.

  const res = await fetch(url.toString(), {
    headers: chromeHeaders({
      kind: "xhr",
      referer: "https://kagi.com/fastgpt",
      cookieHeader: `kagi_session=${sessionToken}`,
      accept: "text/event-stream",
      extra: { "Cache-Control": "no-cache" },
    }),
  });

  if (res.status === 401 || res.status === 403) throw new KagiAuthError();
  if (!res.ok) throw new KagiUpstreamError(res.status, res.statusText);

  const body = await res.text();
  const finalPayload = parseSseFinalPayload(body);
  if (finalPayload === null) {
    throw new KagiParseError("FastGPT stream ended without a payload");
  }
  const parsed = extractAnswerAndReferences(finalPayload, args.query);

  return {
    query: args.query,
    answer: parsed.answer,
    references: parsed.references,
    meta: buildMeta({ impl: "scrape", start_ms }),
  };
}

/**
 * Walk SSE frames and return the payload string of the last data frame
 * that wasn't [DONE] or [ERROR]. Returns null if no such frame arrived;
 * throws KagiCaptchaError if the server signaled a Turnstile challenge.
 */
export function parseSseFinalPayload(body: string): string | null {
  const frames = body.split(/\n\n+/);
  let last: string | null = null;
  for (const frame of frames) {
    // Extract data: lines (SSE allows multi-line data: fields, concatenated by \n).
    const dataParts: string[] = [];
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith("data:")) dataParts.push(line.slice("data:".length).trimStart());
    }
    if (dataParts.length === 0) continue;
    const raw = dataParts.join("\n");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Not every frame is guaranteed JSON. Skip unparseable frames.
      continue;
    }
    if (parsed === "[DONE]") break;
    if (parsed === "[ERROR]") {
      throw new KagiUpstreamError(200, "FastGPT stream reported [ERROR]");
    }
    if (typeof parsed === "string") {
      if (isTurnstileChallenge(parsed)) {
        throw new KagiCaptchaError("FastGPT requires a Turnstile challenge");
      }
      last = parsed;
    }
  }
  return last;
}

function isTurnstileChallenge(payload: string): boolean {
  // The Turnstile widget markup is injected via the standard Cloudflare
  // container; the exact HTML depends on Kagi's page-side wrapper. This is
  // a best-effort sniff so hybrid/api mode can be tried before we give up.
  return /turnstile|cf-turnstile|challenge-form/i.test(payload);
}

/**
 * Parse the final HTML payload into the canonical FastGPTResponse shape.
 * The HTML structure Kagi renders inside `#recipe_output .text_content`
 * varies with the answer's length + style, so we take a layered approach:
 *
 * 1. Prefer any explicit "reference" section (ordered list of citations).
 * 2. Fall back to numbered `<sup>` / `<a class="ref">` inline markers.
 * 3. Final fallback: every unique `<a href>` in the payload.
 *
 * If none of those succeed the caller still gets a usable `answer` (the
 * plain text of the whole payload), just with an empty references[]. That
 * degrades gracefully compared to throwing when reference extraction fails.
 */
export function extractAnswerAndReferences(
  html: string,
  query: string,
): { answer: string; references: FastGPTReference[] } {
  const $ = cheerio.load(html);

  const references: FastGPTReference[] = [];
  const seen = new Set<string>();

  // Layer 1 — explicit reference section.
  const explicitSelectors = [
    ".fastgpt_references a[href]",
    ".fastgpt-references a[href]",
    ".references a[href]",
    "._0_fastgpt_references a[href]",
    ".ref_list a[href]",
    "ol.references li a[href]",
  ];
  for (const sel of explicitSelectors) {
    if (references.length > 0) break;
    $(sel).each((_, el) => {
      pushRef($, el, references, seen);
    });
  }

  // Layer 2 — inline citation markers (sup, .ref, .citation).
  if (references.length === 0) {
    $("sup a[href], .ref[href], .citation a[href], a.ref[href]").each((_, el) => {
      pushRef($, el, references, seen);
    });
  }

  // Layer 3 — every unique external anchor. Filter kagi-internal links.
  if (references.length === 0) {
    $("a[href^='http']").each((_, el) => {
      const href = $(el).attr("href") ?? "";
      if (isKagiInternalLink(href)) return;
      pushRef($, el, references, seen);
    });
  }

  // Answer text: strip the reference block (if any) then get text.
  for (const sel of explicitSelectors) {
    $(sel).parents().first().remove();
  }
  const answerText = $("body").text().replace(/\s+/g, " ").trim();

  return {
    answer: answerText || `(FastGPT returned no answer text for "${query}")`,
    references,
  };
}

/**
 * True for links served by Kagi itself — navigation, not citations. Matched
 * on the parsed hostname so lookalikes like https://kagi.com.evil.example/
 * are still treated as external references.
 */
function isKagiInternalLink(href: string): boolean {
  try {
    return new URL(href).hostname.toLowerCase() === "kagi.com";
  } catch {
    return false;
  }
}

function pushRef(
  $: cheerio.CheerioAPI,
  el: import("domhandler").AnyNode,
  refs: FastGPTReference[],
  seen: Set<string>,
): void {
  const $el = $(el);
  const url = $el.attr("href");
  if (!url || seen.has(url)) return;
  seen.add(url);
  const rawTitle = $el.text().trim();
  const title = rawTitle && rawTitle.length > 2 ? rawTitle : url;
  refs.push({ title, url, snippet: "" });
}
