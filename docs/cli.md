# CLI

```bash
npm run cli -- <command> <domain> [options]
# or directly:
node bin/rankproof.mjs scan example.com
```

Requires Node 22+. The `--experimental-strip-types` flag is added automatically.

## Commands

### `verify <pairs.csv | ->`

Checks a list of backlinks you already know about — bought, earned or agreed placements — against their **link contract**: is the exact target URL linked in the source HTML, with the expected anchor and rel?

```bash
npm run cli -- verify links.csv
npm run cli -- verify links.csv --format json --out run.json --capture-dir evidence/
npm run cli -- verify links.csv --previous run.json --format html --out report.html
cat links.csv | node bin/rankproof.mjs verify - --strict
```

The pairs file is CSV, TSV, semicolon- or pipe-separated; a header row is optional and may reorder columns. Default column order:

```csv
source_url,target_url,expected_anchor,expected_rel,expected_placement
https://publisher.example/post,https://you.example/guide,Your Brand,sponsored,content
https://blog.example/review,https://you.example/,,,
```

`expected_rel` is `follow`, `nofollow`, `sponsored` or `ugc`; `expected_placement` is `content`, `navigation`, `footer`, `sidebar` or `comment`. Leave a column empty to skip that clause. Invalid lines are reported with their line number and skipped; duplicate pairs are ignored. Any number of pairs is verified in batches of 50.

Each pair ends as **Meets contract**, **Deviates** (linked, but anchor or rel differ), **Not in HTML** (scoped to the fetched HTML) or **Unverified** (fetch error — never counted as a lost link).

- `--previous run.json` compares with an earlier JSON run and labels each pair: _Appeared_, _Gone from HTML_, _Source page gone_, _Details changed_, _Run failed_ (the earlier observation stands), _Verified again_ or _Unchanged_.
- `--capture-dir dir` saves every fetched HTML representation as `<sha256>.html` plus a small metadata file. The hash matches `response_hash` in the run.
- `--strict` exits with `3` unless every pair meets its contract — useful in CI or cron.
- `--checkpoint progress.jsonl` saves results after every batch of 50 and skips pairs already in the file, so rerunning the same command after a crash, a reboot or Ctrl-C resumes where it stopped. Resumed observations are re-judged against the current table's expectations. The file is deleted when the run completes. Captured HTML is written per batch too, so an interruption loses at most one batch of evidence.
- `--render` re-checks pages in headless Chromium when the HTML has no link or is a JavaScript shell; `--render=always` renders every page and also flags links **hidden from visitors**. Needs `npm install playwright` and a Chromium (`npx playwright install chromium`, or a system Chrome/Chromium; set `RANKPROOF_CHROMIUM_PATH` to choose one). The receipt shows both observations; the HTML verdict is never rewritten. `replay --render` re-renders captured HTML offline, with only inline scripts.

Formats: `text` (default), `json` (a `rankproof.verify-run` document, also accepted by `--previous`), `csv`, `html` (a standalone report you can send to a client or publisher).

### Monitoring: `verify --history <dir>` and `history <dir>`

`--history monitor/` turns `verify` into a local monitor without a database: every run is stored in `monitor/runs/`, the fetched HTML in `monitor/evidence/`, and each run is compared with the latest stored one automatically. Schedule it with cron:

```bash
# Every Monday at 07:30; Slack/Discord/Mattermost get a message only when something changed.
30 7 * * 1 cd /opt/rankproof && node bin/rankproof.mjs verify links.csv --history monitor/ \
  --webhook https://hooks.slack.com/services/… --quiet
```

- `--webhook <url>` POSTs JSON (`kind: rankproof.verify-changes`, `summary`, `changes[]`, plus `text`/`content` for chat tools) only when at least one pair changed. Private, loopback and metadata addresses are refused unless `RANKPROOF_WEBHOOK_ALLOW_PRIVATE=1`; redirects are refused. A failed webhook does not lose the run (it is stored first) but exits with `4`.
- `--keep <n>` keeps the newest _n_ run documents (default 200). Evidence files are not pruned.

`rankproof history monitor/` prints one line per pair: number of runs, share of observed runs in which the link was confirmed, failed runs, when it was last confirmed, the current streak and recent changes. `--format csv` or `json` for spreadsheets and dashboards.

### `replay <run.json> --capture-dir <dir>`

