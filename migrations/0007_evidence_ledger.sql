-- Legacy aggregates remain readable; new comparisons require a versioned cohort.
alter table scan_history add column if not exists measurement jsonb;

create table if not exists evidence_runs (
  root_hash text primary key check (root_hash ~ '^[a-f0-9]{64}$'),
  host text not null,
  queried_at timestamptz not null,
  ledger jsonb not null check (ledger->>'version' = 'evidence-ledger-v2'),
  check (ledger->>'rootHash' = root_hash),
  check (ledger->>'host' = host)
);
create index if not exists evidence_runs_host_time_idx on evidence_runs(host, queried_at desc);

create or replace function reject_evidence_rewrite() returns trigger language plpgsql as $$
begin
  raise exception 'Evidence rows are append-only; corrections require a new observation';
end;
$$;
drop trigger if exists evidence_runs_immutable on evidence_runs;
create trigger evidence_runs_immutable before update or delete on evidence_runs
  for each row execute function reject_evidence_rewrite();
