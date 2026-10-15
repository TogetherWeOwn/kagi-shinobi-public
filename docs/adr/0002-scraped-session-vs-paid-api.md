# ADR 0002 — Scraped session vs. paid API

**Status:** Accepted — 2026-07-11
**Deciders:** @Rick7C2

## Context

Kagi exposes its search + summarizer through two authentication mechanisms:

1. A **`kagi_session` cookie** issued to logged-in browsers. Reaches the same
   HTML endpoints (`kagi.com/html/search`, `kagi.com/summarizer`) a normal user
   sees. Free (comes with the Kagi Ultimate subscription); the account's
   personalization applies automatically.
2. A **paid REST API** at `api.kagi.com` (two roots, `/v0` and `/v1`). Priced
   per call. Personalization is per-request via a `personalizations{}` field.

The worker must serve operators who have either, neither (bootstrap), or both.

## Decision

- **Scrape mode is the free default.** Session cookie via `KAGI_SESSION_TOKEN`
  secret, auto-refresh via Cloudflare Browser Rendering + Puppeteer.
- **API mode is opt-in** — requires `KAGI_API_KEY` secret AND
  `MAX_API_CENTS_PER_MONTH > 0`. Both defaults are the safest possible
  (unset / 0).
- **Hybrid mode** is auto-picked when both are configured; scrape is preferred
  wherever it can serve (per user directive: "scrape for anything scrape can
  do; API for the rest").
- The scraper stack fails fast when the session has been stale for >12h AND
  refresh keeps failing — better a 503 than a silent 401 storm.

## Consequences

**Positive**
- Free scrape path preserves the original single-mode server's behavior.
- Muriel guard, monthly cost cap, and per-bearer rate limits mean paid usage
  requires deliberate opt-in.
- CAPTCHA webhook (`CAPTCHA_WEBHOOK_URL`) surfaces refresh failures before
  the session decays past 12h.

**Negative**
- Scrape is fragile — Kagi HTML changes break parsers; we mitigate with
  fixture-based tests.
- Session cookie theft has broader consequences than a scoped API key.
