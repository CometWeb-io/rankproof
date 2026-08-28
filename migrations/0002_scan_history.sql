-- Trwała historia skanów RankProof.
--
-- Aplikacja działa bez logowania (auth OFF), więc wiersze są nieprzypisane do
-- użytkownika i celowo zawierają wyłącznie dane publiczne: skanowaną domenę i
-- zagregowane metryki jej profilu linków. Dzięki temu wykres trendu oraz
-- porównanie „nowe / utracone linki" działa między urządzeniami i sesjami,
-- a nie tylko w localStorage jednej przeglądarki.

create table if not exists scan_history (
  id bigserial primary key,
  host text not null,
  queried_at timestamptz not null default now(),
  backlinks integer not null default 0,
  referring_domains integer not null default 0,
  dofollow integer not null default 0,
  domain_rating integer not null default 0,
  health integer not null default 0,
  spam_domains integer not null default 0,
  lost_links integer not null default 0,
  -- Identyfikatory linków i lista domen służą do policzenia różnicy
  -- względem poprzedniego skanu (nowe / utracone).
  link_ids jsonb not null default '[]'::jsonb,
  domains jsonb not null default '[]'::jsonb
);

create index if not exists scan_history_host_time_idx
  on scan_history (host, queried_at desc);
