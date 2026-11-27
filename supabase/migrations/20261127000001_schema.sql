-- ═══════════════════════════════════════════════════════════════════════
-- De Broekhof beheer — databaseschema v1
-- Vervangt de Google Sheet "Boekingen de Broekhof (app versie)":
--   tabblad "Formulierreacties 1" → boekingen
--   tabblad "Financieel status"   → betalingen
-- Alle koppelingen via vaste uuid's, nooit meer via rijnummers.
-- ═══════════════════════════════════════════════════════════════════════

create extension if not exists pgcrypto;

-- ── Beheerders ────────────────────────────────────────────────────────
-- Alleen accounts in deze tabel mogen iets zien of wijzigen.
-- Toevoegen: insert into public.beheerders (user_id, naam)
--            select id, 'Eric' from auth.users where email = '...';
create table public.beheerders (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  naam          text not null,
  aangemaakt_op timestamptz not null default now()
);

create or replace function public.is_beheerder()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.beheerders where user_id = auth.uid());
$$;

-- ── Boekingen ─────────────────────────────────────────────────────────
create table public.boekingen (
  id              uuid primary key default gen_random_uuid(),
  aangemaakt_op   timestamptz not null default now(),
  gewijzigd_op    timestamptz not null default now(),
  boekingsdatum   date not null default ((now() at time zone 'Europe/Amsterdam')::date),

  aankomst        date not null,
  vertrek         date not null,
  checkin         time not null default '16:00',
  checkout        time not null default '10:00',

  aanhef          text check (aanhef in ('heer', 'mevrouw')),
  voornaam        text not null default '',
  achternaam      text not null,
  telefoon        text,
  email           text,
  adres           text,
  postcode        text,
  plaats          text,
  land            text default 'Nederland',

  personen        integer not null default 1 check (personen >= 0),
  huisdieren      integer not null default 0 check (huisdieren >= 0),
  bedlinnen       integer not null default 0 check (bedlinnen >= 0),
  keukenlinnen    integer not null default 0 check (keukenlinnen >= 0),

  -- Bedragen zoals afgesproken in de huurovereenkomst (euro)
  huurprijs       numeric(10,2) not null default 0,
  schoonmaak      numeric(10,2) not null default 0,
  extras          numeric(10,2) not null default 0,
  totaal          numeric(10,2) not null default 0,
  aanbetaling     numeric(10,2) not null default 0,
  restant         numeric(10,2) not null default 0,
  borg            numeric(10,2) not null default 0,

  toegangscode    text check (toegangscode ~ '^[0-9]{6}$'),
  nuki_auth_id    text,
  mail_huurder    boolean not null default false,  -- aankomstmail ook naar huurder + sleutelbeheerder

  -- handmatig | micazu-import | micazu-aanvullen | micazu | migratie
  bron            text not null default 'handmatig',
  vraag_huurder   text,
  notitie         text,

  legacy_rijnr    integer,      -- rijnummer in de oude Sheet (alleen voor migratie)
  verwijderd_op   timestamptz,  -- verwijderen = verbergen

  constraint vertrek_na_aankomst check (vertrek > aankomst)
);

create index boekingen_aankomst_idx on public.boekingen (aankomst) where verwijderd_op is null;
create unique index boekingen_legacy_rijnr_idx on public.boekingen (legacy_rijnr) where legacy_rijnr is not null;

-- ── Betalingen ────────────────────────────────────────────────────────
create type public.betaling_soort as enum ('aanbetaling', 'restant', 'borg_terug');

create table public.betalingen (
  id                    uuid primary key default gen_random_uuid(),
  boeking_id            uuid not null references public.boekingen(id) on delete cascade,
  soort                 public.betaling_soort not null,
  vervaldatum           date not null,
  vervaldatum_handmatig boolean not null default false,
  bedrag                numeric(10,2) not null,  -- altijd positief; borg_terug is geld dat terug gaat
  betaald               boolean not null default false,
  betaald_op            date,
  notitie               text,
  verborgen             boolean not null default false,
  gewijzigd_op          timestamptz not null default now(),
  unique (boeking_id, soort)
);

-- ── Documenten (huurovereenkomsten) ───────────────────────────────────
create table public.documenten (
  id            uuid primary key default gen_random_uuid(),
  boeking_id    uuid not null references public.boekingen(id) on delete cascade,
  soort         text not null default 'huurovereenkomst',
  bestandsnaam  text not null,
  opslagpad     text,   -- pad in Storage-bucket 'huurovereenkomsten' (nieuw)
  drive_file_id text,   -- bestaande PDF in Google Drive (gemigreerd)
  aangemaakt_op timestamptz not null default now(),
  check (opslagpad is not null or drive_file_id is not null)
);

create index documenten_boeking_idx on public.documenten (boeking_id);

