# Coverage, agreement, extraction quality and held-out evaluation

RankProof keeps four different questions separate:

1. Did each requested engine attempt return a usable measurement?
2. Do comparable source attempts agree, and are repeated results stable?
3. Did verification return usable HTML evidence, resource absence or an error?
4. Do **declared probabilities for a specific event** agree with independent labels?

`serp.measurementQuality.sourceAgreement` groups by the exact keyword, market,
device and measured depth, retaining each engine in its own source cohort.
Attempts at different scopes never become agreement. Failed attempts are retained
as unavailable, and repeated attempts from one engine do not create extra sources.
Disagreement, including confirmed no-result versus a position, remains visible.
Rankings from different engines can legitimately differ. Agreement is descriptive,
not a calibrated confidence or evidence that one engine has the true ranking.

`extractionQuality(observations)` consumes actual verifier observations. It separates
confirmed anchors, HTML absence, HTTP 404/410 resource absence, errors, inconsistent
evidence, missing hashes and missing extractor metadata. Failure categories group
verifier reasons; they do not establish the underlying cause. Usable HTML share is
a denominator over returned attempts, never extraction accuracy or false-loss rate.

## Offline calibration gate

The evaluator does not train a model, tune a score or infer probabilities from a
0–100 heuristic. It accepts two explicit datasets and separately declared holdout
predictions for the event `exact_html_anchor_present` (1 present, 0 absent).

Print the machine-readable input schema:

```sh
node --experimental-strip-types scripts/calibration.mjs schema > calibration-schema.json
```

Each dataset has `schemaVersion: 1`, a distinct `datasetId`, `kind` (`synthetic` or
`observed`) and `cases`. A case retains an ID, source/target URLs, the source
content, and `groundTruth` containing binary `label`, `kind` (`synthetic` or
`human_annotated`), `annotatedBy`, `annotatedAt` and `evidenceRef`. Observed cases
require human annotation; naming something observed does not prove authenticity.
Do not put private or unlicensed source content in a public repository.

Prepare your tuning dataset and an independent holdout before examining its
outcomes. Save `{ "tuning": <dataset>, "holdout": <dataset> }` as `partitions.json`:

```sh
node --experimental-strip-types scripts/calibration.mjs freeze partitions.json holdout.lock.json reviewer-id
```

The exclusive freeze records both dataset hashes, case IDs, registrable source
domains, content hashes and the admission policy. It refuses shared dataset IDs,
case IDs, source domains or source content across partitions, duplicate content
within a partition, missing labels, annotations after the freeze and inadequate
class/source coverage. Floors are 100 tuning cases with 20 source domains and 10
labels per class; 200 holdout cases with 30 source domains and 20 labels per class.
These are minimum admission rules, not a statistical guarantee.

Keep the training procedure and acceptance thresholds frozen independently.
Generate predictions with the frozen candidate, without exposing holdout labels
to tuning. A study contains the same partitions plus `schemaVersion: 1`,
`candidateId`, `event: "exact_html_anchor_present"`, `predictionKind`,
`predictionEvidenceRef`, `predictedAt` and `predictions: [{ "caseId": "...",
"value": 0.8 }]`. Prediction time must follow the holdout freeze.

```sh
node --experimental-strip-types scripts/calibration.mjs evaluate study.json holdout.lock.json > report.json
```

The evaluator checks the frozen hashes before producing results. Complete,
explicit `probability` predictions in [0,1] produce Brier score (mean squared
probability error), a ten-bin reliability table, and ECE (count-weighted absolute
bin calibration error). Empty bins retain null values. Missing/null predictions,
`heuristic_score`, and `none` return `not_calibrated` with null Brier/ECE/reliability.
No score is silently divided by 100. The report retains prediction coverage and
hashes so that abstention cannot disappear from the denominator.

Evaluation creates a receipt in `.rankproof-calibration-receipts/` beside the
frozen manifest exclusively **before** printing results. The receipt is keyed by
the held-out source-content hash set, so renaming a manifest, dataset or case IDs
does not permit reuse of the same source set in that directory. A second
evaluation refuses reuse, even if the first used
heuristics or incomplete predictions. Obtain a fresh independent holdout to tune
again; do not delete the receipt and reuse exposed labels. Pure API callers must
persist and supply previously used holdout hashes themselves. File owners can
copy locks to other directories or erase receipts: this is an auditable local workflow, not remote
attestation or a guarantee of operator conduct.

Every report keeps `calibrationQualified: false`. Synthetic fixtures validate the
formulas and leakage gates only. Real calibration additionally requires independent
review of annotation correctness, source authenticity, annotation independence,
collection rights, frozen acceptance criteria and relevance to the production
population. Brier/ECE alone are not an acceptance decision, and this evaluator does
not apply a calibrated model to production.
