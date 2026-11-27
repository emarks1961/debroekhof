// ═══════════════════════════════════════════════════════════════════════
// micazu-pdf.js — huurdergegevens uit het Micazu-bestand "Boeking details"
//
// In Micazu kun je per boeking een PDF downloaden met adres, telefoon en
// e-mail van de huurder. Die staan niet in de acceptatiemail. Dit script
// leest de PDF in de browser (pdf.js, pas geladen als het nodig is).
//
//   const g = await leesMicazuPdf(bestand);   // { voornaam, adres, ... }
//   raadAanhef('Henricus')                     // 'heer'
// ═══════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
  let pdfjsBelofte = null;

  function laadPdfJs() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    if (!pdfjsBelofte) {
      pdfjsBelofte = new Promise((ok, mis) => {
        const s = document.createElement('script');
        s.src = PDFJS + 'pdf.min.js';
        s.onload = () => {
          window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.js';
          ok(window.pdfjsLib);
        };
        s.onerror = () => { pdfjsBelofte = null; mis(new Error('PDF-lezer kon niet worden geladen')); };
        document.head.appendChild(s);
      });
    }
    return pdfjsBelofte;
  }

  // Tekst per regel: stukjes met (bijna) dezelfde hoogte op de pagina horen bij elkaar
  async function pdfRegels(bestand) {
    const pdfjs = await laadPdfJs();
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(await bestand.arrayBuffer()) }).promise;
    const regels = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const items = (await (await pdf.getPage(p)).getTextContent()).items.filter(i => i.str.trim());
      const groepen = [];
      for (const it of items) {
        const y = it.transform[5], x = it.transform[4];
        let g = groepen.find(g => Math.abs(g.y - y) < 3);
        if (!g) groepen.push(g = { y, delen: [] });
        g.delen.push({ x, t: it.str.trim() });
      }
      groepen.sort((a, b) => b.y - a.y);
      for (const g of groepen) regels.push(g.delen.sort((a, b) => a.x - b.x).map(d => d.t));
    }
    return regels; // [['Adres', 'Daalseweg 1-01'], ...]
  }

  function datumIso(t) {
    const m = String(t || '').match(/(\d{1,2})-(\d{1,2})-(\d{4})/);
    return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : '';
  }

  async function leesMicazuPdf(bestand) {
    const regels = await pdfRegels(bestand);
    const vlak = regels.map(r => r.join(' '));
    if (!vlak.some(r => /boeking details/i.test(r))) {
      throw new Error('Dit lijkt geen Micazu-bestand "Boeking details" te zijn');
    }
    // Labelregel: eerste stuk is het label, de rest de waarde
    const veld = label => {
      const r = regels.find(r => r.length > 1 && r[0].toLowerCase() === label.toLowerCase());
      return r ? r.slice(1).join(' ').trim() : '';
    };
    const g = { boekingsnummer: (vlak.find(r => /boeking details/i.test(r)).match(/(\d{4,})/) || [])[1] || '' };

    const i = vlak.findIndex(r => /^wie komt er\??$/i.test(r));
    const naam = i >= 0 ? (vlak[i + 1] || '') : '';
    const delen = naam.split(/\s+/).filter(Boolean);
    g.voornaam = delen.slice(0, 1).join(' ');
    g.achternaam = delen.slice(1).join(' ');

    // Aankomst en vertrek staan tussen "Aankomstdatum" en "Wie komt er?"; ze kunnen op één
    // regel staan. Verderop staat ook de geboortedatum, die mag niet als vertrek gelden.
    const j = vlak.findIndex(r => /aankomstdatum/i.test(r));
    const eind = i > j ? i : vlak.length;
    const datums = vlak.slice(Math.max(j, 0), eind)
      .filter(r => !/geboren|geboorte/i.test(r))
      .flatMap(r => [...r.matchAll(/\d{1,2}-\d{1,2}-\d{4}/g)].map(m => datumIso(m[0])));
    g.aankomst = datums[0] || '';
    g.vertrek = datums[1] || '';

    g.adres = veld('Adres');
    const pc = veld('Postcode');                    // "3611AA, Oud Zuilen"
    const pm = pc.match(/^(\d{4})\s*([A-Za-z]{2})\b[\s,]*(.*)$/);
    if (pm) { g.postcode = `${pm[1]} ${pm[2].toUpperCase()}`; g.plaats = pm[3].trim(); }
    else { const [a, ...b] = pc.split(','); g.postcode = (a || '').trim(); g.plaats = b.join(',').trim(); }
    g.land = veld('Land');
    g.telefoon = veld('Telefoonnummer');
    g.email = veld('E-mailadres') || veld('E-mail');
    return g;
  }

  // ── Aanhef raden uit de voornaam ────────────────────────────────────
  // Een gok: de beheerder ziet het resultaat in het formulier en kan het aanpassen.
  const VROUW = new Set(('anne anna annemarie annemieke astrid bianca brenda carla carolien chantal claudia corinne daphne '
    + 'debby diana dorien ellen els elske esther eva evelien femke fleur floor gerda hanneke hanna heleen ilse inge '
    + 'ingrid iris janneke jeanette jenny joke jolanda josephine judith karin kim lieke linda lisa liesbeth loes lotte maaike '
    + 'manon margriet marian marianne marieke marije marjan marjolein marloes mieke miriam monique myrthe nicole '
    + 'noor petra rianne rosa sandra sanne saskia simone sophie suzanne tamara tineke yvonne wendy willemijn '
    + 'elisabeth ellis ester gwen helga hilde ingeborg karen katrien lies lidwien maud marleen mirjam nathalie nel '
    + 'riet rita ruth sara sarah sigrid sylvia trees truus ursula vera wilma yasmin agnes greet ans ank anneke dewi ruth').split(' '));
  const MAN = new Set(('henk jan piet kees klaas joost bas tom tim sem luca noah jonah joshua jona sacha andre andré rene '
    + 'rené pierre jose josé dirk erik eric frank gerrit hans harm jeroen jos koen mark martijn michiel niels '
    + 'paul peter rob roel ruud sander stefan thijs wim willem henricus johannes hendrik johan maarten mike bart '
    + 'dave guus jesse jelle sjoerd wouter arie ate tjeerd bauke nico mattia andrea elia ilja sasha').split(' '));

  function raadAanhef(voornaam) {
    const n = String(voornaam || '').trim().split(/[\s-]/)[0].toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '');
    if (!n) return '';
    if (VROUW.has(n)) return 'mevrouw';
    if (MAN.has(n)) return 'heer';
    if (/(a|ie|ine|ette|elle|een|ien|ke|tje)$/.test(n)) return 'mevrouw';
    return 'heer';
  }

  window.leesMicazuPdf = leesMicazuPdf;
  window.raadAanhef = raadAanhef;
})();
