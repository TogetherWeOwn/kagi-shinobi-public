# kagi-shinobi — Implementation Plan

> **Status:** Approved 2026-07-10. Implementation in progress.
> **Location:** the `kagi-shinobi` repository working copy

## Locked decisions (from review)

1. **Token strategy: C (Hybrid).** KV-cached manual token as primary; Browser
   Rendering refresh triggered on 401; `/admin/token` always available as
   manual override.
2. **Name: `kagi-shinobi`.**
3. **Deploy: existing CF account, `*.workers.dev` subdomain.** No custom
   domain for v1.
4. **`/mcp` bearer-gated:** required.
5. **Direct HTTP endpoints (`/search`, `/summarize`) kept AND bearer-gated.**
   Every non-`/health` endpoint requires the bearer token. `ADMIN_TOKEN`
   secret is the single shared bearer.

## Name rationale

**kagi-shinobi** — "shinobi" (忍び) means shadow/stealth in Japanese, matching the
requirement to disguise requests as a normal Chrome browser. Pairs naturally with
`kagi` (key/search) and `ken` (fist/technique) from the upstream libraries.

If you'd rather use a different name (`kagi-gate`, `kensaku`, `kagi-relay`, or your
own pick), say so and I'll rename before scaffolding.

## What we're building

A single **Cloudflare Worker** that:

1. Wraps `czottmann/kagi-ken` so it runs in the Workers runtime.
2. Exposes a **remote MCP server** (Streamable HTTP transport) equivalent to
   `czottmann/kagi-ken-mcp`, so any MCP client (Claude Desktop/Code, MCP Inspector,
   etc.) can connect to `https://kagi-shinobi.<subdomain>.workers.dev/mcp`.
3. Also exposes a plain HTTP JSON API at `/search` and `/summarize` for non-MCP
   callers (curl, scripts, other agents).
4. Manages the Kagi session token in **Workers KV** with automatic refresh when the
   token expires (approach picked below — needs your input).
5. Sends **Chrome browser headers** on every request to Kagi (not the Safari UA
   that upstream `kagi-ken` hardcodes).

## Key research findings

### kagi-ken (upstream)
- Node ESM, only runtime dep is `cheerio` (works on Workers under `nodejs_compat`).
- Endpoints hit: `GET kagi.com/html/search` (server-rendered HTML, parsed with
  cheerio) and `POST kagi.com/mother/summary_labs` (streaming JSON).
- Auth = `Cookie: kagi_session=<token>` header.
- **Hardcodes Safari UA** — we must override this. Confirmed by reading the source
  (`src/search.ts`, `src/summarize.ts` set `User-Agent` explicitly).

### kagi-ken-mcp (upstream)
- Node stdio MCP server. Only tools: `kagi_search_fetch`, `kagi_summarizer`.
- Reads token from `KAGI_SESSION_TOKEN` env or `~/.kagi_session_token` file.
- We won't reuse this package directly — we'll re-implement its two tools on top
  of our port of `kagi-ken`, using the Streamable HTTP MCP transport instead of
  stdio.

### Cloudflare best-practice bits that shape the design
- **`nodejs_compat` compat flag + compat date `2024-09-23` or later** is required
  for cheerio to work. Bundle overhead ≈100–150 KB compressed — safe under the
  1 MB free-tier Worker limit.
- **`agents` SDK + `McpAgent`** is the current Cloudflare-recommended way to host
  a remote MCP server. It handles Streamable HTTP and gives each session its own
  Durable Object for state.
- **Workers Secrets** (via `wrangler secret put`) for credentials; **Workers KV**
  for the live session token + cached metadata.
- **Cloudflare Browser Rendering** (Puppeteer-compatible, available on the
  Workers Paid plan and higher) is the cleanest way to log in to Kagi
  programmatically because Kagi's login flow requires JS/redirects.

## The hard problem: "automatically get the token as needed"

Kagi's session token is a browser cookie (`kagi_session`). Kagi does **not**
publish a `POST /login` returning a JSON token — the login flow uses either a
magic email link or a password form, plus JS-side redirects. That means there is
no way to obtain a fresh token from `email + password` with a plain `fetch()`
alone. You need to pick one of these:

