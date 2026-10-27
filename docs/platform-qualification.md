# Controlled platform qualification

Run a bounded local acceptance workload from a checkout using Node 22.18+:

```sh
node --experimental-strip-types scripts/platform-qualify.mjs 200 /private/tmp/rankproof-qualification
```

The output directory must be empty. The default workload is 200 jobs; the CLI accepts 100–500. It writes a private JSON report and SQLite evidence database, with a sampled 20 MiB storage ceiling. A smaller regression test exercises the same path:

```sh
node --experimental-strip-types --test scripts/platform-qualify.test.mjs
```

The workload uses three child scheduler processes, the actual `platformWorker` entry point, the default queued verifier, durable grants/artifacts, request reservations and telemetry. Each job opens the existing worker's normal database connection. The HTTP transport is redirected through explicit test DNS/fetch hooks to a loopback server; it refuses unknown logical hosts and paths. No external source, model, provider or Docker runtime is used.

An IPC ready/start barrier waits until all three initial workers have initialized. The main run also holds responses to its first two source requests other than the crash victim until both have reached the HTTP server, proving actual concurrent admission without depending on process startup speed or a short response delay. Both barriers fail after five seconds. Replacement workers report readiness before starting, after the killed process is confirmed terminal.

Sixteen jobs exercise the global and per-host request limits. The remaining jobs include known present anchors, known absent anchors and HTTP 403 responses. Every committed observation is checked against its controlled response; budget failures must never become `not_found`. Request reservations are reconciled with actual server requests, and shared host concurrency is checked across processes.

One child is killed after its source request reaches the server. Only after that process exits does a replacement start. The expired lease must be reclaimed on attempt two, with one committed completion and the original request still charged. Polling timeouts fail the run and terminate its own remaining workers; they do not silently restart them. Existing queue unit tests separately cover deterministic backoff and stale-worker fencing. Completed HTTP-error observations are not retried by this workload.

Acceptance also checks artifact immutability, tenant isolation and database close/reopen durability. The report distinguishes worker execution latency from enqueue-to-observed-committed-completion latency and reports nearest-rank p50/p95. Latencies include the deliberate barriers and lease-expiry fault injection; they do not measure steady-state throughput. CPU samples cover final committed attempts; killed-process CPU and received bytes are unavailable and remain null. RSS values are observed process snapshots, not per-job peak memory. Server response bytes count decoded bodies written, not wire bytes or acknowledged delivery. Storage is sampled between polling intervals, not enforced as an OS quota.

`operationalAssertionsPassed` means these specific controlled assertions passed. `pricedQualityQualified` remains false because source and hosting prices are unknown; monetary cost per job remains null. Blocked sources and deliberate request exhaustion also remain incomplete measurements. This qualification establishes neither real-world extraction accuracy nor a production SLO, monetary unit economics, multi-machine scaling or external-network SSRF behavior. Preserve the report together with its database and record the tested source revision when using it as release evidence.
