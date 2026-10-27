# CLI

```bash
npm run cli -- <command> <domain> [options]
# or directly:
node bin/rankproof.mjs scan example.com
```

Requires Node 22+. The `--experimental-strip-types` flag is added automatically.

## Commands

### `scan <domain>`

A full audit: backlinks, SERP, risk, visibility index and action plan. Add `--no-audit` to skip the internal crawl and finish faster.

```bash
npm run cli -- scan example.com
npm run cli -- scan example.com --market us --device mobile
npm run cli -- scan example.com --format json --out report.json
npm run cli -- scan example.com --format html --out report.html
npm run cli -- scan example.com --format disavow --out disavow.txt
```

Private GSC/Bing data is disabled by default. Use `scan --webmaster` only for a local report you are authorized to read. `--profile quick|standard|deep` selects a bounded workload; API/Web scans enforce quick.

Formats: `text` (default, readable in a terminal), `json` (full report), `csv` (backlinks), `html` (standalone report), `disavow` (file for Google Search Console).

### `capture <pairs.json>` and `replay <capture.json>`

Capture is explicit and requires `--out` with a new file. It writes compact JSON
with owner-only permissions and never overwrites an existing path. Replay checks
hashes, method versions and the original HTML extraction without network access.

```sh
node bin/rankproof.mjs capture pairs.json --out private-capture.json
node bin/rankproof.mjs replay private-capture.json --out replay.json
```

See [capture/replay](evidence-replay.md) for sensitive-response omissions and
retention limits. The default verifier does not retain source bodies.

### `graph <report.json>`

Export a scan's retained technical graph as JSON, or its complete per-URL
investigation list as CSV. This runs offline and requires a current graph export;
legacy scans cannot reconstruct missing edges or repair URLs.

```sh
node bin/rankproof.mjs graph report.json --out graph.json
node bin/rankproof.mjs graph report.json --format csv --out repair-urls.csv
```

CSV includes the finding kind, exact URL, related URLs, certainty and evidence
references. It retains candidates as candidates and does not authenticate the
imported graph or establish current page state.

### `render <request.json>`

Compare fetched HTML with an actual Chromium DOM snapshot. Supply only `url` and
trusted operator `runtime` configuration in the JSON file. A new `--out` file is
required and is written with owner-only permissions. Browser assets and the exact
qualified Docker image must already exist; the command never installs them.

```sh
node bin/rankproof.mjs render request.json --out private-render.json
```

See [isolated rendering](../renderer/README.md) for the runtime configuration,
platform qualification and enforced limits. Output contains source bodies and may
be sensitive. A rendered anchor is an observed DOM link, not proof of search
indexability. Ordinary scans and backlink verification remain HTML-only.

### `serp <domain> [keywords...]`

Positions for the given keywords.

```bash
npm run cli -- serp example.com "packshot,product photography"
npm run cli -- serp example.com --keywords "packshot" --depth 20 --engines bing,brave
```

### `ideas <domain> [keywords...]`

Keyword ideas from DuckDuckGo and Bing autocomplete, related searches and SERP questions.

```bash
npm run cli -- ideas example.com --keywords "product photography" --format csv
```

### `gap <domain> [competitors...]`

Domains that link to your competitors but not to you. It scans the competitors too, so it takes a few minutes.

```bash
npm run cli -- gap example.com --competitors "rival.com,other.com" --format csv --out gap.csv
```

### `doctor`

Checks whether the tool itself still works: probes every engine with a known query and reports whether results come back, a bot challenge appeared, or the parser no longer understands the markup.

```bash
npm run cli -- doctor
npm run cli -- doctor --format json
```

Exits with code `1` when no engine returns results — useful as a CI canary, because a broken parser otherwise produces reports full of confident zeros.

## Options

| Option          | Short | Values                                        | Default            |
| --------------- | ----- | --------------------------------------------- | ------------------ |
| `--keywords`    | `-k`  | comma-separated list                          | —                  |
| `--competitors` | `-c`  | comma-separated list (max 5)                  | —                  |
| `--market`      | `-m`  | `pl` `us` `gb` `de` `fr` `es`                 | `pl`               |
| `--device`      | `-d`  | `desktop` `mobile`                            | `desktop`          |
| `--engines`     | `-e`  | `bing` `duckduckgo` `mojeek` `brave` `google` | from configuration |
| `--depth`       |       | `10` `20`                                     | `10`               |
| `--format`      | `-f`  | `text` `json` `csv` `html` `disavow`          | `text`             |
| `--out`         | `-o`  | file path                                     | stdout             |
| `--quiet`       | `-q`  | —                                             | off                |
| `--no-audit`    |       | —                                             | off                |
| `--profile`     |       | `quick` `standard` `deep`                     | from configuration |
| `--webmaster`   |       | private local GSC/Bing opt-in (scan only)     | off                |

Progress messages go to **stderr**, results to **stdout**. `npm run` prints its own banner to stdout, so redirect from the binary rather than through npm — `node bin/rankproof.mjs scan example.com --format json > report.json` — or use `--out report.json`, which npm cannot pollute.

## Exit codes

| Code | Meaning                                     |
| ---- | ------------------------------------------- |
| `0`  | Success                                     |
| `1`  | Runtime failure (the scan did not complete) |
| `2`  | Invalid arguments                           |

## Keeping it working

Search engines change their markup without notice. A cron job that scans weekly should also run `doctor` and alert on a non-zero exit — otherwise a broken parser reports zero visibility for weeks and it looks like data.

```bash
node bin/rankproof.mjs doctor --quiet || echo "RankProof: no engine is returning results" | mail -s alert you@example.com
```

`google` in `--engines` needs `RANKPROOF_GOOGLE_PROVIDER_URL` (see `docs/providers.md`). Without it, doctor marks Google as `not-configured` (skip), not a failure.

## Running from cron

```bash
#!/bin/bash
# Weekly audit with a dated JSON export.
export RANKPROOF_MARKET=us
cd /opt/rankproof
node bin/rankproof.mjs scan example.com --quiet --format json \
  --out "/var/log/rankproof/$(date +%F).json"
```

Standalone CLI scans write the requested export; they do not persist Web database history. Retain dated exports for offline analysis. The Web application records cohort-scoped history when persistence is enabled; its embedded in-memory database resets on restart unless a persistent PostgreSQL database is configured.