### Option A — Manual token, KV-cached (simplest, cheapest, no CF paid features)
- You paste your current session token once via a protected admin endpoint
  (`POST /admin/token` with a bearer secret) or via `wrangler secret put`.
- Worker stores it in KV and uses it for every request.
- When Kagi returns 401 / login redirect, worker marks the token stale and
  returns a clear "please refresh token" error. You paste a new one when it
  breaks.
- **Free-tier friendly.** No Browser Rendering. Truly automatic ≠ possible here,
  but very low maintenance because Kagi session tokens are long-lived
  (months, in practice).

### Option B — Browser Rendering auto-refresh (fully automatic)
- Store your Kagi email + password (or a saved auth state / cookies from a
  previous manual login) as Workers Secrets.
- On boot and on 401, a Durable Object triggers a Browser Rendering session:
  Puppeteer opens `kagi.com/signin`, submits credentials, waits for the redirect,
  reads the `kagi_session` cookie, writes it into KV.
- Requires the **Workers Paid plan** (~$5/mo) for Browser Rendering, or the free
  tier's 10-minute-per-day allotment.
- Handles 2FA only if you disable it or plumb TOTP through as a secret.

### Option C — Hybrid (recommended)
- Primary path = Option A (KV-cached manual token, works forever if you never
  hit a 401).
- Refresh path = Option B triggered only when the primary path fails, guarded by
  a config flag so you can turn Browser Rendering off if you don't want to pay.
- Admin endpoint always available as manual override.

**→ Please pick A, B, or C before I build.** My recommendation is **C** — you get
"set it and forget it" behavior if you want to pay for Browser Rendering, and a
zero-cost fallback if you don't.

## Chrome-header strategy

kagi-ken's fetch calls are internal, so we can't just pass headers in. Two clean
options:

1. **Fork the two files** (`search.ts`, `summarize.ts`) into `src/kagi/` and swap
   the `User-Agent` + add `sec-ch-ua`, `sec-ch-ua-mobile`, `sec-ch-ua-platform`,
   `Accept-Language`, `Accept-Encoding`, `Sec-Fetch-*` headers to match a current
   stable Chrome on Windows. Keep the file structure close to upstream so we can
   rebase easily.
2. **Wrap globalThis.fetch** at Worker startup with a per-request override for
   any `kagi.com` URL. Cleaner (no vendored code) but relies on kagi-ken not
   calling fetch in a way that resists override.

**→ I'll go with (1)** — vendored copies of the two files, kept minimal, with a
`// upstream: kagi-ken@<version>/src/search.ts` header so future rebases are
mechanical. Option 2 is fragile if upstream ever switches to `undici` or a
custom client.

Header set (Chrome 131 on Windows, current stable as of July 2026):

```
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36
sec-ch-ua: "Chromium";v="131", "Not_A Brand";v="24", "Google Chrome";v="131"
sec-ch-ua-mobile: ?0
sec-ch-ua-platform: "Windows"
Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8
Accept-Language: en-US,en;q=0.9
Accept-Encoding: gzip, deflate, br, zstd
Sec-Fetch-Dest: document
Sec-Fetch-Mode: navigate
Sec-Fetch-Site: none
Sec-Fetch-User: ?1
Upgrade-Insecure-Requests: 1
```

Header casing matters for stealth — we'll preserve Chrome's exact ordering and
lowercase where Chrome uses lowercase.

## Proposed file layout

```
kagi-shinobi/
├── PLAN.md                     ← this file
├── README.md                   ← generated after approval
├── package.json
├── tsconfig.json
├── wrangler.jsonc              ← Worker config, KV binding, secrets list, compat flags
├── .dev.vars.example           ← template for local secrets
├── .gitignore
├── src/
│   ├── index.ts                ← Worker entry: routes /mcp, /search, /summarize, /admin/*
│   ├── mcp.ts                  ← McpAgent subclass, exposes kagi_search_fetch + kagi_summarizer
│   ├── kagi/
│   │   ├── search.ts           ← vendored + Chrome-header-patched from kagi-ken
│   │   ├── summarize.ts        ← vendored + Chrome-header-patched from kagi-ken
│   │   ├── languages.ts        ← SUPPORTED_LANGUAGES table
│   │   └── headers.ts          ← Chrome header factory (single source of truth)
│   ├── token/
│   │   ├── store.ts            ← KV read/write, staleness check
│   │   ├── refresh.ts          ← Browser Rendering login flow (Option B/C only)
│   │   └── admin.ts            ← /admin/token endpoint, bearer-secret protected
│   └── util/
│       ├── errors.ts           ← typed error responses
│       └── log.ts              ← structured logs (workers observability)
└── test/
    ├── search.test.ts          ← Vitest + @cloudflare/vitest-pool-workers, MSW mocks Kagi
    ├── summarize.test.ts
    └── mcp.test.ts             ← spins up McpAgent, asserts tool schemas
```

