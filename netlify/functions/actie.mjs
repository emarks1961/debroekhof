// ═══════════════════════════════════════════════════════════════════════
// actie.mjs — De Broekhof beheer: alle serveracties in één function
//
// Aanroep: POST /api/actie  { actie: '<naam>', ... }
//
//   Voor ingelogde beheerders (Authorization: Bearer <Supabase-token>):
//     nuki             code vastleggen in het Nuki-slot
//     verwerk-boeking  bevestiging + PDF mailen (en eventueel Nuki-code)
//     pdf-link         tijdelijke downloadlink voor een opgeslagen PDF
//     mail             soort: overzicht | sleutelbeheerder | aankomst
//   Intern (header x-broekhof-geheim):
//     dagelijks        aankomstmails + op maandag de betaalwaarschuwing (INTERN_GEHEIM)
//     micazu-import    nieuwe Micazu-boeking uit micazu.gs (MICAZU_GEHEIM)
//
//   POST /api/micazu-inbound  webhook "email.received" van Resend (RESEND_WEBHOOK_SECRET):
//     leest de ontvangen Micazu-mail, maakt de boeking aan en mailt info@ een melding.
//
// Alleen ingebouwde Node-modules en fetch; alles in dit ene bestand.
// ═══════════════════════════════════════════════════════════════════════

import { createHmac, timingSafeEqual } from 'node:crypto';

const TZ = 'Europe/Amsterdam';
const BUCKET = 'huurovereenkomsten';
const env = k => process.env[k] || '';

// ── HTTP ─────────────────────────────────────────────────────────────
const antwoord = (obj, status = 200) => Response.json(obj, { status });
const fout = (message, status = 200) => antwoord({ status: 'error', message }, status);

class Fout extends Error {}

// ── Supabase (service role) ──────────────────────────────────────────
async function db(pad, { method = 'GET', body, prefer } = {}) {
  const res = await fetch(`${env('SUPABASE_URL')}/rest/v1/${pad}`, {
    method,
    headers: {
      apikey: env('SUPABASE_SERVICE_ROLE_KEY'),
      Authorization: `Bearer ${env('SUPABASE_SERVICE_ROLE_KEY')}`,
      'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const tekst = await res.text();
  if (!res.ok) throw new Fout(`Database ${res.status}: ${tekst.slice(0, 200)}`);
  return tekst ? JSON.parse(tekst) : null;
}

async function opslagLezen(pad) {
  const res = await fetch(`${env('SUPABASE_URL')}/storage/v1/object/${BUCKET}/${encodeURI(pad)}`, {
    headers: { Authorization: `Bearer ${env('SUPABASE_SERVICE_ROLE_KEY')}` },
  });
  if (!res.ok) throw new Fout(`PDF niet gevonden in opslag (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

async function opslagLink(pad, bestandsnaam) {
  const res = await fetch(`${env('SUPABASE_URL')}/storage/v1/object/sign/${BUCKET}/${encodeURI(pad)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env('SUPABASE_SERVICE_ROLE_KEY')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn: 600 }),
  });
  if (!res.ok) throw new Fout(`Downloadlink maken mislukt (${res.status})`);
  const { signedURL } = await res.json();
  return `${env('SUPABASE_URL')}/storage/v1${signedURL}&download=${encodeURIComponent(bestandsnaam)}`;
}

async function gebruikerUitToken(req) {
  const auth = req.headers.get('authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  const res = await fetch(`${env('SUPABASE_URL')}/auth/v1/user`, {
    headers: { apikey: env('SUPABASE_ANON_KEY'), Authorization: auth },
  });
  if (!res.ok) return null;
  const user = await res.json();
  const rij = await db(`beheerders?user_id=eq.${user.id}&select=naam`);
  return rij.length ? { id: user.id, naam: rij[0].naam } : null;
}

async function laadInstellingen() {
  const rijen = await db('instellingen?select=sleutel,waarde');
  return Object.fromEntries(rijen.map(r => [r.sleutel, r.waarde]));
}

async function laadBoeking(id) {
  const rij = await db(`boekingen?id=eq.${encodeURIComponent(id)}&verwijderd_op=is.null&select=*`);
  if (!rij.length) throw new Fout('Boeking niet gevonden');
  return rij[0];
}

async function actieveBoekingen() {
  const grens = plusDagen(vandaag(), -7);
  return db(`boekingen?verwijderd_op=is.null&vertrek=gte.${grens}&order=aankomst.asc&select=*`);
}

// ── Datums (altijd Nederlandse tijd) ─────────────────────────────────
function vandaag() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date());
}

function plusDagen(iso, n) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const DAGEN = ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za'];
const MAANDEN_KORT = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];

