// Public landing page served at GET / (no auth required).
//
// Inlined instead of using a static-assets binding so the worker stays a
// single deployable unit. The page is intentionally sparse — describes what
// the server is, points at the config snippet for clients, and never leaks
// tokens or endpoint internals beyond what the docs already publish.

export const LANDING_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>kagi-shinobi</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      max-width: 720px; margin: 3rem auto; padding: 0 1.25rem;
      color: #222; background: #fafafa;
    }
    @media (prefers-color-scheme: dark) {
      body { color: #e5e5e5; background: #121212; }
      code, pre { background: #1e1e1e !important; border-color: #333 !important; }
      a { color: #7aa2f7; }
    }
    h1 { font-size: 1.5rem; margin: 0 0 .25rem; }
    .sub { color: #888; margin: 0 0 2rem; }
    h2 { font-size: 1.05rem; margin: 2rem 0 .5rem; }
    code, pre {
      font-family: "SF Mono", ui-monospace, Menlo, Consolas, monospace;
      font-size: 13px; background: #f0f0f0; border: 1px solid #ddd;
      border-radius: 6px; padding: 2px 5px;
    }
    pre { padding: .75rem 1rem; overflow-x: auto; }
    ul { padding-left: 1.25rem; }
    li { margin: .25rem 0; }
    .pill {
      display: inline-block; padding: 1px 7px; border-radius: 999px;
      background: #e5e7eb; color: #374151; font-size: 12px; margin-left: .5em;
    }
    @media (prefers-color-scheme: dark) { .pill { background: #333; color: #ccc; } }
  </style>
</head>
<body>
  <h1>kagi-shinobi</h1>
  <p class="sub">A Cloudflare Worker exposing Kagi search, FastGPT, Summarizer, and Extract as an MCP server.</p>

  <h2>Endpoints</h2>
  <ul>
    <li><code>POST /mcp</code> &mdash; Streamable-HTTP MCP endpoint <span class="pill">bearer required</span></li>
    <li><code>POST /search</code> &mdash; REST search <span class="pill">bearer required</span></li>
    <li><code>POST /summarize</code> &mdash; REST summarizer <span class="pill">bearer required</span></li>
    <li><code>GET /health</code> &mdash; liveness <span class="pill">public</span>, token status <span class="pill">bearer required</span></li>
    <li><code>GET /</code> &mdash; this page <span class="pill">public</span></li>
  </ul>

  <h2>Add to your MCP client</h2>
  <pre><code>{
  "mcpServers": {
    "kagi-shinobi": {
      "url": "https://kagi-shinobi.&lt;your-subdomain&gt;.workers.dev/mcp",
      "headers": { "Authorization": "Bearer &lt;YOUR_ADMIN_TOKEN&gt;" }
    }
  }
}</code></pre>

  <h2>Modes</h2>
  <p>Set <code>KAGI_MODE</code> (default: <code>scrape</code>) to one of:</p>
  <ul>
    <li><code>scrape</code> &mdash; uses a Kagi session cookie only. Free features from the paid tier are unavailable.</li>
    <li><code>api</code> &mdash; uses <code>api.kagi.com</code> with <code>Authorization: Bot &lt;KAGI_API_KEY&gt;</code>. Every call bills at Kagi's published rate.</li>
    <li><code>hybrid</code> &mdash; scrape for anything the scraper can do; API for the rest.</li>
    <li><code>auto</code> &mdash; picks scrape / api / hybrid based on which secrets are set.</li>
  </ul>

  <h2>Cost guard</h2>
  <p>API calls are metered against <code>MAX_API_CENTS_PER_MONTH</code> (default <code>0</code> &mdash; every API call refuses until you raise the cap).</p>

  <h2>Source</h2>
  <p><a href="https://github.com/TogetherWeOwn/kagi-shinobi">github.com/TogetherWeOwn/kagi-shinobi</a></p>
</body>
</html>`;

export function landingResponse(): Response {
  return new Response(LANDING_HTML, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
