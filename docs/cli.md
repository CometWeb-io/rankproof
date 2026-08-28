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

Formats: `text` (default, readable in a terminal), `json` (full report), `csv` (backlinks), `html` (standalone report), `disavow` (file for Google Search Console).

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

| Option | Short | Values | Default |
| --- | --- | --- | --- |
| `--keywords` | `-k` | comma-separated list | — |
| `--competitors` | `-c` | comma-separated list (max 5) | — |
| `--market` | `-m` | `pl` `us` `gb` `de` `fr` `es` | `pl` |
| `--device` | `-d` | `desktop` `mobile` | `desktop` |
| `--engines` | `-e` | `bing` `duckduckgo` `mojeek` `brave` `google` | from configuration |
| `--depth` | | `10` `20` | `10` |
| `--format` | `-f` | `text` `json` `csv` `html` `disavow` | `text` |
| `--out` | `-o` | file path | stdout |
| `--quiet` | `-q` | — | off |
| `--no-audit` | | — | off |

Progress messages go to **stderr**, results to **stdout**. `npm run` prints its own banner to stdout, so redirect from the binary rather than through npm — `node bin/rankproof.mjs scan example.com --format json > report.json` — or use `--out report.json`, which npm cannot pollute.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Runtime failure (the scan did not complete) |
| `2` | Invalid arguments |

## Keeping it working

Search engines change their markup without notice. A cron job that scans weekly should also run `doctor` and alert on a non-zero exit — otherwise a broken parser reports zero visibility for weeks and it looks like data.

```bash
node bin/rankproof.mjs doctor --quiet || echo "RankProof: no engine is returning results" | mail -s alert you@example.com
```

`google` in `--engines` needs `RANKPROOF_GOOGLE_PROVIDER_URL` (see `docs/providers.md`). Without it, doctor marks Google as `not-configured` (skip), not a failure.

## Running from cron

```bash
#!/bin/bash
# Weekly audit with rank history recorded.
export RANKPROOF_MARKET=us
export DATABASE_URL="postgres://..."
cd /opt/rankproof
node bin/rankproof.mjs scan example.com --quiet --format json \
  --out "/var/log/rankproof/$(date +%F).json"
```

Rank history is written on every scan, so the next one will show gains and drops.
