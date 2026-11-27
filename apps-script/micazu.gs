// ═══════════════════════════════════════════════════════════════════════
// micazu.gs — nieuwe Micazu-boekingen automatisch inlezen (v3)
// v3: stuurt boekingen door naar de beheerapp (Netlify + Supabase) i.p.v. de Sheet.
//     Vereiste Scripteigenschappen: BEHEER_URL, MICAZU_GEHEIM.
//
// Leest "Je hebt een boekingsaanvraag geaccepteerd"-mails van Micazu uit Gmail, maakt een
// conceptboeking in de sheet (kolom "Bron" = "Micazu – aanvullen") en mailt
// info@ een samenvatting. Contactgegevens, aanhef en keukenlinnen staan niet
// in de Micazu-mail en vul je daarna aan via de beheerpagina.
//
// Eenmalig: voer installeerMicazuTrigger() uit (controleert elke 15 minuten).
// Werkt zelfstandig; Code.gs is niet meer nodig.
// ═══════════════════════════════════════════════════════════════════════

const MICAZU_ZOEK        = 'micazu "boekingsaanvraag geaccepteerd" newer_than:60d -label:micazu-verwerkt -label:micazu-fout';
const MICAZU_HERKEN      = /boekingsaanvraag[\s\S]{0,40}geaccepteerd/i;
const MICAZU_LABEL_OK    = 'micazu-verwerkt';
const MICAZU_LABEL_FOUT  = 'micazu-fout';
const EMAIL_BCC          = 'info@debroekhof.nl';

function installeerMicazuTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'verwerkMicazuMails')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('verwerkMicazuMails').timeBased().everyMinutes(15).create();
  Logger.log('Trigger geïnstalleerd: verwerkMicazuMails elke 15 minuten');
}

function verwerkMicazuMails() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;
  try {
    const labelOk   = GmailApp.getUserLabelByName(MICAZU_LABEL_OK)   || GmailApp.createLabel(MICAZU_LABEL_OK);
    const labelFout = GmailApp.getUserLabelByName(MICAZU_LABEL_FOUT) || GmailApp.createLabel(MICAZU_LABEL_FOUT);

    for (const thread of GmailApp.search(MICAZU_ZOEK, 0, 20)) {
      let gelukt = true;
      for (const msg of thread.getMessages()) {
        if (!MICAZU_HERKEN.test(msg.getSubject() + ' ' + msg.getPlainBody().slice(0, 400))) continue;
        try {
          const b = parseMicazuMail(msg.getPlainBody());
          const res = slaMicazuBoekingOp(b);
          stuurMicazuMelding(b, res, msg);
          Logger.log('Micazu: ' + res + ' – ' + b.voornaam + ' ' + b.achternaam + ' ' + b.aankomstNL);
        } catch (err) {
          gelukt = false;
          Logger.log('Micazu parse-fout: ' + err);
          GmailApp.sendEmail(EMAIL_BCC, '⚠ Micazu-boeking niet automatisch ingelezen',
            'Deze Micazu-mail kon niet worden verwerkt: ' + err + '\n\nOnderwerp: ' + msg.getSubject() +
            '\nOntvangen: ' + msg.getDate() + '\n\nVoer de boeking handmatig in via de beheerpagina.',
            { name: 'De Broekhof beheer' });
        }
      }
      thread.addLabel(gelukt ? labelOk : labelFout);
    }
  } finally {
    lock.releaseLock();
  }
}