-- ── Mail-log ──────────────────────────────────────────────────────────
-- soort: bevestiging | aankomst | sleutelbeheerder | overzicht | betaalwaarschuwing | micazu
create table public.mail_log (
  id            uuid primary key default gen_random_uuid(),
  boeking_id    uuid references public.boekingen(id) on delete set null,
  soort         text not null,
  sleutel       text,   -- bv. aankomstdatum: voorkomt dubbele automatische mails
  naar          text not null,
  cc            text,
  onderwerp     text,
  status        text not null default 'verzonden',  -- verzonden | mislukt
  foutmelding   text,
  verzonden_op  timestamptz not null default now()
);

create unique index mail_log_automatisch_uniek
  on public.mail_log (boeking_id, soort, sleutel)
  where sleutel is not null and status = 'verzonden';

-- ── Instellingen ──────────────────────────────────────────────────────
create table public.instellingen (
  sleutel      text primary key,
  waarde       jsonb not null,
  omschrijving text
);

-- ═══════════════════════════════════════════════════════════════════════
-- Triggers
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.zet_gewijzigd_op()
returns trigger
language plpgsql
as $$
begin
  new.gewijzigd_op := now();
  return new;
end;
$$;

create trigger boekingen_gewijzigd_op before update on public.boekingen
  for each row execute function public.zet_gewijzigd_op();
create trigger betalingen_gewijzigd_op before update on public.betalingen
  for each row execute function public.zet_gewijzigd_op();

-- Betaalregels bijhouden bij elke boeking:
--   aanbetaling: 7 dagen na boekingsdatum
--   restant:     28 dagen voor aankomst
--   borg_terug:  7 dagen na vertrek
-- Een handmatig aangepaste vervaldatum blijft staan. Een bedrag van 0 haalt
-- een nog niet betaalde regel weg. Betaalde regels worden nooit verwijderd.
create or replace function public.werk_betalingen_bij()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
begin
  for r in
    select * from (values
      ('aanbetaling'::betaling_soort, new.aanbetaling, new.boekingsdatum + 7),
      ('restant'::betaling_soort,     new.restant,     new.aankomst - 28),
      ('borg_terug'::betaling_soort,  new.borg,        new.vertrek + 7)
    ) as t(soort, bedrag, vervaldatum)
  loop
    if coalesce(r.bedrag, 0) > 0 then
      insert into betalingen (boeking_id, soort, bedrag, vervaldatum)
      values (new.id, r.soort, r.bedrag, r.vervaldatum)
      on conflict (boeking_id, soort) do update
        set bedrag      = excluded.bedrag,
            vervaldatum = case when betalingen.vervaldatum_handmatig
                               then betalingen.vervaldatum
                               else excluded.vervaldatum end;
    else
      delete from betalingen
       where boeking_id = new.id and soort = r.soort and not betaald;
    end if;
  end loop;
  return new;
end;
$$;

create trigger boekingen_betalingen
  after insert or update of aanbetaling, restant, borg, boekingsdatum, aankomst, vertrek
  on public.boekingen
  for each row execute function public.werk_betalingen_bij();

-- ═══════════════════════════════════════════════════════════════════════
-- Beveiliging (RLS): alleen ingelogde beheerders
-- ═══════════════════════════════════════════════════════════════════════

alter table public.beheerders   enable row level security;
alter table public.boekingen    enable row level security;
alter table public.betalingen   enable row level security;
alter table public.documenten   enable row level security;
alter table public.mail_log     enable row level security;
alter table public.instellingen enable row level security;

create policy "eigen beheerdersrij" on public.beheerders
  for select to authenticated using (user_id = auth.uid());

create policy "beheerders" on public.boekingen
  for all to authenticated using (public.is_beheerder()) with check (public.is_beheerder());
create policy "beheerders" on public.betalingen
  for all to authenticated using (public.is_beheerder()) with check (public.is_beheerder());
create policy "beheerders" on public.documenten
  for all to authenticated using (public.is_beheerder()) with check (public.is_beheerder());
create policy "beheerders lezen" on public.mail_log
  for select to authenticated using (public.is_beheerder());
create policy "beheerders" on public.instellingen
  for all to authenticated using (public.is_beheerder()) with check (public.is_beheerder());

-- Mail-log wordt alleen door de server (service role) geschreven.

-- ── Opslag voor PDF's ─────────────────────────────────────────────────
insert into storage.buckets (id, name, public)
values ('huurovereenkomsten', 'huurovereenkomsten', false)
on conflict (id) do nothing;

create policy "beheerders lezen pdf" on storage.objects
  for select to authenticated
  using (bucket_id = 'huurovereenkomsten' and public.is_beheerder());
create policy "beheerders schrijven pdf" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'huurovereenkomsten' and public.is_beheerder());
create policy "beheerders vervangen pdf" on storage.objects
  for update to authenticated
  using (bucket_id = 'huurovereenkomsten' and public.is_beheerder());
