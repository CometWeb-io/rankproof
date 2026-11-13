# API contract

The files in `fixtures/` are the source of truth for consumers of `POST /v1/backlinks/verify` and `GET /health` (schema `1`), such as other services and SDKs. They are produced by the real extractor from the bundled example, offline and deterministically.

- `verify-request.json` — a request covering every contract clause.
- `verify-response.json` — the response, with every verdict (`meets`, `deviates`, `missing`, `unverified`).
- `verify-response-previous.json` — an earlier run of the same pairs, for change-detection tests.
- `health.json` — the health document with capabilities.

RankProof's own test suite fails when the produced documents drift from these files. A deliberate API change means: run `npm run contract:update`, review the diff as an API change, and update [CHANGELOG](../CHANGELOG.md). Within schema `1` changes must be additive.

## On the consumer side

Copy these fixtures into the consumer's tests (or fetch them for the RankProof version you pin) and assert that the integration parses them. The reference clients do exactly that:

- Python (standard library only): [`clients/python/rankproof_client.py`](../clients/python/rankproof_client.py), tests in `clients/python/test_rankproof_client.py`.
- TypeScript (no dependencies): [`clients/typescript/rankproof-client.ts`](../clients/typescript/rankproof-client.ts).

`npm run test:clients` runs both against the committed fixtures. Rules every client follows: check `schema_version` and `capabilities` at start-up, treat `unverified` as a measurement gap and never as a lost link, and keep unknown fields.
