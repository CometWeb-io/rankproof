-- Saved link lists and their server-side runs (web app monitoring).
--
-- Every row belongs to one user (user_id from the verified session, never
-- from the client) and every query is scoped by it. A run stores the slim
-- observations needed to compare with the next run, not the fetched HTML.

create table if not exists link_monitors (
  id bigserial primary key,
  user_id text not null,
  name text not null,
  pairs text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists link_monitors_user_idx on link_monitors (user_id, updated_at desc);

create table if not exists link_monitor_runs (
  id bigserial primary key,
  monitor_id bigint not null references link_monitors (id) on delete cascade,
  user_id text not null,
  ran_at timestamptz not null default now(),
  summary jsonb not null,
  results jsonb not null
);

create index if not exists link_monitor_runs_monitor_idx
  on link_monitor_runs (monitor_id, ran_at desc);
