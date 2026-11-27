// ═══════════════════════════════════════════════════════════════════════
// huurovereenkomst.js — reserveringsbevestiging + huurovereenkomst als PDF
//
// Vervangt het Google Doc-sjabloon "reserveringsbevestiging en
// huurovereenkomst (app-versie)". De vaste tekst staat hieronder; namen,
// telefoonnummers en het rekeningnummer komen uit de tabel instellingen.
// Gebruikt jsPDF (al geladen in index.html).
//
//   const blob = maakHuurovereenkomstPdf(placeholders, instellingen);
// ═══════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  const GOUD = [140, 109, 63];
  const TEKST = [45, 41, 33];
  const GRIJS = [120, 110, 95];

  function bedrag(v) {
    const n = parseFloat(String(v ?? '').replace('€', '').replace(',', '.').trim());
    if (!Number.isFinite(n)) return String(v ?? '');
    return n % 1 === 0 ? String(Math.round(n)) : n.toFixed(2).replace('.', ',');
  }

  window.maakHuurovereenkomstPdf = function (p, inst) {
    inst = inst || {};
    const v = k => String(p[k] ?? '').trim();
    const ontvangst = inst.ontvangst_naam || 'de sleutelbeheerder';
    const ontvangstTel = inst.ontvangst_telefoon || '';
    const ondertekening = inst.ondertekening || '';
    const telefoon = inst.telefoon || '';
    const email = inst.email_info || 'info@debroekhof.nl';
    const iban = inst.iban || '';
    const tnv = inst.iban_tnv || '';
    const schoonmaak = bedrag(v('Prijs schoonmaak'));

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const L = 22, R = 188, B = R - L;
    let y = 28;

    function tekst(t, opt = {}) {
      doc.setFont('helvetica', opt.vet ? 'bold' : 'normal');
      doc.setFontSize(opt.grootte || 10.5);
      doc.setTextColor(...(opt.kleur || TEKST));
      const regels = doc.splitTextToSize(t, opt.breedte || B);
      doc.text(regels, opt.x || L, y, opt.align ? { align: opt.align } : undefined);
      y += regels.length * (opt.regel || (opt.grootte || 10.5) * 0.41) + (opt.na ?? 3);
    }

    // ── Pagina 1: reserveringsbevestiging ────────────────────────────
    tekst('RESERVERINGSBEVESTIGING', { vet: true, grootte: 15, kleur: GOUD, na: 8 });
    tekst(`Klarenbeek, ${v('Today')}`, { na: 8 });
    tekst(`Geachte ${v('Aanhef')} ${v('Achternaam')}, beste ${v('Voornaam')},`, { na: 5 });
    tekst('Hierbij doe ik u de nadere bevestiging van de reservering van de vakantiewoning de Broekhof toekomen.');
    tekst(`Check-in: ${ontvangst} zal u ontvangen en nader wegwijs maken in de woning. Het afgesproken tijdstip voor de check-in is ${v('Tijdstip check in')} uur. Indien u op een afwijkende tijd arriveert laat dit dan s.v.p. aan haar weten.${ontvangstTel ? ` U kunt haar telefonisch bereiken op ${ontvangstTel}.` : ''}`);
    tekst('Gedurende uw verblijf heeft u de beschikking over de sleutels van beide zijdeuren. Tevens krijgt u toegang tot de voordeur middels een persoonlijke code. Deze code wordt u voorafgaand aan het verblijf toegezonden. Verdere informatie over het huis en de omgeving treft u aan in de informatiemap.');
    tekst(`Check-out: Op de dag van vertrek uiterlijk om ${v('Tijdstip check out')} uur met inachtneming van de instructies. Sleutels dient u achter te laten op het sleutelrekje bij de zijdeur. U kunt het pand verlaten door de voordeur achter u dicht te trekken.`);
    tekst('Het is gebruikelijk dat direct na de reservering een aanbetaling van 25% van de huursom wordt gedaan en de rest 4 weken voor het begin van de huurperiode. Betaling van schoonmaakkosten graag contant bij aankomst. Details hierover vindt u in de bijgevoegde huurovereenkomst.');
    tekst('Ik denk dat alles zo goed geregeld is en ik hoop dat u een hele prettige tijd in de Broekhof zal doorbrengen.', { na: 8 });
    tekst('Met vriendelijke groeten,', { na: 1 });
    tekst(tnv ? `Namens ${tnv.replace(/ te .*$/, '')},` : '', { na: 6 });
    if (ondertekening) tekst(ondertekening, { na: 1 });
    tekst('Vakantiewoning "De Broekhof"', { na: 6 });
    if (telefoon) tekst(`Telefoon: ${telefoon}`, { na: 1, kleur: GRIJS });
    tekst(`E-mail: ${email}`, { na: 1, kleur: GRIJS });
    tekst('Website: www.debroekhof.nl', { kleur: GRIJS });

    // ── Pagina 2: huurovereenkomst ───────────────────────────────────
    doc.addPage();
    y = 28;
    tekst('HUUROVEREENKOMST', { vet: true, grootte: 15, kleur: GOUD, na: 8 });

    const kolom = 42;
    function rij(kop, regels) {
      const breedte = B - kolom;
      const delen = regels.flatMap(r => doc.splitTextToSize(r, breedte));
      const hoogte = Math.max(1, delen.length) * 4.1;
      if (y + hoogte > 280) { doc.addPage(); y = 28; }
      doc.setDrawColor(229, 213, 184);
      doc.line(L, y - 4, R, y - 4);
      doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(...GOUD);
      doc.text(kop, L, y);
      doc.setFont('helvetica', 'normal'); doc.setTextColor(...TEKST);
      doc.text(delen, L + kolom, y);
      y += hoogte + 4;
    }

    const adresregel = [v('Postcode'), v('Plaats')].filter(Boolean).join('  ') + (v('Land') ? ` (${v('Land')})` : '');
    rij('Huurder', [`${v('Voornaam')} ${v('Achternaam')}`, v('Adres'), adresregel, v('Telefoonnummer'), v('E-mail')].filter(Boolean));
    rij('Periode', [`Aankomst: ${v('Datum start')}, ${v('Tijdstip check in')} uur`, `Vertrek: ${v('Datum eind')}, ${v('Tijdstip check out')} uur`]);
    rij('Gebruik', [`${v('Aantal personen')} personen`, `${v('Aantal huisdieren') || '0'} huisdier(en)`]);
    rij('Huurprijs', [`€ ${bedrag(v("Huurprijs excl. schoonmaak en extra's"))},--`, 'Vooruitbetaling 25% (zie Betaling)']);
    rij("Extra's", [`€ ${bedrag(v("Prijs extra's"))},--`, "Vooruitbetaling voor extra's als bed- en keukenlinnen"]);
    rij('Borg', [`€ ${bedrag(v('Borg') || '0')},--`, 'De borg wordt opgeteld bij de aanbetaling en zal direct na de huurperiode worden teruggestort.']);
    rij('Schoonmaak', [`€ ${schoonmaak},--`, 'Roken in het huis is niet toegestaan. Bij vertrek dient u de woning opgeruimd en bezemschoon achter te laten, zonder sporen van eventuele huisdieren.']);
    rij('Betaling', [
      `De huurprijs inclusief extra's bedraagt € ${bedrag(v('Totale huursom'))},--. Dit bedrag is exclusief schoonmaak en borg.`,
      `Uw aanbetaling bedraagt € ${bedrag(v('Aanbetaling'))},--, te betalen binnen één week na ontvangst van de huurovereenkomst.`,
      `Het resterende deel à € ${bedrag(v('Restant betaling huursom'))},-- ontvangen wij graag vier weken voor het begin van de huurperiode${iban ? ` op rekening ${iban}` : ''}${tnv ? ` t.n.v. ${tnv}` : ''}.`,
      `De eindschoonmaak is verplicht. Gelieve de schoonmaakkosten à € ${schoonmaak},-- contant te betalen aan ${ontvangst} bij aankomst.`,
    ]);
    rij('Sleutels', [
      `De check-in en sleuteloverdracht zal op ${v('Datum start')} om ${v('Tijdstip check in')} uur plaatsvinden op de Broekhof door ${ontvangst}.${ontvangstTel ? ` Indien u onverhoopt later aankomt kunt u haar telefonisch bereiken op ${ontvangstTel}.` : ''}`,
      `De check-out is op ${v('Datum eind')} uiterlijk om ${v('Tijdstip check out')} uur.`,
    ]);

    y += 6;
    tekst('Wij wensen u een prettig verblijf in de Broekhof!', { vet: true, na: 1 });
    tekst('www.debroekhof.nl', { kleur: GRIJS });

    return doc.output('blob');
  };
})();
