#!/usr/bin/env node
// Nieuw versienummer in public/releasenotes.json (nummering 2.H.F.P).
//   npm run release                → nieuwe functies   (2.0.5.0 → 2.0.6.0)
//   npm run release -- patch       → alleen herstel    (2.0.5.0 → 2.0.5.1)
//   npm run release -- hoofdversie → alleen op verzoek (2.0.5.0 → 2.1.0.0)
//   npm run release -- major       → alleen op verzoek (2.0.5.0 → 3.0.0.0)
// Vult bij de vorige versie de commit van origin/main in als die leeg is en
// zet de commit-onderwerpen sinds die commit als concept in de nieuwe versie.
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const BESTAND = new URL('../public/releasenotes.json', import.meta.url);
const soort = process.argv[2] || 'functie';

const git = cmd => {
  try { return execSync(`git ${cmd}`, { encoding: 'utf8' }).trim(); } catch { return ''; }
};

const notes = JSON.parse(readFileSync(BESTAND, 'utf8'));
const vorige = notes.versies[0];
const [M, H, F, P] = vorige.versie.split('.').map(Number);

const nieuw = {
  functie:     [M, H, F + 1, 0],
  patch:       [M, H, F, P + 1],
  hoofdversie: [M, H + 1, 0, 0],
  major:       [M + 1, 0, 0, 0],
}[soort];
if (!nieuw) {
  console.error(`Onbekende soort "${soort}". Gebruik: patch | hoofdversie | major`);
  process.exit(1);
}

git('fetch origin main --quiet');
if (!vorige.commit) vorige.commit = git('rev-parse origin/main');

const bereik = vorige.commit ? `${vorige.commit}..HEAD` : 'HEAD';
const onderwerpen = git(`log ${bereik} --no-merges --format=%s`)
  .split('\n')
  .map(s => s.trim())
  .filter(s => s && !/^Merge/.test(s) && !/TIJDELIJK/.test(s) && !/^Release \d/.test(s));

const versie = nieuw.join('.');
notes.versies.unshift({
  versie,
  datum: new Date().toISOString().slice(0, 10),
  commit: '',
  wijzigingen: onderwerpen.length ? onderwerpen : ['(beschrijf de wijzigingen)'],
});

writeFileSync(BESTAND, JSON.stringify(notes, null, 2) + '\n');
console.log(`Versie ${versie} toegevoegd. Herschrijf de concept-regels in public/releasenotes.json en commit als "Release ${versie}".`);
