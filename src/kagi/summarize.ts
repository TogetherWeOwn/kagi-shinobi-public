// Ported from czottmann/kagi-ken@1.3.0 src/summarize.js (MIT).
// Changes: TypeScript, Chrome headers instead of Safari, KagiAuthError on 401/403.
import { chromeHeaders } from "./headers.js";
import { KagiAuthError, KagiParseError, upstreamErrorFromResponse } from "./errors.js";
import { isSupportedLanguage, SUPPORTED_LANGUAGES } from "./languages.js";

export type SummaryType = "summary" | "takeaway";

export interface SummarizeOptions {
  type?: SummaryType;
  language?: string;
  isUrl?: boolean;
}

export interface SummarizeResponse {
  data: { output: string };
}

export async function summarize(
  input: string,
  token: string,
  options: SummarizeOptions = {},
): Promise<SummarizeResponse> {
  if (!input || typeof input !== "string") {
    throw new Error("Input is required and must be a string");
  }
  if (!token || typeof token !== "string") {
    throw new Error("Session token is required and must be a string");
  }

  const { type = "summary", language = "EN", isUrl = false } = options;

  if (type !== "summary" && type !== "takeaway") {
    throw new Error("Type must be 'summary' or 'takeaway'");
  }
  if (!isSupportedLanguage(language)) {
    throw new Error(
      `Unsupported language code '${language}'. Supported: ${SUPPORTED_LANGUAGES.join(", ")}`,
    );
  }

  const commonHeaders = chromeHeaders({
    kind: "xhr",
    referer: "https://kagi.com/summarizer",
    cookieHeader: `kagi_session=${token}`,
    accept: "application/vnd.kagi.stream",
  });

  let response: Response;
  if (isUrl) {
    const url = new URL("https://kagi.com/mother/summary_labs");
    url.searchParams.set("url", input);
    url.searchParams.set("stream", "1");
    url.searchParams.set("target_language", language);
    url.searchParams.set("summary_type", type);
    response = await fetch(url.toString(), {
      method: "GET",
      headers: commonHeaders,
    });
  } else {
    const body = new URLSearchParams();
    body.set("text", input);
    body.set("stream", "1");
    body.set("target_language", language);
    body.set("summary_type", type);
    response = await fetch("https://kagi.com/mother/summary_labs/", {
      method: "POST",
      headers: chromeHeaders({
        kind: "form",
        referer: "https://kagi.com/summarizer",
        cookieHeader: `kagi_session=${token}`,
        accept: "application/vnd.kagi.stream",
        contentType: "application/x-www-form-urlencoded;charset=UTF-8",
      }),
      body,
    });
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new KagiAuthError();
    }
    throw upstreamErrorFromResponse(response.status);
  }

  const streamData = await response.text();
  const parsed = parseStreamingSummary(streamData);
  const output =
    parsed?.output_data?.markdown ?? parsed?.md ?? "";
  return { data: { output } };
}

interface ParsedStream {
  output_data?: { markdown?: string };
  md?: string;
}

function parseStreamingSummary(streamData: string): ParsedStream {
  const messages = streamData.split("\x00").filter((m) => m.trim());
  if (messages.length === 0) throw new KagiParseError("No summary data received");

  const last = messages[messages.length - 1].trim();
  const jsonString = last
    .replace(/^final:/, "")
    .replace(/^new_message\.json:/, "")
    .trim();

  if (!jsonString) throw new KagiParseError("Empty summary received");

  try {
    return JSON.parse(jsonString) as ParsedStream;
  } catch (e) {
    if (e instanceof SyntaxError) {
      throw new KagiParseError("Failed to parse summary JSON response");
    }
    throw new KagiParseError("Failed to parse summary response");
  }
}
