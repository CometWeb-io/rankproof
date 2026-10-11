-- Link and SERP histories compare only equivalent market, device,
-- keyword set, scan profile, sources and collection caps.
-- Legacy positions remain NULL; they must not manufacture ranking changes.
alter table serp_rank_history add column if not exists scan_scope text;

create index if not exists serp_rank_history_scope_idx
  on serp_rank_history (host, scan_scope, keyword, engine, queried_at desc);
