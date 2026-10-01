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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-unit-'));

try {
  const out = path.join(tmp, 'files.mjs');
  await build({ entryPoints: [path.join(APP, 'src', 'main', 'files.ts')], outfile: out, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
  const { importInputs, saveFeedbackImage, writeProjectText, backupText } = await import(pathToFileURL(out).href);

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

  // Markierung (E16): PNG nach .soma/feedback/, Name mit Datum und Uhrzeit, nichts wird überschrieben
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const when = new Date(2026, 8, 30, 14, 5);
  const f1 = saveFeedbackImage(proj, png, when), f2 = saveFeedbackImage(proj, png, when);
  check('Markierung landet als markierung-JJJJMMTT-HHMM.png in .soma/feedback/', f1.ok && f1.path === '.soma/feedback/markierung-20260930-1405.png'
    && fs.readFileSync(path.join(proj, f1.path)).equals(Buffer.from(png)), f1.path ?? f1.error);
  check('Zweite Markierung in derselben Minute: neuer Name mit -2, erste bleibt', f2.ok && f2.path === '.soma/feedback/markierung-20260930-1405-2.png'
    && fs.existsSync(path.join(proj, f1.path)), f2.path ?? f2.error);
  const bad = saveFeedbackImage(proj, new TextEncoder().encode('kein Bild'), when);
  check('Kein PNG: abgelehnt, nichts geschrieben', !bad.ok && fs.readdirSync(path.join(proj, '.soma', 'feedback')).length === 2, bad.error);
  // .soma als Verweis nach außen, feedback/ gibt es noch nicht: Auch der Ordner darüber zählt
  const proj3 = path.join(tmp, 'projekt3');
  fs.mkdirSync(proj3);
  let linked3 = true;
  try { fs.symlinkSync(outside, path.join(proj3, '.soma'), 'junction'); } catch { linked3 = false; }
  if (linked3) {
    const r3 = saveFeedbackImage(proj3, png, when);
    check('.soma zeigt nach außen: Markierung abgelehnt, draußen landet nichts', !r3.ok && fs.readdirSync(outside).length === 0, r3.error?.slice(0, 70) ?? '');
  } else check('.soma als Verweis nach außen (übersprungen, Verweis nicht anlegbar)', true);

  // Editor: schreiben nur, wenn die Platte noch dem gelesenen Stand entspricht (der Agent schreibt an denselben Dateien)
  const bdir = path.join(tmp, 'sicherungen');
  const mp = path.join(proj, 'model.py');
  fs.writeFileSync(mp, 'A = 1\n');
  let w = writeProjectText(proj, 'model.py', 'A = 2\n', 'A = 1\n', false, bdir);
  check('Editor schreibt, wenn die Platte dem gelesenen Stand entspricht', w.ok && fs.readFileSync(mp, 'utf8') === 'A = 2\n' && !fs.existsSync(`${mp}.soma-tmp`));
  fs.writeFileSync(mp, 'A = 3  # Agent\n');
  w = writeProjectText(proj, 'model.py', 'A = 4\n', 'A = 2\n', false, bdir);
  check('Außen geändert: Konflikt statt Überschreiben, Platte bleibt, aktueller Inhalt kommt mit', !w.ok && w.conflict && w.disk === 'A = 3  # Agent\n' && fs.readFileSync(mp, 'utf8') === 'A = 3  # Agent\n');
  w = writeProjectText(proj, 'model.py', 'A = 4\n', 'A = 2\n', true, bdir);
  check('„Meine Fassung behalten": schreibt und sichert vorher die Fassung von außen', w.ok && fs.readFileSync(mp, 'utf8') === 'A = 4\n' && !!w.backup
    && fs.readFileSync(w.backup, 'utf8') === 'A = 3  # Agent\n' && path.dirname(w.backup) === bdir, w.backup ? path.basename(w.backup) : w.error);
  fs.rmSync(mp);
  w = writeProjectText(proj, 'model.py', 'A = 5\n', 'A = 4\n', false, bdir);
  check('Außen gelöscht: Konflikt mit disk = null', !w.ok && w.conflict && w.disk === null && !fs.existsSync(mp));
  const locked = ['AGENTS.md', 'CLAUDE.md', '.gitignore', 'output/model.step', 'exports/Body.stl', '.soma/project.json', '.git/config', 'parts/../AGENTS.md'].map((r) => {
    fs.mkdirSync(path.dirname(path.join(proj, r)), { recursive: true });
    fs.writeFileSync(path.join(proj, r), 'x');
    const res = writeProjectText(proj, r, 'y', 'x', true, bdir);
    return !res.ok && !res.conflict && fs.readFileSync(path.join(proj, r), 'utf8') === 'x';
  });
  check('App-Dateien, Ergebnisse, .soma und .git: Schreiben aus dem Editor abgelehnt', locked.every(Boolean), locked.join(','));
  w = writeProjectText(proj, '../draussen.py', 'x', null, true, bdir);
  check('Pfad außerhalb des Projekts: abgelehnt', !w.ok && !fs.existsSync(path.join(tmp, 'draussen.py')), w.error?.slice(0, 60));
  const b1 = backupText(bdir, 'parts/deckel.py', 'eins'), b2 = backupText(bdir, 'parts/deckel.py', 'zwei');
  check('Sicherungen überschreiben einander nicht', b1 !== b2 && fs.readFileSync(b1, 'utf8') === 'eins' && fs.readFileSync(b2, 'utf8') === 'zwei', path.basename(b2));
  // App-Icon (E44): ICO mit allen Größen für Fenster und Taskleiste (Breite 0 steht für 256), PNG für andere Systeme
  const ico = fs.readFileSync(path.join(APP, 'resources', 'icon.ico'));
  const icoSizes = Array.from({ length: ico.readUInt16LE(4) }, (_, i) => ico[6 + 16 * i] || 256);
  check('App-Icon: icon.ico mit 16 bis 256 px, icon.png vorhanden', [16, 24, 32, 48, 256].every((s) => icoSizes.includes(s))
    && fs.existsSync(path.join(APP, 'resources', 'icon.png')), icoSizes.join(','));

  // Skills mit Einstellungen (E17): Variablen im Kopf, Platzhalter im Text, Prüfung der Werte
  const sk = path.join(tmp, 'skills.mjs');
  await build({ entryPoints: [path.join(APP, 'src', 'main', 'skills.ts')], outfile: sk, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
  const { parseSkill, renderSkill, checkValue, cleanValues, bundledSkills } = await import(pathToFileURL(sk).href);
  const SRC = '---\ntitle: Test\nvar angle: 45 | ° | Winkel | 10..80\nvar mat: PLA | | Material | PLA, PETG=Petg-Filament\n---\n# Skill\n\nUp to {{angle}}° in {{mat}}, {{unknown}} stays.\n';
  const ps = parseSkill('t', SRC);
  check('Skill-Kopf: Zahl mit Einheit und Bereich, Auswahl mit Anzeigenamen', ps.vars.length === 2 && ps.vars[0].kind === 'number' && ps.vars[0].min === 10 && ps.vars[0].max === 80 && ps.vars[0].unit === '°'
    && ps.vars[1].kind === 'choice' && ps.vars[1].options[1].value === 'PETG' && ps.vars[1].options[1].label === 'Petg-Filament', JSON.stringify(ps.vars));
  const rs = renderSkill(SRC, { angle: 50, mat: 'PETG' });
  check('Eingesetzt: Text mit Werten, Kopf mit Werten statt Standard, Unbekanntes bleibt', rs.includes('Up to 50° in PETG, {{unknown}} stays.') && rs.includes('var angle: 50 | °') && rs.includes('var mat: PETG |'), rs);
  check('Ohne Einstellungen: die Standardwerte', renderSkill(SRC, {}).includes('Up to 45° in PLA'));
  const cv = [checkValue(ps.vars[0], '52,5'), checkValue(ps.vars[0], 95), checkValue(ps.vars[0], 'abc'), checkValue(ps.vars[1], 'ABS')];
  check('Werte geprüft: Komma geht, außerhalb des Bereichs, keine Zahl und fremde Auswahl abgelehnt', cv[0].value === 52.5 && cv[1].error?.includes('10 bis 80°') && cv[2].error && cv[3].error, JSON.stringify(cv));
  check('Gespeicherte Werte bereinigt: Ungültiges und Standard fallen weg', JSON.stringify(cleanValues(ps.vars, { angle: 45, mat: 'XYZ', other: 1 })) === '{}'
    && JSON.stringify(cleanValues(ps.vars, { angle: '60' })) === '{"angle":60}');
  const shipped = [...bundledSkills(path.join(APP, 'resources', 'skills')).values()];
  const leftover = shipped.map((s) => renderSkill(s.text, {})).filter((x) => /\{\{/.test(x));
  check('Mitgelieferte Skills: jeder Platzhalter hat eine Variable', shipped.length >= 3 && shipped.every((s) => s.vars.length) && !leftover.length, shipped.map((s) => `${s.id}:${s.vars.length}`).join(','));
} catch (e) {
  console.log('ABBRUCH:', e.message);
  t.fail();
}
cleanup(tmp);
console.log(t.fails ? `\n${t.fails} Prüfung(en) fehlgeschlagen` : '\nALLE PRÜFUNGEN BESTANDEN');
process.exit(t.fails ? 1 : 0);
