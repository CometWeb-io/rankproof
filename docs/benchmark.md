# Verification benchmark

`npm run benchmark` scores the HTML extractor against a labelled corpus in [`src/lib/backlinks/fixtures/verify-benchmark.ts`](../src/lib/backlinks/fixtures/verify-benchmark.ts). It runs offline and deterministically through the same `observeRepresentation()` function that live verification and `rankproof replay` use. The test suite fails if any labelled case regresses.

```bash
npm run benchmark            # readable report
npm run benchmark -- --json  # machine-readable, e.g. to publish per release
```

## What is measured

| Metric              | Meaning                                                                                |
| ------------------- | -------------------------------------------------------------------------------------- |
| accuracy            | Cases where status and every labelled field (anchor, rel, placement) match             |
| confirmed precision | Of all `confirmed` verdicts, the share that were right                                 |
| confirmed recall    | Of all truly linked cases, the share that were confirmed                               |
| unresolved share    | Cases answered with `error` — an honest abstention, but no answer                      |
| false absences      | `not_found` where the link exists or the page was unreadable; the costliest error type |

Categories: URL identity (fragments, entities, case, ports, `<base>`, tracking parameters, trailing slashes, scheme, `www`, redirect wrappers), markup traps (comments, scripts, `<textarea>`, `<template>`, unquoted and duplicate attributes), rel tokens, anchor text (nested markup, image alt, `<wbr>`, entities), placement, HTTP statuses and unreadable pages (challenges, application shells, non-HTML, empty bodies).

## Documented limitations

Some cases differ between fetched HTML and what a browser shows. They carry `limitation: true` and `browser_truth`, are reported separately, and do not count toward accuracy: a link inserted by JavaScript (RankProof: `not_found`, browser: present) and a link hidden with CSS (RankProof: `confirmed`, visitor: not visible).

## Rendered mode

```bash
npm run benchmark -- --render
```

Runs the same corpus through headless Chromium, offline (each case's HTML is served to the browser and every other request is blocked), with `render: always` semantics. It checks two things: rendering must not change a single correct status, and the documented limitations must now match what a visitor sees — the JavaScript-inserted link is confirmed, the CSS-hidden link is reported as hidden. Current result: 39/39 and 2/2. The tests run this mode automatically when a Chromium is available and skip it otherwise.

## Benchmark on your own real links

The built-in corpus is small and written by the maintainers. The audit-grade test is a few hundred **real** pairs, labelled by a person:

```bash
# 1. Verify real links and keep the HTML.
npm run cli -- verify links.csv --format json --out run.json --capture-dir evidence/
# 2. Turn the run into labelling material.
npm run cli -- corpus run.json --capture-dir evidence/ --out cases.json
# 3. Review each case: open the snapshot or page, set expected.status (and anchor/rel),
#    then "reviewed": true. RankProof's verdict is only in "suggested".
# 4. Score it.
npm run benchmark -- --corpus cases.json            # fetched HTML
npm run benchmark -- --corpus cases.json --render   # plus headless Chromium
```

Unreviewed cases are ignored, so RankProof never grades itself. Mix in redirects, JavaScript-heavy pages, `nofollow`/`sponsored`, blocked hosts, odd encodings, subdomains and links that were removed. Report precision, recall, unresolved share and false absences together: a tool that answers "unknown" to everything never errs and is useless. Contributing anonymised, labelled cases back to the built-in corpus is the most valuable contribution there is.

## What it does not prove

The labels follow the documented rules in [API](api.md) and were written by the maintainers, not by an independent panel. A perfect score means the extractor does what the rules say on these pages, not that it is right on every page on the web. The corpus is small by design so every case can be read. Add a case for every bug report; a contribution from someone outside the project is the most valuable kind.