function dagVan(iso) { return new Date(iso + 'T12:00:00Z').getUTCDay(); }
function nl(iso) { const [y, m, d] = String(iso).slice(0, 10).split('-'); return `${d}-${m}-${y}`; }
function nlLang(iso) { return iso ? `${DAGEN[dagVan(iso)]} ${nl(iso)}` : ''; }
function nlKort(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${DAGEN[dagVan(iso)]} ${d} ${MAANDEN_KORT[m - 1]} ${y}`;
}
const uur = t => String(t || '').slice(0, 5);

// UTC-offset van Nederland op een datum + tijd, bv. "+02:00"
function tzOffset(iso, hhmm) {
  const gok = new Date(`${iso}T${hhmm}:00Z`);
  const naam = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'longOffset' })
    .formatToParts(gok).find(p => p.type === 'timeZoneName').value; // "GMT+02:00"
  return naam === 'GMT' ? '+00:00' : naam.replace('GMT', '');
}

function tijdPlus(hhmm, min) {
  const [h, m] = hhmm.split(':').map(Number);
  const t = (((h * 60 + m + min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

// ── Opmaak ───────────────────────────────────────────────────────────
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const euro = v => '€ ' + Math.round(Number(v) || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');

function telLokaal(v) {
  let s = String(v || '').replace(/\s+/g, '');
  if (s.startsWith('+31')) return '0' + s.slice(3);
  if (s.startsWith('0031')) return '0' + s.slice(4);
  return s;
}

function telInternationaal(v) {
  let s = String(v || '').replace(/[\s-]+/g, '');
  if (!s) return '';
  if (s.startsWith('00')) return '+' + s.slice(2);
  if (s.startsWith('+')) return s;
  if (s.startsWith('0')) return '+31' + s.slice(1);
  return '+' + s;
}

function afwijkend(tijd, standaard) {
  return tijd && tijd !== standaard ? ' <span style="color:#c0392b;font-weight:bold">⚠️ Afwijkend!</span>' : '';
}

function boekingKaartHtml(b, inst) {
  const std = inst.tijden || { checkin: '16:00', checkout: '10:00' };
  const ci = uur(b.checkin) || std.checkin, co = uur(b.checkout) || std.checkout;
  const telL = telLokaal(b.telefoon), telI = telInternationaal(b.telefoon);
  return `
  <div style="border:1px solid #ddd;padding:16px;margin-bottom:14px;font-family:Arial,sans-serif;font-size:13px;border-radius:4px">
    <h3 style="margin:0 0 10px 0;color:#8c6d3f;font-size:15px">${nlLang(b.aankomst)} - ${esc(b.aanhef || '')} ${esc(b.achternaam)}</h3>
    <p style="margin:0 0 4px 0"><b>Aankomst</b><br>${nlLang(b.aankomst)} om ${ci} uur${afwijkend(ci, std.checkin)}</p>
    <p style="margin:0 0 10px 0"><b>Vertrek</b><br>${nlLang(b.vertrek)} om ${co} uur${afwijkend(co, std.checkout)}</p>
    <p style="margin:0 0 4px 0"><b>Huurder</b><br>
      ${esc([b.aanhef, b.voornaam, b.achternaam].filter(Boolean).join(' '))}<br>
      ${telL ? `<a href="tel:${esc(telL)}">${esc(telL)}</a>` : '-'}
      ${telI ? ` | <a href="https://wa.me/${esc(telI.replace('+', ''))}">WhatsApp</a>` : ''}<br>
      ${b.email ? `<a href="mailto:${esc(b.email)}">${esc(b.email)}</a>` : '-'}
    </p>
    <p style="margin:0 0 4px 0">Personen: ${b.personen} &nbsp;|&nbsp; Huisdieren: ${b.huisdieren ? b.huisdieren : 'geen'}
      &nbsp;|&nbsp; Bedlinnen: ${b.bedlinnen || 0} &nbsp;|&nbsp; Keukenlinnen: ${b.keukenlinnen || 0}</p>
    <p style="margin:0">Schoonmaak: ${euro(b.schoonmaak)} &nbsp;|&nbsp; Toegangscode: <b>${esc(b.toegangscode || '-')}</b></p>
  </div>`;
}

function ondertekeningHtml(inst) {
  return `<p>Met vriendelijke groet,<br>
    ${inst.ondertekening ? `<b>${esc(inst.ondertekening)}</b><br>` : ''}
    Vakantiewoning De Broekhof<br>
    <a href="mailto:${esc(inst.email_info)}">${esc(inst.email_info)}</a>
    ${inst.telefoon ? `<br>${esc(inst.telefoon)}` : ''}</p>`;
}

function aankomstMailHtml(b, inst) {
  const std = inst.tijden || { checkin: '16:00', checkout: '10:00' };
  const ontvangst = inst.ontvangst_naam || 'Onze sleutelbeheerder';
  return `<html><body style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;max-width:600px">
    <p>Geachte ${esc(b.aanhef || '')} ${esc(b.achternaam)}, beste ${esc(b.voornaam)},</p>
    <p>Uw verblijf in vakantiewoning De Broekhof nadert! Wij verheugen ons op uw komst en willen u graag de volgende informatie meegeven.</p>
    <p><b>Inpakken:</b><br>
    Behalve passende kleding voor het jaargetijde en toiletspullen vragen wij om zelf handdoeken mee te nemen. Linnensets en keukenlinnen zijn als extra beschikbaar op verzoek. Het huis is verder compleet ingericht, met onder meer keukengerei, spelletjes, etc. Veel basisbehoeften als kruiden, suiker, zijn aanwezig. Wat u niet aantreft is verkrijgbaar bij supermarkt Plus, Hoofdweg 86, 7382 BK Klarenbeek.</p>
    <p><b>De route:</b><br>
    Vakantiewoning de Broekhof is gelegen aan de Landweg 10, 7382 BL Klarenbeek. U kunt vanaf de snelweg A1 afslag Voorst nemen (N345) en na 8,9 km de rotonde, afslag Klarenbeek (N789). Deze weg 3,1 km volgen tot aan de afslag Kopermolenweg. Na 350 m linksaf naar de Landweg. De Broekhof bevindt zich na 1,3 km aan uw linkerhand.</p>
    <p><b>Check-in:</b> ${nlLang(b.aankomst)} om <b>${uur(b.checkin) || std.checkin} uur</b><br>
    Wij willen u vragen de kosten voor de eindschoonmaak bij aankomst contant af te rekenen. ${esc(ontvangst)} zal u ontvangen en wegwijs maken in de woning.${inst.ontvangst_telefoon ? ` Bij vragen bereikt u haar op ${esc(inst.ontvangst_telefoon)}.` : ''}</p>
    <p><b>Verblijf:</b><br>
    Gedurende uw verblijf heeft u de beschikking over de sleutels van het huis. Tevens krijgt u toegang tot de voordeur middels een persoonlijke code. Verdere informatie over het huis en de omgeving treft u aan in de informatiemap. Een digitale versie van de informatiemap is te vinden op <a href="https://www.debroekhof.app">www.debroekhof.app</a></p>
    <p><b>Toegangscode voordeur:</b> <span style="font-size:18px;font-weight:bold;letter-spacing:2px">${esc(b.toegangscode || '-')}</span></p>
    <p><b>Check-out:</b> ${nlLang(b.vertrek)} om <b>${uur(b.checkout) || std.checkout} uur</b><br>
    Laat de sleutels achter op het sleutelrekje bij de zijdeur. U kunt het pand verlaten door de voordeur achter zich dicht te trekken.</p>
    <p><b>Evaluatie:</b><br>
    Na afloop van uw verblijf zult u worden uitgenodigd door ons boekingsbureau Micazu om een beoordeling te geven. Uiteraard stellen wij dit zeer op prijs en zullen eventuele suggesties graag ter harte nemen.</p>
    <p><b>Hieronder enkele huishoudelijke mededelingen:</b><br>
    - er is zowel een Nespresso als een filter koffiezet apparaat aanwezig<br>
    - vaatwasmachine graag uitgeruimd en leeg achter laten<br>
    - het vuilnis graag naar buiten in de daarvoor bestemde containers<br>
    - bed- en keukenlinnen is tegen betaling beschikbaar. Bed is niet opgemaakt.<br>
    - handdoeken dient u zelf mee te nemen<br>
    - roken in het huis is niet toegestaan<br>
    - zorg dat eventuele huisdieren zo min mogelijk hun sporen achterlaten</p>
    <p>Wij wensen u een bijzonder prettig verblijf in De Broekhof!</p>
    ${ondertekeningHtml(inst)}
    <hr style="border:none;border-top:1px solid #ddd;margin:20px 0">
    ${boekingKaartHtml(b, inst)}
  </body></html>`;
}

function overzichtHtml(boekingen, inst, intro = '') {
  return `<div style="font-family:Arial,sans-serif;font-size:14px;max-width:700px">
    ${intro}
    <h2 style="color:#8c6d3f">Boekingen De Broekhof - ${nl(vandaag())}</h2>
    <p>${boekingen.length} actieve boekingen</p>
    ${boekingen.map(b => boekingKaartHtml(b, inst)).join('')}
  </div>`;
}

// ── Mail (Resend) ────────────────────────────────────────────────────
const geldigAdres = s => /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(String(s || '').trim());

async function mail({ naar, cc = [], onderwerp, html, tekst, bijlagen = [], soort, boekingId = null, sleutel = null }, inst) {
  const to = [].concat(naar).filter(geldigAdres);
  const ccLijst = [].concat(cc).filter(a => geldigAdres(a) && !to.includes(a));
  if (!to.length) throw new Fout('Geen geldig e-mailadres om naar te versturen');
  const afzender = env('MAIL_FROM') || `${inst.afzender_naam || 'De Broekhof'} <${inst.email_info}>`;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env('RESEND_API_KEY')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: afzender, to, cc: ccLijst.length ? ccLijst : undefined, reply_to: inst.email_info,
      subject: onderwerp, html, text: tekst,
      attachments: bijlagen.length ? bijlagen.map(b => ({ filename: b.naam, content: b.inhoud.toString('base64') })) : undefined,
    }),
  });
  const ok = res.ok;
  const melding = ok ? null : (await res.text()).slice(0, 300);
  await db('mail_log', {
    method: 'POST',
    body: { boeking_id: boekingId, soort, sleutel, naar: to.join(', '), cc: ccLijst.join(', ') || null,
            onderwerp, status: ok ? 'verzonden' : 'mislukt', foutmelding: melding },
  }).catch(() => {}); // dubbele automatische mail of logfout mag het versturen niet blokkeren
  if (!ok) throw new Fout(`Mail versturen mislukt: ${melding}`);
  return to.join(', ') + (ccLijst.length ? ` (cc: ${ccLijst.join(', ')})` : '');
}

// ── Nuki ─────────────────────────────────────────────────────────────
async function maakNukiCode({ naam, code, aankomst, vertrek, checkIn, checkOut }) {
  const codeNum = parseInt(String(code).replace(/\D/g, ''), 10);
  if (!codeNum || codeNum < 100000 || codeNum > 999999) return { status: 'error', message: 'Ongeldige code' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(aankomst) || !/^\d{4}-\d{2}-\d{2}$/.test(vertrek)) {
    return { status: 'error', message: 'Aankomst en vertrek zijn verplicht' };
  }
  const van = tijdPlus(uur(checkIn) || '16:00', -30);
  const tot = tijdPlus(uur(checkOut) || '10:00', 30);
  const lockId = env('NUKI_SMARTLOCK_ID');
  const payload = {
    smartlockId: Number(lockId),
    name: `${aankomst.slice(0, 4)}-${naam || 'Broekhof'}`.slice(0, 20),
    code: codeNum,
    type: 13,
    allowedFromDate: `${aankomst}T${van}:00${tzOffset(aankomst, van)}`,
    allowedUntilDate: `${vertrek}T${tot}:00${tzOffset(vertrek, tot)}`,
    allowedFromTime: 0,
    allowedUntilTime: 1439,
    allowedWeekDays: 127,
  };
  const res = await fetch(`https://api.nuki.io/smartlock/${lockId}/auth`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${env('NUKI_API_TOKEN')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (res.status === 200 || res.status === 204) return { status: 'ok', message: 'Nuki code aangemaakt' };
  return { status: 'error', message: `Nuki API fout ${res.status}: ${(await res.text()).slice(0, 200)}` };
}

