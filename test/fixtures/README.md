# Test fixtures

Recorded Kagi responses used by the parser tests. Tests never hit real Kagi in CI.

## Adding a new fixture

1. Reproduce the request locally with `curl` and the `kagi_session` cookie or the `Authorization: Bot` header.
2. Save the raw response body under the appropriate subdirectory:
   - `search/` — HTML from `kagi.com/html/search`
   - `summarize/` — NUL-delimited stream body from `kagi.com/mother/summary_labs`
   - `fastgpt/` — response body from `kagi.com/fastgpt` or `api.kagi.com/v0/fastgpt`
   - `api/v1/` — JSON from `api.kagi.com/v1/*`
   - `api/v0/` — JSON from `api.kagi.com/v0/*`
3. **Redact anything PII-shaped** — session cookies, email addresses, account IDs. The scraper doesn't care about surrounding chrome, only the result markup, so trim aggressively.
4. Add a test in the matching `test/{scrape,api}/` file referencing the fixture.

## Naming convention

`<endpoint>-<scenario>.<ext>` — e.g. `basic-results.html`, `zero-results.html`, `auth-error.json`.
