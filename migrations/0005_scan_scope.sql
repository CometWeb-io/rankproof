-- Scope-aware scan history. Existing rows are intentionally left NULL because
-- their sampling/market/profile conditions cannot be reconstructed reliably.
alter table scan_history add column if not exists scan_scope text;