// ── Acties voor beheerders ───────────────────────────────────────────
const beheerActies = {
  async nuki(d) {
    return maakNukiCode(d);
  },

  async 'pdf-link'({ opslagpad, bestandsnaam }) {
    return { status: 'ok', pdfUrl: await opslagLink(opslagpad, bestandsnaam || 'Huurovereenkomst.pdf') };
  },

  // Bevestiging met huurovereenkomst versturen. De PDF is door de browser
  // gemaakt en al opgeslagen in Storage (opslagpad).
  async 'verwerk-boeking'({ boekingId, opslagpad, bestandsnaam, emailAan, emailTekst, nuki }, inst) {
    const b = await laadBoeking(boekingId);
    if (!opslagpad) throw new Fout('Geen PDF ontvangen');
    const naam = `${bestandsnaam || 'Huurovereenkomst'}.pdf`;
    await db('documenten', { method: 'POST', body: { boeking_id: b.id, bestandsnaam: naam, opslagpad } });

    const pdf = await opslagLezen(opslagpad);
    const naarHuurder = geldigAdres(emailAan);
    await mail({
      naar: naarHuurder ? emailAan : inst.email_info,
      cc: naarHuurder ? [inst.email_info] : [],
      onderwerp: 'Reserveringsbevestiging en huurovereenkomst',
      tekst: emailTekst,
      html: `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;white-space:pre-wrap">${esc(emailTekst)}</div>`,
      bijlagen: [{ naam, inhoud: pdf }],
      soort: 'bevestiging', boekingId: b.id,
    }, inst);

    let nukiResultaat = null;
    if (nuki && b.toegangscode) {
      nukiResultaat = await maakNukiCode({
        naam: b.achternaam, code: b.toegangscode, aankomst: b.aankomst, vertrek: b.vertrek,
        checkIn: uur(b.checkin), checkOut: uur(b.checkout),
      });
    }
    return { status: 'ok', pdfUrl: await opslagLink(opslagpad, naam), naam, nuki: nukiResultaat };
  },

  async mail(d, inst) {
    if (d.soort === 'overzicht') {
      const lijst = await actieveBoekingen();
      await mail({
        naar: inst.email_info,
        onderwerp: `Boekingen De Broekhof - overzicht ${nl(vandaag())}`,
        html: overzichtHtml(lijst, inst), soort: 'overzicht',
      }, inst);
      return { status: 'ok' };
    }

    if (d.soort === 'sleutelbeheerder') {
      if (!geldigAdres(inst.email_sleutelbeheerder)) throw new Fout('E-mailadres sleutelbeheerder ontbreekt in de instellingen');
      const lijst = await actieveBoekingen();
      const intro = `
        <p>Beste ${esc(inst.naam_sleutelbeheerder || '')},</p>
        <p>De lijst met boekingen is bijgewerkt.</p>
        ${d.naam && d.aankomst ? `<p>De volgende boeking is nieuw of bijgewerkt: <strong>${esc(d.aankomst)} – ${esc(d.naam)}</strong></p>` : ''}
        <p>Met vriendelijke groet,<br><strong>${esc((inst.ondertekening || '').split(' ')[0])}</strong></p>
        <hr style="border:none;border-top:1px solid #ddd;margin:20px 0">`;
      const naar = await mail({
        naar: inst.email_sleutelbeheerder, cc: [inst.email_info],
        onderwerp: 'Boekingen De Broekhof - overzicht voor sleutelbeheerder',
        html: overzichtHtml(lijst, inst, intro), soort: 'sleutelbeheerder',
      }, inst);
      return { status: 'ok', naar };
    }

    if (d.soort === 'aankomst') {
      if (!d.boekingId) throw new Fout('Geen boeking geselecteerd (open via potlood)');
      const b = await laadBoeking(d.boekingId);
      const onderwerp = `Uw boeking bij de Broekhof - ${nlLang(b.aankomst)}`;
      const html = aankomstMailHtml(b, inst);
      let naar, cc = [];
      if (d.ontvanger === 'info') naar = inst.email_info;
      else if (d.ontvanger === 'huurder') {
        if (!geldigAdres(b.email)) throw new Fout('Geen geldig e-mailadres voor huurder');
        naar = b.email; cc = [inst.email_info];
      } else if (d.ontvanger === 'sleutelbeheerder') {
        if (!geldigAdres(inst.email_sleutelbeheerder)) throw new Fout('E-mailadres sleutelbeheerder ontbreekt in de instellingen');
        naar = inst.email_sleutelbeheerder; cc = [inst.email_info];
      } else throw new Fout('Onbekende ontvanger');
      const verstuurd = await mail({ naar, cc, onderwerp, html, soort: 'aankomst-handmatig', boekingId: b.id }, inst);
      return { status: 'ok', naar: verstuurd };
    }

    throw new Fout('Onbekende soort mail');
  },
};

