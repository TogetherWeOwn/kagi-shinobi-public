// Chrome browser header set used on every upstream request to kagi.com.
//
// Kept in canonical Chrome ordering (User-Agent first, sec-ch-* grouped,
// then Sec-Fetch-* group) because some anti-bot systems fingerprint header
// order. Header names use the exact casing Chrome sends.
//
// Values represent Chrome 154 on Windows 10/11 (stable channel, October
// 2026). Bump this table when the stable channel moves several majors ahead —
// the sec-ch-ua brand list must match the UA version or the fingerprint stops
// being coherent. test/kagi/headers.test.ts pins that coherence, and
// src/token/refresh.ts reuses CHROME_UA so the login flow cannot drift.
export const CHROME_VERSION = "154";

export const CHROME_UA =
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION}.0.0.0 Safari/537.36`;

export type ChromeRequestKind = "document" | "xhr" | "form";

interface HeaderOpts {
  kind?: ChromeRequestKind;
  referer?: string;
  cookieHeader?: string;
  accept?: string;
  contentType?: string;
  extra?: Record<string, string>;
}

export function chromeHeaders(opts: HeaderOpts = {}): HeadersInit {
  const {
    kind = "document",
    referer,
    cookieHeader,
    accept,
    contentType,
    extra,
  } = opts;

  const headers: Record<string, string> = {
    "User-Agent": CHROME_UA,
    "sec-ch-ua":
      `"Chromium";v="${CHROME_VERSION}", "Not_A Brand";v="24", "Google Chrome";v="${CHROME_VERSION}"`,
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "Accept":
      accept ??
      (kind === "document"
        ? "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"
        : "*/*"),
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br, zstd",
  };

  if (kind === "document") {
    headers["Sec-Fetch-Dest"] = "document";
    headers["Sec-Fetch-Mode"] = "navigate";
    headers["Sec-Fetch-Site"] = referer ? "same-origin" : "none";
    headers["Sec-Fetch-User"] = "?1";
    headers["Upgrade-Insecure-Requests"] = "1";
  } else {
    headers["Sec-Fetch-Dest"] = "empty";
    headers["Sec-Fetch-Mode"] = "cors";
    headers["Sec-Fetch-Site"] = "same-origin";
  }

  if (referer) headers["Referer"] = referer;
  if (cookieHeader) headers["Cookie"] = cookieHeader;
  if (contentType) headers["Content-Type"] = contentType;
  if (extra) Object.assign(headers, extra);

  return headers;
}
