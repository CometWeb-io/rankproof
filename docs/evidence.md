# What RankProof evidence proves — and what it does not

"Proof" is in the name, so the claim has to be exact. Every RankProof result is an **observation**: what one request, at one moment, from one network location, returned for one URL, read by one versioned extractor. This page lists what each artifact supports, and where it stops.

## The artifacts

| Artifact                                | Where                                    | What it is                                                                |
| --------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------- |
| Observation                             | every result (`status`, `checked_at`, …) | The verdict for one source → target pair, with the rules that produced it |
| `response_hash`                         | every result with a response body        | SHA-256 of the exact text the extractor read                              |
| `extraction_version`, `identity_policy` | every result                             | Which parser and which URL-equality rules were applied                    |
| `contract`                              | every result                             | Expected vs observed anchor, rel, placement and visibility                |
| Captured HTML                           | `--capture-dir` / `--history`            | The response body itself, named by its SHA-256                            |
| Replay                                  | `rankproof replay`                       | The current extractor re-reading a captured body, offline                 |
| `rendered` + `dom_hash`                 | `--render`                               | A second observation in headless Chromium, after scripts ran              |
| WARC file                               | `rankproof export-warc`                  | Captured bodies and observations in the archival standard (ISO 28500)     |
| Run history                             | `--history` directory                    | The sequence of observations of the same pairs over time                  |

## What each claim means

**`confirmed`** — The fetched HTML (or, with `basis: rendered_dom`, the DOM after scripts ran) contained an `<a>` element whose resolved `href` equals the exact target URL under `identity_policy`. Supported by the stored body and its hash: anyone can re-run the extractor on it and get the same answer (`replay`).

**`not_found`** — The representation that was read contained no such anchor. Its scope is stated in `absence_scope`:

- `fetched_html`: absent from the HTML returned to RankProof's request. JavaScript-inserted links were not rendered.
- `rendered_dom`: also absent after rendering. Still one request; personalised, geo-targeted or A/B variants may differ.
- `http_resource`: the source page itself returned 404/410.

**`error` / `unverified`** — Nothing could be established. It is never evidence that a link is missing, and history never reports it as a loss.

**Changes over time** — "Gone from HTML" compares two observations of the same pair. It says the link was in one representation and not in the next, not when or why it was removed.

## What the evidence does **not** prove

- **That every visitor saw the same page.** Servers vary content by location, cookies, user agent and time. RankProof proves what _it_ received.
- **That the hash proves authenticity.** A SHA-256 shows that a stored body has not changed since it was hashed. It does not show that the publisher served it: whoever controls the RankProof run could have produced any body. For third-party trust, timestamp the capture with an independent service, or archive the same URL at the same time in a public archive.
- **That a link has SEO value.** `rel`, placement and visibility describe markup. How a search engine weighs them is not observable here.
- **That an AI system or a search engine used the page.** A link's existence and a citation's influence are different questions.
- **That a contract deviation is a breach.** `deviates` means "differs from the stated expectation". A `sponsored` rel on a paid link is what Google asks for.

## Making a capture stronger

1. Run with `--capture-dir` (or `--history`) so the body exists, not just its hash.
2. Export a WARC (`rankproof export-warc`) and store it outside the machine that produced it.
3. For disputes, seal the run (below): an independent timestamp, a signature, and public web-archive copies of the source pages.
4. Keep the RankProof version, `extraction_version` and `identity_policy` with the evidence. `replay` with a newer extractor reports `differs` instead of silently changing an old verdict.

## Sealing a run

`rankproof seal run.json` writes `run.json.seal.json` with the file's SHA-256 and, optionally:

| Option          | Adds                                                                                      | Proves                                                                                                    |
| --------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `--key key.pem` | Ed25519 signature over `rankproof-seal-v1`, hash, time and file name, plus the public key | The holder of that key sealed exactly this file. Create a key with `rankproof keygen --out key`.          |
| `--tsa <url>`   | RFC 3161 timestamp token in `run.json.tsr` (request with nonce, `certReq`)                | A third-party Time Stamping Authority saw this hash no later than its `genTime`. Verifiable with OpenSSL. |
| `--wayback`     | Internet Archive _Save Page Now_ request for every source URL in the run                  | An independent copy of each page exists at `archived_at` — what the page showed, not what RankProof saw.  |

`rankproof check-seal run.json [--public-key key.pub.pem]` re-hashes the file, checks the signature (and, with `--public-key`, that it is the expected signer), checks the token's status, message imprint, nonce and time structurally, and prints the `openssl ts -verify` command that checks the token's signature against the TSA's certificate chain, which RankProof does not ship. A failed archive request never fails the seal: it is reported and the archive copy is simply absent.

The result has one of three states (`status` in `--format json`):

| State        | Meaning                                                                                                                                                                                                                                    | Output                           | Exit |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- | ---- |
| `verified`   | Every check passed: hash, signature and, with `--public-key`, the signer. No timestamp, or none to check.                                                                                                                                  | `Seal OK: every check verified.` | `0`  |
| `unverified` | Nothing failed, but a claim was not verified here: the signer (no `--public-key`), or a timestamp token, which is only checked _structurally_ (`?` mark) — its CMS signature is verified only by the printed `openssl ts -verify` command. | `Seal NOT fully verified: …`     | `0`  |
| `failed`     | A check failed: the file changed, the signature or signer is wrong, or the token does not match this file and nonce.                                                                                                                       | `Seal check FAILED.`             | `3`  |

`ok` in the JSON is `true` only for `verified`. A timestamped seal is therefore never `verified` by RankProof alone: treat it as verified once `openssl ts -verify` with the TSA's CA certificate prints `Verification: OK`.

What a seal does not prove: that the run's verdicts are right (see above), that the signer is who they say they are (distribute the public key through a channel you trust), or that the TSA is trustworthy (choose one your counterpart accepts). Tested: signatures and tampering, and a full RFC 3161 round trip against an OpenSSL TSA in the test suite. The Wayback request is tested against a recorded response shape only; the archive's API is not under our control.

The accuracy of the extractor itself is measured, with its limits, in [benchmark](benchmark.md).
