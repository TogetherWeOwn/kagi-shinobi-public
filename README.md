# kagi-shinobi

Cloudflare Worker that fronts Kagi's search and summarizer through a session
token, exposing them both as a **remote MCP server** and a **REST API**. Uses
Chrome browser headers on every upstream call and refreshes its session token
automatically via Cloudflare Browser Rendering when the current one expires.

Built on top of [`czottmann/kagi-ken`](https://github.com/czottmann/kagi-ken)
(ported to Workers) and modeled after
[`czottmann/kagi-ken-mcp`](https://github.com/czottmann/kagi-ken-mcp) (ported
from stdio to Streamable HTTP).

## Endpoints

| Path | Method | Auth | Purpose |
|---|---|---|---|
| `/mcp` | POST/GET | Admin or client key | MCP Streamable HTTP transport (McpAgent) |
| `/search` | POST `{queries, limit?, engine?}` | Admin or client key | Direct search — max 20 queries per request; `engine` is `kagi` (default), `searxng`, or `auto` |
| `/search` | GET `?q=&format=json&limit=` | Admin or client key | One query, SearXNG-shaped `{results:[{url,title,content}]}` for `json_engine` |
| `/summarize` | POST `{url, summary_type?, target_language?}` | Admin | Direct summarize |
| `/admin/token` | POST `{token}` | Admin | Manually rotate session token |
| `/admin/refresh` | POST | Admin | Force Browser Rendering refresh |
| `/health` | GET | none / Bearer | Liveness for anyone; token-staleness detail plus the deployed `BUILD_SHA` only with the Bearer |

The admin bearer is the `ADMIN_TOKEN` secret. Use `Authorization: Bearer <token>`.

### Scoped client keys

To give an integration its own credential without sharing `ADMIN_TOKEN`, set the
optional `CLIENT_KEYS` secret to a JSON map of client name to the hex SHA-256 of
that client's key (see [ADR 0013](docs/adr/0013-scoped-client-keys-and-searxng-get-search.md)):

```bash
KEY=$(openssl rand -hex 32)          # give this to the client
printf '%s' "$KEY" | sha256sum       # store only the digest
printf '{"searxng":"<digest>"}' | npx wrangler secret put CLIENT_KEYS
```

A client key reaches `/search` (GET and POST) and `/mcp` only; anything else
answers `403 forbidden-scope`. Per-client-key volume windows `CLIENT_KEY_RPM`
and `CLIENT_KEY_RPD` both default to `0` (disabled — no per-key volume cap),
on top of `PER_BEARER_RPM`. A 429 from a re-enabled window carries
`Retry-After`, so a SearXNG `json_engine` degrades to its other engines
instead of failing the query.

### Global Kagi call budget

Independently of who calls, every request that actually reaches Kagi passes
the global pacer: `KAGI_CALLS_PER_SECOND` (default 2, paced — callers wait out
the current second, bounded, before a `429` with `Retry-After`).
`KAGI_CALLS_PER_DAY` and `KAGI_CALLS_PER_MONTH` default to `0` (disabled — no
volume caps). A fan-out of N queries costs N pacer slots. When the Meter
counter itself is unreachable the pacer fails open (isolate-local slot queue
at the per-second rate, refusing past a 3 s wait, then admit) so search stays
up. `0` disables a window. See ADR 0019.

**SearXNG `json_engine`:**
```yaml
  - name: kagi
    engine: json_engine
    shortcut: kg
    search_url: https://<your-host>/search?q={query}&format=json
    headers:
      Authorization: Bearer <client key>
    results_query: results
    url_query: url
    title_query: title
    content_query: content
```

## MCP tools exposed

- `kagi_search_fetch({ queries: string[], limit?: number, engine?: "kagi"|"searxng"|"auto" })` — max 20 queries per call
- `kagi_summarizer({ url: string, summary_type?: "summary"|"takeaway", target_language?: string })`

Schemas match the upstream `kagi-ken-mcp` server so any client already
configured for it works with a URL change.

## Setup

```powershell
# 1. Install
npm install

# 2. Create the KV namespace and copy the id into wrangler.jsonc
wrangler kv namespace create TOKEN_KV

# 3. Set secrets
wrangler secret put ADMIN_TOKEN          # openssl rand -hex 32
wrangler secret put KAGI_SESSION_TOKEN   # from kagi.com/settings
wrangler secret put KAGI_EMAIL           # optional, for auto-refresh
wrangler secret put KAGI_PASSWORD        # optional, for auto-refresh

# 4. Deploy
wrangler deploy
```

For local dev, copy `.dev.vars.example` to `.dev.vars`, fill in values, then
`npm run dev`.

## SearXNG fallback engine

Kagi scrape mode rides one personal subscription, so it must stay
human-scale. A self-hosted SearXNG instance is free and unlimited but noisier — use it as the
fallback tier via the `engine` param on `POST /search` and
`kagi_search_fetch`: `kagi` (default, current behavior), `searxng` (straight
to the fallback), or `auto` (Kagi while under budget and the session is
healthy, otherwise SearXNG, with the switch recorded in `meta.warnings`).
Results keep the same schema either way (`source_impl: "searxng"`).

Setup (operator deployment work, through the gated deploy path):

```powershell
# 1. Point the worker at your SearXNG instance — a Tunnel hostname (or binding),
#    never an IP, and never the Caddy /mcp-ext path
#    (wrangler.jsonc var; empty = fallback unconfigured)
#    "SEARXNG_BASE_URL": "https://searxng.<your-tunnel>.cfargotunnel.com"

# 2. Only when the Tunnel sits behind Cloudflare Access:
wrangler secret put SEARXNG_ACCESS_CLIENT_ID
wrangler secret put SEARXNG_ACCESS_CLIENT_SECRET
```

See [ADR 0014](docs/adr/0014-searxng-fallback-engine.md).

## Client config

**Claude Desktop / MCP Inspector — remote MCP:**
```json
{
  "mcpServers": {
    "kagi-shinobi": {
      "url": "https://kagi-shinobi.<your-subdomain>.workers.dev/mcp",
      "headers": { "Authorization": "Bearer <your ADMIN_TOKEN>" }
    }
  }
}
```

**curl — direct search:**
```bash
curl -X POST https://kagi-shinobi.<subdomain>.workers.dev/search \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"queries":["cloudflare workers durable objects"],"limit":5}'
```

## Token auto-refresh (Option C hybrid)

- Primary: the `KAGI_SESSION_TOKEN` secret / KV cache is used for every request.
- On upstream `401`/`403`: the worker marks the KV entry stale and, if
  `AUTO_REFRESH_ENABLED=true` and Browser Rendering is available, spawns a
  Puppeteer session that logs into Kagi with `KAGI_EMAIL`/`KAGI_PASSWORD`,
  reads the fresh `kagi_session` cookie, and writes it to KV.
- Manual override: `POST /admin/token` accepts a new token any time.
- If auto-refresh is disabled or fails, `/search` and `/summarize` return
  `401 kagi-token-stale` and `/health` reports `"token": "stale"` — to callers
  presenting the Bearer. Without it, `/health` returns `{"ok": true}` only.

Set `AUTO_REFRESH_ENABLED=false` in `wrangler.jsonc` `vars` if you don't want
to pay for Browser Rendering — you'll rotate tokens manually via
`/admin/token`.

## License

MIT. Upstream `kagi-ken` and `kagi-ken-mcp` are also MIT — see `src/kagi/*`
for attribution headers on ported files.
