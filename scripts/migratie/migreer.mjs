#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════
// Eenmalige migratie: Google Sheet "Boekingen de Broekhof (app versie)" → Supabase
//
// 1. Download in Google Sheets beide tabbladen als CSV
//    (Bestand → Downloaden → Door komma's gescheiden waarden):
//      scripts/migratie/data/boekingen.csv   ← tabblad "Formulierreacties 1"
//      scripts/migratie/data/financieel.csv  ← tabblad "Financieel status"
//    (de map data/ staat in .gitignore: er komen geen persoonsgegevens in Git)
//
// 2. Proefdraai, schrijft alleen een rapport:
//      node scripts/migratie/migreer.mjs
//
// 3. Echt overzetten (met SUPABASE_URL en SUPABASE_SERVICE_ROLE_KEY in de omgeving):
//      node scripts/migratie/migreer.mjs --uitvoeren
//    Al gemigreerde boekingen eerst weghalen en opnieuw beginnen:
//      node scripts/migratie/migreer.mjs --uitvoeren --opnieuw
//
// Zonder sleutels: --sql schrijft data/overzetten.sql om in de Supabase SQL Editor te plakken.
// Rijen kun je overslaan met --sla-over=5,12 (rijnummers uit het rapport).
// ═══════════════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const MAP = join(dirname(fileURLToPath(import.meta.url)), 'data');
const args = process.argv.slice(2);
const UITVOEREN = args.includes('--uitvoeren');
const OPNIEUW = args.includes('--opnieuw');
const SLA_OVER = new Set((args.find(a => a.startsWith('--sla-over=')) || '=').split('=')[1].split(',').filter(Boolean).map(Number));

// ── CSV ──────────────────────────────────────────────────────────────
function leesCsv(pad) {
  const t = readFileSync(pad, 'utf8').replace(/^﻿/, '');
  const rijen = [];
  let rij = [], veld = '', inQuote = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inQuote) {
      if (c === '"' && t[i + 1] === '"') { veld += '"'; i++; }
      else if (c === '"') inQuote = false;
      else veld += c;
    } else if (c === '"') inQuote = true;
    else if (c === ',') { rij.push(veld); veld = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && t[i + 1] === '\n') i++;
      rij.push(veld); rijen.push(rij); rij = []; veld = '';
    } else veld += c;
  }
  if (veld || rij.length) { rij.push(veld); rijen.push(rij); }
  const kop = rijen.shift().map(h => h.trim().toLowerCase());
  return { kop, rijen };
}

// ── Omzetten ─────────────────────────────────────────────────────────
const MAANDEN_EN = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

// "6-12-2025", "06-12-2025 22:23:43", "2026-03-05", "Thu May 14 2026 00:00:00 GMT+0200 (…)"
function datum(v) {
  const s = String(v || '').trim();
  let m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
  if (m) return geldig(+m[3], +m[2], +m[1]);
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return geldig(+m[1], +m[2], +m[3]);
  m = s.match(/^[A-Za-z]{3} ([A-Za-z]{3}) (\d{1,2}) (\d{4})/);
  if (m && MAANDEN_EN[m[1].toLowerCase()]) return geldig(+m[3], MAANDEN_EN[m[1].toLowerCase()], +m[2]);
  return null;
}

