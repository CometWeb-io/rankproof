-- Historia pozycji w SERP-ach (RankProof 5.0).
--
-- Jeden wiersz = jedna fraza w jednej wyszukiwarce w jednym skanie. Dzięki
-- temu kolejny skan potrafi pokazać awanse i spadki zamiast samej migawki.
-- Dane są publiczne (domena, fraza, pozycja) — bez informacji o użytkowniku.

create table if not exists serp_rank_history (
  id bigserial primary key,
  host text not null,
  keyword text not null,
  engine text not null,
  -- null = cel poza sprawdzonym zakresem wyników.
  position integer,
  difficulty integer not null default 0,
  queried_at timestamptz not null default now()
);

create index if not exists serp_rank_history_host_time_idx
  on serp_rank_history (host, queried_at desc);

create index if not exists serp_rank_history_keyword_idx
  on serp_rank_history (host, keyword, engine, queried_at desc);
