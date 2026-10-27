# Accuracy regression benchmark

Run offline with Node 22+:

```sh
npm ci
node --experimental-strip-types scripts/benchmark-accuracy.mjs > accuracy-report.json
```

The runner uses the actual `verifyBacklinks` API and fully mocked HTTP/DNS. It
fails on any incorrect scenario status. The corpus has 24 authored HTML and HTTP
scenarios crossed with six languages and eight generated URL identities: 1152
cases. Cases include genuine anchors, exact query identity, fragments, relative
bases, image and hidden HTML anchors, inert script/template/comment content,
`data-href`, challenges, unavailable sources, missing resources and JS shells.
A confirmed hidden anchor is an HTML observation, not a claim of indexability.

This is a **synthetic regression corpus**. It is not 1152 independently labelled
websites. `independentRealWorldAnnotations: 0` and
`realWorldAccuracyQualified: false` are intentional. All cases form one public
regression set; there is no independent calibration holdout. The corpus hash
pins the complete generated inputs and labels. No live hosting, rendering,
robots variability or DNS rebinding quality is established by this runner.

The report includes precision, recall, abstention, exact-status agreement and
false-absence proportions, each with its denominator and Wilson 95% interval.
Abstentions on present links remain in recall's denominator. Intervals describe
these cases, with no claim that their variants are independent real-world
samples. The report leaves false-loss rate null: link loss requires earlier
confirmation and a later comparable recheck, not one HTML absence observation.

Before claiming >=99% real-world precision, collect an independent, manually
annotated corpus of real source/target pairs under permitted collection and
redistribution terms; record blocked outcomes separately and publish recall.
Any calibrated probabilities need a separately frozen holdout that was not used
to tune heuristics. Neither a perfect fixture result nor coverage is calibration.
