-- Scheduled runs for saved lists: how often, where to report changes, when
-- next, and why the last scheduled run failed (if it did).
alter table link_monitors add column if not exists schedule text not null default 'off';
alter table link_monitors add column if not exists webhook_url text;
alter table link_monitors add column if not exists next_run_at timestamptz;
alter table link_monitors add column if not exists last_error text;

create index if not exists link_monitors_due_idx
  on link_monitors (next_run_at) where schedule <> 'off';
