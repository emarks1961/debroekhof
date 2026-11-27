-- Koppelingen met andere diensten (nu: OneDrive). Alleen de server (service role)
-- mag hierbij: RLS aan en geen policies, dus niet leesbaar vanuit de browser.
create table if not exists public.koppelingen (
  naam       text primary key,
  gegevens   jsonb not null default '{}'::jsonb,
  bijgewerkt timestamptz not null default now()
);
alter table public.koppelingen enable row level security;
revoke all on public.koppelingen from anon, authenticated;
