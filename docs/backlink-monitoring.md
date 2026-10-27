# Finite local backlink monitoring

The local monitor schedules fresh checks of an operator-supplied, fixed source–target URL cohort. It reuses the durable SQLite scan queue, expiring verification grants, the default backlink verifier, and append-only artifacts. It neither discovers new sources nor sends notifications. Exported alert records are for local consumption.

## Run a plan

Use Node 22.18+ or Node 24+, on POSIX with a private directory owned by the current user. From a source checkout:

```sh
mkdir -m 700 "$HOME/rankproof-monitor"
node --input-type=module -e '
import {writeFileSync} from "node:fs";
writeFileSync(process.argv[1], JSON.stringify({
  id: "partner-links-01",
  pairs: [{source_url: "https://publisher.example/article", target_url: "https://site.example/guide"}],
  firstAt: Date.now() + 60000,
  intervalMs: 86400000,
  occurrences: 7,
  windowMs: 900000,
  maxRequestsPerCycle: 10
}), {mode: 0o600, flag: "wx"});
' "$HOME/rankproof-monitor/plan.json"
node --experimental-strip-types scripts/monitor-backlinks.mjs create \
  "$HOME/rankproof-monitor/queue.sqlite" local project operator \
  "$HOME/rankproof-monitor/plan.json" "$HOME/rankproof-monitor/created.json"
```

Replace the illustrative URLs with authorized public source and target URLs before running. Creation persists the original exact-pair grants and future queue jobs; it makes no HTTP requests. Creating the same plan again is idempotent only when its input is unchanged. Renewal or a changed cohort requires a new monitor id and explicit plan creation.

Invoke `tick` inside each scheduled window. Each invocation executes at most one queued verification job, so a multi-pair cohort needs repeated ticks. Use the returned `state` and epoch-millisecond `nextAt` to drive your own local scheduler:

```sh
node --experimental-strip-types scripts/monitor-backlinks.mjs tick \
  "$HOME/rankproof-monitor/queue.sqlite" local project operator \
  partner-links-01 "$HOME/rankproof-monitor/tick-001.json"
node --experimental-strip-types scripts/monitor-backlinks.mjs export \
  "$HOME/rankproof-monitor/queue.sqlite" local project operator \
  partner-links-01 "$HOME/rankproof-monitor/report-001.json"
```

Every output path must be new. Outputs are created exclusively with mode `0600`; the command prints no report or response body to stdout. Plan, database, and output files require owner-only permissions and a private parent directory. Keep SQLite sidecars with the database in that private directory. The command does not install a daemon, cron entry, or background service. The tenant, project, and operator arguments identify a local administrative namespace under the OS user's authority; they do not authenticate a hosted tenant.

## Schedule and request bounds

- One to ten distinct external source–target pairs, with URL identity normalized by the existing backlink identity policy.
- One to thirty occurrences; interval one hour to thirty days; the last window must end within thirty-one days of creation.
- Each window lasts one minute to one hour and cannot exceed the interval; default fifteen minutes. A new plan may start at most sixty seconds in the past, while its first window is still open.
- One to one hundred outgoing request attempts per occurrence, default ten per pair. Robots requests and redirects consume that same durable budget. Each run permits one request in flight per host and at most two job attempts, with a two-minute lease and a one-second retry base.

A restart reopens the same database and original grants. A crashed lease can be reclaimed after expiry while the original window remains open. A tick after a window expires records its missing observations as unmeasured and sets `missedWindow`; it does not backfill or renew authorization. Calling `tick` after the final window seals any outstanding missed receipts and returns `finished`. Stopping the driver stops new work; already-running work remains subject to its existing deadline and request budget. There is no continuous-monitoring claim.

The underlying queue currently fences outgoing requests to the original source hostname. A cross-host redirect can therefore produce an unavailable check. SSRF, DNS, robots, response-size and HTML-completeness guards remain those of the actual verifier. Request caps may prevent all pairs from being measured; inspect receipts and `currentJobs` rather than treating schedule completion as successful measurement. Worker runtime failures propagate to the caller; claimed failures retain the existing queue retry state, and a failed command leaves no partial output report.

## Interpret evidence and local alerts

Each completed occurrence receives an immutable receipt containing the cohort and plan digests, original window, request usage, pair outcomes, actual verification artifact references, and the previous receipt digest. Export revalidates the plan, original grants, exact queued cohort, worker artifact origin, response metadata, and every receipt against its retained evidence. Generic operator artifacts cannot be substituted as verifier observations. Hashes and proof reconstruction detect alteration relative to retained records; they are not signatures, source authenticity guarantees, or protection against a fully compromised local owner.

`html_link_absent` requires an earlier actual confirmation and a fresh comparable complete fetched-HTML recheck. Errors, challenges, robots refusals, missing jobs, and changed source representation or final resource are not link-loss proof. HTTP 404/410 is reported as source unavailability rather than HTML link absence. The last confirmation survives unavailable windows. Repeated comparable absence emits one absence alert until a subsequent confirmation produces `link_reconfirmed`.

`link_attributes_changed` compares compatible actual observations of anchor text, rel values, and the optional relationship metadata. This monitor explicitly opts its trusted grants into retaining `html-relationship-context-v1`: **the first matching HTML anchor**, its matching-anchor count, text/image kind, heuristic placement, and bounded parser-text context (at most 400 characters) plus its hash. This may retain source text in the private database. It is not rendered text or a semantic assessment. Default API verification and grants outside this explicit opt-in keep their existing context-retention behavior. Older observations without compatible metadata do not establish a context change.

The export's `execution: complete` means every pair has a worker observation, including errors; inspect each pair's `outcome` and `attempt`. Alerts and observations describe fetched HTML only. They do not establish global or rendered absence, indexing, publication time, endorsement, or ranking impact. The monitor retains verifier facts and the bounded opted-in excerpt, not replayable full HTML; use the separate [opt-in evidence capture and replay workflow](evidence-replay.md) when that is required. Retention does not grant confidentiality or redistribution rights over source content. No email, webhook, external alert delivery, remote database, or Team Cloud service is configured.

## Local checks

```sh
node --experimental-strip-types --test \
  src/lib/backlinks/backlink-monitor.server.test.ts scripts/monitor-backlinks.test.mjs
```

The tests exercise the default worker and parser with controlled network responses, finite windows, challenge/error handling, attribute changes, expired lease recovery, independent-process restart, and tamper refusal. They do not certify a live publisher, a hosted scheduler, or an external notification provider.
