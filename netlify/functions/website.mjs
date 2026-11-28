// ═══════════════════════════════════════════════════════════════════════
// website.mjs — koppeling tussen de openbare website en het beheer
//
//   GET  /api/beschikbaarheid      bezette periodes, alleen datums (geen namen)
//        → { status:'ok', bezet:[{ van:'2026-12-11', tot:'2026-12-14' }], bronnen:{…} }
//          "tot" is de vertrekdag: die dag is weer vrij als aankomstdag.
//          Bron: boekingen in Supabase + de Micazu-agenda (MICAZU_ICAL_URL).
//   POST /api/aanvraag             beschikbaarheidsaanvraag vanaf de website
//        { naam, email, telefoon, aankomst, vertrek, personen, huisdier, bericht, website }
//          → tabel aanvragen + mail naar info@ (met link naar de beheerapp)
//            + ontvangstbevestiging naar de aanvrager
//   GET  /api/ical?token=…         agenda voor Micazu: eigen boekingen die niet
//                                  al in de Micazu-agenda staan (ICAL_EXPORT_TOKEN)
//
// De website mag deze adressen vanuit de browser aanroepen (CORS) als haar
// domein in WEBSITE_ORIGINS staat (komma-gescheiden).
// Alleen ingebouwde Node-modules en fetch; alles in dit ene bestand.
// ═══════════════════════════════════════════════════════════════════════

import { createHash, timingSafeEqual } from 'node:crypto';

const TZ = 'Europe/Amsterdam';
const env = k => process.env[k] || '';

const MICAZU_CACHE_MS = 30 * 60 * 1000;   // Micazu-agenda: 30 minuten
const MAX_AANVRAGEN_PER_UUR = 5;           // per IP-adres

class Fout extends Error {
  constructor(message, status = 400, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

// ── HTTP + CORS ──────────────────────────────────────────────────────
function corsKoppen(req) {
  const origin = req.headers.get('origin') || '';
  const toegestaan = env('WEBSITE_ORIGINS').split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);
  if (!origin || !toegestaan.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}
const json = (req, obj, status = 200, koppen = {}) =>
  Response.json(obj, { status, headers: { ...corsKoppen(req), ...koppen } });

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
  if (!res.ok) throw new Error(`Database ${res.status}: ${tekst.slice(0, 200)}`);
  return tekst ? JSON.parse(tekst) : null;
}

async function laadInstellingen() {
  const rijen = await db('instellingen?select=sleutel,waarde');
  return Object.fromEntries(rijen.map(r => [r.sleutel, r.waarde]));
}

// ── Datums ───────────────────────────────────────────────────────────
function vandaag() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date());
}
function plusDagen(iso, n) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function geldigeDatum(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T12:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}
const nl = iso => { const [y, m, d] = String(iso).slice(0, 10).split('-'); return `${d}-${m}-${y}`; };
const nachten = (van, tot) => Math.round((new Date(tot + 'T12:00:00Z') - new Date(van + 'T12:00:00Z')) / 86400000);

// ── Periodes ─────────────────────────────────────────────────────────
function voegSamen(periodes) {
  const uit = [];
  [...periodes].sort((a, b) => a.van.localeCompare(b.van)).forEach(p => {
    const laatste = uit[uit.length - 1];
    if (laatste && p.van <= laatste.tot) { if (p.tot > laatste.tot) laatste.tot = p.tot; }
    else uit.push({ van: p.van, tot: p.tot });
  });
  return uit;
}
const overlapt = (van, tot, periodes) => periodes.some(p => van < p.tot && tot > p.van);

// ── Micazu-agenda (iCal) ─────────────────────────────────────────────
// De feed bevat gastnamen (SUMMARY); die worden bewust niet bewaard.
function parseIcal(ics) {
  const tekst = String(ics).replace(/\r?\n[ \t]/g, '');
  const periodes = [];
  for (const [, ev] of tekst.matchAll(/BEGIN:VEVENT([\s\S]*?)END:VEVENT/g)) {
    const datum = veld => {
      const m = ev.match(new RegExp(`^${veld}[^:\\r\\n]*:(\\d{4})(\\d{2})(\\d{2})`, 'm'));
      return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
    };
    const van = datum('DTSTART');
    if (!van) continue;
    let tot = datum('DTEND');
    if (!tot || tot <= van) tot = plusDagen(van, 1);
    periodes.push({ van, tot });
  }
  return periodes;
}

let micazuCache = { tijd: 0, periodes: null };   // blijft bewaard zolang de function warm is

