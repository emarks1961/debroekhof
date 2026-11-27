-- Standaardinstellingen. Lege waarden ("") vul je na installatie in;
-- contact- en bankgegevens staan bewust niet in de repository.
-- Waarden zijn later aan te passen in de tabel
-- instellingen (Supabase Table Editor) zonder de code te wijzigen.
insert into public.instellingen (sleutel, waarde, omschrijving) values
  ('email_info',             '"info@debroekhof.nl"',  'Afzender en vaste ontvanger (cc) van alle mails'),
  ('email_sleutelbeheerder', '""',                     'E-mailadres sleutelbeheerder: invullen na installatie'),
  ('naam_sleutelbeheerder',  '""',                     'Voornaam sleutelbeheerder voor de aanhef'),
  ('afzender_naam',          '"De Broekhof"',          'Naam die de ontvanger als afzender ziet'),
  ('ondertekening',          '""', 'Naam onder bevestigingsmails'),
  ('telefoon',               '""',          'Telefoonnummer in mails'),
  ('iban',                   '""',   'Rekeningnummer voor betalingen'),
  ('iban_tnv',               '""', 'Tenaamstelling rekening'),
  ('prijzen',                '{"schoonmaak": 90, "schoonmaak_per_huisdier": 10, "bedlinnen": 10, "keukenlinnen": 7}', 'Standaardprijzen in euro'),
  ('tijden',                 '{"checkin": "16:00", "checkout": "10:00"}', 'Standaard check-in en check-out'),
  ('betaaltermijnen',        '{"aanbetaling_dagen_na_boeking": 7, "restant_dagen_voor_aankomst": 28, "borg_dagen_na_vertrek": 7}', 'Ter informatie; de berekening zit in de databasetrigger'),
  ('aankomstmail_dagen_vooraf', '4',                   'Aantal dagen voor aankomst dat de aankomstmail automatisch gaat')
on conflict (sleutel) do nothing;
