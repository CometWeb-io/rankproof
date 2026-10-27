# RankProof

Audit search visibility, backlinks and internal links from your own machine. Inspect the evidence behind a finding and export the results.

Measurements retain source, method, scope and uncertainty. A blocked source is an unavailable observation; a missing discovery result does not establish link loss.

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

Open **http://localhost:8080**. Local history uses in-memory PGLite when `DATABASE_URL` is unset and resets on restart. The development server binds to localhost.

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
| Backlinks         | Discovered links checked against source-page HTML                 |
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

## Evidence workflows

```bash
node bin/rankproof.mjs analyze report.json --out decisions.json
node bin/rankproof.mjs ledger report.json --out evidence.json
node bin/rankproof.mjs graph report.json --format csv --out repair-urls.csv
node bin/rankproof.mjs citations citation-dataset.json --out citations.json
npm run benchmark:accuracy
```

These export commands replay local inputs without provider calls. The benchmark uses labelled synthetic cases and does not certify real-world accuracy. Citation datasets distinguish observed captures from synthetic samples.

The [evidence ledger](docs/evidence-ledger.md) describes immutable Web history and comparable cohorts. [Intelligence](docs/intelligence.md) covers technical graphs, cited recommendations and citation replay. Optional [isolated Chromium rendering](renderer/README.md) compares fetched HTML with a bounded DOM snapshot using a separately provisioned, pinned runtime. Ordinary scans remain HTML-only.

For agents, use the [versioned API, MCP and SDKs](docs/agent-api.md), with optional [durable evidence history](docs/agent-history.md). Explicit [HTML capture/replay](docs/evidence-replay.md) permits offline extraction checks. [Calibration tooling](docs/calibration.md) checks frozen holdouts without inventing calibrated probabilities. The optional [local queue and telemetry](docs/platform.md) require Node 22.13+; base CLI commands retain Node 22 support. These are self-hosted tools, with no managed cloud or commercial service implied.

[Finite backlink monitoring](docs/backlink-monitoring.md) schedules an exact cohort,
retains comparable rechecks and exports local alerts. It requires an operator-run
driver and private storage. [Controlled platform qualification](docs/platform-qualification.md)
exercises real worker processes, HTTP, crash recovery and request budgets without
claiming production throughput or priced unit economics.

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

Vendored Public Suffix List data uses [MPL-2.0](docs/licenses/public-suffix-MPL-2.0.txt); its pinned upstream revision is retained in the source.
