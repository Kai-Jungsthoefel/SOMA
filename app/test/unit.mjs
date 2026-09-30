// Einheitentests für Hauptprozess-Bausteine ohne Electron. Aufruf: npm run test:unit (Teil von npm test).
// Gezogene Dateien lassen sich im Ende-zu-Ende-Test nicht auslösen (der Renderer bekommt Pfade nur vom echten Ziehen).
import { build } from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { APP, checker, cleanup } from './harness.mjs';

const t = checker();
const { check } = t;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cadide-unit-'));

try {
  const out = path.join(tmp, 'files.mjs');
  await build({ entryPoints: [path.join(APP, 'src', 'main', 'files.ts')], outfile: out, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
  const { importInputs, saveFeedbackImage } = await import(pathToFileURL(out).href);

  const proj = path.join(tmp, 'projekt');
  const src = path.join(tmp, 'quelle');
  fs.mkdirSync(proj); fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, 'platine.step'), 'neu');
  fs.mkdirSync(path.join(src, 'ordner'));

  let r = importInputs(proj, [path.join(src, 'platine.step')]);
  check('Datei landet in inputs/ (Ordner wird angelegt)', r.files[0] === 'inputs/platine.step' && fs.readFileSync(path.join(proj, 'inputs', 'platine.step'), 'utf8') === 'neu');

  fs.writeFileSync(path.join(proj, 'inputs', 'platine.step'), 'ALT, vom Agenten bearbeitet');
  r = importInputs(proj, [path.join(src, 'platine.step'), path.join(src, 'platine.step')]);
  check('Gleicher Name: nichts überschrieben, neue Namen (2) und (3)', JSON.stringify(r.files) === '["inputs/platine (2).step","inputs/platine (3).step"]'
    && fs.readFileSync(path.join(proj, 'inputs', 'platine.step'), 'utf8').startsWith('ALT'), r.files.join(','));

  r = importInputs(proj, [path.join(src, 'ordner'), path.join(src, 'fehlt.step')]);
  check('Ordner und fehlende Dateien werden gemeldet, nicht übernommen', r.files.length === 0 && r.errors.length === 2 && /Ordner/.test(r.errors[0]), r.errors.join(' | ').slice(0, 90));

  // inputs/ als Verweis nach außen: resolveInside lehnt ab (Agent könnte so Dateien außerhalb des Projekts schreiben lassen)
  const outside = path.join(tmp, 'draussen');
  fs.mkdirSync(outside);
  const proj2 = path.join(tmp, 'projekt2');
  fs.mkdirSync(proj2);
  let linked = true;
  try { fs.symlinkSync(outside, path.join(proj2, 'inputs'), 'junction'); } catch { linked = false; }
  if (linked) {
    r = importInputs(proj2, [path.join(src, 'platine.step')]);
    check('inputs/ zeigt nach außen: Import wird abgelehnt, draußen landet nichts', r.files.length === 0 && fs.readdirSync(outside).length === 0, r.errors[0]?.slice(0, 70) ?? '');
  } else check('inputs/ als Verweis nach außen (übersprungen, Verweis nicht anlegbar)', true);

  // Markierung (E16): PNG nach .cadide/feedback/, Name mit Datum und Uhrzeit, nichts wird überschrieben
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const when = new Date(2026, 8, 30, 14, 5);
  const f1 = saveFeedbackImage(proj, png, when), f2 = saveFeedbackImage(proj, png, when);
  check('Markierung landet als markierung-JJJJMMTT-HHMM.png in .cadide/feedback/', f1.ok && f1.path === '.cadide/feedback/markierung-20260930-1405.png'
    && fs.readFileSync(path.join(proj, f1.path)).equals(Buffer.from(png)), f1.path ?? f1.error);
  check('Zweite Markierung in derselben Minute: neuer Name mit -2, erste bleibt', f2.ok && f2.path === '.cadide/feedback/markierung-20260930-1405-2.png'
    && fs.existsSync(path.join(proj, f1.path)), f2.path ?? f2.error);
  const bad = saveFeedbackImage(proj, new TextEncoder().encode('kein Bild'), when);
  check('Kein PNG: abgelehnt, nichts geschrieben', !bad.ok && fs.readdirSync(path.join(proj, '.cadide', 'feedback')).length === 2, bad.error);
  // .cadide als Verweis nach außen, feedback/ gibt es noch nicht: Auch der Ordner darüber zählt
  const proj3 = path.join(tmp, 'projekt3');
  fs.mkdirSync(proj3);
  let linked3 = true;
  try { fs.symlinkSync(outside, path.join(proj3, '.cadide'), 'junction'); } catch { linked3 = false; }
  if (linked3) {
    const r3 = saveFeedbackImage(proj3, png, when);
    check('.cadide zeigt nach außen: Markierung abgelehnt, draußen landet nichts', !r3.ok && fs.readdirSync(outside).length === 0, r3.error?.slice(0, 70) ?? '');
  } else check('.cadide als Verweis nach außen (übersprungen, Verweis nicht anlegbar)', true);
} catch (e) {
  console.log('ABBRUCH:', e.message);
  t.fail();
}
cleanup(tmp);
console.log(t.fails ? `\n${t.fails} Prüfung(en) fehlgeschlagen` : '\nALLE PRÜFUNGEN BESTANDEN');
process.exit(t.fails ? 1 : 0);
