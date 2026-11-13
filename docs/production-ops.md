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

RankProof is **not published to the npm registry yet**. Install from a clone (or a
GitHub release tarball) until a separate publish gate lands:

```bash
git clone https://github.com/CometWeb-io/rankproof.git
cd rankproof
npm ci
npm run build:cli   # optional: emit dist/ for packaged CLI
node bin/rankproof.mjs doctor
```

The package ships a compiled CLI (`dist/`) via `prepack` when maintainers do
publish. Until then, `npm install rankproof` will 404.

When publishing becomes intentional:

```bash
npm run check
npm run build:cli
npm pack --dry-run   # inspect tarball contents
npm publish --tag next   # or --tag latest after GA validation
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

Set `DATABASE_URL` for persistent scan history and saved lists across restarts. Without it, embedded PGLite keeps them in memory and they are lost when the process restarts (the build copies PGLite's data files next to the server bundle so this fallback works in built apps).

### Saved lists

`/monitors` stores link lists (up to 200 pairs, 50 lists per user, 30 runs per list) in `link_monitors` and `link_monitor_runs` (migration `0005`). Every query is scoped by the user id from the verified session. With sign-in off and no database, one local user owns everything — fine on a laptop. With `DATABASE_URL` set, saved lists require sign-in (`BETTER_AUTH_SECRET`): the app refuses to share one anonymous user on a real database. A run verifies the whole list in one server request (batches of 50), so allow function timeouts of a few minutes on serverless hosts, or keep lists short. Runs store observations, not HTML; for archivable evidence use `rankproof verify --history`.

#### Scheduled runs

A list can be checked every day or every week, and post a short summary to a Slack, Discord or other `https://` webhook when a run finds a change. Scheduling needs one secret and something that calls the app regularly:

1. Set `RANKPROOF_CRON_SECRET` (16+ characters; on Vercel, `CRON_SECRET` works too).
2. Call `GET` or `POST /api/cron/monitors` with `Authorization: Bearer <secret>` — hourly is a good rhythm. On Vercel, add to `vercel.json`:

   ```json
   { "crons": [{ "path": "/api/cron/monitors", "schedule": "17 * * * *" }] }
   ```

   (Hobby plans allow daily crons only: use `"17 6 * * *"`.) Anywhere else: `curl -fsS -H "Authorization: Bearer $RANKPROOF_CRON_SECRET" https://your-app/api/cron/monitors`.

Each call runs at most `RANKPROOF_CRON_MAX_LISTS` (default 5) due lists within about four minutes and answers with counts only (`ran`, `failed`, `notified`, `remaining`); lists still due wait for the next call. Every list is claimed before it runs, so overlapping calls never run it twice. Without a secret the endpoint answers 404. Webhook URLs must be `https://` and pass the crawler's URL policy, including DNS, when the message is sent; a failed run or webhook is shown on the list. Set `PUBLIC_ORIGIN` so messages link back to the app.

### Required environment

| Variable                     | Production value                                                                                                                  |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `PUBLIC_ORIGIN`              | Your public URL (if using auth callbacks)                                                                                         |
| `BETTER_AUTH_SECRET`         | Random 32+ byte secret when auth is enabled                                                                                       |
| `BETTER_AUTH_URL`            | Public origin, e.g. `https://rankproof.example.com`                                                                               |
| `DATABASE_URL`               | Postgres connection string                                                                                                        |
| `RANKPROOF_USER_AGENT`       | Include a contact URL site owners can reach                                                                                       |
| `RANKPROOF_CRAWLER_IDENTITY` | `browser` (default) or `rankproof`: page fetches send `RANKPROOF_USER_AGENT` so publishers see who reads them (some may block it) |

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

| Signal                              | Meaning                                                      |
| ----------------------------------- | ------------------------------------------------------------ |
| `doctor` exit 1                     | All engines blocked or parsers broken — investigate fixtures |
| Rising CAPTCHA rate in scan notes   | Reduce concurrency or enable disk cache                      |
| Scan duration p95 over budget       | Raise `RANKPROOF_SCAN_BUDGET_MS` or reduce keyword depth     |
| Empty backlink lists on known sites | Source API change — check `sources` tab and GitHub issues    |

## Container

```bash
docker build -t rankproof .                          # CLI + API, no browser
docker build -t rankproof:render --target render .   # + Playwright and Chromium
docker run --rm -v "$PWD:/work" rankproof verify /work/links.csv --format html --out /work/report.html
docker run --rm -p 8787:8787 -e RANKPROOF_API_TOKEN=change-me rankproof api
```

The image runs as the unprivileged `node` user with `RANKPROOF_PIN_DNS=1`, contains only the engine and its three runtime packages, and has a health check. Inside the container `api` binds to all interfaces so the port can be published; keep a token and a reverse proxy in front of it. The web UI is not included.

## Rendered verification

`RANKPROOF_RENDER=1` lets API and web callers ask for a headless Chromium check. It is off by default because a browser is a much larger attack surface than an HTML parser:

- Install it deliberately: `npm install playwright && npx playwright install --with-deps chromium`, or point `RANKPROOF_CHROMIUM_PATH` at a maintained Chrome/Chromium and keep it patched.
- Set `RANKPROOF_PIN_DNS=1` (the Docker image does): Chromium then makes no connections of its own, every request — including each redirect hop — is checked and performed by the pinned network layer, and the browser is launched behind a proxy address that refuses every connection, so anything that escapes the interceptor fails closed. Still run the renderer in a container or network namespace without access to internal services or cloud metadata as defence in depth.
- Keep API rate limits on: each rendered page costs a browser context for up to 15 s (90 s per batch). At most `RANKPROOF_RENDER_CONCURRENCY` browsers (default `1`, maximum `8`) run at once per process; other render batches wait for a slot inside their own time budget, and pages not started in time are errors, never absences.
- Images, media, fonts, service workers and downloads are blocked. WebSockets are closed by the interceptor before any connection to the server is opened. No single response is passed to the page above 5 MB (without pinning, Playwright's own network stack has already read such a body before it is refused). Bot challenges are never solved.
- A source whose rendered page ends up on the target's own site is reported as an internal link (error), as in the fetched path.

## Owner data

Search Console and Bing Webmaster data are attached to web and API scans only for hosts listed in `RANKPROOF_OWNER_SITES` (comma-separated). Without it, a shared deployment never shows the operator's private performance data to other callers. The CLI is run by the operator and attaches it for any property the credentials can read.

## Security reminders

- Do not expose the API on `0.0.0.0` without auth and rate limits.
- Rotate OAuth refresh tokens if a host is compromised.
- Report SSRF bypasses privately — see [`SECURITY.md`](../SECURITY.md).
