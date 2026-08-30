# Production operations

This guide covers running RankProof in production: health checks, parser monitoring, npm distribution, and deployment patterns.

## Health and parser canary

The `doctor` command probes every SERP engine with a known query and exits non-zero when nothing works. Use it as a cron canary:

```bash
# Every 6 hours — alert when exit code ≠ 0
0 */6 * * * cd /opt/rankproof && ./node_modules/.bin/rankproof doctor --format json >> /var/log/rankproof-doctor.log 2>&1 || notify-admin
```

HTTP API equivalent (rate-limited like other endpoints):

```bash
curl -s http://127.0.0.1:8787/doctor | jq .
```

`GET /health` is a lightweight liveness probe and is not rate-limited.

## npm install

The package ships a compiled CLI (`dist/`) via `prepack`. Publish from a clean tree:

```bash
npm run check
npm run build:cli
npm pack --dry-run   # inspect tarball contents
npm publish --tag next   # or --tag latest after GA validation
```

Consumers install with:

```bash
npm install rankproof
rankproof scan example.com --format json
```

CI verifies the packed tarball installs into a path containing a space and runs `rankproof version`.

## Web app deployment

RankProof is a TanStack Start app. Typical self-host flow:

```bash
npm ci
npm run build          # vite build + db migrate
npm run preview -- --port 8080 --host 127.0.0.1
```

Put a reverse proxy (Caddy, nginx, Cloudflare Tunnel) in front with:

- TLS termination
- Authentication if exposed publicly (the scan endpoints accept URLs from callers)
- Rate limiting on `/scan`, `/doctor`, and related POST routes

Set `DATABASE_URL` for persistent scan history across restarts. Without it, embedded PGLite stores data locally inside the process working directory.

### Required environment

| Variable | Production value |
| --- | --- |
| `PUBLIC_ORIGIN` | Your public URL (if using auth callbacks) |
| `BETTER_AUTH_SECRET` | Random 32+ byte secret when auth is enabled |
| `BETTER_AUTH_URL` | Public origin, e.g. `https://rankproof.example.com` |
| `DATABASE_URL` | Postgres connection string |
| `RANKPROOF_USER_AGENT` | Include a contact URL site owners can reach |

Never expose `GOOGLE_OAUTH_*` or `BING_WEBMASTER_API_KEY` without treating the host as production.

## HTTP API

```bash
RANKPROOF_RATE_LIMIT=20 npm run api -- --port 8787 --host 127.0.0.1
```

Bind to loopback and proxy externally. See [`api.md`](api.md) for endpoints.

## Disk cache

For repeat scans of the same targets, enable conditional revalidation:

```bash
export RANKPROOF_CACHE_DIR=/var/cache/rankproof
```

Repeat requests send `If-None-Match` and take `304` responses when sources unchanged — fewer CAPTCHAs and less load on third-party servers.

## Google organic SERP

Scraping Google from RankProof is intentionally unsupported. For competitor Google positions, run a self-hosted JSON provider (e.g. [OpenSERP](https://openserp.org/docs/)) and set:

```bash
export RANKPROOF_GOOGLE_PROVIDER_URL=http://127.0.0.1:7000
```

See [`providers.md`](providers.md).

## Upgrade checklist

1. `git pull && npm ci`
2. `npm run check`
3. `npm run build`
4. `rankproof doctor` (or `/doctor` on the API)
5. Restart the process / reload the proxy
6. Spot-check one known domain in the UI or CLI

## Monitoring signals

| Signal | Meaning |
| --- | --- |
| `doctor` exit 1 | All engines blocked or parsers broken — investigate fixtures |
| Rising CAPTCHA rate in scan notes | Reduce concurrency or enable disk cache |
| Scan duration p95 over budget | Raise `RANKPROOF_SCAN_BUDGET_MS` or reduce keyword depth |
| Empty backlink lists on known sites | Source API change — check `sources` tab and GitHub issues |

## Security reminders

- Do not expose the API on `0.0.0.0` without auth and rate limits.
- Rotate OAuth refresh tokens if a host is compromised.
- Report SSRF bypasses privately — see [`SECURITY.md`](../SECURITY.md).