Re-runs the current extractor offline against HTML captured by `verify --capture-dir`, and checks each snapshot's SHA-256 against the recorded `response_hash`. Outcomes: `reproduced`, `differs` (the extractor now reads the stored page differently), `no_snapshot`, `integrity_failed` (the file was modified). Exits `3` on `differs` or `integrity_failed`.

A replay shows what RankProof saw and that the stored copy is intact. It does not prove that every visitor saw the same page.

### `report <run.json>`

Re-formats a stored `verify` run without any network request: `--format text|csv|html|markdown|json`, `--strict` for the exit code. Markdown is a table for CI job summaries and pull-request comments.

### `corpus <run.json> --capture-dir <dir>`

Turns a captured run into a benchmark corpus to label by hand — see [benchmark](benchmark.md#benchmark-on-your-own-real-links).

### `export-warc <run.json> --capture-dir <dir> --out evidence.warc.gz`

Packages captured evidence as a WARC 1.1 file (ISO 28500), the format web archives use, so it can be stored outside RankProof and opened with standard tools (`warcio`, pywb, ReplayWeb.page). Each captured body becomes a `resource` record at its final URL, with SHA-256 block and payload digests and a `RankProof-Response-SHA256` header equal to the run's `response_hash`. A `metadata` record linked by `WARC-Concurrent-To` holds the observation and contract as JSON. They are `resource` and not `response` records because RankProof does not store raw HTTP headers. Observations without a body, or whose snapshot is missing or fails its hash, are skipped and listed. Validated with `warcio check`. See [evidence](evidence.md) for what such a file proves.

### `seal <run.json>`, `check-seal <run.json>`, `keygen --out <name>`

Seal any evidence file with its SHA-256 and, optionally, an Ed25519 signature (`--key key.pem`), an RFC 3161 timestamp (`--tsa https://freetsa.org/tsr`) and Internet Archive copies of every source URL (`--wayback`). `check-seal` verifies the seal (`--public-key` for the expected signer, `--seal` for a non-default seal path; exit `3` on failure; an unverified signer or TSA signature is reported as _not fully verified_, see [evidence](evidence.md#sealing-a-run)). `keygen` writes `<name>.pem` (mode 600) and `<name>.pub.pem`, and refuses to overwrite an existing key unless `--force` is given. TSA URLs pass the crawler's URL policy; set `RANKPROOF_SEAL_ALLOW_PRIVATE=1` for an internal TSA. See [evidence](evidence.md#sealing-a-run).

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
| `--previous`    |       | JSON file from an earlier `verify` run        | —                  |
| `--capture-dir` |       | directory for HTML evidence                   | —                  |
| `--strict`      |       | —                                             | off                |
| `--history`     |       | directory for runs + evidence                 | —                  |
| `--webhook`     |       | http(s) URL                                   | —                  |
| `--keep`        |       | number of runs to keep with `--history`       | `200`              |
| `--key`         |       | Ed25519 private key PEM (`seal`)              | —                  |
| `--tsa`         |       | RFC 3161 TSA URL (`seal`)                     | —                  |
| `--wayback`     |       | — (`seal`)                                    | off                |
| `--seal`        |       | seal file (`check-seal`)                      | `<file>.seal.json` |
| `--public-key`  |       | expected signer PEM (`check-seal`)            | —                  |
| `--force`       |       | — (`keygen`: replace an existing key pair)    | off                |

Progress messages go to **stderr**, results to **stdout**. `npm run` prints its own banner to stdout, so redirect from the binary rather than through npm — `node bin/rankproof.mjs scan example.com --format json > report.json` — or use `--out report.json`, which npm cannot pollute.

## Exit codes

| Code | Meaning                                                                                                                                                                                                   |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | Success                                                                                                                                                                                                   |
| `1`  | Runtime failure (the scan did not complete)                                                                                                                                                               |
| `2`  | Invalid arguments                                                                                                                                                                                         |
| `3`  | `verify --strict`: a pair does not meet its contract; `replay`: a result differs or a snapshot fails its hash; `check-seal`: a check failed (an unverified signer or TSA signature is reported, exit `0`) |
| `4`  | `verify --webhook`: the run succeeded and was stored, but the notification failed; with `--strict`, a contract failure (`3`) takes precedence, and a passing `--strict` keeps `4`                         |

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