function geldig(y, mo, d) {
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

function getal(v) {
  let t = String(v ?? '').replace(/[€\s]/g, '');
  if (!t || t === '-') return 0;
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : 0;
}

const geheel = v => Math.max(0, parseInt(v, 10) || 0);
const tekst = v => { const s = String(v ?? '').trim(); return s && s !== '-' ? s : null; };
const tijd = v => { const m = String(v || '').match(/(\d{1,2}):(\d{2})/); return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null; };
const driveId = v => { const m = String(v || '').match(/\/d\/([A-Za-z0-9_-]{20,})/); return m ? m[1] : null; };

// ── Inlezen ──────────────────────────────────────────────────────────
const bBestand = join(MAP, 'boekingen.csv');
const fBestand = join(MAP, 'financieel.csv');
if (!existsSync(bBestand)) {
  console.error(`Bestand ontbreekt: ${bBestand}\nZie de uitleg bovenin dit script.`);
  process.exit(1);
}

const { kop, rijen } = leesCsv(bBestand);
const kol = namen => {
  for (const n of [].concat(namen)) { const i = kop.indexOf(n); if (i >= 0) return i; }
  return -1;
};
const K = {
  tijdstempel: kol('tijdstempel'), aankomst: kol('datum start'), vertrek: kol('datum eind'),
  aanhef: kol('aanhef'), voornaam: kol('voornaam'), achternaam: kol('achternaam'),
  personen: kol('aantal personen'), huisdieren: kol('aantal huisdieren'),
  bedlinnen: kol('aantal bedlinnen'), keukenlinnen: kol('aantal keukenlinnen'),
  huurprijs: kol("huurprijs excl. schoonmaak en extra's"), schoonmaak: kol('prijs schoonmaak'),
  extras: kol("prijs extra's"), totaal: kol('totale huursom'), aanbetaling: kol('aanbetaling huursom'),
  restant: kol('restant betaling huursom'), borg: kol('borg'), telefoon: kol('telefoonnummer'),
  adres: kol('adres'), postcode: kol('postcode'), plaats: kol('plaats'), land: kol('land'),
  email: kol('e-mail'), code: kol(['toegangscode', 'code', 'pincode']),
  checkin: kol('tijdstip check in'), checkout: kol('tijdstip check out'),
  pdf: kol('[form publisher] pdf url'), mailHuurder: kol('mail huurder'), bron: kol('bron'),
};
for (const [k, i] of Object.entries(K)) {
  if (i < 0 && !['pdf', 'mailHuurder', 'bron', 'code'].includes(k)) {
    console.error(`Kolom niet gevonden voor "${k}". Is dit de export van "Formulierreacties 1"?`);
    process.exit(1);
  }
}

const g = (r, k) => (K[k] >= 0 ? r[K[k]] ?? '' : '');
const boekingen = [];
const meldingen = [];

rijen.forEach((r, i) => {
  const rijnr = i + 2; // rijnummer zoals in de Sheet (rij 1 = koppen)
  if (r.every(c => !String(c).trim())) return;
  const m = [];
  const aankomst = datum(g(r, 'aankomst'));
  const vertrek = datum(g(r, 'vertrek'));
  const achternaam = tekst(g(r, 'achternaam'));
  if (!aankomst || !vertrek || !achternaam) {
    meldingen.push({ rijnr, naam: achternaam || '?', ernst: 'OVERGESLAGEN', tekst: 'aankomst, vertrek of achternaam ontbreekt of is onleesbaar' });
    return;
  }
  if (vertrek <= aankomst) m.push('vertrek ligt niet na aankomst');

  const code = String(g(r, 'code')).trim();
  const geldigeCode = /^\d{6}$/.test(code) ? code : null;
  if (code && !geldigeCode) m.push(`toegangscode "${code}" is geen 6-cijferige code, wordt leeg`);

  const aanhef = String(g(r, 'aanhef')).trim().toLowerCase();
  const b = {
    legacy_rijnr: rijnr,
    boekingsdatum: datum(g(r, 'tijdstempel')) || aankomst,
    aankomst, vertrek,
    checkin: tijd(g(r, 'checkin')) || '16:00',
    checkout: tijd(g(r, 'checkout')) || '10:00',
    aanhef: aanhef === 'heer' || aanhef === 'mevrouw' ? aanhef : null,
    voornaam: tekst(g(r, 'voornaam')) || '',
    achternaam,
    telefoon: tekst(g(r, 'telefoon')), email: tekst(g(r, 'email')),
    adres: tekst(g(r, 'adres')), postcode: tekst(g(r, 'postcode')),
    plaats: tekst(g(r, 'plaats')), land: tekst(g(r, 'land')) || 'Nederland',
    personen: geheel(g(r, 'personen')), huisdieren: geheel(g(r, 'huisdieren')),
    bedlinnen: geheel(g(r, 'bedlinnen')), keukenlinnen: geheel(g(r, 'keukenlinnen')),
    huurprijs: getal(g(r, 'huurprijs')), schoonmaak: getal(g(r, 'schoonmaak')),
    extras: getal(g(r, 'extras')), totaal: getal(g(r, 'totaal')),
    aanbetaling: getal(g(r, 'aanbetaling')), restant: getal(g(r, 'restant')), borg: getal(g(r, 'borg')),
    toegangscode: geldigeCode,
    mail_huurder: /^(ja|true|1)$/i.test(String(g(r, 'mailHuurder')).trim()),
    bron: /micazu/i.test(g(r, 'bron')) ? (/aanvullen/i.test(g(r, 'bron')) ? 'micazu-aanvullen' : 'micazu') : 'migratie',
  };
  if (!b.totaal) m.push('totale huursom is leeg of 0');
  if (b.totaal > 0 && b.totaal < 10) m.push(`totale huursom is € ${b.totaal}: testboeking?`);
  if (Math.abs(b.aanbetaling + b.restant - b.borg - b.totaal) > 1 && b.totaal) {
    m.push(`aanbetaling + restant (${b.aanbetaling + b.restant}) wijkt af van totaal + borg (${b.totaal + b.borg})`);
  }
  if (!b.email) m.push('geen e-mailadres');

  const pdfId = driveId(g(r, 'pdf'));
  b._pdf = pdfId;
  b._pdfNaam = `${aankomst} Huurovereenkomst ${achternaam}.pdf`;
  if (!pdfId && String(g(r, 'pdf')).trim()) m.push('PDF staat alleen als naam in de Sheet, geen link: niet gekoppeld');

  boekingen.push(b);
  m.forEach(t => meldingen.push({ rijnr, naam: `${b.voornaam} ${achternaam}`.trim(), ernst: 'let op', tekst: t }));
});

// Dubbele boekingen (zelfde aankomst + achternaam)
const gezien = new Map();
for (const b of boekingen) {
  const sleutel = `${b.aankomst}|${b.achternaam.toLowerCase()}`;
  if (gezien.has(sleutel)) {
    meldingen.push({ rijnr: b.legacy_rijnr, naam: b.achternaam, ernst: 'let op', tekst: `zelfde aankomst en naam als rij ${gezien.get(sleutel)}: dubbel?` });
  } else gezien.set(sleutel, b.legacy_rijnr);
}

// ── Financieel status ────────────────────────────────────────────────
const SOORT = { aanbetaling: 'aanbetaling', restant: 'restant', borg: 'borg_terug' };
const betaalStatus = [];
if (existsSync(fBestand)) {
  const fin = leesCsv(fBestand);
  const fk = n => fin.kop.indexOf(n);
  const [iId, iBet, iNot, iDat, iVerw] = ['id', 'betaald', 'notitie', 'datum', 'verwijderd'].map(fk);
  for (const r of fin.rijen) {
    const id = String(r[iId] || '').trim();
    const m = id.match(/^(\d+)-(aanbetaling|restant|borg)$/);
    if (!m) continue;
    const rijnr = +m[1];
    const b = boekingen.find(x => x.legacy_rijnr === rijnr);
    if (!b) {
      meldingen.push({ rijnr, naam: '?', ernst: 'let op', tekst: `betaalstatus "${id}" hoort bij een rij die niet (meer) bestaat: niet overgenomen` });
      continue;
    }
    betaalStatus.push({
      id, rijnr, soort: SOORT[m[2]], naam: `${b.voornaam} ${b.achternaam}`.trim(), aankomst: b.aankomst,
      betaald: /^(ja|true)$/i.test(String(r[iBet] || '').trim()),
      notitie: tekst(r[iNot]),
      datum: datum(r[iDat]),
      verborgen: /^ja$/i.test(String(r[iVerw] || '').trim()),
    });
  }
} else {
  meldingen.push({ rijnr: '-', naam: '-', ernst: 'let op', tekst: 'financieel.csv niet gevonden: betaalstatus wordt niet overgenomen' });
}

// ── Rapport ──────────────────────────────────────────────────────────
const nl = iso => (iso ? iso.split('-').reverse().join('-') : '');
const euro = n => '€ ' + Math.round(n).toLocaleString('nl-NL');
const perJaar = {};
for (const b of boekingen.filter(b => !SLA_OVER.has(b.legacy_rijnr))) {
  const j = b.aankomst.slice(0, 4);
  perJaar[j] = (perJaar[j] || 0) + b.totaal;
}

let rapport = `# Migratierapport De Broekhof\n\n`;
rapport += `Gemaakt: ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC · ${UITVOEREN ? 'UITGEVOERD' : 'proefdraai, er is niets overgezet'}\n\n`;
rapport += `- Boekingen gelezen: ${boekingen.length}${SLA_OVER.size ? ` (waarvan ${SLA_OVER.size} overgeslagen met --sla-over)` : ''}\n`;
rapport += `- Betaalstatusregels gekoppeld: ${betaalStatus.length}\n`;
rapport += `- Totale huursom per aankomstjaar: ${Object.entries(perJaar).sort().map(([j, t]) => `${j}: ${euro(t)}`).join(' · ')}\n\n`;

rapport += `## Controleer de koppeling van betalingen\n\n`;
rapport += `In de Sheet hangt de betaalstatus aan een rijnummer. Is er ooit een rij verwijderd, dan kan een vinkje nu bij een andere boeking staan. Controleer of naam en aankomst kloppen.\n\n`;
rapport += `| Sheet-ID | Boeking | Aankomst | Betaald | Verborgen | Datum | Notitie |\n| --- | --- | --- | --- | --- | --- | --- |\n`;
for (const s of betaalStatus) {
  rapport += `| ${s.id} | ${s.naam} | ${nl(s.aankomst)} | ${s.betaald ? 'ja' : ''} | ${s.verborgen ? 'ja' : ''} | ${nl(s.datum)} | ${s.notitie || ''} |\n`;
}

rapport += `\n## Meldingen\n\n`;
if (!meldingen.length) rapport += 'Geen.\n';
else {
  rapport += `| Rij | Boeking | Soort | Melding |\n| --- | --- | --- | --- |\n`;
  for (const m of meldingen) rapport += `| ${m.rijnr} | ${m.naam} | ${m.ernst} | ${m.tekst} |\n`;
}

rapport += `\n## Boekingen\n\n| Rij | Aankomst | Vertrek | Naam | Totaal | Aanbet. | Restant | Code | PDF |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n`;
for (const b of [...boekingen].sort((a, c) => a.aankomst.localeCompare(c.aankomst))) {
  const over = SLA_OVER.has(b.legacy_rijnr) ? ' (overgeslagen)' : '';
  rapport += `| ${b.legacy_rijnr} | ${nl(b.aankomst)} | ${nl(b.vertrek)} | ${b.voornaam} ${b.achternaam}${over} | ${euro(b.totaal)} | ${euro(b.aanbetaling)} | ${euro(b.restant)} | ${b.toegangscode || '-'} | ${b._pdf ? 'link' : '-'} |\n`;
}

const rapportPad = join(MAP, 'rapport.md');
writeFileSync(rapportPad, rapport);
console.log(`Rapport geschreven: ${rapportPad}`);
console.log(`${boekingen.length} boekingen, ${betaalStatus.length} betaalregels, ${meldingen.length} meldingen.`);

// ── SQL-bestand (alternatief voor --uitvoeren: plakken in de Supabase SQL Editor) ──
if (args.includes('--sql')) {
  const lit = v => (v === null || v === undefined ? 'null'
    : typeof v === 'number' ? String(v)
    : typeof v === 'boolean' ? String(v)
    : `'${String(v).replace(/'/g, "''")}'`);
  let sql = `-- Overzetten van ${boekingen.length - SLA_OVER.size} boekingen uit de Google Sheet.\n`;
  sql += `-- Gemaakt met scripts/migratie/migreer.mjs --sql. Plak dit in de Supabase SQL Editor en klik Run.\n`;
  sql += `-- Draai je het nog eens, dan worden eerder overgezette boekingen eerst vervangen.\n\nbegin;\n\n`;
  sql += `delete from public.boekingen where legacy_rijnr is not null;\n\n`;
  for (const b of boekingen) {
    if (SLA_OVER.has(b.legacy_rijnr) || b.vertrek <= b.aankomst) continue;
    const { _pdf, _pdfNaam, ...record } = b;
    const kol = Object.keys(record);
    sql += `insert into public.boekingen (${kol.join(', ')})\nvalues (${kol.map(k => lit(record[k])).join(', ')});\n`;
    if (_pdf) {
      sql += `insert into public.documenten (boeking_id, bestandsnaam, drive_file_id)\n`
        + `select id, ${lit(_pdfNaam)}, ${lit(_pdf)} from public.boekingen where legacy_rijnr = ${b.legacy_rijnr};\n`;
    }
    sql += '\n';
  }
  sql += `-- Betaalstatus uit "Financieel status" (de betaalregels zelf maakt de database aan)\n`;
  for (const s of betaalStatus) {
    if (SLA_OVER.has(s.rijnr)) continue;
    const d = s.datum ? `date ${lit(s.datum)}` : 'null';
    sql += `update public.betalingen p set betaald = ${s.betaald}, notitie = ${lit(s.notitie)}, verborgen = ${s.verborgen},\n`
      + `  vervaldatum = coalesce(${d}, p.vervaldatum), vervaldatum_handmatig = coalesce(${d} <> p.vervaldatum, false)\n`
      + `from public.boekingen b where p.boeking_id = b.id and b.legacy_rijnr = ${s.rijnr} and p.soort = '${s.soort}';\n`;
  }
  sql += `\ncommit;\n\n-- Controle\nselect count(*) as boekingen from public.boekingen where legacy_rijnr is not null;\n`
    + `select count(*) as betaald from public.betalingen where betaald;\n`;
  const sqlPad = join(MAP, 'overzetten.sql');
  writeFileSync(sqlPad, sql);
  console.log(`SQL geschreven: ${sqlPad}`);
}

if (!UITVOEREN) {
  console.log('Proefdraai: er is niets overgezet. Gebruik --uitvoeren om echt over te zetten.');
  process.exit(0);
}

// ── Overzetten ───────────────────────────────────────────────────────
const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_ || !KEY) { console.error('SUPABASE_URL en SUPABASE_SERVICE_ROLE_KEY zijn nodig.'); process.exit(1); }