// ── Dagelijkse taak ──────────────────────────────────────────────────
async function aankomstMails(inst) {
  const dagen = Number(inst.aankomstmail_dagen_vooraf) || 4;
  const datum = plusDagen(vandaag(), dagen);
  const lijst = await db(`boekingen?verwijderd_op=is.null&aankomst=eq.${datum}&select=*`);
  const log = [];
  for (const b of lijst) {
    const al = await db(`mail_log?boeking_id=eq.${b.id}&soort=eq.aankomst&sleutel=eq.${b.aankomst}&status=eq.verzonden&select=id`);
    if (al.length) { log.push(`al verstuurd: ${b.achternaam}`); continue; }
    const onderwerp = `Uw boeking bij de Broekhof - ${nlLang(b.aankomst)}`;
    const html = aankomstMailHtml(b, inst);
    const naarHuurder = b.mail_huurder && geldigAdres(b.email);
    try {
      await mail({
        naar: naarHuurder ? b.email : inst.email_info, cc: naarHuurder ? [inst.email_info] : [],
        onderwerp, html, soort: 'aankomst', boekingId: b.id, sleutel: b.aankomst,
      }, inst);
      log.push(`aankomstmail: ${b.achternaam}${naarHuurder ? ' (incl. huurder)' : ' (alleen intern)'}`);
    } catch (e) {
      log.push(`MISLUKT ${b.achternaam}: ${e.message}`);
      continue;
    }
    // Sleutelbeheerder: aparte mail, zodat huurder en sleutelbeheerder elkaars adres niet zien
    if (b.mail_huurder && geldigAdres(inst.email_sleutelbeheerder)) {
      try {
        await mail({ naar: inst.email_sleutelbeheerder, onderwerp, html, soort: 'aankomst-sleutelbeheerder', boekingId: b.id }, inst);
      } catch (e) { log.push(`sleutelbeheerder MISLUKT: ${e.message}`); }
    }
  }
  return log;
}

