// Test für Git-Verlauf, Speichern als .soma (innen eine ZIP), Öffnen von .soma und .zip, Export als ZIP (E79), Vorschau und
// Wiederherstellen, dazu Störfälle im Arbeitsordner (Robustheit).
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
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-vt-'));
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
  const type = async (cmd) => { const id = await term(); await ev(([i, c]) => window.soma.term.write(i, c + '\r'), [id, cmd]); };
  const termText = async () => ev((i) => window.__t.termText(i), await term());
  const zipPath = path.join(workDir, 'Testmodell.soma');
  const versions = () => ev(() => window.__t.versions());
  const saveState = () => ev(() => window.__t.saveState());
  // Vorschau-Cache eines Standes (previews/<Projekt>/<Commit>) und Warten auf Dateien außerhalb des Fensters
  const cached = (hash) => path.join(ud, 'previews', proj.id, hash);
  const until = async (fn, ms = 15000) => { const t0 = Date.now(); while (!fn() && Date.now() - t0 < ms) await sleep(200); return fn(); };

  // ---- 1) Neues Projekt hat einen Git-Verlauf, mitgeliefertes Git im Terminal ----
  await waitFor('Verlauf geladen', () => window.__t.versions().count === 1);
  check('Neues Projekt: Git-Repository mit Startcommit', (await g('log', '--format=%s')) === 'New model created');
  check('Startcommit enthält output/model.step (Vorschau des ersten Standes möglich)', (await g('ls-files', 'output/model.step')) === 'output/model.step');
  check('Nach dem ersten Build gilt der Stand als sauber (output/ zählt nicht)', (await versions()).dirtyFiles === 0);
  check('Git-Identität ist gesetzt (Agent kann committen)', (await g('config', 'user.name')).length > 0 && (await g('config', 'user.email')).length > 0);
  check('Zeilenenden werden nicht umgewandelt (autocrlf aus)', (await g('config', 'core.autocrlf')) === 'false');
  await type('git --version');
  await waitFor('git im Terminal', (i) => /git version 2\.\d+/.test(window.__t.termText(i)), 20000, await term());
  check('Im Terminal läuft das mitgelieferte Git (2.53)', /git version 2\.53/.test(await termText()), (await termText()).match(/git version [\d.]+\S*/)?.[0] ?? '');

  // ---- 2) Agent committet selbst ----
  const src = fs.readFileSync(modelPy, 'utf8');
  fs.writeFileSync(modelPy, src.replace('LENGTH = param(60.0', 'LENGTH = param(80.0'));
  await waitFor('Build mit Länge 80', () => window.__t.status().state === 'ok' && (window.__t.partSize('Body') || [0])[0] > 79);
  check('Änderung am Modell erscheint im Viewer (Body 80 mm lang)', (await ev(() => window.__t.partSize('Body')))[0] === 80);
  await waitFor('ungesicherte Änderung', () => window.__t.versions().dirtyFiles === 1);
  check('Ungesicherte Änderung wird angezeigt (1 Datei)', true);
  await type('git add -A; git commit -q -m "Laenge auf 80"');
  await waitFor('zweiter Stand im Verlauf', () => window.__t.versions().count === 2, 20000);
  check('Commit des Agenten erscheint in der Verlaufsleiste', (await versions()).subjects.includes('Laenge auf 80'));
  // Sauberer Arbeitsordner und aktueller Build: Der Build zeigt genau den neuen Commit und wird dessen Vorschau
  const head2 = await g('rev-parse', 'HEAD');
  check('Neuer Commit bei sauberem Ordner: Build liegt gleich als Vorschau bereit', await until(() => fs.existsSync(path.join(cached(head2), 'model.glb'))));
  const cmap = fs.existsSync(path.join(cached(head2), 'model.map.json')) ? JSON.parse(fs.readFileSync(path.join(cached(head2), 'model.map.json'), 'utf8')) : { parts: [] };
  check('Vorschau aus dem Build: Rollen bleiben, ohne Code-Verweise, mit Geometrie zum Messen', cmap.parts.length === 2
    && cmap.parts.every((x) => x.role !== 'basic' && !('file' in x) && !('line' in x)) && fs.existsSync(path.join(cached(head2), 'geometry', `${cmap.build}.brep`)));
  const kinds = (await versions()).byApp;
  check('Leiste unterscheidet App-Stand (Start) und Agenten-Stand', kinds[0] === true && kinds[1] === false, JSON.stringify(kinds));
  check('App-Commits tragen den Trailer „Created-by: SOMA"', (await g('log', '--format=%(trailers:key=Created-by,valueonly)', 'HEAD~1')).includes('SOMA'));
  check('Commit enthält die STEP-Datei des gebauten Standes', (await g('show', '--stat', '--format=', 'HEAD')).includes('output/model.step'));
  // Ältere Projekte (vor E73): Der deutsche Trailer zählt weiter als Stand der App, auch bei einem Betreff, den die App nicht kennt
  await g('commit', '--allow-empty', '--no-verify', '-q', '-m', 'Alter Stand der App', '--trailer', 'Erstellt-von: SOMA');
  await waitFor('dritter Stand im Verlauf', () => window.__t.versions().count === 3, 20000);
  check('Alter Trailer „Erstellt-von: SOMA“ gilt weiter als App-Stand', (await versions()).byApp[2] === true, JSON.stringify((await versions()).byApp));

  // ---- 3) Speichern: Snapshot + ZIP ----
  fs.appendFileSync(path.join(dir, 'NOTES.md'), '\nWunsch: Deckel mit Lippe\n');
  await waitFor('Notizänderung', () => window.__t.saveState() && window.__t.saveState().dirtyFiles === 1);
  check('Vor dem Speichern: Badge „ungespeichert"', (await saveState()).unsaved === true);
  // Im Dialog ohne Endung eingegeben: Die App hängt .soma an
  await app.answers([zipPath.replace(/\.soma$/, '')]);
  await domClick('btn-save');
  await waitFor('gespeichert', () => window.__t.saveState() && !window.__t.saveState().unsaved && window.__t.saveState().zipPath, 60000);
  check('Modell als .soma gespeichert (Endung angehängt)', fs.existsSync(zipPath) && (await saveState()).zipPath === zipPath,
    `${fs.existsSync(zipPath) ? Math.round(fs.statSync(zipPath).size / 1024) : 0} KB, ${(await saveState()).zipPath}`);
  const names = await listZip(zipPath);
  check('Die .soma ist eine ZIP mit Modell, .git, Projektdaten und Marker', ['model.py', '.git/HEAD', '.soma/project.json', '.soma/zip-info.json', 'AGENTS.md'].every((n) => names.includes(n)));
  check('ZIP enthält keine Caches (GLB, Mapping, build.json, __pycache__)', !names.some((n) => /model\.glb|model\.map\.json|build\.json|__pycache__/.test(n)));
  await waitFor('Meldung und Name', () => window.__t.toast().text.startsWith('Saved') && window.__t.project().name === 'Testmodell', 20000);
  check('Auto-Snapshot beim Speichern hat die Notiz gesichert', (await g('log', '-1', '--format=%s')) === 'Automatic snapshot on save');
  check('Modellname folgt dem Dateinamen', (await ev(() => window.__t.project())).name === 'Testmodell');
  check('Nach dem Speichern: sauber, Anzeige „Saved · Uhrzeit"', (await saveState()).dirtyFiles === 0 && /^Saved · \d\d:\d\d$/.test(await ev(() => document.getElementById('save-badge').textContent)), await ev(() => document.getElementById('save-badge').textContent));
  await waitFor('grüner Punkt', () => document.querySelectorAll('#vdots .vdot.saved').length === 1, 10000).catch(() => {});
  check('Verlaufsleiste markiert den gespeicherten Stand', await ev(() => document.querySelectorAll('#vdots .vdot.saved').length) === 1);
  check('Meldung „Saved" erscheint', (await ev(() => window.__t.toast())).text.startsWith('Saved'));
  const commitsBefore = (await g('rev-list', '--count', 'HEAD'));
  await app.domClick('btn-save');
  await sleep(2500);
  check('Zweites Speichern ohne Änderung legt keinen leeren Snapshot an', (await g('rev-list', '--count', 'HEAD')) === commitsBefore);

  // ---- 3b) Export „Everything as ZIP“ (E79): gleicher Inhalt, kein Snapshot, die .soma bleibt die Modelldatei ----
  const exported = path.join(workDir, 'Weitergabe.zip');
  const somaBytes = fs.readFileSync(zipPath);
  await app.answers([exported]);
  await domClick('exp-zip');
  await waitFor('exportiert', () => window.__t.toast().text.startsWith('Model exported as ZIP'), 60000).catch(() => {});
  const expNames = fs.existsSync(exported) ? await listZip(exported) : [];
  check('Export als ZIP: Modell, .git und Marker darin', ['model.py', '.git/HEAD', '.soma/project.json', '.soma/zip-info.json'].every((n) => expNames.includes(n)),
    (await ev(() => window.__t.toast())).text.slice(0, 120));
  const st3 = await saveState();
  check('Export ändert nichts am Modell: kein neuer Commit, .soma unverändert und weiter die Modelldatei, gespeichert',
    (await g('rev-list', '--count', 'HEAD')) === commitsBefore && st3.zipPath === zipPath && !st3.unsaved && somaBytes.equals(fs.readFileSync(zipPath)), JSON.stringify(st3).slice(0, 160));

  // ---- 4) Vorschau alter Stände ----
  const first = await g('rev-list', '--max-parents=0', 'HEAD');
  check('Erster Stand liegt schon als Vorschau bereit (beim Anlegen abgelegt)', fs.existsSync(path.join(cached(first), 'model.glb')));
  // Ohne Cache entsteht die Vorschau wie bisher aus der STEP-Datei des Standes
  fs.rmSync(cached(first), { recursive: true, force: true });
  await ev(() => document.querySelectorAll('#vdots .vdot')[0].click());
  await waitFor('Vorschau aktiv', () => !!window.__t.versions().previewing, 60000);
  await waitFor('Vorschau geladen', () => window.__t.partCount() === 2 && !window.__t.banner().hidden);
  check('Vorschau des ersten Standes: Body ist 60 mm lang (Arbeitsstand: 80)', (await ev(() => window.__t.partSize('Body')))[0] === 60);
  const smap = JSON.parse(fs.readFileSync(path.join(cached(first), 'model.map.json'), 'utf8'));
  check('Ohne Cache: Vorschau aus der STEP-Datei des Standes erzeugt (Basismodus)', smap.parts.length === 2 && smap.parts.every((x) => x.role === 'basic'));
  const bn = (await ev(() => window.__t.banner())).text.replace(/\s+/g, ' ').trim();
  check('Banner zeigt „Preview · version 1 of …, view only"', bn.includes('Preview · version 1 of') && bn.includes('view only') && bn.includes('current work stays unchanged'), bn.slice(0, 60));
  check('Viewer hat den Vorschau-Rahmen', await ev(() => document.getElementById('viewer').classList.contains('preview')));
  await sleep(800); // capturePage liefert bei unsichtbaren Fenstern sonst ein etwas älteres Bild
  const shot = await app.screenshot(path.join(import.meta.dirname, 'versions.png')).catch((e) => ({ error: String(e) }));
  check('Screenshot der Vorschau (Verlaufsleiste sichtbar)', !!shot.width, shot.width ? `${shot.width}x${shot.height}` : shot.error);
  check('Arbeitsordner blieb unberührt (model.py hat weiter 80)', fs.readFileSync(modelPy, 'utf8').includes('LENGTH = param(80.0'));
  check('Kein neuer Commit durch die Vorschau', (await g('rev-list', '--count', 'HEAD')) === commitsBefore);
  fs.appendFileSync(modelPy, '\n# Kommentar während der Vorschau\n');
  await sleep(4000);
  check('Ein Build während der Vorschau ändert die Anzeige nicht', (await ev(() => window.__t.partSize('Body')))[0] === 60);
  fs.writeFileSync(modelPy, fs.readFileSync(modelPy, 'utf8').replace('\n# Kommentar während der Vorschau\n', ''));
  // Markierung einer Vorschau: Der Agent erfährt, dass das Bild einen alten Stand zeigt (sonst vergleicht er es mit dem aktuellen Code)
  await domClick('btn-mark');
  // Unter Last braucht das Öffnen (Bild des Viewers) mehrere Sekunden. Ein Klick auf „An Agent“ davor bliebe still wirkungslos
  await waitFor('Zeichenfläche', () => window.__t.markup().active, 30000).catch(() => {});
  await domClick('btn-mark-send');
  const firstShort = await g('rev-parse', '--short', first);
  // Bis zur schließenden Klammer warten: Unter Last kommt das Echo der Shell stückweise
  await waitFor('Markierung im Terminal', (i) => /\[Markup: \.soma\/feedback\/[^\]]*\]/.test(window.__t.termText(i)), 30000, await term()).catch(() => {});
  check('Markierung in der Vorschau nennt den alten Stand', (await termText()).includes(`shows the older version ${firstShort} "New model created"]`), (await termText()).match(/\[Markup:[^\]]*\]/)?.[0]?.slice(0, 200) ?? '');
  check('Nach der Markierung läuft die Vorschau weiter', !!(await versions()).previewing && await ev(() => document.getElementById('viewer').classList.contains('preview')));
  await ev((i) => window.soma.term.write(i, '\x03'), await term()); // Zeile verwerfen

  // ---- 5) Wiederherstellen als neuer Commit ----
  await app.answers([0]);
  await domClick('btn-restore');
  await waitFor('wiederhergestellt', () => !window.__t.versions().previewing && window.__t.versions().subjects.some((s) => s.startsWith('Restored version')), 60000);
  // Vorher lud die Ansicht hier den vorherigen Build (Body 80) und zeigte ihn, bis der neue fertig war
  check('Gleich nach dem Wiederherstellen ist der wiederhergestellte Stand zu sehen (Body 60, nicht 80)', (await ev(() => window.__t.partSize('Body')))[0] === 60);
  check('Wiederherstellen legt einen NEUEN Commit an', (await g('log', '-1', '--format=%s')).startsWith('Restored version: New model created'));
  check('Verlauf blieb vollständig (alter Startcommit unverändert vorhanden)', (await g('cat-file', '-t', first)) === 'commit' && (await g('rev-list', '--count', 'HEAD')) > commitsBefore);
  check('Dateien sind zurück: model.py mit 60, Notiz-Wunsch entfernt', fs.readFileSync(modelPy, 'utf8').includes('LENGTH = param(60.0') && !fs.readFileSync(path.join(dir, 'NOTES.md'), 'utf8').includes('Wunsch'));
  await waitFor('Build nach Wiederherstellung', () => window.__t.status().state === 'ok' && (window.__t.partSize('Body') || [0])[0] === 60);
  check('Live-Ansicht zeigt wieder den (wiederhergestellten) Stand, Body 60 mm', true);
  check('Kein HEAD-Umbau: Branch ist weiter main, nicht detached', (await g('symbolic-ref', '--short', 'HEAD')) === 'main');

  // ---- 6) Störfall: .git verschwindet (Agent hat es gelöscht/verschoben) ----
  await app.domClick('btn-save');
  await waitFor('gespeichert nach Restore', () => !window.__t.saveState().unsaved, 60000);
  check('ZIP enthält die Markierung aus .soma/feedback/ (in Git ist sie nicht)', (await listZip(zipPath)).some((n) => /^\.soma\/feedback\/markup-\d{8}-\d{4}\.png$/.test(n))
    && (await g('ls-files', '.soma/feedback')) === '');
  fs.renameSync(path.join(dir, '.git'), path.join(dir, '.git_weg'));
  await waitFor('Problem gemeldet', () => window.__t.versions().problems.some((p) => p.includes('No Git history')), 20000);
  check('Ohne .git: Verlauf meldet das Problem verständlich', (await versions()).problems[0].includes('No Git history'), (await versions()).problems[0].slice(0, 50));
  check('Ohne .git: App und Terminal laufen weiter', await ev(() => window.__t.terminals.count) === 1);
  fs.appendFileSync(path.join(dir, 'NOTES.md'), '\nohne git geändert\n');
  await sleep(300);
  await app.domClick('btn-save');
  await waitFor('Speichern ohne Git', () => window.__t.toast().text.includes('No Git history'), 60000);
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
  const startsBefore = await ev(() => window.__t.buildStarts());
  await domClick('btn-new');
  await waitFor('zweites Projekt', (id) => window.__t.project().id !== id && window.__t.status().state === 'ok' && window.__t.partCount() === 2, 90000, proj.id);
  check('Neues Modell: gebaut wird beim Anlegen, beim Öffnen nicht noch einmal', (await ev(() => window.__t.buildStarts())) === startsBefore);
  await rmRetry(dir);
  fs.rmSync(path.join(ud, 'projects', `${proj.id}.json`), { force: true });
  await app.answers([zipPath]);
  await domClick('btn-open');
  await waitFor('entpackt und geöffnet', (id) => window.__t.project().id === id && window.__t.status().state === 'ok' && window.__t.versions().count > 1, 90000, proj.id);
  check('Arbeitsordner fehlt (anderer Rechner): ZIP wird entpackt und geöffnet', fs.existsSync(modelPy) && fs.readFileSync(modelPy, 'utf8').includes('LENGTH = param(60.0'));
  check('Der Verlauf ist mitgekommen (gleiche Commits wie vorher)', (await g('log', '--format=%s')) === logBefore);
  // Der Build ist oft schneller da als der Speicherstand des neuen Modells (bis dahin gilt noch der des vorherigen)
  await waitFor('Speicherstand', () => window.__t.saveState() && !window.__t.saveState().unsaved, 15000).catch(() => {});
  check('Entpacktes Projekt gilt als gespeichert', (await saveState()).unsaved === false);
  // D) böse ZIP (Zip-Slip)
  const evil = path.join(workDir, 'boese.zip');
  const z = new yazl.ZipFile();
  z.addBuffer(Buffer.from(JSON.stringify({ id: randomUUID() })), '.soma/project.json');
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
  check(`Böse ZIP („../evil.txt", ${replaced} Einträge im Archiv) wird abgelehnt`, /Unsafe|invalid relative path/.test(evilToast), evilToast.slice(0, 70));
  check('Nichts außerhalb des Zielordners geschrieben, keine Reste', !fs.existsSync(path.join(ud, 'evil.txt')) && !fs.existsSync(path.join(ud, 'workspaces', 'evil.txt')) && !fs.readdirSync(path.join(ud, 'workspaces')).some((n) => n.startsWith('.tmp-')));
  check('Keine ZIP-Datei im Weg: Projekt bleibt offen und nutzbar', (await ev(() => window.__t.project().id)) === proj.id);
  // E) ZIP öffnen (älteres Modell oder Export): Speichern fragt einmal nach dem Ort der .soma, die ZIP bleibt (E79)
  const zipBytes = fs.readFileSync(exported);
  await app.answers([exported, 0]); // Arbeitsordner ist neuer: behalten
  await domClick('btn-open');
  await waitFor('ZIP als Modelldatei', (f) => window.__t.saveState()?.zipPath === f, 30000, exported).catch(() => {});
  check('ZIP öffnen: Modell offen, die ZIP ist vorerst seine Datei', (await ev(() => window.__t.project().id)) === proj.id && (await saveState()).zipPath === exported);
  const somaFromZip = path.join(workDir, 'Weitergabe.soma');
  await app.answers([somaFromZip]);
  await domClick('btn-save');
  await waitFor('als .soma gespeichert', (f) => window.__t.saveState()?.zipPath === f && !window.__t.saveState().unsaved, 60000, somaFromZip).catch(() => {});
  check('Speichern nach dem Öffnen einer ZIP: neue .soma, ZIP unverändert', fs.existsSync(somaFromZip) && (await listZip(somaFromZip)).includes('model.py')
    && zipBytes.equals(fs.readFileSync(exported)) && (await saveState()).zipPath === somaFromZip, JSON.stringify(await saveState()).slice(0, 160));

  // ---- 8) Absturz-Wiederherstellung: ungespeicherte Änderung überlebt ----
  fs.appendFileSync(path.join(dir, 'NOTES.md'), '\nungespeichert vor dem Absturz\n');
  await waitFor('ungespeichert', () => window.__t.saveState().unsaved, 20000);
  const ud2 = app.ud;
  app.crash();
  await sleep(1500);
  app = await startApp({ name: 'versions', userData: ud2 });
  await app.waitFor('Projekt wieder da', () => !!window.__t && !!window.__t.project() && window.__t.status().state === 'ok');
  check('Nach hartem Beenden öffnet die App dasselbe Projekt wieder', (await app.ev(() => window.__t.project().id)) === proj.id);
  await app.waitFor('Modell sichtbar', () => window.__t.partCount() === 2, 20000).catch(() => {});
  check('Modell unverändert seit dem letzten Build: Es ist gleich zu sehen, ohne Neubau', (await app.ev(() => window.__t.partCount())) === 2
    && (await app.ev(() => window.__t.buildStarts())) === 0, `Builds: ${await app.ev(() => window.__t.buildStarts())}`);
  // Ohne Neubau ist das Modell da, bevor das Fenster den Speicherstand abgefragt hat
  await app.waitFor('Speicherstand', () => !!window.__t.saveState(), 20000).catch(() => {});
  check('Die ungespeicherte Änderung ist noch da und als ungespeichert markiert', fs.readFileSync(path.join(dir, 'NOTES.md'), 'utf8').includes('vor dem Absturz') && (await app.ev(() => window.__t.saveState()?.unsaved)));

  const relevant = page.errors.filter((e) => !/favicon/i.test(e));
  check('Keine Konsolenfehler im Renderer (vor dem Neustart)', relevant.length === 0, relevant.slice(0, 2).join(' | ').slice(0, 120));

  // ---- 9) Start auf der Startseite, unveränderte neue Modelle verschwinden, Entfernen (E69) ----
  // Wie außerhalb der Tests: Die App öffnet kein Modell, eigene App-Daten
  await app.stop();
  cleanup(app.ud);
  app = await startApp({ name: 'versions-home', env: { SOMA_TEST_START: 'home' } });
  const h = app;
  await h.waitFor('Startseite', () => !!window.__t && !document.getElementById('start').hidden, 30000);
  await sleep(1500);
  const wsDir = path.join(h.ud, 'workspaces');
  const models = () => (fs.existsSync(wsDir) ? fs.readdirSync(wsDir).filter((n) => /^[0-9a-f-]{36}$/.test(n)) : []);
  check('Start auf der Startseite: kein Modell offen oder angelegt, nicht wegzuklicken', (await h.ev(() => window.__t.project())) === null && models().length === 0
    && await h.ev(() => document.getElementById('btn-start-close').hidden), `Modelle: ${models().length}`);
  await h.waitFor('Agenten', () => document.querySelectorAll('#start-agents .agrow').length > 0, 15000).catch(() => {});
  check('Startseite ohne offenes Modell nennt die Agenten', (await h.ev(() => document.querySelectorAll('#start-agents .agrow').length)) > 0);
  await h.domClick('start-new');
  await h.waitFor('erstes neues Modell', () => !!window.__t.project() && window.__t.status().state === 'ok' && window.__t.partCount() === 2, 90000);
  const m1 = await h.ev(() => window.__t.project());
  check('„New model“ auf der Startseite: Modell offen, Startseite zu', fs.existsSync(m1.dir) && await h.ev(() => document.getElementById('start').hidden));
  await h.domClick('btn-new');
  await h.waitFor('zweites neues Modell', (id) => window.__t.project()?.id !== id && window.__t.status().state === 'ok' && window.__t.partCount() === 2, 90000, m1.id);
  const m2 = await h.ev(() => window.__t.project());
  check('Unverändertes neues Modell verschwindet beim Wechsel, mit seinen App-Daten', await until(() => !fs.existsSync(m1.dir))
    && !fs.existsSync(path.join(h.ud, 'projects', `${m1.id}.json`)) && models().length === 1, `Modelle: ${models().join(', ')}`);
  fs.appendFileSync(path.join(m2.dir, 'NOTES.md'), '\nEigene Notiz\n');
  await h.waitFor('Notiz geändert', () => window.__t.saveState()?.dirtyFiles === 1, 20000);
  await h.domClick('btn-new');
  await h.waitFor('drittes neues Modell', (id) => window.__t.project()?.id !== id && window.__t.status().state === 'ok', 90000, m2.id);
  const m3 = await h.ev(() => window.__t.project());
  await sleep(1000);
  check('Geändertes Modell bleibt beim Wechsel', fs.existsSync(m2.dir));
  await h.ev(() => window.__t.showStart(true));
  await h.waitFor('Karten', () => document.querySelectorAll('#start-recent .recent-item').length === 2, 10000).catch(() => {});
  const cards = await h.ev(() => [...document.querySelectorAll('#start-recent .recent-item')].map((c) => ({ text: c.textContent, rm: !!c.querySelector('.recent-rm') })));
  check('Karten nennen „never saved“, Entfernen gibt es nur beim nicht geöffneten', cards.length === 2 && cards.every((c) => c.text.includes('never saved'))
    && cards.filter((c) => c.rm).length === 1, JSON.stringify(cards).slice(0, 120));
  await h.answers([1]);
  await h.ev(() => document.querySelector('#start-recent .recent-rm').click());
  await sleep(1500);
  check('Entfernen mit Rückfrage, Abbrechen lässt das Modell stehen', fs.existsSync(m2.dir) && !(await h.ev(() => window.__t.toast().error)));
  await h.answers([0]);
  await h.ev(() => document.querySelector('#start-recent .recent-rm').click());
  const bin = path.join(h.ud, 'test-papierkorb');
  check('Entfernen: Arbeitsordner im Papierkorb, App-Daten weg', await until(() => !fs.existsSync(m2.dir))
    && fs.existsSync(bin) && fs.readdirSync(bin).some((n) => n.endsWith(m2.id)) && !fs.existsSync(path.join(h.ud, 'projects', `${m2.id}.json`)));
  check('Entferntes Modell verschwindet von der Startseite', await h.waitFor('Karte weg', () => document.querySelectorAll('#start-recent .recent-item').length === 1, 10000).then(() => true, () => false));
  // Beenden wie mit dem Kreuz des Fensters: Das offene, unveränderte Modell verschwindet
  await h.ev(() => { void window.soma.test.close(); return true; });
  check('Beim Beenden verschwindet das unveränderte neue Modell', await until(() => !fs.existsSync(m3.dir), 30000));
} catch (e) {
  console.log('ABBRUCH:', e.message);
  t.fail();
}
if (app) { await app.stop(); cleanup(app.ud); }
cleanup(workDir);
console.log(t.fails ? `\n${t.fails} Prüfung(en) fehlgeschlagen` : '\nALLE PRÜFUNGEN BESTANDEN');
process.exit(t.fails ? 1 : 0);
