-- Briefhoofd van de huurovereenkomst: KvK-nummer en (optioneel) handtekening.
-- Waarden staan bewust niet in de repository; vul ze in via de Table Editor.
-- handtekening = afbeelding als data-URL ("data:image/jpeg;base64,...").
insert into public.instellingen (sleutel, waarde, omschrijving) values
  ('kvk',          '""', 'KvK-nummer in het briefhoofd van de huurovereenkomst'),
  ('handtekening', '""', 'Handtekening onder de reserveringsbevestiging (data-URL van een afbeelding)')
on conflict (sleutel) do nothing;
