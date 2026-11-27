# Afspraken voor deze repository

## Bij elke wijziging die in productie komt

1. **Versie en releasenotes**: `npm run release` (of `-- patch` voor alleen herstel) en
   herschrijf de conceptregels in `public/releasenotes.json`. Schrijf voor Eric, in
   begrijpelijk Nederlands: wat hij merkt of anders moet doen, geen technische termen,
   geen bestandsnamen of codenamen. Eén zin per wijziging.
2. **Handleiding**: werk `public/handleiding.html` bij als er iets verandert aan wat de
   gebruiker ziet of doet (nieuwe knop, ander scherm, andere automatische mail). Die
   tekst verschijnt onder "Help" onderaan de app. Kort houden, alleen h4/p/ul/li/b.
3. Commit als `Release <versie>`.

## Verder

- Schrijf in het Nederlands, in de stijl van de bestaande code.
- Geen geheimen of persoonsgegevens in de repository; alles via omgevingsvariabelen
  (zie `.env.example`) of de tabel `instellingen` in Supabase.
- Netlify Functions zonder npm-pakketten: alleen ingebouwde Node-modules en `fetch`.
