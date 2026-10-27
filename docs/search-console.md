# Connecting Google Search Console and Bing Webmaster Tools

Everything else in RankProof estimates. These two APIs do not — they report what the search engines actually recorded for a property you own. Connecting them is the single biggest quality upgrade available, and both are free.

## What changes once connected

| Without                                         | With                                                                                            |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Positions scraped from Bing, DDG, Mojeek, Brave | Real Google positions alongside them, with the gap shown                                        |
| Traffic modelled from a CTR curve               | Actual clicks and impressions                                                                   |
| "This keyword looks like an opportunity"        | "This keyword earns 2,000 impressions at position 6 — reaching position 3 is worth ~180 clicks" |
| No way to see snippet problems                  | CTR anomalies: ranks well, nobody clicks                                                        |
| No decay detection                              | Queries losing clicks while the position holds                                                  |

The report also states how far our CTR model sits from your measured reality, so you know how much to trust the modelled numbers on sites without a connection.

## Google Search Console

You need OAuth credentials with the read-only Search Console scope. This is private performance data, so there is no shortcut around the site owner's own authorisation.

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project and enable the **Google Search Console API**.
2. Create an **OAuth 2.0 Client ID** of type _Desktop app_.
3. Grant your account the `https://www.googleapis.com/auth/webmasters.readonly` scope and complete the consent flow to obtain a refresh token. Any standard OAuth helper works; the token exchange is a single POST to `https://oauth2.googleapis.com/token`.
4. Put the values in `.env`:

```bash
GOOGLE_OAUTH_CLIENT_ID=xxxxx.apps.googleusercontent.com
GOOGLE_OAUTH_CLIENT_SECRET=xxxxx
GOOGLE_OAUTH_REFRESH_TOKEN=1//xxxxx
```

For a quick test you can skip the refresh token and paste a short-lived access token instead:

```bash
GOOGLE_OAUTH_ACCESS_TOKEN=ya29.xxxxx
```

RankProof tries the property formats Search Console accepts, most specific first: `sc-domain:example.com`, then `https://example.com/`, `https://www.example.com/`, `http://example.com/`. If none is accessible the report says so rather than failing the scan.

Query rows are a bounded sample. Property-level clicks, impressions, CTR and average position are fetched separately without query dimensions; sums of query rows are not presented as site totals. A missing totals request remains unavailable.

### Data window

The last 28 days by default, plus the preceding 28 for comparison. Search Console lags about two days, so the window ends two days before today — asking for today returns nothing.

## Bing Webmaster Tools

Simpler: one API key, no OAuth.

1. Open [Bing Webmaster Tools](https://www.bing.com/webmasters), verify your site.
2. Settings → **API access** → generate a key.
3. Add it to `.env`:

```bash
BING_WEBMASTER_API_KEY=xxxxx
```

This is a useful cross-check, since our scraped positions lean on Bing's index.

## Verifying the connection

```bash
node bin/rankproof.mjs scan example.com --webmaster --format json --out private-report.json
```

Only an explicit local `scan --webmaster` reads these server credentials. Web scans and the public HTTP API never use them. Keep the resulting report private; it can contain query-level performance data.

## Privacy

Credentials are read from the environment and used only to call the two APIs. Nothing is stored: performance data lives in the report you generate and is never written to the scan history tables.

Public API and Web UI scan options cannot opt into operator credentials. API authentication still controls who can spend your server's crawling budget. See [`SECURITY.md`](../SECURITY.md).