async function betaalwaarschuwing(inst) {
  const week = new Date(Date.now() - 6 * 864e5).toISOString();
  const al = await db(`mail_log?soort=eq.betaalwaarschuwing&status=eq.verzonden&verzonden_op=gte.${week}&select=id`);
  if (al.length) return 'betaalwaarschuwing deze week al verstuurd';

  const grens = plusDagen(vandaag(), -90);
  const regels = await db(
    `betalingen?verborgen=eq.false&vervaldatum=gte.${grens}&order=vervaldatum.asc` +
    '&select=*,boekingen!inner(voornaam,achternaam,aankomst,verwijderd_op)&boekingen.verwijderd_op=is.null');
  const nu = vandaag();
  const open = regels.filter(r => r.vervaldatum < nu && !r.betaald);
  if (!open.length) return 'geen openstaande betalingen';

  const TYPE = { aanbetaling: ['Aanbetaling', '#2e7d32'], restant: ['Restant', '#1565c0'], borg_terug: ['Borg terug', '#c62828'] };
  const rijen = regels.map(r => {
    const vv = r.vervaldatum < nu && !r.betaald;
    const [label, kleur] = TYPE[r.soort];
    const terug = r.soort === 'borg_terug';
    const naam = r.boekingen.achternaam + (r.boekingen.voornaam ? ', ' + r.boekingen.voornaam : '');
    return `<tr style="background:${r.betaald ? '#f5f5f5' : vv ? '#fdecea' : '#fff'};border-bottom:1px solid #eee">
      <td style="padding:8px 12px;${vv ? 'color:#c62828;font-weight:bold' : ''}">${nlKort(r.vervaldatum)}${vv ? ' ⚠' : ''}</td>
      <td style="padding:8px 12px"><strong>${esc(naam)}</strong><br><small>${nl(r.boekingen.aankomst)}</small>${r.notitie ? `<br><em style="color:#8c6d3f;font-size:12px">${esc(r.notitie)}</em>` : ''}</td>
      <td style="padding:8px 12px"><span style="background:${kleur}22;color:${kleur};padding:2px 8px;border-radius:12px;font-size:12px;font-weight:600">${label}</span></td>
      <td style="padding:8px 12px;text-align:right;font-weight:600;color:${terug ? '#c62828' : '#2e7d32'}">${terug ? '- ' : '+ '}€ ${Math.round(Number(r.bedrag))}</td>
      <td style="padding:8px 12px;text-align:center">${r.betaald ? '✅' : vv ? '⚠️' : '◻'}</td>
    </tr>`;
  }).join('');
  const n = open.length;
  const html = `<html><body style="font-family:Arial,sans-serif;font-size:14px;max-width:700px">
    <h2 style="color:#8c6d3f;border-bottom:2px solid #8c6d3f;padding-bottom:8px">Financieel overzicht - De Broekhof</h2>
    <p style="color:#888">${nlKort(nu)}</p>
    <p style="background:#fdecea;border:1px solid #ef9a9a;padding:10px 14px;border-radius:4px;color:#c62828">
      ⚠ <strong>${n} openstaande betaling${n !== 1 ? 'en' : ''}</strong> verwacht maar nog niet ontvangen</p>
    <table style="width:100%;border-collapse:collapse;margin-top:16px">
      <thead><tr style="background:#8c6d3f;color:#fff">
        <th style="padding:8px 12px;text-align:left;font-size:12px">Datum</th>
        <th style="padding:8px 12px;text-align:left;font-size:12px">Huurder</th>
        <th style="padding:8px 12px;text-align:left;font-size:12px">Type</th>
        <th style="padding:8px 12px;text-align:right;font-size:12px">Bedrag</th>
        <th style="padding:8px 12px;text-align:center;font-size:12px">Status</th>
      </tr></thead>
      <tbody>${rijen}</tbody>
    </table>
    ${env('URL') ? `<p style="margin-top:20px;color:#888;font-size:12px">Beheer via <a href="${esc(env('URL'))}">beheerpagina</a>.</p>` : ''}
  </body></html>`;
  await mail({ naar: inst.email_info, onderwerp: 'Financieel overzicht - De Broekhof', html, soort: 'betaalwaarschuwing' }, inst);
  return `betaalwaarschuwing verstuurd (${n})`;
}

