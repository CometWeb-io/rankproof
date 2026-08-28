# Security policy

## Reporting a vulnerability

**Do not open a public issue** for a security flaw. Email `security@cometweb.io` or use GitHub's private vulnerability reporting (*Security* tab → *Report a vulnerability*).

We respond within 5 working days. If the issue is real, we agree a disclosure timeline together with the reporter.

## In scope

We are particularly interested in:

- **SSRF** — the scanner fetches URLs supplied by the user. Any path that reaches internal resources (`localhost`, `169.254.169.254`, private ranges, cloud metadata) is a vulnerability. Requests are guarded in `src/lib/backlinks/ssrf.ts`: protocol allow-list, no embedded credentials, DNS resolved and validated before connecting, and redirects followed manually so every hop is re-checked. Set `RANKPROOF_PIN_DNS=1` to connect via the validated IP (Host/SNI preserved) and close the remaining DNS-rebinding TOCTOU between lookup and connect. **A bypass of any of these is in scope.**
- **SQL injection** in the scan-history layer.
- **XSS** in the HTML report — it embeds titles and snippets taken from other people's pages.
- **Credential leaks** through logs or API responses — particularly Google OAuth tokens and the Bing Webmaster key, which grant access to private analytics.
- **Denial of service** through missing limits in `scripts/serve-api.mjs`.

## Out of scope

- Scan results that disagree with a commercial tool — that is a different methodology, not a security bug (see `docs/metrics.md`).
- Blocks and CAPTCHAs from search engines under aggressive settings.
- Automated scanner output with no demonstrated impact.

## Running it yourself

The HTTP API listens on `127.0.0.1` by default. **Exposing it publicly without a reverse proxy providing authentication and rate limiting means anyone can use your server to query other people's sites — and, if you have connected Search Console, to read your own performance data.** The server owner carries that responsibility.

Credentials are read from the environment and never written to the database. If you deploy publicly, treat `GOOGLE_OAUTH_*` and `BING_WEBMASTER_API_KEY` as you would any production secret.
