# Retained HTML capture and offline replay

Capture is explicit and disabled in ordinary verification. `verifyBacklinks(body)`
returns its existing v1 observations and an additive `extraction_quality` summary;
it does not retain or export response bodies. For an explicitly requested capture:

```ts
import { captureBacklinks } from "../src/lib/backlinks/evidence-capture.server.ts";
import { replayEvidenceCapture } from "../src/lib/backlinks/evidence-replay.ts";

const { verification, capture } = await captureBacklinks({
  items: [
    {
      source_url: "https://publisher.example/article",
      target_url: "https://brand.example/offer",
    },
  ],
});
// Keep capture private. Store compact JSON in a new file with mode 0600.
const replay = replayEvidenceCapture(JSON.parse(JSON.stringify(capture)));
```

These are library calls; this example does not create a file or configure a
public HTTP endpoint. Compiled exports live at `dist/evidence-capture.server.js`
and `dist/evidence-replay.js`. Network calls occur only during capture, using
the existing verifier's URL, DNS, robots, redirect and request-budget guards.
Replay performs no network calls or DNS lookups.

Capture retains supported UTF-8 text only. Unsupported declarations or uncertain
decoding are omitted, including response bodies whose HTTP status alone could
establish resource absence. Invalid bytes never become replacement characters
used to infer a missing link. These omissions remain visible in capture coverage.
Replay requires the recorded extractor version. Retain the matching engine
artifact for older captures; the current synthetic fixture uses `html-anchor-v5`.

The CLI creates a new private file explicitly; it refuses to overwrite an existing
path and never prints captured HTML to stdout:

```sh
node bin/rankproof.mjs capture pairs.json --out private-capture.json
node bin/rankproof.mjs replay private-capture.json --out replay.json
```

`pairs.json` has the verifier's `{ "items": [{ "source_url": "...", "target_url":
"..." }] }` shape. Captures use compact JSON and file mode `0600`; choose an
operator-owned directory. The input request is capped at 2 MB, and replay input
at 8 MB. Offline replay preserves the original timestamps/revision and verifies
the captured source text against the claimed extraction; it makes no fresh
observation or network request.

## Actual local workflow

The reserved `.example` fixture is synthetic, not evidence from a live publisher:

```bash
node --experimental-strip-types --input-type=module <<'JS'
import { readFile } from "node:fs/promises";
import { replayEvidenceCapture } from "./src/lib/backlinks/evidence-replay.ts";
const fixture = JSON.parse(await readFile(
  "src/lib/backlinks/fixtures/evidence-replay-v1.json", "utf8",
));
const replay = replayEvidenceCapture(fixture);
console.log(replay.coverage, replay.results[0].status);
JS
```

Expected: one captured item, zero omissions, `confirmed`. This uses the same
`observeBacklinkResponse` extractor as live verification, including the strict
HTML tokenizer, exact URL semantics, entity decoding and raw-text/template
exclusions. A `data-href` attribute is not an anchor. The fixture includes
multilingual text and a real HTML anchor; it does not measure live accuracy.

## Bounds and omissions

`captureBacklinks(body, { maxTotalBytes })` accepts 1–50 explicit source/target
pairs. Each retained decoded body is limited to 2,000,000 UTF-8 bytes. The compact
JSON artifact, including metadata and omission records, is limited to 8,000,000
bytes by default; `maxTotalBytes` may reduce it to at least 16,384 bytes. The total
budget applies to retained output, in addition to the verifier's per-request
network limits. Pretty-printing adds whitespace beyond the recorded compact size.

A body is kept whole or omitted; capture never labels a truncated body complete.
The artifact records each item's original index and either its response or an
omission reason. Late responses after a deadline do not produce complete captures.
The returned capture is frozen in memory. Content hashes detect subsequent changes;
file immutability and storage access remain the caller's responsibility.

Non-HTML bodies and responses with fetch/parser errors, challenges, incomplete HTML, cached bodies,
unknown redirect provenance or unsupported metadata are not replayable evidence.
Live observations still report their actual verification outcome independently of
whether retention was allowed. `replay.coverage` keeps captured and omitted items
separate: a valid artifact containing only omissions has no reproduced measurement.

## What is hashed

`body_hash_scope` is **`utf8_decoded_response_text`**. `body_sha256` hashes the UTF-8
encoding of the JavaScript response text inspected by the verifier and matches its
existing `response_hash`. `decoded_utf8_bytes` measures that same encoding.
These are not hashes or sizes of original compressed wire bytes. Decoding may have
replaced invalid byte sequences, and the artifact cannot recover those original
bytes or independently verify TLS delivery.

Each entry retains the exact requested pair, final URL, HTTP status, content type,
complete decoded text, followed redirect URLs/statuses, extraction/identity versions
and the claimed observation. It has an entry hash; the artifact has a root hash.
Replay validates bounded structure, body/entry/root hashes, contiguous item coverage,
redirect continuity and supported method versions before extracting again. The
entire re-extracted observation must match the claim, including anchors and rel.
Changes require a new artifact; incompatible extractor/identity versions are refused.
A rehashed changed body cannot reproduce an unchanged anchor claim. A caller who
rewrites both body and claim can create a different internally consistent artifact:
these hashes establish integrity and replay consistency, **not source authenticity**.

A 404/410 observation remains scoped to `http_resource`; HTML absence remains
`fetched_html`. Neither establishes absence from a rendered page, loss of a live
relationship, provider truth or ranking impact. Provider assertions never enter
this capture path.

## Sensitive response policy

The verifier does not accept authorization/cookie headers through this capture
wrapper and does not log bodies, headers or captures. Capture omits URLs with
credential-looking query fields, any fragment-bearing request/final/redirect URL
(including OAuth-style `#/callback?...` fragments), and responses carrying `Set-Cookie`,
`WWW-Authenticate`, private/no-store cache policy, cookie/authorization Vary,
password inputs or obvious access/refresh/ID token fields. It retains only the
content type, never raw response headers or cookie values. Omission records contain
an index and fixed reason, not the rejected URL or secret. This conservative
fragment policy applies only to capture admission; ordinary verification still
ignores fragments when comparing the source anchor with the requested target.
Actual raw HTML may retain ordinary anchor fragments such as `#details`.

This is a conservative filter, not a privacy classifier. A publicly fetched page
can still contain personal, confidential or copyrighted material, including values
the filter cannot recognize. Capture does not establish permission to retain,
redistribute or publish it. Keep captures private, restrict file access and apply an
appropriate retention policy. No source confidentiality or redistribution rights
are claimed by this format or its synthetic fixture.

This optional artifact complements the hash-only evidence ledger. Ordinary ledger
exports still do not include raw HTML unless a separate capture is explicitly made.
