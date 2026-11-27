# De Broekhof beheer

Beheerapp voor vakantiewoning De Broekhof: boekingen, huurovereenkomsten,
betalingen, Nuki-toegangscodes en mails aan huurder en sleutelbeheerder.

Opvolger van de beheerpagina op Strato (`index.html` + `proxy.php` + Google
Apps Script + Google Sheet).

## Opbouw

| Onderdeel | Waar |
| --- | --- |
| Scherm | `public/index.html` (geen build-stap) |
| Database, login, PDF-opslag | Supabase (regio EU) — schema in `supabase/migrations/` |
| Serverfuncties (Nuki, mail, PDF, geplande mails) | `netlify/functions/` — alleen ingebouwde Node-modules en `fetch` |
| Versies | `public/releasenotes.json`, ophogen met `npm run release` |

De browser leest en schrijft boekingen en betalingen rechtstreeks in Supabase.
Alleen ingelogde accounts die in de tabel `beheerders` staan krijgen toegang
(Row Level Security). Acties met een geheime sleutel lopen via Netlify Functions.

## Eenmalige installatie

### 1. Supabase

1. Maak op [supabase.com](https://supabase.com) een nieuw project, regio
   **Central EU (Frankfurt)**.
2. Open **SQL Editor** en voer de bestanden in `supabase/migrations/` uit, op
   volgorde van naam.
3. **Authentication → Providers → Email**: aan. Zet **Allow new users to sign up**
   uit, zodat niemand zelf een account kan maken.
4. **Authentication → Users → Add user**: maak een account per beheerder.
5. Maak elk account beheerder in de SQL Editor:

   ```sql
   insert into public.beheerders (user_id, naam)
   select id, 'Eric' from auth.users where email = 'jouw@adres.nl';
   ```

6. Vul in de tabel `instellingen` de lege waarden in: e-mailadres en naam
   sleutelbeheerder, wie de gasten ontvangt (naam + telefoon), ondertekening,
   telefoonnummer, IBAN en tenaamstelling.
7. Noteer onder **Project Settings → API**: Project URL, `anon` key en
   `service_role` key.

### 2. Resend (mail)

1. Maak een account op [resend.com](https://resend.com) en voeg het domein
   `debroekhof.nl` toe.
2. Zet de DNS-records die Resend toont bij de domeinbeheerder (Strato).
3. Maak een API-key met alleen verzendrechten.

### 3. Netlify

1. **Add new project → Import from Git** → deze repository. Build command leeg,
   publish directory `public` (staat al in `netlify.toml`).
2. **Project configuration → Environment variables**: zet de variabelen uit
   `.env.example`.
3. **Domain management**: voeg `beheer.debroekhof.app` toe en zet bij Strato een
   CNAME-record `beheer` naar het Netlify-adres.

### 4. Micazu-mails via Resend (zonder Gmail)

1. **Resend → Emails → Receiving**: zet een ontvangstadres aan (`…@<id>.resend.app`).
2. **Resend → Webhooks → Add webhook**: URL `https://beheer.debroekhof.app/api/micazu-inbound`
   (of het Netlify-adres), event `email.received`. Zet het ondertekeningsgeheim als
   `RESEND_WEBHOOK_SECRET` in Netlify en publiceer opnieuw.
3. `RESEND_API_KEY` moet **Full access** hebben, anders kan de app de ontvangen mail niet lezen.
4. Zet in Micazu het e-mailadres voor boekingsmeldingen op bijvoorbeeld
   `micazu@<id>.resend.app`. De app maakt de boeking aan en stuurt info@ een melding met
   de oorspronkelijke mail. Andere mails op dat adres worden naar info@ doorgestuurd.

### 4b. Micazu-mails via Gmail (oude manier, Apps Script)

Het automatisch inlezen van Micazu-mails blijft in Google Apps Script, omdat het
Gmail moet lezen. Vervang in het bestaande Apps Script-project `micazu.gs` door
`apps-script/micazu.gs` en zet onder **Projectinstellingen → Scripteigenschappen**:

- `BEHEER_URL` = `https://beheer.debroekhof.app`
- `MICAZU_GEHEIM` = dezelfde waarde als in Netlify

Zet daarna in Apps Script de triggers van `stuurAankomstMailDagelijks` en
`stuurFinancieelOverzichtAlsNodig` uit: dat doet de nieuwe app nu (`planning.mjs`).

## Gegevens overzetten uit de Google Sheet

Zie `scripts/migratie/migreer.mjs`. Kort:

1. Download de tabbladen "Formulierreacties 1" en "Financieel status" als CSV naar
   `scripts/migratie/data/boekingen.csv` en `financieel.csv` (deze map gaat nooit naar Git).
2. `node scripts/migratie/migreer.mjs`: proefdraai, schrijft `data/rapport.md` met
   meldingen en de koppeling van betaalstatus aan boekingen. Controleer die.
3. `SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… node scripts/migratie/migreer.mjs --uitvoeren`

Rijen overslaan (bv. testboekingen): `--sla-over=4,12`.

## Geheimen

Er staan geen sleutels of wachtwoorden in deze repository. Alles staat als
omgevingsvariabele in Netlify; zie `.env.example` voor de namen.
