-- Null legacy scopes remain unknown; do not guess their market or device.
alter table serp_rank_history add column if not exists market text;
alter table serp_rank_history add column if not exists device text;
alter table serp_rank_history add column if not exists checked_depth integer;
alter table serp_rank_history add column if not exists result_status text;
alter table serp_rank_history add column if not exists identity_policy text;
alter table serp_rank_history add column if not exists measurement_version text;
alter table serp_rank_history add column if not exists source_revision text;
create index if not exists serp_rank_history_scope_idx
  on serp_rank_history(host, market, device, checked_depth, keyword, engine, queried_at desc);
