// ═══════════════════════════════════════════════════════════════════════
// api.js — De Broekhof beheer: koppeling tussen het scherm en Supabase
//
// Het scherm (index.html) stuurt nog steeds acties met dezelfde namen als
// vroeger naar Apps Script ("laadBoekingen", "wijzigBoeking", ...). Deze laag
// vertaalt elke actie naar Supabase of naar een Netlify Function en geeft een
// antwoord in de vorm die het scherm verwacht.
//
// Het scherm gebruikt een volgnummer (rijnr) als sleutel in knoppen en
// betaal-ID's ("3-aanbetaling"). Dat volgnummer geldt alleen binnen deze
// browsersessie; in de database staat altijd de vaste uuid.
// ═══════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  let sb = null;              // Supabase-client
  let gereed = null;          // Promise: client is aangemaakt
  const nrVanId = new Map();  // uuid → volgnummer
  const idVanNr = new Map();  // volgnummer → uuid
  let volgnr = 0;
  const bronVanId = new Map();

  window.BROEKHOF = { instellingen: {} };

  // ── Start ────────────────────────────────────────────────────────────
  function start() {
    if (!gereed) {
      gereed = (async () => {
        const res = await fetch('/api/config', { cache: 'no-store' });
        if (!res.ok) throw new Error('Configuratie niet beschikbaar (HTTP ' + res.status + ')');
        const cfg = await res.json();
        sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
          auth: { persistSession: true, autoRefreshToken: true },
        });
        return sb;
      })();
    }
    return gereed;
  }

  function nummer(id) {
    if (!nrVanId.has(id)) {
      volgnr += 1;
      nrVanId.set(id, volgnr);
      idVanNr.set(volgnr, id);
    }
    return nrVanId.get(id);
  }

  function uuidVan(rijnr) {
    const id = idVanNr.get(Number(rijnr));
    if (!id) throw new Error('Boeking niet gevonden; laad de lijst opnieuw.');
    return id;
  }

  // ── Omzetten ─────────────────────────────────────────────────────────
  const isoNaarNL = iso => {
    if (!iso) return '';
    const [y, m, d] = String(iso).slice(0, 10).split('-');
    return `${d}-${m}-${y}`;
  };

  const nlNaarISO = s => {
    const m = String(s || '').trim().match(/^(\d{1,2})-(\d{1,2})-(\d{4})/);
    return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
  };

  const tijd = t => (t ? String(t).slice(0, 5) : '');

  // "€ 1.234,50", "1234.5", "€90" → 1234.5 (leeg → 0)
  function getal(v) {
    let t = String(v ?? '').replace(/[€\s]/g, '');
    if (!t) return 0;
    if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
    const n = parseFloat(t);
    return Number.isFinite(n) ? n : 0;
  }

  const geheel = v => Math.max(0, parseInt(v, 10) || 0);
  const tekst = v => (v === null || v === undefined ? '' : String(v));
  const bedragTekst = v => (v === null || v === undefined ? '' : String(Number(v)));
  const leegNaarNull = v => (String(v ?? '').trim() === '' ? null : String(v).trim());

  // Database-record → boekingsobject zoals het scherm dat kent
  function naarScherm(r) {
    bronVanId.set(r.id, r.bron);
    return {
      rijnr:       nummer(r.id),
      id:          r.id,
      tijdstempel: isoNaarNL(r.boekingsdatum),
      aankomst:    isoNaarNL(r.aankomst),
      vertrek:     isoNaarNL(r.vertrek),
      aanhef:      tekst(r.aanhef),
      voornaam:    tekst(r.voornaam),
      achternaam:  tekst(r.achternaam),
      personen:    tekst(r.personen),
      huisdieren:  tekst(r.huisdieren),
      bedlinnen:   tekst(r.bedlinnen),
      keuken:      tekst(r.keukenlinnen),
      huurprijs:   bedragTekst(r.huurprijs),
      schoonmaak:  bedragTekst(r.schoonmaak),
      extras:      bedragTekst(r.extras),
      totaal:      bedragTekst(r.totaal),
      aanbetaling: bedragTekst(r.aanbetaling),
      restant:     bedragTekst(r.restant),
      borg:        bedragTekst(r.borg),
      telefoon:    tekst(r.telefoon),
      adres:       tekst(r.adres),
      postcode:    tekst(r.postcode),
      plaats:      tekst(r.plaats),
      land:        tekst(r.land),
      email:       tekst(r.email),
      code:        tekst(r.toegangscode),
      checkIn:     tijd(r.checkin),
      checkOut:    tijd(r.checkout),
      mailHuurder: !!r.mail_huurder,
      bron:        r.bron === 'micazu-aanvullen' ? 'Micazu – aanvullen' : tekst(r.bron),
      vraag:       tekst(r.vraag_huurder),
      notitie:     tekst(r.notitie),
    };
  }

  // Rij (28 kolommen, zelfde volgorde als de oude Sheet) → database-record
  function rijNaarRecord(rij) {
    if (!Array.isArray(rij)) throw new Error('Geen geldige boekingsgegevens');
    const aankomst = nlNaarISO(rij[2]);
    const vertrek = nlNaarISO(rij[3]);
    if (!aankomst || !vertrek) throw new Error('Aankomst- en vertrekdatum zijn verplicht');
    if (vertrek <= aankomst) throw new Error('Vertrek moet na aankomst liggen');
    const code = String(rij[25] || '').trim();
    if (code && !/^\d{6}$/.test(code)) throw new Error('Toegangscode moet uit 6 cijfers bestaan');
    const aanhef = String(rij[4] || '').trim();
    return {
      aankomst,
      vertrek,
      aanhef:       aanhef === 'heer' || aanhef === 'mevrouw' ? aanhef : null,
      voornaam:     String(rij[5] || '').trim(),
      achternaam:   String(rij[6] || '').trim(),
      personen:     geheel(rij[7]),
      huisdieren:   geheel(rij[8]),
      bedlinnen:    geheel(rij[9]),
      keukenlinnen: geheel(rij[10]),
      huurprijs:    getal(rij[11]),
      schoonmaak:   getal(rij[12]),
      extras:       getal(rij[13]),
      totaal:       getal(rij[14]),
      aanbetaling:  getal(rij[15]),
      restant:      getal(rij[16]),
      borg:         getal(rij[17]),
      telefoon:     leegNaarNull(rij[18]),
      adres:        leegNaarNull(rij[19]),
      postcode:     leegNaarNull(rij[20]),
      plaats:       leegNaarNull(rij[21]),
      land:         leegNaarNull(rij[22]),
      email:        leegNaarNull(rij[23]),
      toegangscode: code || null,
      checkin:      String(rij[26] || '16:00').slice(0, 5),
      checkout:     String(rij[27] || '10:00').slice(0, 5),
    };
  }

  const SOORT_NAAR_DB = { aanbetaling: 'aanbetaling', restant: 'restant', borg: 'borg_terug' };
  const SOORT_NAAR_SCHERM = { aanbetaling: 'aanbetaling', restant: 'restant', borg_terug: 'borg' };

  function splitsBetaalId(id) {
    const m = String(id || '').match(/^(\d+)-(aanbetaling|restant|borg)$/);
    if (!m) throw new Error('Onbekende betaalregel');
    return { boekingId: uuidVan(m[1]), soort: SOORT_NAAR_DB[m[2]] };
  }

  function ok(extra) { return Object.assign({ status: 'ok' }, extra || {}); }

  function dbFout(error) {
    if (!error) return;
    if (error.code === 'PGRST301' || /JWT/i.test(error.message)) throw new NietIngelogd();
    throw new Error(error.message);
  }

  class NietIngelogd extends Error {
    constructor() { super('Niet ingelogd'); this.status = 401; }
  }

  // ── Serverfuncties (Netlify) ─────────────────────────────────────────
  async function roepFunctie(naam, payload) {
    const { data } = await sb.auth.getSession();
    const token = data.session && data.session.access_token;
    if (!token) throw new NietIngelogd();
    const res = await fetch('/api/actie', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify(Object.assign({}, payload, { actie: naam })),
    });
    if (res.status === 401) throw new NietIngelogd();
    if (res.status === 404) return { status: 'error', message: 'Deze functie is nog niet beschikbaar in de nieuwe app.' };
    let json;
    try { json = await res.json(); } catch { json = { status: 'error', message: 'HTTP ' + res.status }; }
    return json;
  }

  // ── Huurovereenkomst (PDF in de browser, opslag in Supabase) ─────────
  const BUCKET = 'huurovereenkomsten';

  async function maakEnBewaarPdf(bestandsnaam, placeholders) {
    const blob = window.maakHuurovereenkomstPdf(placeholders || {}, window.BROEKHOF.instellingen);
    const veilig = String(bestandsnaam || 'Huurovereenkomst').replace(/[^A-Za-z0-9._ -]/g, '_').trim();
    const pad = `${new Date().getFullYear()}/${veilig}.pdf`;
    const { error } = await sb.storage.from(BUCKET).upload(pad, blob, { contentType: 'application/pdf', upsert: true });
    if (error) throw new Error('PDF opslaan mislukt: ' + error.message);
    return { blob, pad };
  }

  async function verstuurBevestiging(boekingId, d) {
    const { pad } = await maakEnBewaarPdf(d.bestandsnaam, d.placeholders);
    return roepFunctie('verwerk-boeking', {
      boekingId, opslagpad: pad, bestandsnaam: d.bestandsnaam,
      emailAan: d.emailAan, emailTekst: d.emailTekst, nuki: !!d.nuki,
    });
  }

  // ── Acties ───────────────────────────────────────────────────────────
  const acties = {
    async laadBoekingen() {
      const { data, error } = await sb.from('boekingen')
        .select('*')
        .is('verwijderd_op', null)
        .order('aankomst', { ascending: true });
      dbFout(error);
      return ok({ boekingen: data.map(naarScherm) });
    },

    async alleenOpslaan({ rij }) {
      const record = rijNaarRecord(rij);
      const { data, error } = await sb.from('boekingen').insert(record).select('id').single();
      dbFout(error);
      return ok({ id: data.id });
    },

    async wijzigBoeking(d) {
      const id = uuidVan(d.rijnr);
      const record = rijNaarRecord(d.rij);
      // Gecontroleerd via de beheerpagina → markering "aanvullen" vervalt
      if (bronVanId.get(id) === 'micazu-aanvullen') record.bron = 'micazu';
      const { error } = await sb.from('boekingen').update(record).eq('id', id);
      dbFout(error);
      if (!d.templateId) return ok();
      return verstuurBevestiging(id, d);
    },

    async opslaanEnVersturen(d) {
      const record = rijNaarRecord(d.rij);
      const { data, error } = await sb.from('boekingen').insert(record).select('id').single();
      dbFout(error);
      return verstuurBevestiging(data.id, Object.assign({}, d, { nuki: true }));
    },

    async verwijderBoeking({ rijnr }) {
      const { error } = await sb.from('boekingen')
        .update({ verwijderd_op: new Date().toISOString() })
        .eq('id', uuidVan(rijnr));
      dbFout(error);
      return ok();
    },

    async setMailHuurder({ rijnr, waarde }) {
      const { error } = await sb.from('boekingen')
        .update({ mail_huurder: !!waarde })
        .eq('id', uuidVan(rijnr));
      dbFout(error);
      return ok();
    },

    async laadFinancieelStatus() {
      const { data, error } = await sb.from('betalingen').select('*');
      dbFout(error);
      const res = {};
      for (const b of data) {
        res[`${nummer(b.boeking_id)}-${SOORT_NAAR_SCHERM[b.soort]}`] = {
          betaald:    b.betaald,
          notitie:    b.notitie || '',
          datum:      b.vervaldatum_handmatig ? b.vervaldatum : '',
          verwijderd: b.verborgen,
        };
      }
      return ok({ data: res });
    },

    async slaFinancieelStatus({ id, betaald, notitie, datum }) {
      const { boekingId, soort } = splitsBetaalId(id);
      const { data: huidig, error: e1 } = await sb.from('betalingen')
        .select('vervaldatum, vervaldatum_handmatig, betaald, betaald_op')
        .eq('boeking_id', boekingId).eq('soort', soort).maybeSingle();
      dbFout(e1);
      if (!huidig) throw new Error('Betaalregel niet gevonden');
      const wijziging = {
        betaald: !!betaald,
        betaald_op: betaald ? (huidig.betaald ? huidig.betaald_op : new Date().toISOString().slice(0, 10)) : null,
        notitie: notitie || null,
      };
      if (datum && datum !== huidig.vervaldatum) {
        wijziging.vervaldatum = datum;
        wijziging.vervaldatum_handmatig = true;
      }
      const { error } = await sb.from('betalingen').update(wijziging)
        .eq('boeking_id', boekingId).eq('soort', soort);
      dbFout(error);
      return ok();
    },

    async verwijderFinancieelStatus({ id }) {
      const { boekingId, soort } = splitsBetaalId(id);
      const { error } = await sb.from('betalingen').update({ verborgen: true })
        .eq('boeking_id', boekingId).eq('soort', soort);
      dbFout(error);
      return ok();
    },

    async genereerPdf(d) {
      const { blob } = await maakEnBewaarPdf(d.bestandsnaam, d.placeholders);
      return ok({ pdfUrl: URL.createObjectURL(blob), naam: d.bestandsnaam + '.pdf' });
    },
    legVastNuki: d => roepFunctie('nuki', d),
    stuurOverzicht: () => roepFunctie('mail', { soort: 'overzicht' }),
    informeerSleutelbeheerder: d => roepFunctie('mail', { soort: 'sleutelbeheerder', naam: d.naam, aankomst: d.aankomst }),
    stuurHerinneringHandmatig: d => roepFunctie('mail', {
      soort: 'aankomst', ontvanger: d.ontvanger, boekingId: d.rijnr ? uuidVan(d.rijnr) : null,
    }),
  };

  // ── Antwoord in de vorm van fetch() ──────────────────────────────────
  function antwoord(obj, status) {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => obj,
    };
  }

  // Vervangt fetch('proxy.php', { body }) in het scherm
  window.beheerApi = async function (_url, init) {
    try {
      await start();
      const data = init && init.body ? JSON.parse(init.body) : {};
      const actie = acties[data.actie];
      if (!actie) return antwoord({ status: 'error', message: 'Onbekende actie: ' + data.actie }, 400);
      const res = await actie(data);
      return antwoord(res, 200);
    } catch (err) {
      if (err instanceof NietIngelogd) {
        if (typeof window.toonLoginScherm === 'function') window.toonLoginScherm();
        return antwoord({ status: 'error', message: 'Niet ingelogd' }, 401);
      }
      console.error('[beheerApi]', err);
      return antwoord({ status: 'error', message: err.message }, 200);
    }
  };

  // ── Inloggen ─────────────────────────────────────────────────────────
  async function laadInstellingen() {
    const { data, error } = await sb.from('instellingen').select('sleutel, waarde');
    if (error) return;
    for (const r of data) window.BROEKHOF.instellingen[r.sleutel] = r.waarde;
  }

  async function isBeheerder() {
    const { data: u } = await sb.auth.getUser();
    if (!u || !u.user) return false;
    const { data } = await sb.from('beheerders').select('naam').eq('user_id', u.user.id).maybeSingle();
    if (data) window.BROEKHOF.naam = data.naam;
    return !!data;
  }

  window.beheerAuth = {
    async inloggen(email, wachtwoord) {
      await start();
      const { error } = await sb.auth.signInWithPassword({ email, password: wachtwoord });
      if (error) return { ok: false, melding: 'E-mailadres of wachtwoord onjuist.' };
      if (!(await isBeheerder())) {
        await sb.auth.signOut();
        return { ok: false, melding: 'Dit account heeft geen toegang tot het beheer.' };
      }
      await laadInstellingen();
      return { ok: true };
    },

    async sessie() {
      await start();
      const { data } = await sb.auth.getSession();
      if (!data.session) return false;
      if (!(await isBeheerder())) return false;
      await laadInstellingen();
      return true;
    },

    async uitloggen() {
      await start();
      await sb.auth.signOut();
    },

    async wachtwoordVergeten(email) {
      await start();
      const { error } = await sb.auth.resetPasswordForEmail(email, {
        redirectTo: location.origin + location.pathname,
      });
      return !error;
    },

    async nieuwWachtwoord(wachtwoord) {
      await start();
      const { error } = await sb.auth.updateUser({ password: wachtwoord });
      return error ? error.message : null;
    },

    async opWachtwoordHerstel(cb) {
      await start();
      sb.auth.onAuthStateChange(evt => { if (evt === 'PASSWORD_RECOVERY') cb(); });
    },

    // Boeking ophalen op vaste ID (link uit e-mails: ?boeking=<uuid>)
    async boekingOpId(id) {
      await start();
      const { data, error } = await sb.from('boekingen').select('*').eq('id', id).is('verwijderd_op', null).maybeSingle();
      if (error || !data) return null;
      return naarScherm(data);
    },
  };
})();
