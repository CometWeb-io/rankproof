# Evidence ledger and measured history

Scan reports now include a `measurement-v2` manifest. The Web application's
history stores that manifest with each scan; after applying the migrations in
`migrations/`, PostgreSQL and the embedded PGLite backend also store an immutable
`evidence-ledger-v2` export in `evidence_runs`.

## Export and check a report

For a source checkout, use the existing Node TypeScript support:

```ts
import {
  buildEvidenceLedger,
  verifyEvidenceLedger,
} from "../src/lib/backlinks/evidence-ledger.server.ts";

const ledger = buildEvidenceLedger(report);
const json = JSON.stringify(ledger);
if (!verifyEvidenceLedger(JSON.parse(json))) throw new Error("Evidence integrity failed");
```

The compiled package has the same exports in
`dist/evidence-ledger.server.js`. Pass an existing `ScanReport`; this operation
performs no network calls. `loadEvidenceLedger(host, at)` in
`src/lib/backlinks/store.server.ts` reads a stored Web scan at its exact UTC scan
timestamp. That accessor requires the application's database runtime; it is not
a standalone HTTP endpoint. Standalone CLI scans can export their existing
report through `buildEvidenceLedger` without the Web database.

Each export contains the manifest, copied backlink observations, provider reports,
observation hashes and a root hash. Its observation status keeps a freshly fetched
HTML anchor (`CONFIRMED`) separate from a provider assertion (`REPORTED`). Archive
candidates do not establish current link loss. `interpretations` labels scores as
uncalibrated inferences and absent discovery rows as unknown.

Hashes detect changes relative to a trusted root hash. They do not authenticate a
server or prove that the original source was honest. Raw response HTML is **not**
retained: `responseHash` identifies the inspected response, but this export alone
cannot replay extraction from the original HTML. Retain source captures separately
when independent extraction replay is required; the explicit, bounded path is documented in
[evidence replay](evidence-replay.md). The current format is neither a
signed transparency log nor a global hash chain.

## Append-only corrections

`0007_evidence_ledger.sql` adds the ledger table and the scan manifest column.
Database triggers reject updates and deletes of ledger rows. Correct an observation
by appending a new scan; the original remains available. An identical export is
idempotent by root hash. This protects against accidental application rewrites;
a database administrator can still change schema or disable triggers.

The embedded Web database is in memory when no `DATABASE_URL` is configured and
resets when the process restarts. Durable history requires a configured persistent
PostgreSQL database. `0008_serp_measurement_scope.sql` records market, device, checked depth, result status and method versions for rank history; legacy scope stays unknown.

Existing aggregate scan rows remain readable and do not gain
invented evidence during migration.

## What comparisons mean

`sourceRevision` records provenance. A different commit SHA alone does not block a
comparison when the versioned extractor, URL identity and domain policies match.
A changed method must receive a new method version.

The manifest records a stable cohort key from the scan mode, budgets, source IDs
and requested keyword/engine/market/device/depth combinations. Database and browser
history compare observation samples only when those cohorts and method versions
match. The UI labels new rows as **first observed**, missing rows as **not
reobserved; loss unknown**, and reports the common observed relations. These are
sample differences, not proof of acquisition or removal.

Visibility deltas additionally require the same successful query cohort. Heuristic
score deltas additionally require identical graph, scoring version and scoring
inputs; incompatible deltas are `null` and omitted from the UI. Old rows without a
manifest cannot be compared with measured reports.

Persisted backlink rows expose `firstObserved`, `lastConfirmed` and `lastAttempted`.
These refer to observations recorded by this installation. They are not the link's
publication date or a referring domain's archive age. A link omitted from discovery
has no fresh verification attempt, so omission cannot renew its confirmation.
Provider reports do not establish an HTML verification attempt; their
`lastAttempted` stays unknown unless this installation has a retained check.

## Explicit relationship checks

`relationshipObservation` in `relationships.ts` converts a result from the existing
`verifyBacklinks` API into a relationship observation. `compareRelationship`
compares those observations and returns both pieces of evidence for a change.

A confirmed HTML-absence change needs an earlier confirmation and a later complete
HTML absence with the same pair, resolved source URL, extractor, identity policy
and representation. A blocked fetch, missing response hash, incomplete HTML,
different redirect destination or discovery omission stays `UNKNOWN`. Anchor,
rel and placement changes are compared only on compatible confirmations.
`firstObserved`, `lastConfirmed` and `lastAttempted` remain separate.

An HTML-absence change is scoped to fetched HTML; it does not establish absence
from a rendered page. This helper does not by itself schedule rechecks, persist
standalone verifier calls or send loss alerts. Those require an explicitly wired
consumer and storage policy.
