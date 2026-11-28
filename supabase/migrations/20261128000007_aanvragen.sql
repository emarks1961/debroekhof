-- Beschikbaarheidsaanvragen vanaf de website (website.mjs schrijft, beheerders lezen en wijzigen).
-- Een aanvraag blokkeert geen datums; pas een boeking doet dat.
create table if not exists public.aanvragen (
  id            uuid primary key default gen_random_uuid(),
  ontvangen_op  timestamptz not null default now(),
  -- nieuw | overgenomen (boeking gemaakt) | afgewezen
  status        text not null default 'nieuw' check (status in ('nieuw', 'overgenomen', 'afgewezen')),
  naam          text not null,
  email         text not null,
  telefoon      text,
  aankomst      date not null,
  vertrek       date not null,
  personen      integer not null check (personen between 1 and 12),
  huisdier      boolean not null default false,
  bericht       text,
  ip_hash       text,   -- alleen om spam te beperken, geen herleidbaar IP-adres
  boeking_id    uuid references public.boekingen(id) on delete set null,
  constraint aanvraag_vertrek_na_aankomst check (vertrek > aankomst)
);

create index if not exists aanvragen_ontvangen_idx on public.aanvragen (ontvangen_op desc);

alter table public.aanvragen enable row level security;
create policy "beheerders" on public.aanvragen
  for all to authenticated using (public.is_beheerder()) with check (public.is_beheerder());