async function dagelijks(inst) {
  const log = await aankomstMails(inst);
  if (dagVan(vandaag()) === 1) log.push(await betaalwaarschuwing(inst)); // maandag
  return { status: 'ok', log };
}

// ── Micazu-import (vanuit micazu.gs) ─────────────────────────────────
function genereerToegangscode() {
  const c = '23456789';
  let code;
  do {
    code = Array.from({ length: 6 }, () => c[Math.floor(Math.random() * c.length)]).join('');
  } while ([...code].every((x, i) => i === 0 || +x === +code[i - 1] + 1));
  return code;
}

async function micazuImport(b, inst) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.aankomst || '') || !/^\d{4}-\d{2}-\d{2}$/.test(b.vertrek || '') || !b.achternaam) {
    throw new Fout('Aankomst, vertrek en achternaam zijn verplicht');
  }
  const naam = String(b.achternaam).trim();
  const bestaand = await db(`boekingen?verwijderd_op=is.null&aankomst=eq.${b.aankomst}&select=achternaam`);
  if (bestaand.some(x => x.achternaam.trim().toLowerCase() === naam.toLowerCase())) {
    return { status: 'ok', resultaat: 'bestond al' };
  }
  const prijzen = inst.prijzen || {};
  const tijden = inst.tijden || {};
  const totaal = Number(b.totaal) || 0;
  const restant = Math.floor((totaal * 0.75) / 5) * 5;
  const huisdieren = Number(b.huisdieren) || 0;
  const [rij] = await db('boekingen', {
    method: 'POST', prefer: 'return=representation',
    body: {
      aankomst: b.aankomst, vertrek: b.vertrek,
      voornaam: String(b.voornaam || '').trim(), achternaam: naam,
      personen: Number(b.personen) || 0, huisdieren,
      bedlinnen: Number(b.bedlinnen) || 0, keukenlinnen: Number(b.keukenlinnen) || 0,
      huurprijs: Number(b.huurprijs) || 0,
      schoonmaak: Number(b.schoonmaak) || ((prijzen.schoonmaak ?? 90) + huisdieren * (prijzen.schoonmaak_per_huisdier ?? 10)),
      extras: Number(b.extras) || 0, totaal, restant, borg: 0,
      aanbetaling: Math.round(totaal - restant),
      land: 'Nederland', toegangscode: genereerToegangscode(),
      checkin: tijden.checkin || '16:00', checkout: tijden.checkout || '10:00',
      bron: 'micazu-aanvullen', vraag_huurder: b.vraag || null,
    },
  });
  return { status: 'ok', resultaat: 'nieuw', id: rij.id };
}

// ── Micazu-mail via Resend (ontvangen mail) ──────────────────────────
// Resend stuurt bij elke ontvangen mail een webhook (alleen metadata); de inhoud
// halen we op met GET /emails/receiving/{id}. Ondertekend volgens Svix.
function controleerHandtekening(req, ruw) {
  const geheim = env('RESEND_WEBHOOK_SECRET');
  if (!geheim) return false;
  const id = req.headers.get('svix-id') || '';
  const ts = req.headers.get('svix-timestamp') || '';
  const handtekeningen = req.headers.get('svix-signature') || '';
  if (!id || !ts || !handtekeningen) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const sleutel = Buffer.from(geheim.replace(/^whsec_/, ''), 'base64');
  const verwacht = createHmac('sha256', sleutel).update(`${id}.${ts}.${ruw}`).digest();
  return handtekeningen.split(' ').some(deel => {
    const [versie, sig] = deel.split(',');
    if (versie !== 'v1' || !sig) return false;
    const b = Buffer.from(sig, 'base64');
    return b.length === verwacht.length && timingSafeEqual(b, verwacht);
  });
}

function htmlNaarTekst(html) {
  return String(html || '')
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(td|th)>/gi, '\t')
    .replace(/<\/(p|div|tr|h\d|li|table)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&euro;/g, '€').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

