# Verify known backlinks with the local HTTP API

The exact-pair verification endpoint ships in **RankProof 1.0.0** (tag `v1.0.0`). RankProof is not on the npm registry yet, so run it from a clone or a GitHub release tarball. Node.js 22+ required.

The endpoint answers a narrow question: _does the HTML fetched from a supplied source URL contain an anchor pointing to the exact supplied target URL?_ It does not crawl the browser-rendered DOM, establish Google ranking value, or discover every backlink on the web.

## Fastest path: a CSV and one command

No server needed. Put your known links in a file — one pair per line, the anchor and rel you agreed with the publisher are optional:

```csv
source_url,target_url,expected_anchor,expected_rel
https://publisher.example/post,https://you.example/guide,Your Brand,sponsored
https://blog.example/review,https://you.example/,,
```

```bash
npm run cli -- verify links.csv --format json --out run.json --capture-dir evidence/
# a month later:
npm run cli -- verify links.csv --previous run.json --format html --out report.html
```

The web app (`npm run dev`) has the same workflow under **Verify links**: paste or upload the table, run, compare with your last run in that browser and export CSV, JSON or an HTML report. See the [CLI reference](cli.md#verify-pairscsv---) for every option. The rest of this page covers the HTTP API, for integrating verification into another tool.

## 1. Run locally

```bash
git clone https://github.com/CometWeb-io/rankproof.git
cd rankproof
npm ci
npm run api -- --host 127.0.0.1 --port 8787
```

Keep this terminal open. The service is intended to stay on loopback by default; do not expose it publicly without the production security controls in [API documentation](api.md) and [security policy](../SECURITY.md).

In another terminal:

```bash
curl -sS http://127.0.0.1:8787/health
```

Check that `capabilities` includes `backlinks.verify.v1`. Do not infer the capability from `version` alone.

## 2. Check your own authorized source and target URLs

Replace the two example URLs with public pages you have permission to inspect. The `.example` addresses below are **placeholders** and do not produce a meaningful live demo.

```bash
curl -sS -X POST http://127.0.0.1:8787/v1/backlinks/verify \
  -H 'content-type: application/json' \
  -d '{
    "items": [
      {
        "source_url": "https://publisher.example/article",
        "target_url": "https://target.example/offer"
      }
    ]
  }'
```

Batch size is 1–50 exact source/target pairs. Use _different registrable domains_ for backlink checks. An optional `RANKPROOF_API_TOKEN` requires the matching Bearer authorization header.

## 3. Interpret each result

| Status      | What it establishes                                                 | What it does not establish                                        |
| ----------- | ------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `confirmed` | A matching anchor was found in fetched HTML                         | Browser visibility, indexing, ranking value or future persistence |
| `not_found` | No match in successfully parsed fetched HTML, or source was 404/410 | No JavaScript-inserted link, or exact date of loss                |
| `error`     | Verification failed or was blocked; read `reason`                   | Link absence or a link-loss event                                 |

A batch HTTP 200 can include item-level `error` results. Inspect **each** result; do not treat the batch status as successful verification for every pair.

The response may contain `checked_at`, `http_status`, `anchor`, `rel`, `raw_href`, `resolved_href`, `response_hash`, `identity_policy`, and `observation_method`; read the API schema for exact presence/semantics. Requested URLs are compared according to an exact HTTP URL policy: protocol, host, path, case and query details may matter, while fragments are ignored. Do not silently normalize target URLs before labeling a match.

## 4. Manual quality-control checklist

1. Use a mix of known existing links, confirmed absent links, blocked pages, redirects and script-rendered pages.
2. On a **saved source HTML representation**, manually record whether a matching anchor exists; compare that to the program's observation. Do not compare solely to what a visual browser shows.
3. Keep `source_url`, `target_url`, `checked_at`, `status`, `reason`, `identity_policy`, `source_revision` and any hash available.
4. Count **confirmed / not_found / error** separately; report denominator and coverage. Unknown is not zero.
5. Resolve disagreements before reporting accuracy. A manual re-check at a later time is not necessarily the same source representation.
6. Never build or submit a disavow file from a heuristic score without independent expert review. Google warns that incorrect disavow can hurt a site.

## 5. Next workflow step

For a team with an existing spreadsheet of backlinks, first test whether conversion to the documented JSON contract is acceptable. The CLI also reads CSV directly (`rankproof verify pairs.csv`, see [cli.md](cli.md)), and saved lists in the web app re-check links on a schedule; this guide covers the JSON API only.

References: [HTTP API](api.md) · [Methodology](metrics.md) · [Changelog](../CHANGELOG.md).
