# Contributing to RankProof

Thanks for wanting to help. This document explains how to start and what to expect.

## Before you write code

- **Found a bug?** Open an issue with steps to reproduce. For SERP parsers, include the raw HTML fragment — without it the bug cannot be fixed.
- **New feature?** Open a discussion first. Agreeing on direction is easier than rejecting a finished pull request.
- **Small fix** (typo, dead link, obvious bug)? Send the PR straight away.

## Environment

Requires Node 22+ (the project runs TypeScript natively via `--experimental-strip-types`).

```bash
npm install
npm run dev          # app on http://localhost:8080
npm run check        # typecheck + lint + tests — run this before every PR
```

No database needed: without `DATABASE_URL` the embedded PGLite starts up.

## Code standards

- **TypeScript, strict mode.** `npm run typecheck` must be clean.
- **Pure logic in separate files.** Modules without a `.server` suffix must not touch the network or the database — that is what makes them testable without mocking half the world. Anything that performs I/O gets a `.server.ts` suffix.
- **Comments explain "why", not "what".** A comment saying that a loop iterates over an array is noise. A comment explaining why a threshold is 12% saves the next person.
- **English.** Interface, comments, error messages and documentation are in English. Translations of the UI are welcome as a separate layer.
- **No new dependencies** without discussing it first. Every package is a maintenance cost.

## Tests

Tests use `node:test` and run without a bundler:

```bash
npm test
```

A new numeric feature (metric, score, threshold) **requires a test** that checks not merely "it returns something" but that it returns a sensible value at the edges. A SERP parser requires a golden test against a frozen fixture in `src/lib/backlinks/fixtures/` — see the README there for how to capture one.

Do not write tests that need the network. Those layers live in `.server.ts` files precisely so they can be skipped.

## Metrics and honesty

This tool computes approximations from open data. If you add a metric:

- Describe the method in [`docs/metrics.md`](docs/metrics.md).
- Do not name it after a commercial metric if it is calculated differently.
- State plainly what it does **not** measure. People make business decisions on these numbers.

## Being a good network citizen

Any change that increases request volume — higher concurrency, more sources, extra crawl depth — needs a justification in the PR description. The scanner runs against servers whose owners never agreed to it. `robots.txt` and `Crawl-delay` are honoured on crawled pages; do not add code paths that bypass that.

Security-sensitive changes to `net.server.ts`, `ssrf.ts` or `robots.server.ts` need a test demonstrating the new behaviour.

## Pull request

1. Branch with a descriptive name (`fix/parser-bing-cite`, `feat/serp-market-it`).
2. `npm run check` passes.
3. The description explains **what** and **why**; for parser changes, attach sample HTML.
4. One change per PR. Refactor plus feature in one commit is a request for a slow review.

## Reporting vulnerabilities

Do not open a public issue — see [`SECURITY.md`](SECURITY.md).

## Contribution licence

By opening a pull request you agree to release your contribution under the [MIT](LICENSE) licence.

## A note on scaffold tests

`npm test` runs this project's tests (`src/**`). A separate `npm run test:scaffold` covers the build and preview helpers in `scripts/**`. Both suites pass; if either one is red, that is a bug, not a known quirk.
