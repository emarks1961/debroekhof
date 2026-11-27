-- Wie de gasten ontvangt (in huurovereenkomst en aankomstmail). Na installatie invullen.
insert into public.instellingen (sleutel, waarde, omschrijving) values
  ('ontvangst_naam',     '""', 'Wie de gasten ontvangt, zoals in de brief: bv. "Mevrouw Jansen"'),
  ('ontvangst_telefoon', '""', 'Telefoonnummer van wie de gasten ontvangt')
on conflict (sleutel) do nothing;