// ── Parser ────────────────────────────────────────────────────────────────
// Werkt op de platte tekst van de mail; labels en waarden mogen op dezelfde
// regel (tab/spatie gescheiden) of op de volgende regel staan.
function parseMicazuMail(tekst) {
  const regels = String(tekst).replace(/\r/g, '').split('\n')
    .map(r => r.replace(/\u00a0/g, ' ').trim()).filter(Boolean);

  function zoek(label, vanaf) {
    const start = vanaf ? Math.max(0, regels.findIndex(r => r.toLowerCase().startsWith(vanaf.toLowerCase()))) : 0;
    for (let i = start; i < regels.length; i++) {
      const r = regels[i];
      if (r.toLowerCase().startsWith(label.toLowerCase())) {
        const rest = r.slice(label.length).replace(/^[\s:\t]+/, '').trim();
        return { waarde: rest || (regels[i + 1] || ''), index: i };
      }
    }
    return { waarde: '', index: -1 };
  }
  const val = (label, vanaf) => zoek(label, vanaf).waarde;
  // Aantal: getal aan het eind van de labelregel ("… t/m 17 jaar<tab>1"), anders de volgende regel
  const aantal = (label, vanaf) => {
    const z = zoek(label, vanaf);
    if (z.index < 0) return 0;
    const m = regels[z.index].match(/(\d+)\s*$/) || String(regels[z.index + 1] || '').match(/^(\d+)/);
    return m ? parseInt(m[1]) : 0;
  };

  // Boekingsgegevens pas zoeken na het kopje (het bericht van de verhuurder staat erboven)
  const boeking  = 'Gegevens van de boeking';
  const aankomst = parseNLDatumTekst(val('Aankomst', boeking));
  const vertrek  = parseNLDatumTekst(val('Vertrek', boeking));
  if (!aankomst || !vertrek) throw new Error('aankomst/vertrek niet gevonden');

  const gegevens = 'Gegevens huurder';
  const voornaam   = val('Voornaam', gegevens);
  const achternaam = val('Tussenvoegsel & achternaam', gegevens) || val('Achternaam', gegevens);
  if (!achternaam) throw new Error('achternaam niet gevonden');

  const volw    = aantal('Aantal volwassenen', gegevens);
  const kind    = aantal('Aantal kinderen', gegevens);
  const baby    = aantal('Aantal baby', gegevens);
  const dieren  = aantal('Huisdieren', gegevens);

  // Prijzen
  const huur       = bedrag(val('Vakantiehuis', boeking));
  const totaal     = bedrag(val('Totaalprijs', boeking));
  const schoonmaak = bedrag(val('Eindschoonmaak', boeking)) || (90 + dieren * 10);

  // Linnen: "Bedlinnen" → volgende regel "3 personen (€ 10)"
  const aantalVan = s => { const m = String(s).match(/(\d+)/); return m ? parseInt(m[1]) : 0; };
  const bed    = aantalVan(val('Bedlinnen', boeking));
  const keuken = aantalVan(val('Keukenlinnen', boeking));

  const extras = totaal && huur ? Math.max(0, Math.round((totaal - huur) * 100) / 100) : (bed * 10 + keuken * 7);

  // Bericht/vraag van de huurder (tot aan "Tip!" of "Heb je nog vragen")
  const vIdx = regels.findIndex(r => /^(vragen|bericht) van de huurder/i.test(r));
  let vraag = '';
  if (vIdx >= 0) {
    const eind = regels.findIndex((r, i) => i > vIdx && /^(tip!?|heb je nog vragen)/i.test(r));
    vraag = regels.slice(vIdx + 1, eind > 0 ? eind : vIdx + 6).join('\n');
  }

  return {
    aankomst, vertrek,
    aankomstNL: fmtDDMMYYYY(aankomst), vertrekNL: fmtDDMMYYYY(vertrek),
    voornaam, achternaam,
    personen: volw + kind + baby, huisdieren: dieren,
    bedlinnen: bed, keukenlinnen: keuken,
    huurprijs: huur || (totaal - extras), extras, totaal: totaal || (huur + extras),
    schoonmaak, vraag,
  };
}

function bedrag(s) {
  let t = String(s || '').replace(/[€\s]/g, '');
  if (!t) return 0;
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');   // NL: 1.010,00
  else if (/\.\d{3}$/.test(t)) t = t.replace(/\./g, '');            // 1.010
  return parseFloat(t) || 0;
}

function parseNLDatumTekst(s) {
  const maanden = ['januari','februari','maart','april','mei','juni','juli','augustus','september','oktober','november','december'];
  const m = String(s || '').toLowerCase().match(/(\d{1,2})\s+([a-z]+)\s+(\d{4})/);
  if (!m) return null;
  const mi = maanden.indexOf(m[2]);
  return mi < 0 ? null : new Date(parseInt(m[3]), mi, parseInt(m[1]));
}

function fmtDDMMYYYY(d) {
  return String(d.getDate()).padStart(2,'0') + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + d.getFullYear();
}

function genereerToegangscode() {
  // zelfde regels als beheerpagina: cijfers 2-9, geen oplopende reeks
  const c = '23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 6; i++) code += c[Math.floor(Math.random() * c.length)];
  } while ([...code].every((x, i) => i === 0 || +x === +code[i-1] + 1));
  return code;
}