async function db(pad, { method = 'GET', body, prefer } = {}) {
  const res = await fetch(`${URL_}/rest/v1/${pad}`, {
    method,
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', ...(prefer ? { Prefer: prefer } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const t = await res.text();
  if (!res.ok) throw new Error(`${method} ${pad}: ${res.status} ${t.slice(0, 300)}`);
  return t ? JSON.parse(t) : null;
}

const bestaand = await db('boekingen?legacy_rijnr=not.is.null&select=id');
if (bestaand.length && !OPNIEUW) {
  console.error(`Er staan al ${bestaand.length} gemigreerde boekingen in de database. Gebruik --opnieuw om ze te vervangen.`);
  process.exit(1);
}
if (bestaand.length) {
  await db('boekingen?legacy_rijnr=not.is.null', { method: 'DELETE' });
  console.log(`${bestaand.length} eerder gemigreerde boekingen verwijderd.`);
}

const idVanRij = new Map();
for (const b of boekingen) {
  if (SLA_OVER.has(b.legacy_rijnr)) continue;
  const { _pdf, _pdfNaam, ...record } = b;
  if (record.vertrek <= record.aankomst) { console.warn(`Rij ${b.legacy_rijnr} overgeslagen: vertrek niet na aankomst`); continue; }
  const [rij] = await db('boekingen', { method: 'POST', body: record, prefer: 'return=representation' });
  idVanRij.set(b.legacy_rijnr, rij.id);
  if (_pdf) await db('documenten', { method: 'POST', body: { boeking_id: rij.id, bestandsnaam: _pdfNaam, drive_file_id: _pdf } });
}
console.log(`${idVanRij.size} boekingen overgezet (betaalregels maakt de database zelf aan).`);

let n = 0;
for (const s of betaalStatus) {
  const id = idVanRij.get(s.rijnr);
  if (!id) continue;
  const [regel] = await db(`betalingen?boeking_id=eq.${id}&soort=eq.${s.soort}&select=vervaldatum`);
  if (!regel) { console.warn(`Geen betaalregel ${s.id} (${s.naam}): bedrag is 0, status niet overgenomen`); continue; }
  const wijziging = { betaald: s.betaald, notitie: s.notitie, verborgen: s.verborgen };
  if (s.datum && s.datum !== regel.vervaldatum) { wijziging.vervaldatum = s.datum; wijziging.vervaldatum_handmatig = true; }
  await db(`betalingen?boeking_id=eq.${id}&soort=eq.${s.soort}`, { method: 'PATCH', body: wijziging });
  n++;
}
console.log(`${n} betaalstatussen overgenomen. Klaar.`);