async function micazuPeriodes() {
  if (!env('MICAZU_ICAL_URL')) return { ok: false, periodes: [], bijgewerkt: null };
  if (micazuCache.periodes && Date.now() - micazuCache.tijd < MICAZU_CACHE_MS) {
    return { ok: true, periodes: micazuCache.periodes, bijgewerkt: new Date(micazuCache.tijd).toISOString() };
  }
  try {
    const res = await fetch(env('MICAZU_ICAL_URL'), { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const periodes = parseIcal(await res.text());
    micazuCache = { tijd: Date.now(), periodes };
    return { ok: true, periodes, bijgewerkt: new Date().toISOString() };
  } catch (e) {
    console.error('[website] Micazu-agenda ophalen mislukt:', e.message);
    return { ok: false, periodes: micazuCache.periodes || [],
             bijgewerkt: micazuCache.tijd ? new Date(micazuCache.tijd).toISOString() : null };
  }
}

async function beheerBoekingen(vanaf) {
  return db(`boekingen?verwijderd_op=is.null&vertrek=gt.${vanaf}&select=aankomst,vertrek,bron&order=aankomst.asc`);
}

async function bezetting() {
  const vanaf = vandaag();
  const [mic, eigen] = await Promise.all([
    micazuPeriodes(),
    beheerBoekingen(vanaf).then(r => ({ ok: true, rijen: r })).catch(e => {
      console.error('[website] Boekingen laden mislukt:', e.message);
      return { ok: false, rijen: [] };
    }),
  ]);
  if (!mic.ok && !eigen.ok) throw new Fout('Beschikbaarheid tijdelijk niet beschikbaar', 503);
  const alle = [
    ...eigen.rijen.map(b => ({ van: b.aankomst, tot: b.vertrek })),
    ...mic.periodes,
  ].filter(p => p.tot > vanaf);
  return {
    bezet: voegSamen(alle),
    bronnen: {
      beheer: { ok: eigen.ok },
      micazu: { ok: mic.ok, bijgewerkt: mic.bijgewerkt },
    },
  };
}

// ── Mail (Resend) ────────────────────────────────────────────────────
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const geldigAdres = s => /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(String(s || '').trim());

function metKop(titel, html) {
  const basis = (env('URL') || '').replace(/\/$/, '');
  const logo = basis ? `<td style="width:56px;padding:0 14px 0 0;vertical-align:middle"><img src="${esc(basis)}/img/logo-mail.png" width="56" height="56" alt="de Broekhof" style="display:block;border:0;border-radius:6px"></td>` : '';
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:700px;margin:0 0 20px 0;border-collapse:collapse">
    <tr>${logo}<td style="vertical-align:middle;font-family:Georgia,'Times New Roman',serif;font-size:20px;font-weight:bold;color:#2d2921">${esc(titel)}</td></tr>
    <tr><td colspan="2" style="padding-top:12px"><div style="height:2px;line-height:2px;font-size:0;background:#8c6d3f">&nbsp;</div></td></tr>
  </table>${html}`;
}

async function mail({ naar, onderwerp, html, tekst, antwoordAan, soort }, inst) {
  const afzender = env('MAIL_FROM') || `${inst.afzender_naam || 'De Broekhof'} <${inst.email_info}>`;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env('RESEND_API_KEY')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: afzender, to: [naar], reply_to: antwoordAan || inst.email_info,
                           subject: onderwerp, html: metKop(onderwerp, html), text: tekst }),
  });
  const melding = res.ok ? null : (await res.text()).slice(0, 300);
  await db('mail_log', {
    method: 'POST',
    body: { soort, naar, onderwerp, status: res.ok ? 'verzonden' : 'mislukt', foutmelding: melding },
  }).catch(() => {});
  if (!res.ok) throw new Error('Mail versturen mislukt: ' + melding);
}

function knop(href, tekst) {
  return `<a href="${esc(href)}" style="display:inline-block;margin:4px 8px 4px 0;padding:10px 16px;border-radius:4px;text-decoration:none;font-weight:bold;background:#8c6d3f;color:#fff">${tekst}</a>`;
}

function aanvraagMailInfo(a) {
  const rij = (k, v) => `<tr><td style="padding:3px 16px 3px 0;color:#666">${k}</td><td style="padding:3px 0"><b>${esc(v)}</b></td></tr>`;
  const basis = (env('URL') || '').replace(/\/$/, '');
  const link = basis ? `${basis}/?aanvraag=${encodeURIComponent(a.id)}` : '';
  return `<p>Er is een beschikbaarheidsaanvraag binnengekomen via de website.</p>
    <table style="border-collapse:collapse;font-size:14px">
      ${rij('Naam', a.naam)}${rij('E-mail', a.email)}${rij('Telefoon', a.telefoon || '–')}
      ${rij('Periode', `${nl(a.aankomst)} t/m ${nl(a.vertrek)} (${nachten(a.aankomst, a.vertrek)} nachten)`)}
      ${rij('Personen', a.personen)}${rij('Huisdier', a.huisdier ? 'ja' : 'nee')}
    </table>
    ${a.bericht ? `<p style="margin-top:16px"><b>Bericht:</b><br>${esc(a.bericht).replace(/\n/g, '<br>')}</p>` : ''}
    <div style="background:#fffbeb;border:1px solid #f0cc70;padding:12px 16px;margin:16px 0">
      <p style="margin:0 0 8px">De datums zijn nog <b>niet</b> geblokkeerd. Ga je akkoord, maak dan de boeking aan;
      de gegevens van de aanvrager staan dan al ingevuld.</p>
      ${link ? knop(link, '📅 Boeking aanmaken in de beheerapp') : ''}
    </div>
    <p>Antwoorden aan de aanvrager kan direct op deze mail.</p>`;
}

function aanvraagMailAanvrager(a) {
  return `<p>Beste ${esc(a.naam)},</p>
    <p>Dank je wel voor je aanvraag voor De Broekhof van <b>${nl(a.aankomst)}</b> tot <b>${nl(a.vertrek)}</b>
    voor ${esc(a.personen)} personen. We kijken ernaar en laten je zo snel mogelijk weten of het lukt.</p>
    <p>Let op: dit is nog geen bevestiging van je verblijf. Je betaalt pas nadat wij de boeking hebben bevestigd.</p>
    <p>Hartelijke groet,<br>De Broekhof</p>`;
}

// ── Aanvraag ─────────────────────────────────────────────────────────
async function aanvraag(req, context) {
  let d;
  try { d = await req.json(); } catch { throw new Fout('Geen geldige gegevens'); }
  if (!d || typeof d !== 'object') throw new Fout('Geen geldige gegevens');

  // Onzichtbaar veld voor bots: ingevuld → doen alsof het gelukt is
  if (String(d.website || '').trim()) {
    console.log('[website] aanvraag genegeerd (honeypot)');
    return { status: 'ok', message: 'Bedankt! We hebben je aanvraag ontvangen.' };
  }

  const tekst = (v, max) => String(v ?? '').replace(/<[^>]*>/g, '').trim().slice(0, max);
  const a = {
    naam: tekst(d.naam, 100),
    email: tekst(d.email, 150),
    telefoon: tekst(d.telefoon, 30) || null,
    aankomst: String(d.aankomst || ''),
    vertrek: String(d.vertrek || ''),
    personen: parseInt(d.personen, 10) || 0,
    huisdier: d.huisdier === true || d.huisdier === 'ja' || d.huisdier === '1',
    bericht: tekst(d.bericht, 2000) || null,
  };

  const velden = {};
  if (!a.naam) velden.naam = 'Vul je naam in.';
  if (!geldigAdres(a.email)) velden.email = 'Vul een geldig e-mailadres in.';
  if (a.telefoon && !/^\+?[0-9 ()-]{8,20}$/.test(a.telefoon)) velden.telefoon = 'Dit telefoonnummer klopt niet.';
  if (!geldigeDatum(a.aankomst)) velden.aankomst = 'Kies een aankomstdatum.';
  else if (a.aankomst < vandaag()) velden.aankomst = 'De aankomstdatum ligt in het verleden.';
  if (!geldigeDatum(a.vertrek)) velden.vertrek = 'Kies een vertrekdatum.';
  else if (geldigeDatum(a.aankomst) && a.vertrek <= a.aankomst) velden.vertrek = 'De vertrekdatum moet na de aankomstdatum liggen.';
  else if (a.vertrek > plusDagen(vandaag(), 730)) velden.vertrek = 'Zo ver vooruit kun je nog niet aanvragen.';
  if (a.personen < 2 || a.personen > 7) velden.personen = 'Het huis is voor 2 tot 7 personen.';
  if (Object.keys(velden).length) throw new Fout('Controleer de gegevens.', 422, { velden });

  // Spam beperken: maximaal aantal aanvragen per IP-adres per uur
  const ip = context?.ip || req.headers.get('x-nf-client-connection-ip') || '';
  const ipHash = createHash('sha256').update(ip + env('SUPABASE_SERVICE_ROLE_KEY')).digest('hex').slice(0, 32);
  const sinds = new Date(Date.now() - 3600000).toISOString();
  const recent = await db(`aanvragen?ip_hash=eq.${ipHash}&ontvangen_op=gte.${encodeURIComponent(sinds)}&select=id`);
  if (recent.length >= MAX_AANVRAGEN_PER_UUR) {
    throw new Fout('Er zijn al veel aanvragen verstuurd. Probeer het later opnieuw of mail naar info@debroekhof.nl.', 429);
  }

  const b = await bezetting();
  if (overlapt(a.aankomst, a.vertrek, b.bezet)) {
    throw new Fout('Het huis is in (een deel van) deze periode al bezet. Kies andere data.', 409,
                   { status: 'bezet', bezet: b.bezet });
  }

  const [rij] = await db('aanvragen', { method: 'POST', prefer: 'return=representation', body: { ...a, ip_hash: ipHash } });
  const inst = await laadInstellingen();
  const periode = `${nl(a.aankomst)} – ${nl(a.vertrek)}`;

  await mail({
    naar: inst.email_info || 'info@debroekhof.nl',
    onderwerp: `Website-aanvraag: ${a.naam}, ${periode}`,
    html: aanvraagMailInfo(rij),
    tekst: `Website-aanvraag van ${a.naam} (${a.email}) voor ${periode}, ${a.personen} personen.`,
    antwoordAan: a.email,
    soort: 'website-aanvraag',
  }, inst);

  try {
    await mail({
      naar: a.email,
      onderwerp: 'Je aanvraag voor De Broekhof',
      html: aanvraagMailAanvrager(rij),
      tekst: `Dank je wel voor je aanvraag voor De Broekhof van ${nl(a.aankomst)} tot ${nl(a.vertrek)}. ` +
             'We laten je zo snel mogelijk weten of het lukt. Dit is nog geen bevestiging.',
      soort: 'website-ontvangst',
    }, inst);
  } catch (e) {
    console.error('[website] ontvangstbevestiging mislukt:', e.message);   // aanvraag staat wel opgeslagen
  }

  return { status: 'ok', message: 'Bedankt! We hebben je aanvraag ontvangen en reageren zo snel mogelijk.' };
}

// ── iCal-export voor Micazu ──────────────────────────────────────────
function gelijkGeheim(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

async function icalExport(req) {
  const token = new URL(req.url).searchParams.get('token') || '';
  if (!env('ICAL_EXPORT_TOKEN') || !gelijkGeheim(token, env('ICAL_EXPORT_TOKEN'))) {
    return new Response('Geen toegang', { status: 403 });
  }
  const vanaf = plusDagen(vandaag(), -30);
  const [rijen, mic] = await Promise.all([beheerBoekingen(vanaf), micazuPeriodes()]);
  // Alleen boekingen die niet uit Micazu komen én niet al in de Micazu-agenda staan,
  // anders komen Micazu-boekingen dubbel terug in Micazu.
  const eigen = voegSamen(rijen
    .filter(b => !String(b.bron || '').startsWith('micazu'))
    .map(b => ({ van: b.aankomst, tot: b.vertrek }))
    .filter(p => !overlapt(p.van, p.tot, mic.periodes)));

  const stempel = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const r = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//De Broekhof//Beheer//NL',
             'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:De Broekhof - eigen boekingen'];
  for (const p of eigen) {
    const van = p.van.replace(/-/g, ''), tot = p.tot.replace(/-/g, '');
    r.push('BEGIN:VEVENT', `UID:broekhof-${van}-${tot}@debroekhof.nl`, `DTSTAMP:${stempel}`,
           `DTSTART;VALUE=DATE:${van}`, `DTEND;VALUE=DATE:${tot}`, 'SUMMARY:Bezet', 'TRANSP:OPAQUE', 'END:VEVENT');
  }
  r.push('END:VCALENDAR');
  return new Response(r.join('\r\n') + '\r\n', {
    headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'no-cache' },
  });
}

// ── Ingang ───────────────────────────────────────────────────────────
export default async (req, context) => {
  const pad = new URL(req.url).pathname;
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsKoppen(req) });

  try {
    if (pad.endsWith('/beschikbaarheid')) {
      if (req.method !== 'GET') return json(req, { status: 'error', message: 'Alleen GET' }, 405);
      return json(req, { status: 'ok', ...(await bezetting()) }, 200, { 'Cache-Control': 'public, max-age=300' });
    }
    if (pad.endsWith('/aanvraag')) {
      if (req.method !== 'POST') return json(req, { status: 'error', message: 'Alleen POST' }, 405);
      return json(req, await aanvraag(req, context));
    }
    if (pad.endsWith('/ical')) return await icalExport(req);
    return json(req, { status: 'error', message: 'Onbekend adres' }, 404);
  } catch (e) {
    if (e instanceof Fout) return json(req, { status: 'error', message: e.message, ...e.extra }, e.status);
    console.error('[website]', e);
    return json(req, { status: 'error', message: 'Er ging iets mis. Mail je aanvraag naar info@debroekhof.nl.' }, 500);
  }
};

export const config = { path: ['/api/beschikbaarheid', '/api/aanvraag', '/api/ical'] };
