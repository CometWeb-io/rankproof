# Durable agent verification history

The HTTP/MCP service normally keeps bounded process memory. For restart-safe
evidence, configure an operator-owned SQLite file before starting either transport:

```sh
mkdir -m 700 .rankproof-agent-history
export RANKPROOF_AGENT_HISTORY_DB="$PWD/.rankproof-agent-history/history.sqlite"
npm run agent:api
```

Use the same environment variable when launching `scripts/agent-mcp.mjs` directly
from an MCP host. Source checkouts require `--experimental-strip-types`; installed
packages load compiled JavaScript. The optional database needs Node 22.13+ (23.4+
on the Node 23 line), `node:sqlite`, and POSIX private filesystem permissions.
SQLite remains experimental in Node 22. Windows ACL qualification is not implemented,
so this optional backend refuses Windows; base CLI and memory mode are unchanged.

The immediate parent directory must already exist, belong to the process user and
allow access only to that owner. A new database is created with mode `0600`.
Symlink files/directories and existing group/world-accessible files are refused.
Keep the database, WAL/SHM sidecars and backups inside the protected directory.
There is no silent memory fallback when configured persistence fails admission.

## Receipts after restart

Verification and remeasurement return opaque `report_id` and `observation_id`
strings. Save these identifiers. After a process restart, `get_evidence`,
`list_findings` and a `diff` using stored IDs read the original retained observations.
The durable profile reports:

```json
{
  "kind": "bounded_sqlite",
  "max_reports": 5000,
  "max_bytes": 64000000,
  "ttl_seconds": null
}
```

Inspect this metadata instead of assuming a service uses durable storage. A stored
diff reports `evidence_origin: rankproof_history`; an ordinary memory-session diff
keeps `rankproof_session`. Caller-supplied observations remain
`caller_supplied_untrusted`. HTTP errors, challenges and incomplete observations
remain unknown; retained history cannot turn them into link loss.

The store admits only bounded observations from the actual verifier path. Dataset
imports and replayed captures do not write trusted history. Each report is an
immutable JSON payload with a SHA-256 integrity hash; reads revalidate its schema,
observation identifiers, exact confirmed destination and hash. Database triggers
reject updates/deletes. `WAL`, `synchronous=FULL` and an atomic transaction protect
acknowledged writes; a tested SIGKILL/restart retains the same receipts.

## Capacity, ownership and permissions

The maximum serialized report is 1 MiB. Reduce the verification batch if its
retained metadata would exceed that limit. At 5000 reports or 64,000,000 serialized
payload bytes per tenant/project, new writes fail explicitly. Existing observations
remain readable. No eviction or automatic deletion occurs in durable mode. Export
the observations and rotate to another protected database under the operator's
retention policy. Payload quota is not an exact physical SQLite/WAL disk-size cap.

The library `createPersistentObservationStore(path, issuedScope)` reuses the
platform's process-issued tenant/project/role capability. Every read/write applies
that scope; copied or serialized capabilities are refused, and a reader cannot
save verifier results. The built-in HTTP/MCP transports are **single operator**:
their configured database scope is `local-operator/agent-history`, shared by all
holders of that service token and local MCP processes using the same database.
Request JSON cannot choose the database path, tenant or membership. This is not
Team Cloud authentication or authorization.

The in-process `save` method is a trusted integration sink, not a remote import
endpoint. The OS/database owner can disable triggers or replace both payload and
hash. Integrity checks are not signatures or source authenticity. Stored URLs,
anchors and outcomes may be sensitive; protect their retention and backups.
Raw HTML bodies are not retained by this store; use the separate explicit
[capture/replay workflow](evidence-replay.md) when needed.
