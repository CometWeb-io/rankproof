# Optional local platform

RankProof's platform modules provide a durable local queue, a controlled link-removal workflow and operational telemetry. They do not provide a hosted multi-tenant service, billing, SSO, remote PR creation or automatic site edits.

## Runtime and reproducible execution

The base CLI keeps its existing Node requirement. The optional SQLite queue requires **Node 22.13+**, or **23.4+** on the Node 23 line, and a build with `node:sqlite` available. The feature checks the version before dynamically importing SQLite; it fails with a feature-specific error on older runtimes. SQLite remains experimental on the supported Node 22 runtime. See [Node's SQLite version history](https://nodejs.org/api/sqlite.html).

From a source checkout:

```sh
npm ci
npm run build:cli
node --experimental-strip-types scripts/platform-smoke.mjs
node --experimental-strip-types scripts/platform-load.mjs 500
```

The smoke prints a private output directory containing SQLite state, `platform-smoke.json` and a static `platform-dashboard.html`. It starts a loopback HTTP server and runs the **default worker and actual backlink verifier** against a test-only relay. The relay forbids any other outbound host. It measures local execution; it does not qualify external websites or providers. The load command measures queue operations only, including a restart; its monetary unit cost is `null` until real prices are configured. Do not interpret it as crawler throughput.

The scripts use compiled `dist` modules in a packaged installation and TypeScript modules in a checkout. Packaging and registry publication are separate release checks; running a source smoke does not establish a published package. Changes to queue/artifact schemas or request-metering semantics require an explicit migration/compatibility review before replacing an existing state file.

## Scope and storage boundary

Use one operator-owned SQLite file in a private directory (mode `0700`). New database files are created with mode `0600`. Place backups and all sidecar files under the same protected directory. SQLite WAL and `synchronous=FULL` protect committed state on a **single machine**; do not put this file on a network filesystem or call this a distributed cluster.

`createTenantScope(authenticatedPrincipal, projectId)` checks project membership and issues a frozen, process-local capability. Every public data method requires that issued scope and filters by **tenant and project**. Serialized or spread-copied scopes are rejected. Roles are `reader`, `worker` and `operator`; only the operator can create runs, enqueue work and create grants/remediation events. A worker can lease jobs and write ordinary artifacts/telemetry, but cannot manufacture a scan grant or remediation approval through the artifact API.

This is an application boundary, **not authentication**. A server adapter must authenticate the caller and obtain membership/role from trusted server state before calling `createTenantScope`; never pass a principal from a JSON body. The local worker CLI trusts the OS user who can open the database. Do not expose that CLI, arbitrary artifact writes or `recordVerification` as remote write endpoints. Anyone with direct filesystem/database access controls the stored data; hashes are integrity checks, not signatures or protection against the database owner.

## Durable queue and request admission

```ts
import { ScanQueue } from "./scan-queue.server.js";
import { createTenantScope } from "./tenant-scope.js";
import { grantQueuedVerification } from "./scan-queue-worker.server.js";

const operator = createTenantScope(
  {
    subject: "operator-1",
    tenantId: "tenant-1",
    projectIds: ["site-1"],
    role: "operator",
  },
  "site-1",
); // obtained after authentication
const queue = new ScanQueue("/private/operator/queue.sqlite");
queue.createRun(operator, "run-1", {
  maxRequests: 20,
  maxRequestsPerHost: 10,
  maxConcurrentPerHost: 1,
  minHostIntervalMs: 0,
  maxAttempts: 3,
  retryBaseMs: 1000,
  leaseMs: 30000,
});
const grantArtifactId = grantQueuedVerification(queue, operator, {
  id: "grant-1",
  runId: "run-1",
  sourceUrl: "https://publisher.example/article",
  targetUrl: "https://brand.example/offer",
  expiresAt: Date.now() + 60000,
});
queue.enqueue(operator, {
  runId: "run-1",
  dedupeKey: "pair-1",
  url: "https://publisher.example/article",
  payload: { kind: "verify_backlinks.v1", grantArtifactId },
});
queue.close();
```

Run one due job with the standalone entrypoint:

```sh
node --experimental-strip-types scripts/platform-worker.mjs \
  /private/operator/queue.sqlite tenant-1 site-1 run-1 worker-1
```

The worker returns `null` if no due job can be admitted. A scheduler can call it repeatedly; `availableAt` schedules individual jobs. Completed jobs remain immutable in their run, and an identical dedupe key returns the existing job. A conflicting URL/payload under that key is rejected. A subsequent measurement uses a new run or a deliberately new dedupe key; this is not automatic discovery of changed pages.

Claims and state transitions use `BEGIN IMMEDIATE`. Each lease has a random token, incrementing attempt and expiry. Heartbeat, request reservation, completion, retry and verifier-artifact creation all check the live lease. After a worker crash, another process can reclaim the expired lease. The previous token cannot write a successful completion or consume more request budget. Explicit retry uses bounded exponential backoff; exhausted crash attempts become `failed` on the next claim. In-flight network work may finish after expiry, but its stale worker cannot commit a successful job result.

The per-host admission count spans live jobs in the shared database; the claiming run supplies its concurrency cap. Use the same host policy across cooperating runs. The actual transport retains its own per-host/global HTTP concurrency bounds. `reserveScanQueueRequest` runs immediately before each network attempt, including robots, retries and redirect hops. Reservations are committed before I/O and never refunded after a crash. Cache hits consume no requests. Cross-host requests under a single-host lease are refused; schedule another host explicitly rather than silently following it. A nonzero host interval refuses attempts during cooldown; a refused verifier attempt is an unknown/blocked measurement and must be rescheduled deliberately.

The default executor refuses to run unless the actual network module advertises `queue-request.v1`. `withScanQueueRequests` carries the lease through async work; `reserveScanQueueRequest` and `recordScanQueueResponse` are the transport hooks. Outside a queued request they are no-ops and do not load SQLite into the base CLI. Custom executors are trusted integrations and must enforce the same hooks for **every** request; declaring the string alone is not a security sandbox.

## Measured link-removal workflow

`RemediationStore` provides a deliberately narrow workflow for removal of a previously measured HTML link:

1. `create(scope, id, findingId, baselineArtifactId)` requires a completed trusted verifier job confirming a real HTML anchor.
2. `createTask` records a local task/reference and the SHA-256 of the proposed patch. It does not create a remote task or PR.
3. `approve` records an explicit operator, matching patch digest and expiry.
4. `recordDeployment` records the operator-supplied deployment reference and the same patch digest. The operator performs the actual change separately.
5. `recordRemeasurement` consumes a completed trusted worker artifact. It never accepts a hand-written `absent` claim as measured verification.

`verified` means the exact link was present before and absent from a fresh, complete fetched-HTML observation after deployment. Source/target URLs, extraction version, identity policy, source revision, method and final URL must be comparable; both complete observations require a response hash and successful HTTP status. The new observation must be later than the baseline and deployment, and a replayed HTML hash cannot establish removal. The absence is limited to **fetched HTML**, not rendered content, search indexing or ranking impact.

403/429, browser challenges, unknown or incomplete observations, changed redirects and HTTP-resource absence remain `inconclusive`. A still-confirmed HTML link becomes `still_present`. A mismatched cohort/method/revision, expired grant or replay is rejected. A generated artifact from an unfinished/stale job is insufficient. Approval and deployment references are operator attestations; there is no remote deployment attestation or causal attribution of SEO outcomes.

The remediation namespace rejects generic artifact writes. Typed writes check the complete state, legal transition, authenticated operator, immutable baseline/approval/deployment fields and predecessor digest. Reads revalidate trusted origin and the full evidence-backed state, including malformed historical rows. Records are append-only, versioned and linked by previous artifact digest. Concurrent alternative writes to one version conflict instead of silently overwriting history. Read operations return tenant-local data only. The database owner remains trusted.

## Telemetry and degradation

`PlatformTelemetry.record` persists immutable samples; `report` returns JSON for one tenant/project/run. The local dashboard uses those samples from actual execution. Metrics include nearest-rank p50/p95, decoded response bytes, reserved requests, blocked/error counts, source errors, process CPU deltas, observed RSS and source cost in USD. RSS is a sampled process value, **not peak memory of an isolated job**; CPU deltas are suitable for the standalone single-job worker, not attribution across unrelated concurrent work in the same process.

Unknown bytes, request counts and costs remain `null` in samples and are counted as unknown in aggregates. Decoded response bytes are not wire/compressed bytes. One explicitly free local source can contribute known cost `0`; unknown provider/hosting/support costs must not be inferred as zero. Expected measurement count is supplied from the caller's cohort. Repeated attempts for the same measurement ID do not inflate coverage; the latest observation determines measurement quality. Technical execution counts remain separate from complete measurement coverage. Reports beyond 5000 stored samples are marked truncated and fail the quality gate.

Hard request budgets stop network admission. The quality/cost report returns these caller actions:

| Condition                                             | Action                                                                                     |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Hard request budget exhausted                         | Transport refuses the next attempt; no false absence                                       |
| Known source cost exceeds configured report threshold | `stop_new_work`; scheduler must stop admitting more work                                   |
| Cost unknown and known cost required                  | `require_cost_configuration`; do not claim an affordable/complete scan                     |
| Coverage below threshold or latency SLO exceeded      | Quality gate fails; retain partial results and reschedule only under a new explicit budget |

Cost actions are signals for the scheduler, not a billing system or automatic provider spending control. There is no monetary budget enforcement across external provider accounts.

## Validation boundaries

Local tests cover two-process atomic claim, `SIGKILL` recovery, stale-token fencing, retry/backoff, request and host budgets, tenant/project isolation, forged/replayed/incomplete evidence and the real-verifier loopback workflow. This is not an external accuracy benchmark, paid pilot, cloud isolation audit, multi-machine qualification or proof of published distribution. Those remain separate release and product acceptance gates.
