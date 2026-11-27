-- Extra prijsvelden: overige extra's, bruto huurprijs en last-minutekorting.
-- huurprijs blijft het bedrag ná korting (bruto_huurprijs - lastminute_korting).

alter table public.boekingen
  add column if not exists overige_extras       text,
  add column if not exists prijs_overige_extras numeric(10,2) not null default 0,
  add column if not exists bruto_huurprijs      numeric(10,2),
  add column if not exists lastminute_korting   numeric(10,2) not null default 0;

-- Bestaande boekingen: bruto = huurprijs (geen korting)
update public.boekingen set bruto_huurprijs = huurprijs where bruto_huurprijs is null;
