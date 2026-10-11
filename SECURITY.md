# Security policy

## Reporting a vulnerability

**Do not open a public issue** for a security flaw. Email `hello@cometweb.io` or use GitHub's private vulnerability reporting (_Security_ tab → _Report a vulnerability_).

We respond within 5 working days. If the issue is real, we agree a disclosure timeline together with the reporter.

## In scope

We are particularly interested in:

- **SSRF** — the scanner fetches URLs supplied by the user. Any path that reaches internal resources (`localhost`, `169.254.169.254`, private ranges, cloud metadata) is a vulnerability. Requests are guarded in `src/lib/backlinks/ssrf.ts`: protocol allow-list, no embedded credentials, DNS resolved and validated before connecting, and redirects followed manually so every hop is re-checked. In production, connections use pinned validated IPs (Host/SNI preserved) by default. Avoid `RANKPROOF_PIN_DNS=0` on untrusted networks. **A bypass of these protections is in scope.**
- **SQL injection** in the scan-history layer.
- **XSS** in the HTML report — it embeds titles and snippets taken from other people's pages.
- **Credential leaks** through logs or API responses — particularly Google OAuth tokens and the Bing Webmaster key, which grant access to private analytics.
- **Denial of service** through missing limits in `scripts/serve-api.mjs`.

## Out of scope

- Scan results that disagree with a commercial tool — that is a different methodology, not a security bug (see `docs/metrics.md`).
- Blocks and CAPTCHAs from search engines under aggressive settings.
- Automated scanner output with no demonstrated impact.

## Running it yourself

The HTTP API listens on `127.0.0.1` by default. Binding beyond loopback requires `RANKPROOF_API_TOKEN` and Bearer authentication; the standalone API also caps concurrent scans and request rates. Environment-backed Search Console and Bing Webmaster data are **never returned by public HTTP or Web UI scans**: only the trusted local CLI can opt in. Exposed installations still need TLS, a reverse proxy and egress controls. The Web UI uses in-process concurrency limits and needs additional proxy-level authorization and rate limiting when publicly reachable.

Credentials are read from the environment and never written to the database. If you deploy publicly, treat `GOOGLE_OAUTH_*` and `BING_WEBMASTER_API_KEY` as you would any production secret.
