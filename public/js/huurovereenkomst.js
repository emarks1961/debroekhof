// ═══════════════════════════════════════════════════════════════════════
// huurovereenkomst.js — reserveringsbevestiging + huurovereenkomst als PDF
//
// Vervangt het Google Doc-sjabloon "reserveringsbevestiging en
// huurovereenkomst (app-versie)" en volgt de opmaak daarvan: briefhoofd met
// bedrijfsgegevens en logo, voettekst met documentnaam en paginanummer.
// Namen, telefoonnummers, rekeningnummer, KvK-nummer en (optioneel) de
// handtekening komen uit de tabel instellingen. Gebruikt jsPDF.
//
//   const blob = await maakHuurovereenkomstPdf(placeholders, instellingen, documentnaam);
// ═══════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  const ZWART = [0, 0, 0];
  const LINK = [17, 85, 204];
  const LOGO_URL = 'img/logo-huurovereenkomst.jpg';

  // Afmetingen in mm, overgenomen van het Google Doc (A4)
  const L = 25.4, R = 184.6, B = R - L;     // tekstmarges
  const KOP_L = 34, KOP_R = 182.6;           // briefhoofd
  const LIJN_L = 26, LIJN_R = 186;
  const PT = 9.5;                            // tekstgrootte
  const REGEL = 4.0;                         // regelafstand bij 9,5 pt

  function bedrag(v) {
    const n = parseFloat(String(v ?? '').replace('€', '').replace(',', '.').trim());
    if (!Number.isFinite(n)) return String(v ?? '');
    return n % 1 === 0 ? String(Math.round(n)) : n.toFixed(2).replace('.', ',');
  }
  // "€ 453,--" bij hele euro's, anders "€ 453,60"
  function euro(v) {
    const b = bedrag(v);
    return /,/.test(b) ? `€ ${b}` : `€ ${b},--`;
  }
  const getal = v => { const n = parseFloat(String(v ?? '').replace('€', '').replace(',', '.').trim()); return Number.isFinite(n) ? n : 0; };

  // Afbeelding ophalen als data-URL (één keer per sessie)
  const cache = {};
  function afbeelding(url) {
    if (!url) return Promise.resolve(null);
    if (/^data:image\//.test(url)) return Promise.resolve(url);
    if (!cache[url]) {
      cache[url] = fetch(url).then(r => (r.ok ? r.blob() : null)).then(b => b && new Promise(ok => {
        const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.onerror = () => ok(null); fr.readAsDataURL(b);
      })).catch(() => null);
    }
    return cache[url];
  }
  const soort = data => (/^data:image\/png/.test(data) ? 'PNG' : 'JPEG');

  window.maakHuurovereenkomstPdf = async function (p, inst, documentnaam) {
    inst = inst || {};
    const v = k => String(p[k] ?? '').trim();
    const ontvangstNaam = inst.ontvangst_naam || 'de sleutelbeheerder';
    // Midden in een zin "mevrouw Steenvoort", aan het begin "Mevrouw Steenvoort"
    const ontvangst = ontvangstNaam.replace(/^(Mevrouw|Meneer|De heer|De)\b/, m => m.toLowerCase());
    const Ontvangst = ontvangst.charAt(0).toUpperCase() + ontvangst.slice(1);
    const ontvangstTel = inst.ontvangst_telefoon || '';
    const ondertekening = inst.ondertekening || '';
    const telefoon = inst.telefoon || '';
    const email = inst.email_info || 'info@debroekhof.nl';
    const iban = inst.iban || '';
    const tnv = inst.iban_tnv || '';
    const bedrijf = inst.bedrijfsnaam || tnv.replace(/ te .*$/, '');
    const kvk = inst.kvk || '';
    const schoonmaak = bedrag(v('Prijs schoonmaak'));
    const naamDocument = documentnaam || `${v('Datum start')} Huurovereenkomst ${v('Achternaam')}`;

    const [logo, handtekening] = await Promise.all([afbeelding(LOGO_URL), afbeelding(inst.handtekening)]);

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    let y = 0;

    function lettertype(vet, grootte = PT, kleur = ZWART) {
      doc.setFont('helvetica', vet ? 'bold' : 'normal');
      doc.setFontSize(grootte);
      doc.setTextColor(...kleur);
    }

    // ── Briefhoofd en voettekst (op elke pagina gelijk) ──────────────
    function briefhoofd() {
      lettertype(true, 7.5);
      if (bedrijf) doc.text(bedrijf.toUpperCase(), KOP_L, 14.6);
      doc.text('LANDGOEDBEHEER', KOP_R, 14.6, { align: 'right' });
      doc.setDrawColor(0); doc.setLineWidth(0.3);
      doc.line(LIJN_L, 19, LIJN_R, 19);
      doc.line(LIJN_L, 49.8, LIJN_R, 49.8);
      lettertype(false, 7.5);
      const regels = [
        'Vakantiewoning “de Broekhof”',
        'Landweg 10, 7382 BL, Klarenbeek (NL)',
        iban ? `Bankrekening: ${iban}` : '',
        kvk ? `KvK nummer: ${kvk}` : '',
      ].filter(Boolean);
      regels.forEach((t, i) => doc.text(t, KOP_L, 25.4 + i * 6.1));
      if (logo) doc.addImage(logo, soort(logo), 143.5, 22, 39.5, 26.3);
    }
    function voettekst(nr) {
      lettertype(false, 7.5);
      doc.text(`Document: ${naamDocument}`, 30.5, 287);
      doc.text(`Pagina ${nr}`, 178, 287, { align: 'right' });
    }
    function nieuwePagina() {
      if (doc.getNumberOfPages() > 1 || y) doc.addPage();
      briefhoofd();
      y = 62;
    }
    function titel(t) {
      lettertype(true, 12.5);
      doc.text(t, 105, y, { align: 'center' });
      const w = doc.getTextWidth(t);
      doc.setLineWidth(0.35); doc.line(105 - w / 2, y + 0.9, 105 + w / 2, y + 0.9);
    }
    function ruimte(nodig) {
      if (y + nodig > 280) { nieuwePagina(); y = 60; }
    }

    // Lopende tekst; opt.uitvullen = uitgevuld zoals in het origineel
    function alinea(t, opt = {}) {
      lettertype(opt.vet);
      const breedte = opt.breedte || B, x = opt.x || L;
      const regels = doc.splitTextToSize(t, breedte);
      ruimte(regels.length * REGEL);
      regels.forEach((r, i) => {
        const woorden = r.trim().split(/\s+/);
        if (opt.uitvullen && i < regels.length - 1 && woorden.length > 1) {
          // Uitvullen: de ruimte tussen de woorden verdelen tot de volle breedte
          const tussen = (breedte - woorden.reduce((t, w) => t + doc.getTextWidth(w), 0)) / (woorden.length - 1);
          let xx = x;
          for (const w of woorden) { doc.text(w, xx, y); xx += doc.getTextWidth(w) + tussen; }
        } else {
          doc.text(r, x, y);
        }
        y += REGEL;
      });
      y += opt.na ?? REGEL;
    }

    // Tekst met vetgedrukte stukken: delen = ['gewoon', ['vet'], 'gewoon', ...]
    function rijkeTekst(delen, x, breedte) {
      const woorden = [];
      for (const d of delen) {
        const vet = Array.isArray(d);
        String(vet ? d[0] : d).split(/(\s+)/).filter(s => s !== '').forEach(w => woorden.push({ w, vet }));
      }
      const regels = [[]]; let bezet = 0;
      for (const wd of woorden) {
        lettertype(wd.vet);
        const bw = doc.getTextWidth(wd.w);
        if (/^\s+$/.test(wd.w)) { if (regels.at(-1).length) { regels.at(-1).push({ ...wd, bw }); bezet += bw; } continue; }
        if (bezet + bw > breedte && regels.at(-1).length) {
          while (regels.at(-1).length && /^\s+$/.test(regels.at(-1).at(-1).w)) regels.at(-1).pop();
          regels.push([]); bezet = 0;
        }
        regels.at(-1).push({ ...wd, bw }); bezet += bw;
      }
      ruimte(regels.length * REGEL);
      for (const r of regels) {
        let xx = x;
        for (const wd of r) { lettertype(wd.vet); doc.text(wd.w, xx, y); xx += wd.bw; }
        y += REGEL;
      }
    }

    // ── Pagina 1: reserveringsbevestiging ────────────────────────────
    nieuwePagina();
    y = 65.7;
    titel('RESERVERINGSBEVESTIGING');
    y = 84;
    lettertype(false);
    doc.text(`Klarenbeek, ${v('Today')}`, KOP_R, y, { align: 'right' });
    y = 97.5;
    alinea(`Geachte ${v('Aanhef')} ${v('Achternaam')}, beste ${v('Voornaam')},`);
    alinea('Hierbij doe ik u de nadere bevestiging van de reservering van de vakantiewoning de Broekhof toekomen.', { uitvullen: true });
    alinea(`Check-in: ${Ontvangst} zal u ontvangen en nader wegwijs maken in de woning. Het afgesproken tijdstip voor de check-in is ${v('Tijdstip check in')} uur. Indien u op een afwijkende tijd arriveert laat dit dan s.v.p. aan haar weten.${ontvangstTel ? ` U kunt haar telefonisch bereiken op ${ontvangstTel}.` : ''}`, { uitvullen: true });
    alinea('Gedurende uw verblijf heeft u de beschikking over de sleutels van beide zijdeuren. Tevens krijgt u toegang tot de voordeur middels een persoonlijke code. Deze code wordt u voorafgaand aan het verblijf toegezonden. Verdere informatie over het huis en de omgeving treft u aan in de informatiemap.', { uitvullen: true });
    alinea(`Check-out: Op de dag van vertrek uiterlijk om ${v('Tijdstip check out')} uur met inachtneming van de instructies. Sleutels dient u achter te laten op het sleutelrekje bij de zijdeur. U kunt het pand verlaten door de voordeur achter u dicht te trekken.`, { uitvullen: true });
    alinea('Het is gebruikelijk dat direct na de reservering een aanbetaling van 25% van de huursom wordt gedaan en de rest 4 weken voor het begin van de huurperiode. Betaling van schoonmaakkosten graag contant bij aankomst. Details hierover vindt u in de bijgevoegde huurovereenkomst.', { uitvullen: true });
    alinea('Ik denk dat alles zo goed geregeld is en ik hoop dat u een hele prettige tijd in de Broekhof zal doorbrengen.', { na: REGEL * 3 });
    alinea('Met vriendelijke groeten,');
    if (bedrijf) alinea(`Namens ${bedrijf},`, { na: 0 });
    if (handtekening) {
      try { doc.addImage(handtekening, soort(handtekening), 29, y + 1, 65, 14.2); } catch (e) { /* ongeldige afbeelding: overslaan */ }
    }
    y += 19;
    if (ondertekening) alinea(ondertekening, { na: 0 });
    alinea('Vakantiewoning “De Broekhof”');
    if (telefoon) alinea(`Telefoon: ${telefoon}`, { na: 0 });
    alinea(`Email: ${email}`, { na: 0 });
    lettertype(false);
    doc.text('Website: ', L, y);
    const xl = L + doc.getTextWidth('Website: ');
    lettertype(false, PT, LINK);
    doc.textWithLink('www.debroekhof.nl', xl, y, { url: 'https://www.debroekhof.nl' });
    doc.setDrawColor(...LINK); doc.setLineWidth(0.2);
    doc.line(xl, y + 0.7, xl + doc.getTextWidth('www.debroekhof.nl'), y + 0.7);

    // ── Pagina 2: huurovereenkomst ───────────────────────────────────
    nieuwePagina();
    y = 61;
    titel('HUUROVEREENKOMST');
    y = 79;

    const KOL_KOP = 28, KOL_SUB = 30.5, KOL_WAARDE = 72, BW = R - KOL_WAARDE;
    // Rij in de tabel: kop (vet) of subkop (ingesprongen), met waarde-regels
    function rij(kop, waarden = [], opt = {}) {
      lettertype(false);
      const regels = waarden.flatMap(w => (w === '' ? [''] : doc.splitTextToSize(w, BW)));
      ruimte(Math.max(1, regels.length) * REGEL);
      lettertype(!opt.sub);
      doc.text(kop, opt.sub ? KOL_SUB : KOL_KOP, y);
      lettertype(!!opt.vet);
      regels.forEach((r, i) => doc.text(r, KOL_WAARDE, y + i * REGEL));
      y += Math.max(1, regels.length) * REGEL + (opt.na ?? REGEL * 0.9);
    }

    const adresregel = [v('Postcode'), v('Plaats')].filter(Boolean).join('  ') + (v('Land') ? `  (${v('Land')})` : '');
    rij('Huurder', [`${v('Voornaam')} ${v('Achternaam')}`], { vet: true, na: REGEL * 0.4 });
    if (v('Adres') || adresregel.trim()) rij('Adres', [v('Adres'), adresregel].filter(s => s.trim()), { sub: true, na: 0 });
    if (v('Telefoonnummer')) rij('Telefoonnummer', [v('Telefoonnummer')], { sub: true, na: 0 });
    if (v('E-mail')) rij('E-mailadres', [v('E-mail')], { sub: true, na: 0 });
    y += REGEL * 0.9;
    rij('Periode', [], { na: 0 });
    rij('Aankomst', [`${v('Datum start')}, ${v('Tijdstip check in')} uur`], { sub: true, na: 0 });
    rij('Vertrek', [`${v('Datum eind')}, ${v('Tijdstip check out')} uur`], { sub: true });
    rij('Gebruik', [`${v('Aantal personen')} personen`, `${v('Aantal huisdieren') || '0'} huisdier(en)`]);

    const huur = v("Huurprijs excl. schoonmaak en extra's");
    const korting = getal(v('Last-minute korting'));
    rij('Huurprijs', korting > 0
      ? [`Bruto huurprijs ${euro(v('Bruto huurprijs'))}`, `Last-minute korting: - ${euro(korting)}`, `Huurprijs ${euro(huur)}`, 'Vooruitbetaling 25% (zie Betaling)']
      : [euro(huur), 'Vooruitbetaling 25% (zie Betaling)']);

    const bed = getal(v('Aantal bedlinnen')), keuken = getal(v('Aantal keukenlinnen'));
    const overig = v("Overige extra's"), overigPrijs = getal(v("Prijs overige extra's"));
    const extraRegels = [
      bed ? `Bedlinnen: ${bed} × € 10,--` : '',
      keuken ? `Keukenlinnen: ${keuken} × € 7,--` : '',
      overig || overigPrijs ? `${overig || 'Overige extra\'s'}: ${euro(overigPrijs)}` : '',
    ].filter(Boolean);
    if (getal(v("Prijs extra's")) > 0 || extraRegels.length) {
      rij("Extra's", [euro(v("Prijs extra's")), ...extraRegels, 'Vooruitbetaling samen met de huurprijs']);
    }
    const borg = getal(v('Borg'));
    if (borg > 0) rij('Borg', [euro(borg), 'De borg wordt opgeteld bij de aanbetaling en zal direct na de huurperiode worden teruggestort.']);
    rij('Schoonmaak', [euro(schoonmaak), 'Roken in het huis is niet toegestaan. Bij vertrek dient u de woning opgeruimd en bezemschoon achter te laten, zonder sporen van eventuele huisdieren.']);

    // Betaling en Sleutels: kop met doorlopende tekst eronder, belangrijke delen vet
    function blok(kop, alineas) {
      ruimte(REGEL * 3);
      lettertype(true); doc.text(kop, KOL_KOP, y); y += REGEL;
      for (const a of alineas) rijkeTekst(a, 29.5, R - 29.5);
      y += REGEL * 0.9;
    }
    blok('Betaling', [
      [`De huurprijs inclusief extra’s bedraagt ${euro(v('Totale huursom'))}. Dit bedrag is exclusief schoonmaak${borg > 0 ? ' en borg' : ''}.`],
      ['Uw aanbetaling bedraagt ', [euro(v('Aanbetaling'))], ', te betalen ', ['binnen één week'], ' na ontvangst van de huurovereenkomst.'],
      ['Het resterende deel à ', [euro(v('Restant betaling huursom'))], ' ontvangen wij graag ', ['vier weken voor het begin'],
        ` van de huurperiode${iban ? ` op rekening ${iban}` : ''}${tnv ? ` t.n.v. ${tnv}` : ''}.`],
      ['De eindschoonmaak is verplicht. Gelieve de schoonmaakkosten à ', [`${euro(schoonmaak)} contant`], ` te betalen aan ${ontvangst} bij aankomst.`],
    ]);
    blok('Sleutels', [
      ['De check-in en sleuteloverdracht zal op ', [`${v('Datum start')} om ${v('Tijdstip check in')} uur`],
        ` plaatsvinden op de Broekhof door ${ontvangst}.${ontvangstTel ? ` Indien u onverhoopt later aankomt kunt u haar telefonisch bereiken op ${ontvangstTel}.` : ''}`,
        ' De check-out is op ', [`${v('Datum eind')} uiterlijk om ${v('Tijdstip check out')} uur`], '.'],
    ]);

    y += REGEL * 0.5;
    ruimte(REGEL * 2);
    lettertype(false);
    doc.text('Wij wensen u een prettig verblijf in de Broekhof!', KOL_KOP, y);
    y += REGEL;
    lettertype(false, PT, LINK);
    doc.textWithLink('www.debroekhof.nl', KOL_KOP, y, { url: 'https://www.debroekhof.nl' });
    doc.setDrawColor(...LINK); doc.setLineWidth(0.2);
    doc.line(KOL_KOP, y + 0.7, KOL_KOP + doc.getTextWidth('www.debroekhof.nl'), y + 0.7);

    // Voettekst op elke pagina
    const n = doc.getNumberOfPages();
    for (let i = 1; i <= n; i++) { doc.setPage(i); voettekst(i); }

    return doc.output('blob');
  };
})();
