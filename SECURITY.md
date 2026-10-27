# Security policy

## Reporting a vulnerability

**Do not open a public issue** for a security flaw. Email `hello@cometweb.io` or use GitHub's private vulnerability reporting (_Security_ tab → _Report a vulnerability_).

We respond within 5 working days. If the issue is real, we agree a disclosure timeline together with the reporter.

## In scope

We are particularly interested in:

- **SSRF** — the scanner fetches URLs supplied by the user. Any path that reaches internal resources (`localhost`, `169.254.169.254`, private ranges, cloud metadata) is a vulnerability. Requests are guarded in `src/lib/backlinks/ssrf.ts`: protocol allow-list, no embedded credentials, DNS resolved and validated before connecting, and redirects followed manually so every hop is re-checked. Production requests pin the validated IP (Host/SNI preserved). Set `RANKPROOF_PIN_DNS=1` for non-production service deployments as well; public API startup refuses an unpinned network configuration. **A bypass of any of these is in scope.**
- **SQL injection** in the scan-history layer.
- **XSS** in the HTML report — it embeds titles and snippets taken from other people's pages.
- **Credential leaks** through logs or API responses — particularly Google OAuth tokens and the Bing Webmaster key, which grant access to private analytics.
- **Denial of service** through missing limits in `scripts/serve-api.mjs`.

## Out of scope

- Scan results that disagree with a commercial tool — that is a different methodology, not a security bug (see `docs/metrics.md`).
- Blocks and CAPTCHAs from search engines under aggressive settings.
- Automated scanner output with no demonstrated impact.

## Running it yourself

The HTTP API listens on `127.0.0.1` by default. Public binding requires `RANKPROOF_API_TOKEN` and DNS pinning, with built-in admission and rate limits. A reverse proxy should provide TLS and deployment-specific access controls. Web/API scans never read server Google/Bing webmaster credentials; private performance data requires an explicit local `scan --webmaster`.

Credentials are read from the environment and never written to the database. If you deploy publicly, treat `GOOGLE_OAUTH_*` and `BING_WEBMASTER_API_KEY` as you would any production secret.
