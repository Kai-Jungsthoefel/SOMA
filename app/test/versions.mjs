// Test für Git-Verlauf, ZIP speichern/öffnen, Vorschau und Wiederherstellen, dazu die Störfälle aus PLAN.md Abschnitt 9.
// Aufruf: npm run test:versions (baut vorher).
import { exec } from 'dugite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import yauzl from 'yauzl';
import yazl from 'yazl';
import { checker, cleanup, sleep, startApp } from './harness.mjs';

const t = checker();
const { check } = t;
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadide-vt-'));
let app;

const listZip = (p) => new Promise((resolve, reject) => yauzl.open(p, { lazyEntries: true }, (e, z) => {
  if (e) return reject(e);
  const names = [];
  z.on('entry', (en) => { names.push(en.fileName); z.readEntry(); });
  z.on('end', () => resolve(names));
  z.readEntry();
}));
const rmRetry = async (p) => { for (let i = 0; i < 10; i++) { try { fs.rmSync(p, { recursive: true, force: true }); return; } catch { await sleep(300); } } };

try {
  app = await startApp({ name: 'versions' });
  const { ev, waitFor, domClick, ud, page } = app;
  await waitFor('Projekt und Build', () => !!window.__t && !!window.__t.project() && window.__t.status().state === 'ok' && window.__t.partCount() === 2);
  const proj = await ev(() => window.__t.project());
  const dir = proj.dir;
  const g = async (...args) => (await exec(args, dir)).stdout.trim();
  const modelPy = path.join(dir, 'model.py');
  const term = () => ev(() => window.__t.terminals.activeId);
  const type = async (cmd) => { const id = await term(); await ev(([i, c]) => window.cadide.term.write(i, c + '\r'), [id, cmd]); };
  const termText = async () => ev((i) => window.__t.termText(i), await term());
  const zipPath = path.join(workDir, 'Testmodell.zip');
  const versions = () => ev(() => window.__t.versions());
  const saveState = () => ev(() => window.__t.saveState());

  // ---- 1) Neues Projekt hat einen Git-Verlauf, mitgeliefertes Git im Terminal ----
  await waitFor('Verlauf geladen', () => window.__t.versions().count === 1);
  check('Neues Projekt: Git-Repository mit Startcommit', (await g('log', '--format=%s')) === 'Neues Modell angelegt');
  check('Startcommit enthält output/model.step (Vorschau des ersten Standes möglich)', (await g('ls-files', 'output/model.step')) === 'output/model.step');
  check('Nach dem ersten Build gilt der Stand als sauber (output/ zählt nicht)', (await versions()).dirtyFiles === 0);
  check('Git-Identität ist gesetzt (Agent kann committen)', (await g('config', 'user.name')).length > 0 && (await g('config', 'user.email')).length > 0);
  check('Zeilenenden werden nicht umgewandelt (autocrlf aus)', (await g('config', 'core.autocrlf')) === 'false');
  await type('git --version');
  await waitFor('git im Terminal', (i) => /git version 2\.\d+/.test(window.__t.termText(i)), 20000, await term());
  check('Im Terminal läuft das mitgelieferte Git (2.53)', /git version 2\.53/.test(await termText()), (await termText()).match(/git version [\d.]+\S*/)?.[0] ?? '');

  // ---- 2) Agent committet selbst ----
  const src = fs.readFileSync(modelPy, 'utf8');
  fs.writeFileSync(modelPy, src.replace('LENGTH = 60.0', 'LENGTH = 80.0'));
  await waitFor('Build mit Länge 80', () => window.__t.status().state === 'ok' && (window.__t.partSize('Body') || [0])[0] > 79);
  check('Änderung am Modell erscheint im Viewer (Body 80 mm lang)', (await ev(() => window.__t.partSize('Body')))[0] === 80);
  await waitFor('ungesicherte Änderung', () => window.__t.versions().dirtyFiles === 1);
  check('Ungesicherte Änderung wird angezeigt (1 Datei)', true);
  await type('git add -A; git commit -q -m "Laenge auf 80"');
  await waitFor('zweiter Stand im Verlauf', () => window.__t.versions().count === 2, 20000);
  check('Commit des Agenten erscheint in der Verlaufsleiste', (await versions()).subjects.includes('Laenge auf 80'));
  const kinds = (await versions()).byApp;
  check('Leiste unterscheidet App-Stand (Start) und Agenten-Stand', kinds[0] === true && kinds[1] === false, JSON.stringify(kinds));
  check('App-Commits tragen den Trailer „Erstellt-von: CAD-IDE"', (await g('log', '--format=%(trailers:key=Erstellt-von,valueonly)', 'HEAD~1')).includes('CAD-IDE'));
  check('Commit enthält die STEP-Datei des gebauten Standes', (await g('show', '--stat', '--format=', 'HEAD')).includes('output/model.step'));

  // ---- 3) Speichern: Snapshot + ZIP ----
  fs.appendFileSync(path.join(dir, 'NOTES.md'), '\nWunsch: Deckel mit Lippe\n');
  await waitFor('Notizänderung', () => window.__t.saveState() && window.__t.saveState().dirtyFiles === 1);
  check('Vor dem Speichern: Badge „ungespeichert"', (await saveState()).unsaved === true);
  await app.answers([zipPath]);
  await domClick('btn-save');
  await waitFor('gespeichert', () => window.__t.saveState() && !window.__t.saveState().unsaved && window.__t.saveState().zipPath, 60000);
  check('ZIP wurde geschrieben', fs.existsSync(zipPath), `${Math.round(fs.statSync(zipPath).size / 1024)} KB`);
  const names = await listZip(zipPath);
  check('ZIP enthält Modell, .git, Projektdaten und Marker', ['model.py', '.git/HEAD', '.cadide/project.json', '.cadide/zip-info.json', 'AGENTS.md'].every((n) => names.includes(n)));
  check('ZIP enthält keine Caches (GLB, Mapping, build.json, __pycache__)', !names.some((n) => /model\.glb|model\.map\.json|build\.json|__pycache__/.test(n)));
  await waitFor('Meldung und Name', () => window.__t.toast().text.startsWith('Gespeichert') && window.__t.project().name === 'Testmodell', 20000);
  check('Auto-Snapshot beim Speichern hat die Notiz gesichert', (await g('log', '-1', '--format=%s')) === 'Automatischer Snapshot beim Speichern');
  check('Modellname folgt dem Dateinamen der ZIP', (await ev(() => window.__t.project())).name === 'Testmodell');
  check('Nach dem Speichern: sauber, Anzeige „Gespeichert · Uhrzeit"', (await saveState()).dirtyFiles === 0 && /^Gespeichert · \d\d:\d\d$/.test(await ev(() => document.getElementById('save-badge').textContent)), await ev(() => document.getElementById('save-badge').textContent));
  await waitFor('grüner Punkt', () => document.querySelectorAll('#vdots .vdot.saved').length === 1, 10000).catch(() => {});
  check('Verlaufsleiste markiert den gespeicherten Stand', await ev(() => document.querySelectorAll('#vdots .vdot.saved').length) === 1);
  check('Meldung „Gespeichert" erscheint', (await ev(() => window.__t.toast())).text.startsWith('Gespeichert'));
  const commitsBefore = (await g('rev-list', '--count', 'HEAD'));
  await app.domClick('btn-save');
  await sleep(2500);
  check('Zweites Speichern ohne Änderung legt keinen leeren Snapshot an', (await g('rev-list', '--count', 'HEAD')) === commitsBefore);

  // ---- 4) Vorschau alter Stände ----
  const first = await g('rev-parse', 'HEAD~2');
  await ev(() => document.querySelectorAll('#vdots .vdot')[0].click());
  await waitFor('Vorschau aktiv', () => !!window.__t.versions().previewing, 60000);
  await waitFor('Vorschau geladen', () => window.__t.partCount() === 2 && !window.__t.banner().hidden);
  check('Vorschau des ersten Standes: Body ist 60 mm lang (Arbeitsstand: 80)', (await ev(() => window.__t.partSize('Body')))[0] === 60);
  const bn = (await ev(() => window.__t.banner())).text.replace(/\s+/g, ' ').trim();
  check('Banner zeigt „Vorschau · Stand 1 von …, nur ansehen"', bn.includes('Vorschau · Stand 1 von') && bn.includes('nur ansehen') && bn.includes('Arbeitsstand bleibt unverändert'), bn.slice(0, 60));
  check('Viewer hat den Vorschau-Rahmen', await ev(() => document.getElementById('viewer').classList.contains('preview')));
  await sleep(800); // capturePage liefert bei unsichtbaren Fenstern sonst ein etwas älteres Bild
  const shot = await app.screenshot(path.join(import.meta.dirname, 'versions.png')).catch((e) => ({ error: String(e) }));
  check('Screenshot der Vorschau (Verlaufsleiste sichtbar)', !!shot.width, shot.width ? `${shot.width}x${shot.height}` : shot.error);
  check('Arbeitsordner blieb unberührt (model.py hat weiter 80)', fs.readFileSync(modelPy, 'utf8').includes('LENGTH = 80.0'));
  check('Kein neuer Commit durch die Vorschau', (await g('rev-list', '--count', 'HEAD')) === commitsBefore);
  fs.appendFileSync(modelPy, '\n# Kommentar während der Vorschau\n');
  await sleep(4000);
  check('Ein Build während der Vorschau ändert die Anzeige nicht', (await ev(() => window.__t.partSize('Body')))[0] === 60);
  fs.writeFileSync(modelPy, fs.readFileSync(modelPy, 'utf8').replace('\n# Kommentar während der Vorschau\n', ''));
  // Markierung einer Vorschau: Der Agent erfährt, dass das Bild einen alten Stand zeigt (sonst vergleicht er es mit dem aktuellen Code)
  await domClick('btn-mark');
  await waitFor('Zeichenfläche', () => window.__t.markup().active, 5000).catch(() => {});
  await domClick('btn-mark-send');
  const firstShort = await g('rev-parse', '--short', first);
  await waitFor('Markierung im Terminal', (i) => window.__t.termText(i).includes('[Markierung: .cadide/feedback/'), 10000, await term()).catch(() => {});
  check('Markierung in der Vorschau nennt den alten Stand', (await termText()).includes(`zeigt den älteren Stand ${firstShort} "Neues Modell angelegt"]`), (await termText()).match(/\[Markierung:[^\]]*\]/)?.[0]?.slice(0, 90) ?? '');
  check('Nach der Markierung läuft die Vorschau weiter', !!(await versions()).previewing && await ev(() => document.getElementById('viewer').classList.contains('preview')));
  await ev((i) => window.cadide.term.write(i, '\x03'), await term()); // Zeile verwerfen

  // ---- 5) Wiederherstellen als neuer Commit ----
  await app.answers([0]);
  await domClick('btn-restore');
  await waitFor('wiederhergestellt', () => !window.__t.versions().previewing && window.__t.versions().subjects.some((s) => s.startsWith('Stand wiederhergestellt')), 60000);
  check('Wiederherstellen legt einen NEUEN Commit an', (await g('log', '-1', '--format=%s')).startsWith('Stand wiederhergestellt: Neues Modell angelegt'));
  check('Verlauf blieb vollständig (alter Startcommit unverändert vorhanden)', (await g('cat-file', '-t', first)) === 'commit' && (await g('rev-list', '--count', 'HEAD')) > commitsBefore);
  check('Dateien sind zurück: model.py mit 60, Notiz-Wunsch entfernt', fs.readFileSync(modelPy, 'utf8').includes('LENGTH = 60.0') && !fs.readFileSync(path.join(dir, 'NOTES.md'), 'utf8').includes('Wunsch'));
  await waitFor('Build nach Wiederherstellung', () => window.__t.status().state === 'ok' && (window.__t.partSize('Body') || [0])[0] === 60);
  check('Live-Ansicht zeigt wieder den (wiederhergestellten) Stand, Body 60 mm', true);
  check('Kein HEAD-Umbau: Branch ist weiter main, nicht detached', (await g('symbolic-ref', '--short', 'HEAD')) === 'main');

  // ---- 6) Störfall: .git verschwindet (Agent hat es gelöscht/verschoben) ----
  await app.domClick('btn-save');
  await waitFor('gespeichert nach Restore', () => !window.__t.saveState().unsaved, 60000);
  check('ZIP enthält die Markierung aus .cadide/feedback/ (in Git ist sie nicht)', (await listZip(zipPath)).some((n) => /^\.cadide\/feedback\/markierung-\d{8}-\d{4}\.png$/.test(n))
    && (await g('ls-files', '.cadide/feedback')) === '');
  fs.renameSync(path.join(dir, '.git'), path.join(dir, '.git_weg'));
  await waitFor('Problem gemeldet', () => window.__t.versions().problems.some((p) => p.includes('Kein Git-Verlauf')), 20000);
  check('Ohne .git: Verlauf meldet das Problem verständlich', (await versions()).problems[0].includes('Kein Git-Verlauf'), (await versions()).problems[0].slice(0, 50));
  check('Ohne .git: App und Terminal laufen weiter', await ev(() => window.__t.terminals.count) === 1);
  fs.appendFileSync(path.join(dir, 'NOTES.md'), '\nohne git geändert\n');
  await sleep(300);
  await app.domClick('btn-save');
  await waitFor('Speichern ohne Git', () => window.__t.toast().text.includes('Kein Git-Verlauf'), 60000);
  check('Ohne .git: Speichern klappt trotzdem, mit Warnung', !(await ev(() => window.__t.toast())).hidden);
  fs.renameSync(path.join(dir, '.git_weg'), path.join(dir, '.git'));
  await waitFor('Problem weg', () => window.__t.versions().problems.length === 0, 20000);
  check('.git zurück: Meldung verschwindet', true);
  // Aufräumen: die Notiz-Änderung wieder in den Verlauf und die ZIP
  await app.domClick('btn-save');
  await waitFor('gespeichert', () => !window.__t.saveState().unsaved, 60000);

  // ---- 7) ZIP öffnen ----
  // A) identisch: kein Dialog, Arbeitsordner bleibt
  await app.answers([zipPath]);
  await domClick('btn-open');
  await sleep(2500);
  check('Öffnen der identischen ZIP: gleicher Arbeitsordner, keine Rückfrage', (await ev(() => window.__t.project())).id === proj.id && !(await ev(() => window.__t.toast())).error);
  // B) Arbeitsordner weicht ab -> „ZIP laden" sichert den Arbeitsstand
  fs.appendFileSync(path.join(dir, 'NOTES.md'), '\nLOKALE ÄNDERUNG\n');
  await waitFor('dirty', () => window.__t.saveState().dirtyFiles >= 1, 20000);
  await app.answers([zipPath, 1]);
  await domClick('btn-open');
  await waitFor('neu geöffnet', () => window.__t.status().state === 'ok' && !window.__t.saveState().unsaved && window.__t.saveState().dirtyFiles === 0, 60000);
  check('ZIP laden: Stand aus der ZIP ist da (lokale Änderung weg)', !fs.readFileSync(path.join(dir, 'NOTES.md'), 'utf8').includes('LOKALE ÄNDERUNG'));
  const backups = fs.existsSync(path.join(ud, 'workspace-backups')) ? fs.readdirSync(path.join(ud, 'workspace-backups')).filter((n) => n.startsWith(proj.id)) : [];
  check('Bisheriger Arbeitsordner liegt gesichert in workspace-backups/', backups.length === 1 && fs.readFileSync(path.join(ud, 'workspace-backups', backups[0], 'NOTES.md'), 'utf8').includes('LOKALE ÄNDERUNG'));
  const logBefore = await g('log', '--format=%s');
  // C) anderer Rechner: Arbeitsordner existiert nicht -> entpacken
  await domClick('btn-new');
  await waitFor('zweites Projekt', (id) => window.__t.project().id !== id && window.__t.status().state === 'ok', 90000, proj.id);
  await rmRetry(dir);
  fs.rmSync(path.join(ud, 'projects', `${proj.id}.json`), { force: true });
  await app.answers([zipPath]);
  await domClick('btn-open');
  await waitFor('entpackt und geöffnet', (id) => window.__t.project().id === id && window.__t.status().state === 'ok' && window.__t.versions().count > 1, 90000, proj.id);
  check('Arbeitsordner fehlt (anderer Rechner): ZIP wird entpackt und geöffnet', fs.existsSync(modelPy) && fs.readFileSync(modelPy, 'utf8').includes('LENGTH = 60.0'));
  check('Der Verlauf ist mitgekommen (gleiche Commits wie vorher)', (await g('log', '--format=%s')) === logBefore);
  check('Entpacktes Projekt gilt als gespeichert', (await saveState()).unsaved === false);
  // D) böse ZIP (Zip-Slip)
  const evil = path.join(workDir, 'boese.zip');
  const z = new yazl.ZipFile();
  z.addBuffer(Buffer.from(JSON.stringify({ id: randomUUID() })), '.cadide/project.json');
  z.addBuffer(Buffer.from('böse'), 'xx/evil.txt');
  z.end();
  const chunks = [];
  await new Promise((res) => { z.outputStream.on('data', (c) => chunks.push(c)); z.outputStream.on('end', res); });
  const raw = Buffer.concat(chunks);
  let at = 0, replaced = 0;
  while ((at = raw.indexOf('xx/evil.txt', at)) >= 0) { raw.write('../evil.txt', at); at += 11; replaced++; }
  fs.writeFileSync(evil, raw);
  await app.answers([evil]);
  await domClick('btn-open');
  await waitFor('Fehlermeldung', () => window.__t.toast().error, 20000);
  const evilToast = (await ev(() => window.__t.toast())).text;
  // Zwei Schichten: yauzl lehnt ungültige Pfade schon beim Lesen ab, unsere Prüfung beim Entpacken ist die zweite
  check(`Böse ZIP („../evil.txt", ${replaced} Einträge im Archiv) wird abgelehnt`, /Unsicher|invalid relative path/.test(evilToast), evilToast.slice(0, 70));
  check('Nichts außerhalb des Zielordners geschrieben, keine Reste', !fs.existsSync(path.join(ud, 'evil.txt')) && !fs.existsSync(path.join(ud, 'workspaces', 'evil.txt')) && !fs.readdirSync(path.join(ud, 'workspaces')).some((n) => n.startsWith('.tmp-')));
  check('Keine ZIP-Datei im Weg: Projekt bleibt offen und nutzbar', (await ev(() => window.__t.project().id)) === proj.id);

  // ---- 8) Absturz-Wiederherstellung: ungespeicherte Änderung überlebt ----
  fs.appendFileSync(path.join(dir, 'NOTES.md'), '\nungespeichert vor dem Absturz\n');
  await waitFor('ungespeichert', () => window.__t.saveState().unsaved, 20000);
  const ud2 = app.ud;
  app.crash();
  await sleep(1500);
  app = await startApp({ name: 'versions', userData: ud2 });
  await app.waitFor('Projekt wieder da', () => !!window.__t && !!window.__t.project() && window.__t.status().state === 'ok');
  check('Nach hartem Beenden öffnet die App dasselbe Projekt wieder', (await app.ev(() => window.__t.project().id)) === proj.id);
  check('Die ungespeicherte Änderung ist noch da und als ungespeichert markiert', fs.readFileSync(path.join(dir, 'NOTES.md'), 'utf8').includes('vor dem Absturz') && (await app.ev(() => window.__t.saveState().unsaved)));

  const relevant = page.errors.filter((e) => !/favicon/i.test(e));
  check('Keine Konsolenfehler im Renderer (vor dem Neustart)', relevant.length === 0, relevant.slice(0, 2).join(' | ').slice(0, 120));
} catch (e) {
  console.log('ABBRUCH:', e.message);
  t.fail();
}
if (app) { await app.stop(); cleanup(app.ud); }
cleanup(workDir);
console.log(t.fails ? `\n${t.fails} Prüfung(en) fehlgeschlagen` : '\nALLE PRÜFUNGEN BESTANDEN');
process.exit(t.fails ? 1 : 0);