// ── Doorsturen naar de nieuwe beheerapp ──────────────────────────────────
// Geeft 'nieuw' of 'bestond al' terug. Dubbelcheck, bedragen en toegangscode
// regelt de app zelf (netlify/functions/actie.mjs, actie "micazu-import").
function slaMicazuBoekingOp(b) {
  const props  = PropertiesService.getScriptProperties();
  const url    = props.getProperty('BEHEER_URL');      // bv. https://beheer.debroekhof.app
  const geheim = props.getProperty('MICAZU_GEHEIM');   // zelfde waarde als in Netlify
  if (!url || !geheim) throw new Error('Scripteigenschap BEHEER_URL of MICAZU_GEHEIM ontbreekt');

  const iso = d => Utilities.formatDate(d, 'Europe/Amsterdam', 'yyyy-MM-dd');
  const res = UrlFetchApp.fetch(url.replace(/\/$/, '') + '/api/actie', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-broekhof-geheim': geheim },
    payload: JSON.stringify({ actie: 'micazu-import', boeking: {
      aankomst: iso(b.aankomst), vertrek: iso(b.vertrek),
      voornaam: b.voornaam, achternaam: b.achternaam,
      personen: b.personen, huisdieren: b.huisdieren,
      bedlinnen: b.bedlinnen, keukenlinnen: b.keukenlinnen,
      huurprijs: b.huurprijs, extras: b.extras, totaal: b.totaal,
      schoonmaak: b.schoonmaak, vraag: b.vraag,
    } }),
    muteHttpExceptions: true,
  });
  const json = JSON.parse(res.getContentText() || '{}');
  if (res.getResponseCode() !== 200 || json.status !== 'ok') {
    throw new Error('Beheerapp: ' + (json.message || 'HTTP ' + res.getResponseCode()));
  }
  return json.resultaat;
}

// ── Melding naar info@ ────────────────────────────────────────────────────
function stuurMicazuMelding(b, resultaat, msg) {
  const onderwerp = (resultaat === 'nieuw' ? 'Nieuwe Micazu-boeking ingelezen: ' : 'Micazu-boeking bestond al: ') +
    b.achternaam + ' ' + b.aankomstNL;
  const html = `
    <div style="font-family:Arial,sans-serif;font-size:14px;max-width:600px">
      <p>${resultaat === 'nieuw'
        ? 'Er is automatisch een conceptboeking aangemaakt vanuit Micazu.'
        : 'Deze boeking stond al in de beheerapp; er is niets toegevoegd.'}</p>
      <table style="border-collapse:collapse">
        <tr><td style="padding:2px 12px 2px 0">Huurder</td><td><b>${b.voornaam} ${b.achternaam}</b></td></tr>
        <tr><td style="padding:2px 12px 2px 0">Periode</td><td>${b.aankomstNL} t/m ${b.vertrekNL}</td></tr>
        <tr><td style="padding:2px 12px 2px 0">Personen</td><td>${b.personen} (huisdieren: ${b.huisdieren})</td></tr>
        <tr><td style="padding:2px 12px 2px 0">Bedlinnen</td><td>${b.bedlinnen}</td></tr>
        <tr><td style="padding:2px 12px 2px 0">Huur / extra's / totaal</td><td>€ ${b.huurprijs} / € ${b.extras} / € ${b.totaal}</td></tr>
        <tr><td style="padding:2px 12px 2px 0">Schoonmaak</td><td>€ ${b.schoonmaak}</td></tr>
      </table>
      ${b.vraag ? `<p><b>Vraag van de huurder:</b><br>${b.vraag.replace(/</g,'&lt;').replace(/\n/g,'<br>')}</p>` : ''}
      ${resultaat === 'nieuw' ? `<p style="background:#fffbeb;border:1px solid #f0cc70;padding:8px 12px">
        <b>Nog aanvullen:</b> aanhef, e-mail, telefoon, adres, keukenlinnen en borg.<br>
        Open de boeking via het potlood in de <a href="https://beheer.debroekhof.app/">beheerpagina</a>
        (of importeer daar de Micazu-Excel) en sla op.</p>` : ''}
    </div>`;
  GmailApp.sendEmail(EMAIL_BCC, onderwerp, '', { htmlBody: html, name: 'De Broekhof beheer' });
}

// ── Test: parse de meest recente Micazu-mail zonder iets op te slaan ─────
function testMicazuParse() {
  const t = GmailApp.search('micazu "boekingsaanvraag geaccepteerd"', 0, 1)[0];
  if (!t) { Logger.log('Geen Micazu-mail gevonden'); return; }
  Logger.log(JSON.stringify(parseMicazuMail(t.getMessages()[0].getPlainBody()), null, 2));
}
