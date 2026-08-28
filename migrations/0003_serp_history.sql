-- Widoczność SERP w trwałej historii skanów (RankProof 4.0).
-- Kolumna jest agregatem publicznym (0–100), bez danych osobowych.

alter table scan_history
  add column if not exists visibility integer not null default 0;
