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
  const { importInputs, saveFeedbackImage, writeProjectText, backupText, createEntry, renameEntry, trashEntry, entryPath, listFiles } = await import(pathToFileURL(out).href);

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

  r = importInputs(proj, [path.join(src, 'fehlt.step')]);
  check('Fehlende Datei wird gemeldet, nicht übernommen', r.files.length === 0 && r.errors.length === 1, r.errors.join(' | ').slice(0, 90));

  // Ordner: mit Unterordnern übernommen, .git und Verknüpfungen bleiben draußen, nichts überschrieben
  const tree = path.join(src, 'ordner');
  fs.mkdirSync(path.join(tree, 'unter', 'tiefer'), { recursive: true });
  fs.mkdirSync(path.join(tree, 'leer'));
  fs.mkdirSync(path.join(tree, '.git'));
  fs.writeFileSync(path.join(tree, '.git', 'HEAD'), 'ref');
  fs.writeFileSync(path.join(tree, 'a.step'), 'A');
  fs.writeFileSync(path.join(tree, 'unter', 'tiefer', 'b.csv'), 'B');
  let treeLink = true;
  try { fs.symlinkSync(tmp, path.join(tree, 'verweis'), 'junction'); } catch { treeLink = false; }
  r = importInputs(proj, [tree]);
  const got = path.join(proj, 'inputs', 'ordner');
  check('Ordner landet mit Unterordnern in inputs/', r.files[0] === 'inputs/ordner/' && fs.readFileSync(path.join(got, 'a.step'), 'utf8') === 'A'
    && fs.readFileSync(path.join(got, 'unter', 'tiefer', 'b.csv'), 'utf8') === 'B' && fs.existsSync(path.join(got, 'leer')), r.files.join(','));
  check('Ordner: .git und Verknüpfungen bleiben draußen und werden gemeldet', !fs.existsSync(path.join(got, '.git')) && !fs.existsSync(path.join(got, 'verweis'))
    && r.errors.length === (treeLink ? 2 : 1) && r.errors.every((e) => e.startsWith('ordner/')), r.errors.join(' | ').slice(0, 90));
  fs.writeFileSync(path.join(got, 'a.step'), 'ALT');
  r = importInputs(proj, [tree]);
  check('Ordner mit gleichem Namen: „ordner (2)“, Vorhandenes bleibt', r.files[0] === 'inputs/ordner (2)/' && fs.readFileSync(path.join(got, 'a.step'), 'utf8') === 'ALT'
    && fs.existsSync(path.join(proj, 'inputs', 'ordner (2)', 'a.step')), r.files.join(','));

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
  check('Markierung landet als markup-JJJJMMTT-HHMM.png in .soma/feedback/', f1.ok && f1.path === '.soma/feedback/markup-20260930-1405.png'
    && fs.readFileSync(path.join(proj, f1.path)).equals(Buffer.from(png)), f1.path ?? f1.error);
  check('Zweite Markierung in derselben Minute: neuer Name mit -2, erste bleibt', f2.ok && f2.path === '.soma/feedback/markup-20260930-1405-2.png'
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

  // Dateibaum: anlegen, umbenennen, Papierkorb, öffnen. Nichts überschrieben, App-Dateien gesperrt, nie endgültig gelöscht.
  const ops = path.join(tmp, 'ops');
  fs.mkdirSync(path.join(ops, 'parts'), { recursive: true });
  fs.mkdirSync(path.join(ops, '.soma', 'feedback'), { recursive: true });
  fs.writeFileSync(path.join(ops, 'model.py'), 'M');
  fs.writeFileSync(path.join(ops, 'AGENTS.md'), 'A');
  fs.writeFileSync(path.join(ops, '.soma', 'feedback', 'markierung-20260930-1405.png'), 'P');
  let o = createEntry(ops, 'parts', 'deckel.py', false);
  const o2 = createEntry(ops, '', 'skizzen', true);
  check('Neue Datei und neuer Ordner', o.ok && o.path === 'parts/deckel.py' && fs.readFileSync(path.join(ops, 'parts', 'deckel.py'), 'utf8') === ''
    && o2.ok && fs.statSync(path.join(ops, 'skizzen')).isDirectory(), `${o.path} ${o2.path}`);
  fs.writeFileSync(path.join(ops, 'parts', 'deckel.py'), 'INHALT');
  o = createEntry(ops, 'parts', 'deckel.py', false);
  check('Neue Datei mit vorhandenem Namen: abgelehnt, Inhalt bleibt', !o.ok && /already exists/.test(o.error) && fs.readFileSync(path.join(ops, 'parts', 'deckel.py'), 'utf8') === 'INHALT', o.error);
  const badNames = ['', ' x', 'a/b', 'a:b', 'con', 'NUL.txt', 'x.', '..'].map((n) => createEntry(ops, '', n, false));
  check('Ungültige Namen (leer, Leerzeichen, / : , reservierte Namen, Punkt am Ende) abgelehnt', badNames.every((x) => !x.ok), badNames.map((x) => x.error).join(' | ').slice(0, 90));
  const blockedCreate = [createEntry(ops, 'output', 'x.step', false), createEntry(ops, '.soma', 'x', false), createEntry(ops, '.soma/feedback', 'x.png', false), createEntry(ops, '', 'AGENTS.md', false), createEntry(ops, '../draussen', 'x', false)];
  check('Anlegen in output/, .soma/ und außerhalb sowie als App-Datei: abgelehnt', blockedCreate.every((x) => !x.ok) && !fs.existsSync(path.join(tmp, 'draussen', 'x')), blockedCreate.map((x) => x.error).join(' | ').slice(0, 90));

  o = renameEntry(ops, 'parts/deckel.py', 'lid.py');
  check('Umbenennen im selben Ordner', o.ok && o.path === 'parts/lid.py' && fs.readFileSync(path.join(ops, 'parts', 'lid.py'), 'utf8') === 'INHALT' && !fs.existsSync(path.join(ops, 'parts', 'deckel.py')), o.path ?? o.error);
  fs.writeFileSync(path.join(ops, 'parts', 'body.py'), 'BODY');
  o = renameEntry(ops, 'parts/lid.py', 'body.py');
  check('Umbenennen auf vorhandenen Namen: abgelehnt, beide bleiben', !o.ok && fs.readFileSync(path.join(ops, 'parts', 'body.py'), 'utf8') === 'BODY' && fs.existsSync(path.join(ops, 'parts', 'lid.py')), o.error);
  o = renameEntry(ops, 'parts/lid.py', 'Lid.py');
  check('Nur Groß-/Kleinschreibung ändern geht', o.ok && fs.readdirSync(path.join(ops, 'parts')).includes('Lid.py'), fs.readdirSync(path.join(ops, 'parts')).join(','));
  const blockedRename = [renameEntry(ops, 'model.py', 'haupt.py'), renameEntry(ops, 'AGENTS.md', 'x.md'), renameEntry(ops, 'parts', 'teile'), renameEntry(ops, 'parts/../model.py', 'x.py'), renameEntry(ops, 'skizzen', 'AGENTS.md')];
  check('Umbenennen gesperrt: model.py, App-Dateien, parts/, Umweg über „..“, App-Name als Ziel', blockedRename.every((x) => !x.ok) && fs.existsSync(path.join(ops, 'model.py')) && fs.existsSync(path.join(ops, 'parts')),
    blockedRename.map((x) => x.error).join(' | ').slice(0, 90));
  o = renameEntry(ops, '.soma/feedback/markierung-20260930-1405.png', 'griff-zu-dick.png');
  check('Markierung in .soma/feedback/ lässt sich umbenennen', o.ok && fs.existsSync(path.join(ops, '.soma', 'feedback', 'griff-zu-dick.png')), o.path ?? o.error);

  const binned = [];
  const fakeTrash = async (abs) => { binned.push(path.basename(abs)); fs.rmSync(abs, { recursive: true }); };
  o = await trashEntry(ops, 'skizzen', fakeTrash);
  const o3 = await trashEntry(ops, 'model.py', fakeTrash), o4 = await trashEntry(ops, 'AGENTS.md', fakeTrash), o5 = await trashEntry(ops, '.soma', fakeTrash);
  check('Löschen geht in den Papierkorb, model.py, App-Dateien und .soma gesperrt', o.ok && !fs.existsSync(path.join(ops, 'skizzen')) && JSON.stringify(binned) === '["skizzen"]'
    && !o3.ok && !o4.ok && !o5.ok && fs.existsSync(path.join(ops, 'model.py')), binned.join(','));
  o = await trashEntry(ops, 'parts/body.py', async () => { throw new Error('Papierkorb nicht erreichbar'); });
  check('Papierkorb klappt nicht: nichts gelöscht, Meldung', !o.ok && fs.existsSync(path.join(ops, 'parts', 'body.py')) && /nothing was deleted/.test(o.error), o.error?.slice(0, 80));

  fs.writeFileSync(path.join(ops, 'start.bat'), '@echo off');
  fs.writeFileSync(path.join(ops, 'parts', 'foto.png'), 'P');
  const runnable = [entryPath(ops, 'start.bat', true), entryPath(ops, 'parts/Lid.py', true)], fine = entryPath(ops, 'parts/foto.png', true), shown = entryPath(ops, 'start.bat', false);
  check('Mit Standardprogramm öffnen: Ausführbares (.bat, .py) abgelehnt, Bild und Zeigen im Explorer gehen', runnable.every((x) => !x.abs && x.error) && !!fine.abs && !!shown.abs, runnable[0].error?.slice(0, 70));
  const tree2 = listFiles(ops);
  const fbNode = tree2.find((n) => n.path === '.soma/feedback');
  check('Dateiliste: .soma/feedback/ als einziger Teil von .soma, sonst bleibt .soma verborgen', !!fbNode && fbNode.children.map((c) => c.name).join() === 'griff-zu-dick.png'
    && !tree2.some((n) => n.path === '.soma'), tree2.map((n) => n.path).join(','));

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
  const { parseSkill, renderSkill, checkValue, cleanValues, bundledSkills, defaultModes, skillsBlock } = await import(pathToFileURL(sk).href);
  const SRC = '---\ntitle: Test\nvar angle: 45 | ° | Winkel | 10..80\nvar mat: PLA | | Material | PLA, PETG=Petg-Filament\n---\n# Skill\n\nUp to {{angle}}° in {{mat}}, {{unknown}} stays.\n';
  const ps = parseSkill('t', SRC);
  check('Skill-Kopf: Zahl mit Einheit und Bereich, Auswahl mit Anzeigenamen', ps.vars.length === 2 && ps.vars[0].kind === 'number' && ps.vars[0].min === 10 && ps.vars[0].max === 80 && ps.vars[0].unit === '°'
    && ps.vars[1].kind === 'choice' && ps.vars[1].options[1].value === 'PETG' && ps.vars[1].options[1].label === 'Petg-Filament', JSON.stringify(ps.vars));
  const rs = renderSkill(SRC, { angle: 50, mat: 'PETG' });
  check('Eingesetzt: Text mit Werten, Kopf mit Werten statt Standard, Unbekanntes bleibt', rs.includes('Up to 50° in PETG, {{unknown}} stays.') && rs.includes('var angle: 50 | °') && rs.includes('var mat: PETG |'), rs);
  check('Ohne Einstellungen: die Standardwerte', renderSkill(SRC, {}).includes('Up to 45° in PLA'));
  const cv = [checkValue(ps.vars[0], '52,5'), checkValue(ps.vars[0], 95), checkValue(ps.vars[0], 'abc'), checkValue(ps.vars[1], 'ABS')];
  check('Werte geprüft: Komma geht, außerhalb des Bereichs, keine Zahl und fremde Auswahl abgelehnt', cv[0].value === 52.5 && cv[1].error?.includes('must be between 10 and 80°') && cv[2].error && cv[3].error, JSON.stringify(cv));
  check('Gespeicherte Werte bereinigt: Ungültiges und Standard fallen weg', JSON.stringify(cleanValues(ps.vars, { angle: 45, mat: 'XYZ', other: 1 })) === '{}'
    && JSON.stringify(cleanValues(ps.vars, { angle: '60' })) === '{"angle":60}');
  const shipped = [...bundledSkills(path.join(APP, 'resources', 'skills')).values()];
  const leftover = shipped.map((s) => renderSkill(s.text, {})).filter((x) => /\{\{/.test(x));
  // Einstellungen sind freiwillig (etwa „Normteile“ hat keine), der Kopf aber nicht
  check('Mitgelieferte Skills: Kopf vollständig, jeder Platzhalter hat eine Variable, Standardwerte gültig', shipped.length >= 12
    && shipped.every((s) => s.title !== s.id && s.name && s.summary && s.topics.length && s.order < 100 && s.when && !s.when.endsWith('.'))
    && shipped.every((s) => s.vars.every((v) => 'value' in checkValue(v, v.default))) && !leftover.length, shipped.map((s) => `${s.id}:${s.vars.length}`).join(','));
  // Kategorien und Stufe für neue Modelle (E46, E55)
  const kp = parseSkill('k', '---\ntitle: K\ncategory: Arbeitsweise\ndefault: always\nwhen: the user asks.\n---\n# K\n');
  const modeOf = (d) => parseSkill('x', `---\ndefault: ${d}\n---\n`).defaultMode;
  check('Skill-Kopf: Kategorie, Stufe „always“ (auch „on“), „off“, ohne Angabe Bei Bedarf, Anlass ohne Punkt', kp.category === 'Arbeitsweise' && kp.defaultMode === 'always'
    && kp.when === 'the user asks' && ps.category === '' && ps.defaultMode === 'demand' && ps.when === '' && modeOf('on') === 'always' && modeOf('off') === 'off' && modeOf('on-demand') === 'demand');
  const cats = [...new Set(shipped.map((s) => s.category))];
  check('Mitgelieferte Skills: jeder mit Kategorie, vier Kategorien', shipped.every((s) => s.category) && cats.length === 4, cats.join(','));
  // Bibliothek (E78): mitgelieferte und eigene Skills, hier ohne eigene
  const SKD = { bundled: path.join(APP, 'resources', 'skills'), user: path.join(tmp, 'keine-eigenen-skills') };
  const dm = defaultModes(SKD, {});
  check('Neue Modelle: ohne Vorgabe des Nutzers Arbeitsweise (mit Parametrik) und Normteile immer, alle übrigen bei Bedarf', dm.always.join(',') === 'konstruktionsablauf,cadquery,parametrik,normteile'
    && dm.demand.join(',') === '3d-druck,harz-pulver,cnc,laser,blech,toleranzen,verbindungen,festigkeit,baugruppen,analyse,animation,fem,zeichnung', JSON.stringify(dm));
  const dm2 = defaultModes(SKD, { konstruktionsablauf: 'demand', toleranzen: 'always', '3d-druck': 'always', laser: 'off' });
  check('Neue Modelle: Vorgabe des Nutzers geht vor, in der Reihenfolge des Panels, „Aus“ fehlt ganz', dm2.always.join(',') === 'cadquery,parametrik,3d-druck,toleranzen,normteile'
    && dm2.demand.join(',') === 'konstruktionsablauf,harz-pulver,cnc,blech,verbindungen,festigkeit,baugruppen,analyse,animation,fem,zeichnung', JSON.stringify(dm2));
  // Bei Bedarf (E55): Hinweis unter der ersten Überschrift, Werte als Standard der App, vom Nutzer gesetzte mit Namen
  const rd = renderSkill(SRC, {}, 'demand');
  check('Bei Bedarf: Hinweis direkt unter der Überschrift, mit Leerzeilen, Werte als Standard der App, NOTES.md', rd.includes('# Skill\n\n> **On demand:**')
    && rd.includes('NOTES.md') && rd.includes('The values in this file are defaults of the app') && rd.includes('Up to 45° in PLA') && /chosen them[^\n]*\n> In the app[^\n]*\n\nUp to/.test(rd), rd);
  check('Bei Bedarf mit eingestelltem Wert: nennt ihn, Immer ohne Hinweis', renderSkill(SRC, { angle: 50 }, 'demand').includes('The user set `angle` in the app. The other values')
    && !renderSkill(SRC, { angle: 50 }, 'always').includes('On demand') && renderSkill(SRC, {}) === renderSkill(SRC, {}, 'always'));
  check('Bei Bedarf ohne Einstellungen: kein Satz zu Werten', !renderSkill('---\ntitle: N\n---\n# N\n\nText.\n', {}, 'demand').includes('values'));
  const blk = skillsBlock([{ id: 'a', name: 'A', when: '', mode: 'always' }, { id: 'b', name: 'B', when: 'parts move', mode: 'demand' }]);
  check('AGENTS.md: zwei Listen, Bei Bedarf mit Anlass, ohne Skills ein Satz', blk.indexOf('### Always follow') < blk.indexOf('- `.soma/skills/a.md`: A')
    && blk.indexOf('- `.soma/skills/a.md`: A') < blk.indexOf('### Read when relevant') && blk.includes('- `.soma/skills/b.md`: B. Read when parts move.')
    && !skillsBlock([{ id: 'b', name: 'B', when: '', mode: 'demand' }]).includes('Always follow') && skillsBlock([]).includes('No skills are switched on'), blk);

  // Bibliothek der Skills (E78): eigene in den App-Daten, eine eigene Datei ersetzt den mitgelieferten mit derselben Kennung
  const slOut = path.join(tmp, 'skilllibrary.mjs');
  await build({ entryPoints: [path.join(APP, 'src', 'main', 'skilllibrary.ts')], outfile: slOut, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
  const SL = await import(pathToFileURL(slOut).href);
  const { checkSkillText } = await import(pathToFileURL(sk).href);
  const snOut = path.join(tmp, 'skillname.mjs');
  await build({ entryPoints: [path.join(APP, 'src', 'shared', 'skillname.ts')], outfile: snOut, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
  const { skillIdFrom } = await import(pathToFileURL(snOut).href);
  const shippedWarnings = shipped.flatMap((s) => checkSkillText(s.text).warnings.map((w) => `${s.id}: ${w}`));
  check('Mitgelieferte Skills: Prüfung ohne Fehler und Hinweise', shipped.every((s) => !checkSkillText(s.text).errors.length) && !shippedWarnings.length, shippedWarnings.slice(0, 3).join(' | '));
  const ck = checkSkillText('---\ntitle: T\nTitel: x\nvar Dicke: 2 | mm\nvar wall: 30 | mm | Wand | 1..10\nvar unused: 1\ndefault: maybe\n---\n# T\n\n{{wall}} und {{missing}}\n');
  const has = (re) => ck.warnings.some((w) => re.test(w));
  check('Prüfung: unbekannter Schlüssel, falsche Einstellung, Standard außerhalb, ungenutzt, Platzhalter ohne Einstellung, Stufe, fehlende Angaben',
    !ck.errors.length && has(/Unknown key “Titel”/) && has(/Header line 4: “var Dicke/) && has(/default 30 is outside 1..10/) && has(/“unused” is not used/)
    && has(/“\{\{missing\}\}” has no setting/) && has(/“default: maybe” is not a level/) && has(/No “summary:”/) && has(/No “when:”/) && !has(/“wall” is not used/), ck.warnings.join(' | '));
  check('Prüfung: leer und zu groß sind Fehler, ohne Kopf ein Hinweis, offener Kopf eigens gemeldet', checkSkillText('  \n').errors.length === 1
    && checkSkillText('x'.repeat(300 * 1024)).errors.some((e) => /larger than 256 KB/.test(e)) && checkSkillText('# Nur Text\n\nRegel.\n').warnings.some((w) => /No header/.test(w))
    && checkSkillText('---\ntitle: A\n# A\n').warnings.some((w) => /no closing/.test(w)));
  check('Kennung aus dem Namen: Kleinbuchstaben, Umlaute umschrieben, Länge begrenzt, leer wird „skill“', skillIdFrom('Schweißen & Löten (Stahl)') === 'schweissen-loeten-stahl'
    && skillIdFrom('Café Règles') === 'cafe-regles' && skillIdFrom('!!!') === 'skill' && skillIdFrom('a'.repeat(60)).length === 36);

  const LIB = { bundled: path.join(APP, 'resources', 'skills'), user: path.join(tmp, 'eigene-skills') };
  const lbak = path.join(tmp, 'skills-sicherung');
  const libIds = () => SL.libraryState(LIB, {}, {}).skills;
  check('Bibliothek ohne eigene Skills: die mitgelieferten, alle „builtin“', libIds().length === shipped.length && libIds().every((s) => s.source === 'builtin'));
  const mine = SL.createLibrarySkill(LIB, 'Geschweißte Rahmen');
  const mineText = fs.readFileSync(path.join(LIB.user, `${mine}.md`), 'utf8');
  const mineCheck = checkSkillText(mineText);
  check('Neuer Skill: Kennung aus dem Name, Vorlage mit Kopf (Kategorie „My skills“, Bei Bedarf), Vorlage ohne Hinweise, in der Bibliothek als „own“',
    mine === 'geschweisste-rahmen' && mineText.startsWith('---\ntitle: Geschweißte Rahmen\nname: Geschweißte Rahmen\n') && mineText.includes('# Skill: Geschweißte Rahmen')
    && !mineCheck.warnings.length && libIds().find((s) => s.id === mine)?.source === 'own' && libIds().find((s) => s.id === mine)?.category === 'My skills'
    && SL.libraryState(LIB, {}, {}).skills.find((s) => s.id === mine)?.defaultMode === 'demand', mineCheck.warnings.join(' | '));
  check('Gleicher Name noch einmal: eigene Kennung mit -2', SL.createLibrarySkill(LIB, 'Geschweißte Rahmen') === 'geschweisste-rahmen-2');
  check('Name fehlt oder zu lang: abgelehnt', (() => { try { SL.createLibrarySkill(LIB, '  '); return false; } catch { return true; } })()
    && (() => { try { SL.createLibrarySkill(LIB, 'x'.repeat(81)); return false; } catch { return true; } })());
  const dupId = SL.createLibrarySkill(LIB, 'Mein 3D-Druck', '3d-druck');
  const dupText = fs.readFileSync(path.join(LIB.user, `${dupId}.md`), 'utf8');
  check('Duplikat eines mitgelieferten: neuer Titel und Name im Kopf und in der Überschrift, Einstellungen bleiben', dupId === 'mein-3d-druck' && dupText.includes('title: Mein 3D-Druck\nname: Mein 3D-Druck\n')
    && dupText.includes('# Skill: Mein 3D-Druck') && dupText.includes('var overhang: 45') && !dupText.includes('title: 3D printing'));

  // Mitgelieferten bearbeiten: eigene Datei, Herkunft „edited“, Fingerabdruck der mitgelieferten Fassung
  const fdmBuiltin = SL.readLibrarySkill(LIB, '3d-druck');
  const edited = fdmBuiltin.text.replace('summary: ', 'summary: Edited. ');
  const sv = SL.saveLibrarySkill(LIB, '3d-druck', edited, fdmBuiltin.text, lbak);
  const st1 = SL.libraryState(LIB, {}, { '3d-druck': sv.base });
  check('Mitgelieferten speichern: eigene Datei, „edited“, Fingerabdruck der mitgelieferten Fassung, Bibliothek liefert die bearbeitete', sv.backup === null && sv.base === SL.textHash(fdmBuiltin.text)
    && fs.existsSync(path.join(LIB.user, '3d-druck.md')) && st1.skills.find((s) => s.id === '3d-druck').source === 'edited' && !st1.skills.find((s) => s.id === '3d-druck').newerBuiltin
    && st1.skills.find((s) => s.id === '3d-druck').summary.startsWith('Edited. ') && SL.readLibrarySkill(LIB, '3d-druck').builtin === fdmBuiltin.builtin);
  check('Neuere mitgelieferte Fassung (anderer Fingerabdruck): gemeldet', SL.libraryState(LIB, {}, { '3d-druck': 'alt' }).skills.find((s) => s.id === '3d-druck').newerBuiltin);
  // Außerhalb der App geändert (Datei weicht von `base` ab): diese Fassung kommt in die Sicherung
  fs.writeFileSync(path.join(LIB.user, '3d-druck.md'), edited + '\nvon außen\n');
  const sv2 = SL.saveLibrarySkill(LIB, '3d-druck', edited + '\nneu\n', edited, lbak);
  check('Datei außerhalb geändert: alte Fassung in der Sicherung, neue geschrieben', !!sv2.backup && fs.readFileSync(sv2.backup, 'utf8').includes('von außen')
    && fs.readFileSync(path.join(LIB.user, '3d-druck.md'), 'utf8').endsWith('\nneu\n'));
  check('Fehler im Text (leer): nicht gespeichert', (() => { try { SL.saveLibrarySkill(LIB, '3d-druck', ' ', null, lbak); return false; } catch (e) { return /empty/.test(e.message); } })()
    && fs.readFileSync(path.join(LIB.user, '3d-druck.md'), 'utf8').endsWith('\nneu\n'));
  // Zurück auf den Text der mitgelieferten Fassung getippt: keine eigene Datei mehr, die bearbeitete in der Sicherung
  const sv3 = SL.saveLibrarySkill(LIB, '3d-druck', fdmBuiltin.builtin, edited + '\nneu\n', lbak);
  check('Text gleich der mitgelieferten Fassung: eigene Datei weg (gesichert), wieder „builtin“', sv3.base === null && !!sv3.backup && !fs.existsSync(path.join(LIB.user, '3d-druck.md'))
    && libIds().find((s) => s.id === '3d-druck').source === 'builtin');
  SL.saveLibrarySkill(LIB, '3d-druck', edited, fdmBuiltin.builtin, lbak);
  const rb = SL.removeLibrarySkill(LIB, '3d-druck', lbak);
  check('Zurücksetzen: eigene Fassung in der Sicherung, wieder die mitgelieferte', !!rb && fs.readFileSync(rb, 'utf8') === edited && libIds().find((s) => s.id === '3d-druck').source === 'builtin');
  check('Mitgelieferte lassen sich nicht löschen', (() => { try { SL.removeLibrarySkill(LIB, 'cnc', lbak); return false; } catch (e) { return /cannot be deleted/.test(e.message); } })());
  const rm = SL.removeLibrarySkill(LIB, 'geschweisste-rahmen-2', lbak);
  check('Eigenen löschen: Datei in der Sicherung, nicht mehr in der Bibliothek', !!rm && !libIds().some((s) => s.id === 'geschweisste-rahmen-2') && !fs.existsSync(path.join(LIB.user, 'geschweisste-rahmen-2.md')));

  // Neue Modelle bekommen eigene Skills nach ihrem Kopf (`default:`), Vorgaben des Nutzers gehen vor
  fs.writeFileSync(path.join(LIB.user, 'immer-eigen.md'), '---\ntitle: Immer\ncategory: My skills\ndefault: always\n---\n# Immer\n');
  const dmLib = defaultModes(LIB, { 'geschweisste-rahmen': 'off' });
  check('Neue Modelle: eigener Skill mit „default: always“ immer, eigener auf „Aus“ fehlt, der Rest wie bisher', dmLib.always.includes('immer-eigen') && !dmLib.demand.includes('geschweisste-rahmen')
    && !dmLib.always.includes('geschweisste-rahmen') && dmLib.demand.includes('mein-3d-druck') && dmLib.always.includes('normteile'), JSON.stringify(dmLib));
  // Dateien, die die App nicht liest, werden gemeldet, nicht umbenannt
  fs.writeFileSync(path.join(LIB.user, 'Meine Regeln.md'), '# X\n');
  fs.writeFileSync(path.join(LIB.user, 'notiz.txt'), 'x');
  const ign = SL.libraryState(LIB, {}, {}).ignored;
  check('Falsch benannte Datei: gemeldet mit Vorschlag, andere Dateitypen still übergangen', ign.length === 1 && ign[0].name === 'Meine Regeln.md' && /meine-regeln\.md/.test(ign[0].reason), JSON.stringify(ign));

  // Import: Kennung aus dem Dateinamen, Rückfrage bei vorhandener Kennung (ersetzen, Kopie, überspringen)
  const impDir = path.join(tmp, 'import');
  fs.mkdirSync(impDir);
  fs.writeFileSync(path.join(impDir, 'Kleben.md'), '---\ntitle: Kleben\nsummary: S.\ncategory: My skills\nwhen: parts are glued\n---\n# Kleben\n\nRegel.\n');
  fs.writeFileSync(path.join(impDir, 'immer-eigen.md'), '---\ntitle: Immer neu\n---\n# Immer neu\n');
  fs.writeFileSync(path.join(impDir, 'cnc.md'), '---\ntitle: Meine CNC\n---\n# Meine CNC\n');
  fs.writeFileSync(path.join(impDir, 'leer.md'), '\n');
  const asked = [];
  const answers = { 'immer-eigen': 'copy', cnc: 'replace' };
  const imp = await SL.importLibrarySkills(LIB, ['Kleben.md', 'immer-eigen.md', 'cnc.md', 'leer.md'].map((n) => path.join(impDir, n)), lbak, async (c) => { asked.push(`${c.id}:${c.source}`); return answers[c.id]; });
  check('Import: neue Kennung, Kopie bei vorhandenem eigenen, Ersetzen eines mitgelieferten (wird „edited“ mit Fingerabdruck), leere Datei gemeldet',
    imp.ids.join(',') === 'kleben,immer-eigen-2,cnc' && asked.join(',') === 'immer-eigen:own,cnc:builtin' && imp.warnings.length === 1 && /leer\.md/.test(imp.warnings[0])
    && libIds().find((s) => s.id === 'cnc').source === 'edited' && !!imp.bases.cnc && libIds().find((s) => s.id === 'kleben').source === 'own', JSON.stringify(imp));
  const imp2 = await SL.importLibrarySkills(LIB, [path.join(impDir, 'Kleben.md')], lbak, async () => 'replace');
  check('Import desselben Texts: nichts zu tun, gemeldet', !imp2.ids.length && /already there/.test(imp2.warnings[0] ?? ''), JSON.stringify(imp2));

  // Animationsdateien (E58): bauen die Animation neu, nicht das Modell
  const ed = path.join(tmp, 'editable.mjs');
  await build({ entryPoints: [path.join(APP, 'src', 'shared', 'editable.ts')], outfile: ed, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
  const { affectsBuild, affectsAnimation, readOnlyReason, fileOpBlockReason } = await import(pathToFileURL(ed).href);
  check('animations/*.py: Animation, kein Model-Build. model.py, parts/, inputs/ bauen das Modell', affectsAnimation('animations/deckel.py') && affectsAnimation('animations\\x.py')
    && !affectsBuild('animations/deckel.py') && affectsBuild('model.py') && affectsBuild('parts/lid.py') && affectsBuild('inputs/a.step')
    && !affectsAnimation('animations/sub/x.py') && !affectsAnimation('model.py') && !affectsAnimation('animations/notes.md'));
  check('parameters.json baut das Modell, ist im Editor nur lesbar, Umbenennen gesperrt, Löschen erlaubt', affectsBuild('parameters.json') && !affectsBuild('parts/parameters.json')
    && !!readOnlyReason('parameters.json') && !!fileOpBlockReason('parameters.json', 'rename') && fileOpBlockReason('parameters.json', 'delete') === null);
  check('Kopien der Skills: im Editor nur lesbar, im Dateibaum kein Anlegen, Umbenennen, Löschen (Grund nennt das Panel), Markierungen schon',
    /Skill/.test(readOnlyReason('.soma/skills/cnc.md') ?? '') && /“Skills”/.test(fileOpBlockReason('.soma/skills/cnc.md', 'rename') ?? '')
    && !!fileOpBlockReason('.soma/skills/cnc.md', 'delete') && !!fileOpBlockReason('.soma/skills/neu.md', 'create') && !!fileOpBlockReason('.soma/skills', 'delete')
    && fileOpBlockReason('.soma/feedback/a.png', 'delete') === null && /Internal/.test(fileOpBlockReason('.soma/project.json', 'delete') ?? ''));

  // Werte aus dem Parameter-Panel (parameters.json): lesen, prüfen, schreiben, beim letzten Eintrag die Datei entfernen
  const pmOut = path.join(tmp, 'params.mjs');
  await build({ entryPoints: [path.join(APP, 'src', 'main', 'params.ts')], outfile: pmOut, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
  const { readUserParams, writeUserParams, checkParamValue } = await import(pathToFileURL(pmOut).href);
  const pdir = path.join(tmp, 'params-projekt');
  fs.mkdirSync(pdir);
  const pfile = path.join(pdir, 'parameters.json');
  check('Ohne parameters.json: keine Werte, kein Fehler', JSON.stringify(readUserParams(pdir)) === '{"rest":{},"values":{}}');
  let perr = writeUserParams(pdir, { BORE: 40, LID: false, NAME: 'Grüße' });
  let pj = JSON.parse(fs.readFileSync(pfile, 'utf8'));
  check('Schreiben: Werte unter „values“, Notiz für den Agenten, keine Zwischendatei', perr === null && pj.values.BORE === 40 && pj.values.LID === false && pj.values.NAME === 'Grüße'
    && /Parameters panel/.test(pj.note) && fs.readdirSync(pdir).join(',') === 'parameters.json', JSON.stringify(pj));
  fs.writeFileSync(pfile, '﻿' + JSON.stringify({ note: 'x', variants: { a: 1 }, values: { BORE: 40, BAD: [1], N: Infinity } }));
  check('Lesen: BOM erlaubt, unbrauchbare Werte fallen weg, fremde Schlüssel bleiben', JSON.stringify(readUserParams(pdir).values) === '{"BORE":40}' && readUserParams(pdir).rest.variants?.a === 1);
  perr = writeUserParams(pdir, { BORE: null });
  pj = JSON.parse(fs.readFileSync(pfile, 'utf8'));
  check('Letzter Wert entfernt, aber fremder Inhalt: Datei bleibt mit leeren Werten', perr === null && JSON.stringify(pj.values) === '{}' && pj.variants?.a === 1);
  fs.writeFileSync(pfile, JSON.stringify({ values: { A: 1 } }));
  check('Letzter Wert entfernt, sonst nichts: Datei verschwindet', writeUserParams(pdir, { A: null }) === null && !fs.existsSync(pfile));
  fs.writeFileSync(pfile, '{ kaputt');
  perr = writeUserParams(pdir, { A: 2 });
  check('Kaputte Datei: gemeldet, nicht überschrieben (melden statt reparieren)', /not valid JSON/.test(readUserParams(pdir).error ?? '') && /Nothing was changed/.test(perr ?? '')
    && fs.readFileSync(pfile, 'utf8') === '{ kaputt', perr ?? '');
  check('Ungültiger Name wird abgelehnt', /not a parameter name/.test(writeUserParams(path.join(tmp, 'leer-' + process.pid), { 'a-b': 1 }) ?? ''));
  const def = (kind, extra = {}) => ({ name: 'X', label: 'X', kind, default: 1, value: 1, source: 'code', min: null, max: null, step: null, unit: null, options: null, group: null, help: null, file: 'model.py', line: 1, ...extra });
  check('Prüfung nach Typ: Zahl, ganze Zahl, Schalter, Auswahl, Text; Bereich zählt nicht', checkParamValue(def('number', { max: 5 }), 99) === null && !!checkParamValue(def('number'), 'a')
    && !!checkParamValue(def('int'), 1.5) && checkParamValue(def('int'), 3) === null && !!checkParamValue(def('bool'), 1) && checkParamValue(def('bool'), true) === null
    && checkParamValue(def('choice', { options: [{ value: 'a', label: 'A' }] }), 'a') === null && !!checkParamValue(def('choice', { options: [{ value: 'a', label: 'A' }] }), 'b')
    && checkParamValue(def('text'), 'hallo') === null && !!checkParamValue(def('text'), 5));

  // Zwischenergebnisse der App (Ergebnisse von soma analyze bis 70 MB) nicht in Snapshot und ZIP, auch in älteren
  // Projekten ohne die Einträge in der .gitignore. dugite (und die CommonJS-Pakete für ZIP) bleiben extern, das Bündel
  // liegt deshalb in app/ (dort findet Node node_modules).
  const gz = path.join(APP, 'test', `.unit-gitzip-${process.pid}.mjs`);
  await build({ stdin: { contents: "export { GitRepo } from './src/main/git.ts'; export { saveProjectZip, readZipTexts } from './src/main/zip.ts';", resolveDir: APP, loader: 'ts' },
    outfile: gz, bundle: true, platform: 'node', format: 'esm', external: ['dugite', 'yazl', 'yauzl'], logLevel: 'silent' });
  try {
    const { GitRepo, saveProjectZip, readZipTexts } = await import(pathToFileURL(gz).href);
    const old = path.join(tmp, 'altprojekt');
    const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(old, rel)), { recursive: true }); fs.writeFileSync(path.join(old, rel), text); };
    put('model.py', 'x = 1\n');
    put('.gitignore', '__pycache__/\n'); // Stand vor E58
    const repo = new GitRepo(old);
    await repo.init('New model created');
    // So hat es der Agent in älteren Projekten mit `git add -A` committet
    put('.soma/results/thickness.glb', 'GROSS');
    put('renders/view-iso.png', 'PNG');
    await repo.run(['add', '-A'], true);
    await repo.run(['commit', '-q', '-m', 'Agent'], true);
    await repo.ensureIgnored();
    await repo.ensureIgnored();
    const excl = fs.readFileSync(path.join(old, '.git', 'info', 'exclude'), 'utf8');
    check('Ältere Projekte: .git/info/exclude nennt .soma/results/, .soma/anim/ und renders/ (einmal), die .gitignore bleibt',
      excl.split('\n').filter((l) => l === '.soma/results/').length === 1 && excl.includes('.soma/anim/') && excl.includes('renders/')
      && fs.readFileSync(path.join(old, '.gitignore'), 'utf8') === '__pycache__/\n', excl.slice(-160));
    put('.soma/results/thickness.glb', 'NEU UND GROSS');
    put('.soma/anim/deckel.glb', 'ANIM');
    put('.soma/drawings/Halter.png', 'BILD'); // Bild der Zeichnung für den Agenten (E76), PDF und DXF liegen in output/
    check('Neues Ergebnis zählt nicht als ungespeicherte Änderung', !(await repo.status()).dirty);
    put('model.py', 'x = 2\n');
    await repo.snapshot('Automatic snapshot on save');
    const tracked = (await repo.run(['ls-files'])).out;
    check('Snapshot nimmt Ergebnis und Bilder aus dem Verlauf, die Dateien bleiben', tracked.includes('model.py') && !tracked.includes('.soma/results')
      && !tracked.includes('renders/') && !tracked.includes('.soma/drawings') && fs.existsSync(path.join(old, '.soma', 'results', 'thickness.glb')), tracked);
    const zip = path.join(tmp, 'altprojekt.zip');
    await saveProjectZip(old, zip, { savedAt: '', head: null, id: 'x', name: 'x' });
    const inZip = await readZipTexts(zip, ['model.py', '.soma/results/thickness.glb', '.soma/anim/deckel.glb', 'renders/view-iso.png', '.soma/drawings/Halter.png']);
    check('ZIP: ohne .soma/results, .soma/anim, .soma/drawings und renders/ (E75, E76), mit Modell', inZip['model.py'] === 'x = 2\n' && inZip['.soma/results/thickness.glb'] === null
      && inZip['.soma/anim/deckel.glb'] === null && inZip['renders/view-iso.png'] === null && inZip['.soma/drawings/Halter.png'] === null, JSON.stringify(inZip));

    // Packen vor der ZIP (E75): Verlauf und Hashes bleiben. Unerreichbares geht nicht verloren: der Blob, den addAll oben aus
    // dem Index genommen hat (lose), und ein Objekt, das nur in einem älteren Pack liegt (ohne --keep-unreachable weg).
    const loose = async () => Number(/^count: (\d+)$/m.exec((await repo.run(['count-objects', '-v'])).out)?.[1] ?? -1);
    const commitsBefore = (await repo.run(['log', '--format=%H'])).out;
    fs.writeFileSync(path.join(tmp, 'unerreichbar.txt'), 'nur in einem alten Pack');
    const orphan = (await repo.run(['hash-object', '-w', path.join(tmp, 'unerreichbar.txt')], true)).out.trim();
    await repo.run(['tag', 'halten', orphan], true);
    const packed = await repo.pack();
    const packs = fs.readdirSync(path.join(old, '.git', 'objects', 'pack')).filter((f) => f.endsWith('.pack'));
    check('pack(): ein Pack, keine losen Objekte, Verlauf gleich, fsck ohne Fehler', packed && packs.length === 1 && (await loose()) === 0
      && (await repo.run(['log', '--format=%H'])).out === commitsBefore && (await repo.run(['fsck', '--no-dangling'])).ok, `${packed} ${packs} ${await loose()}`);
    check('pack() ohne lose Objekte tut nichts', (await repo.pack()) === false);
    await repo.run(['tag', '-d', 'halten'], true);
    put('model.py', 'x = 3\n');
    await repo.snapshot('Automatic snapshot on save');
    check('pack() nach neuem Snapshot: Unerreichbares aus dem alten Pack bleibt erhalten', (await repo.pack()) === true
      && (await repo.run(['cat-file', '-e', orphan])).ok && fs.readdirSync(path.join(old, '.git', 'objects', 'pack')).filter((f) => f.endsWith('.pack')).length === 1);
  } finally {
    fs.rmSync(gz, { force: true });
  }

  // Letzter Build beim Öffnen übernehmen (statt neu zu bauen) und als Vorschau eines Commits ablegen. paths.ts braucht
  // electron nur in Funktionen, die hier nicht laufen: ersetzt durch eine leere Attrappe.
  const bp = path.join(tmp, 'buildstate.mjs');
  const noElectron = { name: 'ohne-electron', setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'attrappe' }));
    b.onLoad({ filter: /.*/, namespace: 'attrappe' }, () => ({ contents: 'export const app = undefined;', loader: 'js' }));
  } };
  await build({ stdin: { contents: "export { newestBuildInput, buildIsStale, currentBuild, OUTPUT_FORMAT } from './src/main/build.ts'; export { storeBuildAsPreview } from './src/main/previews.ts';", resolveDir: APP, loader: 'ts' },
    outfile: bp, bundle: true, platform: 'node', format: 'esm', plugins: [noElectron], logLevel: 'silent' });
  const { newestBuildInput, buildIsStale, currentBuild, OUTPUT_FORMAT, storeBuildAsPreview } = await import(pathToFileURL(bp).href);
  const bd = path.join(tmp, 'gebaut');
  const put2 = (rel, data, secs) => {
    const f = path.join(bd, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, data);
    if (secs != null) fs.utimesSync(f, secs, secs);
  };
  const T = 1_700_000_000; // Sekunden
  put2('model.py', 'x', T); put2('parts/a.py', 'x', T + 10);
  // Neuer, aber ohne Einfluss auf das Modell: Notizen, Ausgaben, App-Daten, Animationen, Caches
  put2('NOTES.md', 'x', T + 500); put2('output/model.step', 'x', T + 500); put2('.soma/x.py', 'x', T + 500);
  put2('animations/a.py', 'x', T + 500); put2('parts/__pycache__/a.py', 'x', T + 500);
  check('Quellen des Modells: .py überall und inputs/, nicht Notizen, Ausgaben, .soma, Animationen', newestBuildInput(bd) === (T + 10) * 1000, String(newestBuildInput(bd)));
  put2('lib/tief/hilfe.py', 'x', T + 20); put2('inputs/teil.step', 'x', T + 30);
  check('Auch Hilfsmodule außerhalb von parts/ und Dateien in inputs/ zählen', newestBuildInput(bd) === (T + 30) * 1000);

  const BID = 'ab'.repeat(16);
  const glb = Buffer.alloc(20);
  glb.writeUInt32LE(0x46546c67, 0); glb.writeUInt32LE(2, 4); glb.writeUInt32LE(20, 8);
  const map = { version: 0, build: BID, parts: [{ id: '0:Body', name: 'Body', step_name: 'Body', role: 'part', file: 'model.py', line: 3, end_line: 4 }] };
  const writeBuild = (b) => put2('.soma/build.json', JSON.stringify({ status: 'ok', format: OUTPUT_FORMAT, started: T + 40, finished: T + 45, parts: [], ...b }));
  writeBuild({});
  put2('.soma/model.glb', glb); put2('.soma/model.map.json', JSON.stringify(map)); put2(`.soma/geometry/${BID}.brep`, 'BREP');
  check('Build nach der letzten Änderung, alles da: gilt noch (kein Neubau beim Öffnen)', !buildIsStale(bd) && currentBuild(bd)?.finished === T + 45);
  writeBuild({ started: T + 25 });
  check('Quelle neuer als der Start des Builds (Änderung während des Builds): veraltet', buildIsStale(bd) && currentBuild(bd) === null);
  writeBuild({ format: undefined });
  check('build.json ohne Fassung (ältere soma): neu bauen', currentBuild(bd) === null);
  writeBuild({ status: 'error' });
  check('Letzter Build fehlgeschlagen: neu bauen', currentBuild(bd) === null);
  writeBuild({});
  fs.renameSync(path.join(bd, '.soma', 'geometry', `${BID}.brep`), path.join(bd, '.soma', 'geometry', 'weg.brep'));
  check('Geometrie zum Messen fehlt (Build mittendrin abgebrochen): neu bauen', currentBuild(bd) === null);
  fs.renameSync(path.join(bd, '.soma', 'geometry', 'weg.brep'), path.join(bd, '.soma', 'geometry', `${BID}.brep`));

  const last = currentBuild(bd);
  const target = path.join(tmp, 'previews', 'p', 'c1');
  check('Vorschau aus dem Build ablegen', await storeBuildAsPreview(bd, target, last, () => true));
  const pm = JSON.parse(fs.readFileSync(path.join(target, 'model.map.json'), 'utf8'));
  check('Vorschau: GLB und Geometrie kopiert, Mapping ohne Code-Verweise, Rolle bleibt', fs.readFileSync(path.join(target, 'model.glb')).equals(glb)
    && fs.readFileSync(path.join(target, 'geometry', `${BID}.brep`), 'utf8') === 'BREP' && pm.build === BID && pm.parts[0].role === 'part'
    && !('file' in pm.parts[0]) && !('line' in pm.parts[0]) && !('end_line' in pm.parts[0]), JSON.stringify(pm.parts[0]));
  const target2 = path.join(tmp, 'previews', 'p', 'c2');
  check('Inzwischen neu gebaut (stillValid false): keine Vorschau', !(await storeBuildAsPreview(bd, target2, last, () => false)) && !fs.existsSync(target2));
  put2('.soma/model.glb', glb.subarray(0, 16));
  check('Abgeschnittene GLB (Build schreibt gerade): keine Vorschau', !(await storeBuildAsPreview(bd, target2, last, () => true)) && !fs.existsSync(target2));
  check('Keine halben Ordner übrig', fs.readdirSync(path.join(tmp, 'previews', 'p')).join(',') === 'c1');

  // Versionsnummer (E68): Major.minor.bugfix, eine für App und soma
  const appVersion = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8')).version;
  const pyInit = fs.readFileSync(path.join(APP, '..', 'python', 'soma', '__init__.py'), 'utf8');
  const pyproject = fs.readFileSync(path.join(APP, '..', 'python', 'pyproject.toml'), 'utf8');
  check('Version in package.json hat die Form Major.minor.bugfix', /^\d+\.\d+\.\d+$/.test(appVersion), appVersion);
  check('soma trägt dieselbe Version (__init__.py, pyproject liest sie dort)', new RegExp(`^__version__ = "${appVersion.replace(/\./g, '\\.')}"`, 'm').test(pyInit)
    && /dynamic = \["version"\]/.test(pyproject) && /version = \{ attr = "soma.__version__" \}/.test(pyproject));
  const vout = path.join(tmp, 'version.mjs');
  await build({ entryPoints: [path.join(APP, 'src', 'shared', 'version.ts')], outfile: vout, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent',
    define: { __SOMA_VERSION__: JSON.stringify('0.4.2') } });
  const { SOMA_VERSION, isNewerVersion, parseVersion } = await import(pathToFileURL(vout).href);
  check('Beim Bauen eingesetzt (define), Vergleich zahlenweise (0.10.0 neuer als 0.9.9)', SOMA_VERSION === '0.4.2' && isNewerVersion('0.4.3') && isNewerVersion('1.0.0')
    && !isNewerVersion('0.4.2') && !isNewerVersion('0.3.9') && isNewerVersion('0.10.0', '0.9.9'));
  check('Unlesbare Nummern gelten nicht als neuer', !isNewerVersion('9.x') && !isNewerVersion(undefined) && !isNewerVersion(42) && parseVersion(' 1.2.3 ')?.join() === '1,2,3');

  // Einstellungen der App (E81): Prüfung gelesener Werte, Änderungen, Mausbelegungen
  const sOut = path.join(tmp, 'settings.mjs');
  await build({ entryPoints: [path.join(APP, 'src', 'shared', 'settings.ts')], outfile: sOut, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
  const S = await import(pathToFileURL(sOut).href);
  const c1 = S.cleanSettings({ viewer: { navigation: 'creo', decimals: 7, edges: 'ja', invertZoom: true }, extra: 1 });
  check('Gelesene Einstellungen: Gültiges gilt, Ungültiges bekommt die Vorgabe und wird genannt, Unbekanntes fällt weg',
    c1.settings.viewer.navigation === 'creo' && c1.settings.viewer.invertZoom === true && c1.settings.viewer.decimals === 2 && c1.settings.viewer.edges === true
    && c1.ignored.join() === 'viewer.edges,viewer.decimals' && !('extra' in c1.settings), c1.ignored.join());
  check('Ohne Datei oder mit Unsinn: Vorgaben', JSON.stringify(S.cleanSettings(null).settings) === JSON.stringify(S.DEFAULT_SETTINGS)
    && S.cleanSettings({ viewer: [1] }).ignored.join() === 'viewer' && S.cleanSettings('x').ignored.length === 0);
  const p1 = S.applyPatch(S.DEFAULT_SETTINGS, { viewer: { projection: 'orthographic', decimals: 4 } });
  check('Änderung: nur die genannten Werte, die Vorgaben bleiben unverändert', p1.settings?.viewer.projection === 'orthographic' && p1.settings.viewer.decimals === 4
    && p1.settings.viewer.navigation === 'soma' && S.DEFAULT_SETTINGS.viewer.projection === 'perspective');
  check('Änderung abgelehnt: ungültiger Wert, unbekannter Schlüssel, kein Objekt', /decimals/.test(S.applyPatch(S.DEFAULT_SETTINGS, { viewer: { decimals: 1.5 } }).error ?? '')
    && /viewer\.speed/.test(S.applyPatch(S.DEFAULT_SETTINGS, { viewer: { speed: 2 } }).error ?? '') && /theme/.test(S.applyPatch(S.DEFAULT_SETTINGS, { theme: 'light' }).error ?? '')
    && !!S.applyPatch(S.DEFAULT_SETTINGS, null).error);
  check('Belegungen: SOMA tauscht mit Umschalt/Strg wie OrbitControls, SolidWorks lässt links frei, Rhino zoomt mit Strg + rechts',
    S.navAction('soma', 'left', '') === 'rotate' && S.navAction('soma', 'left', 'ctrl') === 'pan' && S.navAction('soma', 'right', 'shift') === 'rotate'
    && S.navAction('solidworks', 'left', '') === null && S.navAction('solidworks', 'middle', 'ctrl') === 'pan' && S.navAction('rhino', 'right', 'ctrl') === 'zoom'
    && S.NAV_PRESETS.every((p) => p.bindings.every((b) => p.bindings.filter((x) => x.button === b.button && x.mod === b.mod).length === 1)));
  const lg = Object.fromEntries(S.navLegend('soma').map((l) => [l.action, l.how]));
  check('Legende: erst ohne Taste, dann mit, Umschalt und Strg zusammengefasst, Zoom mit Mausrad vorn', lg.pan === 'right drag, Shift or Ctrl + left drag'
    && lg.zoom === 'wheel, middle drag, Shift or Ctrl + middle drag' && S.navLegend('fusion').find((l) => l.action === 'zoom').how === 'wheel', JSON.stringify(lg));
} catch (e) {
  console.log('ABBRUCH:', e.message);
  t.fail();
}
cleanup(tmp);
console.log(t.fails ? `\n${t.fails} Prüfung(en) fehlgeschlagen` : '\nALLE PRÜFUNGEN BESTANDEN');
process.exit(t.fails ? 1 : 0);