## Runtime dependencies (planned)

- `agents` (Cloudflare Agents SDK — for `McpAgent`)
- `@modelcontextprotocol/sdk` (transitive; comes with `agents`)
- `cheerio` (HTML parsing for search results)
- `zod` (MCP tool argument schemas; already used by agents SDK)
- Dev: `wrangler`, `typescript`, `vitest`, `@cloudflare/vitest-pool-workers`,
  `@cloudflare/workers-types`

**Only** cheerio for runtime — matches upstream. No lodash, no polyfill kitchen
sink.

## wrangler.jsonc highlights

```jsonc
{
  "name": "kagi-shinobi",
  "main": "src/index.ts",
  "compatibility_date": "2026-07-01",
  "compatibility_flags": ["nodejs_compat"],
  "durable_objects": { "bindings": [{ "name": "MCP", "class_name": "KagiMcpAgent" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["KagiMcpAgent"] }],
  "kv_namespaces": [{ "binding": "TOKEN_KV", "id": "<created by wrangler>" }],
  "observability": { "enabled": true },
  // For Option B/C:
  "browser": { "binding": "BROWSER" }
}
```

Secrets (via `wrangler secret put`):
- `ADMIN_TOKEN` — bearer for `/admin/*` endpoints.
- `KAGI_SESSION_TOKEN` — initial token (Option A always, seed value for C).
- `KAGI_EMAIL`, `KAGI_PASSWORD` — only if Option B or C chosen.

## HTTP surface

| Path | Method | Auth | Purpose |
|---|---|---|---|
| `/mcp` | POST/GET | none (or optional bearer) | MCP Streamable HTTP endpoint |
| `/search` | POST `{query}` | optional bearer | Direct search (JSON schema matches Kagi API) |
| `/summarize` | POST `{url\|text, ...}` | optional bearer | Direct summarize |
| `/admin/token` | POST `{token}` | required bearer | Rotate session token manually |
| `/admin/refresh` | POST | required bearer | Trigger Browser Rendering refresh (B/C only) |
| `/health` | GET | none | Liveness + token-staleness indicator |

The MCP endpoint hosts two tools with schemas identical to upstream
`kagi-ken-mcp`:
- `kagi_search_fetch(queries: string[])`
- `kagi_summarizer(url?, text?, summary_type?, target_language?)`

## Testing strategy

- **Unit tests** for search/summarize HTML parsing use recorded Kagi HTML
  fixtures (checked into `test/fixtures/`) — never hit real Kagi in CI.
- **MCP tests** spin up the Durable Object via `@cloudflare/vitest-pool-workers`
  and drive the JSON-RPC handshake.
- **Manual smoke test** after deploy: `curl` and MCP Inspector against the live
  Worker.

## Open questions for you

1. **Token strategy: A, B, or C?** (My rec: C.)
2. **Name confirmation:** `kagi-shinobi` OK, or different?
3. **Deployment plan:** Deploy under your existing Cloudflare account
   (`wrangler.jsonc` uses your default), or set up a new one? Any custom domain
   (`kagi.yourdomain.tld`) or is the `*.workers.dev` subdomain fine?
4. **MCP endpoint auth:** open to the world, or bearer-token gated? (Even though
   the token is on the server side, an open `/mcp` means anyone can burn your
   Kagi searches. **I recommend bearer gating**, same secret as `ADMIN_TOKEN`.)
5. **Direct HTTP endpoints (`/search`, `/summarize`):** keep them, or MCP-only?

Once you answer 1–5 I'll scaffold the project and start implementing.
