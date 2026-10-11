# RankProof

Audit search visibility, backlinks and internal links from your own machine. Inspect the evidence behind a finding and export the results.

![RankProof discovers public signals, verifies source pages, and produces a report with explicit gaps.](docs/media/overview.svg)

[![CI](https://github.com/CometWeb-io/rankproof/actions/workflows/ci.yml/badge.svg)](https://github.com/CometWeb-io/rankproof/actions/workflows/ci.yml)
[![MIT](https://img.shields.io/badge/license-MIT-034C32)](LICENSE)

**Node.js 22+ · Web UI, CLI and HTTP API · Version 8.1.0**

## Run locally

```bash
git clone https://github.com/CometWeb-io/rankproof.git
cd rankproof
npm ci
npm run dev
```

Open **http://localhost:8080**. Local history uses embedded PGLite when `DATABASE_URL` is unset (in memory by default; set `RANKPROOF_PGLITE_DIR` for disk persistence). The development server binds to localhost.

![The local RankProof app with domain, market and device controls, before running a scan.](docs/media/app.png)

## Try the CLI

```bash
npm run cli -- help
npm run cli -- scan example.com --market us --format json --out report.json
```

Replace `example.com` with a public site you are authorized to audit. Scans make network requests; engine blocks and missing data remain visible in the results.

![Actual local CLI help output, showing available commands without running a website scan.](docs/media/cli.gif)

_Animated excerpt of actual local command output. [Static version](docs/media/cli.png)._

## What can I inspect?

| Area              | Output                                                            |
| ----------------- | ----------------------------------------------------------------- |
| Search visibility | Positions, keyword ideas, SERP overlap and scan history           |
| Backlinks         | HTML-verified links distinguished from source-API observations   |
| Site structure    | Internal links, redirects, canonical issues and orphan candidates |
| Comparison        | Link gaps and changes between scans                               |
| Reporting         | JSON, CSV and a standalone HTML report                            |

Bing, DuckDuckGo and Mojeek are enabled by default; Brave is optional. **Google organic results require a separately configured provider.** Search Console supplies data for a property you control. See [providers](docs/providers.md) and [Search Console setup](docs/search-console.md).

## Know what the numbers mean

- Discovery is incomplete: a missing backlink is not proof that it does not exist.
- Traffic estimates and difficulty scores are models, not measured visits or third-party SEO metrics.
- CAPTCHA or blocked requests are measurement gaps, not zero rankings.
- Risk scores and disavow exports require human review.

Read the [metric definitions](docs/metrics.md) before comparing scores.

## Go further

| Task                                  | Guide                                                     |
| ------------------------------------- | --------------------------------------------------------- |
| CLI commands and flags                | [CLI reference](docs/cli.md)                              |
| Run the HTTP service                  | [API reference](docs/api.md)                              |
| Configure engines and integrations    | [.env.example](.env.example)                              |
| Understand discovery and verification | [Architecture](docs/architecture.md)                      |
| Deploy beyond localhost               | [Production operations](docs/production-ops.md)           |
| Contribute or report a vulnerability  | [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) |

```bash
npm run check
npm run build
```

[MIT license](LICENSE). Bundled fonts use the [SIL Open Font License](public/fonts/OFL.txt). Maintained at [CometWeb](https://cometweb.io).

## Choose workload and cost

RankProof does not require paid SEO APIs or hosted infrastructure. Set `RANKPROOF_SCAN_PROFILE` to control the amount of work:

| Profile | Time budget | Backlink cap | Verification candidates | Notes |
| --- | ---: | ---: | ---: | --- |
| `quick` | 20 s | 160 | 24 | Skips expensive secondary discovery and internal crawl; incomplete by design |
| `standard` (default) | 58 s | 400 | 64 | Balanced free-data scan |
| `deep` | 180 s | 1200 | 200 | Wider evidence gathering; run locally |

These are **internal scan budgets and caps, not a guaranteed total runtime or an HTTP request count**. Network operations, optional integrations and the internal audit can extend elapsed time. Compare trends only across equivalent profiles and source coverage.

```bash
RANKPROOF_SCAN_PROFILE=quick node bin/rankproof.mjs scan example.com --format json --out quick.json
RANKPROOF_SCAN_PROFILE=deep node bin/rankproof.mjs scan example.com --format html --out deep.html
```
