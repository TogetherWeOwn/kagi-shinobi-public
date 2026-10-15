// Coverage for the shared URL helpers. Both are used on untrusted input —
// scraped hrefs and caller-supplied summarize targets — so the invalid-input
// branches matter as much as the happy path.

import { describe, expect, it } from "vitest";
import { domainFromUrl, isHttpUrl } from "../../src/util/url";

describe("domainFromUrl", () => {
  it("returns the bare hostname", () => {
    expect(domainFromUrl("https://example.com/a/b?c=1")).toBe("example.com");
  });

  it("strips a leading www.", () => {
    expect(domainFromUrl("https://www.example.com/")).toBe("example.com");
  });

  it("strips www. only at the start, not mid-host", () => {
    expect(domainFromUrl("https://api.www.example.com/")).toBe("api.www.example.com");
  });

  it("keeps subdomains other than www", () => {
    expect(domainFromUrl("https://news.example.co.uk/x")).toBe("news.example.co.uk");
  });

  it("lowercases the host as the URL parser does", () => {
    expect(domainFromUrl("https://EXAMPLE.com/")).toBe("example.com");
  });

  it("drops port, auth, and hash", () => {
    expect(domainFromUrl("https://user:pw@example.com:8443/x#frag")).toBe("example.com");
  });

  it("returns empty string on unparseable input", () => {
    expect(domainFromUrl("not a url")).toBe("");
    expect(domainFromUrl("")).toBe("");
  });
});

describe("isHttpUrl", () => {
  it("accepts http and https", () => {
    expect(isHttpUrl("http://example.com")).toBe(true);
    expect(isHttpUrl("https://example.com")).toBe(true);
  });

  it("rejects other schemes", () => {
    // javascript:/data: matter here — these reach the summarizer from callers.
    expect(isHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isHttpUrl("data:text/html,<script>")).toBe(false);
    expect(isHttpUrl("ftp://example.com")).toBe(false);
    expect(isHttpUrl("file:///etc/passwd")).toBe(false);
  });

  it("rejects unparseable input", () => {
    expect(isHttpUrl("not a url")).toBe(false);
    expect(isHttpUrl("")).toBe(false);
  });

  it("is case-insensitive on the scheme", () => {
    expect(isHttpUrl("HTTPS://example.com")).toBe(true);
  });
});