const MAANDEN = ['januari','februari','maart','april','mei','juni','juli','augustus','september','oktober','november','december'];
function nlDatumNaarIso(s) {
  const t = String(s || '').toLowerCase();
  const twee = n => String(n).padStart(2, '0');
  const m = t.match(/(\d{1,2})\.?\s+([a-z]{3,})\.?\s+(\d{4})/);   // 4 december 2026, 4 dec. 2026
  if (m) {
    const mi = MAANDEN.findIndex(x => x.startsWith(m[2].slice(0, 3)));
    if (mi >= 0) return `${m[3]}-${twee(mi + 1)}-${twee(m[1])}`;
  }
  const c = t.match(/(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);          // 04-12-2026
  if (c) return `${c[3]}-${twee(c[2])}-${twee(c[1])}`;
  const iso = t.match(/(\d{4})-(\d{2})-(\d{2})/);
  return iso ? iso[0] : null;
}

function micazuBedrag(s) {
  const getal = String(s || '').match(/\d[\d.,]*/); // "met verblijf dieren € 100,00" → "100,00"
  let t = getal ? getal[0].replace(/[.,]$/, '') : '';
  if (!t) return 0;
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  else if (/\.\d{3}$/.test(t)) t = t.replace(/\./g, '');
  return parseFloat(t) || 0;
}

// Zelfde regels als parseMicazuMail in apps-script/micazu.gs
function parseMicazuMail(tekst) {
  const regels = String(tekst).replace(/\r/g, '').split('\n')
    .map(r => r.replace(/[\u00a0\u2000-\u200b\u202f]/g, ' ')
      .replace(/^[\s*|>_#-]+/, '').replace(/[\s*|_]+$/, '')   // opmaak uit platte tekst ("**Aankomst** | …")
      .replace(/\*\*/g, '').replace(/\s*\|\s*/g, '\t').trim())
    .filter(Boolean);
  function zoek(label, vanaf) {
    const start = vanaf ? Math.max(0, regels.findIndex(r => r.toLowerCase().startsWith(vanaf.toLowerCase()))) : 0;
    for (let i = start; i < regels.length; i++) {
      if (regels[i].toLowerCase().startsWith(label.toLowerCase())) {
        const rest = regels[i].slice(label.length).replace(/^[\s:\t]+/, '').trim();
        return { waarde: rest || (regels[i + 1] || ''), index: i };
      }
    }
    return { waarde: '', index: -1 };
  }
  const val = (label, vanaf) => zoek(label, vanaf).waarde;
  const aantal = (label, vanaf) => {
    const z = zoek(label, vanaf);
    if (z.index < 0) return 0;
    const m = regels[z.index].match(/(\d+)\s*$/) || String(regels[z.index + 1] || '').match(/^(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  };
  const boeking = 'Gegevens van de boeking';
  const aankomst = nlDatumNaarIso(val('Aankomst', boeking));
  const vertrek = nlDatumNaarIso(val('Vertrek', boeking));
  if (!aankomst || !vertrek) throw new Fout('aankomst/vertrek niet gevonden');
  const gegevens = 'Gegevens huurder';
  const voornaam = val('Voornaam', gegevens);
  const achternaam = val('Tussenvoegsel & achternaam', gegevens) || val('Achternaam', gegevens);
  if (!achternaam) throw new Fout('achternaam niet gevonden');
  const personen = aantal('Aantal volwassenen', gegevens) + aantal('Aantal kinderen', gegevens) + aantal('Aantal baby', gegevens);
  const huisdieren = aantal('Huisdieren', gegevens);
  const huur = micazuBedrag(val('Vakantiehuis', boeking));
  const totaal = micazuBedrag(val('Totaalprijs', boeking));
  const schoonmaak = micazuBedrag(val('Eindschoonmaak', boeking)) || (90 + huisdieren * 10);
  const getal = s => { const m = String(s).match(/(\d+)/); return m ? parseInt(m[1], 10) : 0; };
  const bedlinnen = getal(val('Bedlinnen', boeking));
  const keukenlinnen = getal(val('Keukenlinnen', boeking));
  const extras = totaal && huur ? Math.max(0, Math.round((totaal - huur) * 100) / 100) : (bedlinnen * 10 + keukenlinnen * 7);
  const vIdx = regels.findIndex(r => /^(vragen|bericht) van de huurder/i.test(r));
  let vraag = '';
  if (vIdx >= 0) {
    const eind = regels.findIndex((r, i) => i > vIdx && /^(tip!?|heb je nog vragen)/i.test(r));
    vraag = regels.slice(vIdx + 1, eind > 0 ? eind : vIdx + 6).join('\n');
  }
  return {
    aankomst, vertrek, voornaam, achternaam, personen, huisdieren, bedlinnen, keukenlinnen,
    huurprijs: huur || (totaal - extras), extras, totaal: totaal || (huur + extras), schoonmaak, vraag,
  };
}

const MICAZU_HERKEN = /boekingsaanvraag[\s\S]{0,40}geaccepteerd/i;

async function micazuInbound(req, ruw) {
  if (!controleerHandtekening(req, ruw)) return fout('Ongeldige handtekening', 401);
  let event;
  try { event = JSON.parse(ruw); } catch { return fout('Geen geldige JSON', 400); }
  if (event.type !== 'email.received') return antwoord({ status: 'ok', genegeerd: event.type });
  const emailId = event.data && event.data.email_id;
  if (!emailId) return fout('email_id ontbreekt', 400);

  // Resend kan een webhook opnieuw sturen: elke mail maar één keer verwerken
  const gedaan = await db(`mail_log?soort=eq.micazu-inbound&sleutel=eq.${encodeURIComponent(emailId)}&status=eq.verzonden&select=id`);
  if (gedaan.length) return antwoord({ status: 'ok', resultaat: 'al verwerkt' });

  const res = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}`, {
    headers: { Authorization: `Bearer ${env('RESEND_API_KEY')}` },
  });
  if (!res.ok) throw new Error(`Ontvangen mail ophalen mislukt (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const m = await res.json();
  // Probeer eerst de tekstversie en anders de HTML-versie van de mail
  const versies = [m.text, m.html && htmlNaarTekst(m.html)].filter(t => t && t.trim());
  const tekst = versies.join('\n');
  const inst = await laadInstellingen();
  const origineel = `<hr style="border:none;border-top:1px solid #ddd;margin:20px 0">
    <p style="color:#888;font-size:12px">Oorspronkelijke mail van ${esc(m.from)} · ${esc(m.subject)}</p>
    ${m.html || `<pre style="white-space:pre-wrap;font-family:inherit">${esc(m.text)}</pre>`}`;
  const melding = (onderwerp, kop) => mail({
    naar: inst.email_info, onderwerp,
    html: `<div style="font-family:Arial,sans-serif;font-size:14px;max-width:640px">${kop}${origineel}</div>`,
    soort: 'micazu-inbound', sleutel: emailId,
  }, inst);

  // Alleen een acceptatiebevestiging met boekings- én huurdergegevens wordt een boeking
  const isAcceptatie = MICAZU_HERKEN.test(`${m.subject || ''} ${tekst.slice(0, 600)}`)
    && /gegevens van de boeking/i.test(tekst) && /gegevens huurder/i.test(tekst);
  if (!isAcceptatie) {
    await melding(`Doorgestuurd: ${m.subject || '(geen onderwerp)'}`,
      '<p>Deze mail kwam binnen op het Micazu-adres van de beheerapp, maar is geen geaccepteerde boeking. Hij is hieronder doorgestuurd.</p>');
    return antwoord({ status: 'ok', resultaat: 'doorgestuurd' });
  }

  let b, resultaat;
  try {
    let laatsteFout;
    for (const versie of versies) {
      try { b = parseMicazuMail(versie); break; } catch (e) { laatsteFout = e; }
    }
    if (!b) throw laatsteFout || new Fout('lege mail');
    resultaat = (await micazuImport(b, inst)).resultaat;
  } catch (e) {
    await melding('⚠ Micazu-boeking niet automatisch ingelezen',
      `<p>Deze Micazu-mail kon niet worden verwerkt: <b>${esc(e.message)}</b>.<br>Voer de boeking met de hand in via de beheerapp.</p>
      <details><summary style="color:#888;font-size:12px">Tekst zoals de app die las (voor foutzoeken)</summary>
      <pre style="white-space:pre-wrap;font-size:11px;color:#555">${esc(versies.map((v, i) => `--- versie ${i + 1} ---\n${JSON.stringify(v.slice(0, 2500)).slice(1, -1).replace(/\\n/g, '\n')}`).join('\n'))}</pre></details>`);
    return antwoord({ status: 'ok', resultaat: 'mislukt', message: e.message });
  }
  const nl = iso => iso.split('-').reverse().join('-');
  await melding(
    `${resultaat === 'nieuw' ? 'Nieuwe Micazu-boeking ingelezen' : 'Micazu-boeking bestond al'}: ${b.achternaam} ${nl(b.aankomst)}`,
    `<p>${resultaat === 'nieuw' ? 'Er is automatisch een boeking aangemaakt vanuit Micazu.' : 'Deze boeking stond al in de beheerapp; er is niets toegevoegd.'}</p>
    <table style="border-collapse:collapse">
      <tr><td style="padding:2px 12px 2px 0">Huurder</td><td><b>${esc(b.voornaam)} ${esc(b.achternaam)}</b></td></tr>
      <tr><td style="padding:2px 12px 2px 0">Periode</td><td>${nl(b.aankomst)} t/m ${nl(b.vertrek)}</td></tr>
      <tr><td style="padding:2px 12px 2px 0">Personen</td><td>${b.personen} (huisdieren: ${b.huisdieren})</td></tr>
      <tr><td style="padding:2px 12px 2px 0">Totaal</td><td>€ ${b.totaal}</td></tr>
    </table>
    ${b.vraag ? `<p><b>Vraag van de huurder:</b><br>${esc(b.vraag).replace(/\n/g, '<br>')}</p>` : ''}
    ${resultaat === 'nieuw' ? '<p style="background:#fffbeb;border:1px solid #f0cc70;padding:8px 12px"><b>Nog aanvullen in de beheerapp:</b> aanhef, e-mail, telefoon, adres, keukenlinnen en borg.</p>' : ''}`);
  return antwoord({ status: 'ok', resultaat });
}

// ── Ingang ───────────────────────────────────────────────────────────
export default async (req) => {
  if (req.method !== 'POST') return fout('Alleen POST', 405);
  const ruw = await req.text();
  if (new URL(req.url).pathname.endsWith('/micazu-inbound')) {
    try { return await micazuInbound(req, ruw); } catch (e) {
      console.error('[micazu-inbound]', e);
      return fout('Serverfout: ' + e.message, 500); // 500: Resend probeert het later opnieuw
    }
  }
  let data;
  try { data = JSON.parse(ruw); } catch { return fout('Geen geldige JSON', 400); }
  const actie = data.actie;

  try {
    const geheim = req.headers.get('x-broekhof-geheim') || '';
    if (actie === 'dagelijks') {
      if (!env('INTERN_GEHEIM') || geheim !== env('INTERN_GEHEIM')) return fout('Niet geautoriseerd', 401);
      return antwoord(await dagelijks(await laadInstellingen()));
    }
    if (actie === 'micazu-import') {
      if (!env('MICAZU_GEHEIM') || geheim !== env('MICAZU_GEHEIM')) return fout('Niet geautoriseerd', 401);
      return antwoord(await micazuImport(data.boeking || {}, await laadInstellingen()));
    }

    const handler = beheerActies[actie];
    if (!handler) return fout('Onbekende actie: ' + actie, 400);
    const gebruiker = await gebruikerUitToken(req);
    if (!gebruiker) return fout('Niet ingelogd', 401);
    return antwoord(await handler(data, await laadInstellingen(), gebruiker));
  } catch (e) {
    console.error(`[actie ${actie}]`, e);
    return fout(e instanceof Fout ? e.message : 'Serverfout: ' + e.message);
  }
};

export const config = { path: ['/api/actie', '/api/micazu-inbound'] };
