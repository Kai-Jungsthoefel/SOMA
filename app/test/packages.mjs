// Test der Projektumgebung (E25, E67): kleine venv je Modell unter .soma/env, die die Basis mitbenutzt. `pip install` im
// Terminal landet dort, Basispakete gelten als vorhanden und behalten ihre Version, soma build schreibt die importierten
// Zusatzpakete in requirements.txt, Umgebung weder in ZIP noch in Git, auf einem „anderen Rechner“ (frische App-Daten)
// installiert die App die Liste vor dem Build, ein alter Stand bringt seine eigene Liste mit, ein Paket, das sich nicht
// installieren lässt, wird gemeldet und bleibt in der Liste. Ohne Netz: pip holt die Testpakete aus einem lokalen Ordner.
// Aufruf: node test/run-all.mjs packages (nach npm run build).
import { exec } from 'dugite';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import yauzl from 'yauzl';
import yazl from 'yazl';
import { APP, checker, cleanup, sleep, startApp } from './harness.mjs';

const t = checker();
const { check } = t;
let app;
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-packages-'));
const wheels = path.join(workDir, 'wheels');
const zipPath = path.join(workDir, 'Paketmodell.zip');

/** Ein Wheel ohne Build-Werkzeuge: Modul, METADATA, WHEEL und RECORD in einer ZIP. */
function makeWheel(name, version, code, requires = []) {
  const info = `${name}-${version}.dist-info`;
  const files = {
    [`${name}/__init__.py`]: code,
    [`${info}/METADATA`]: `Metadata-Version: 2.1\nName: ${name}\nVersion: ${version}\n${requires.map((r) => `Requires-Dist: ${r}\n`).join('')}`,
    [`${info}/WHEEL`]: 'Wheel-Version: 1.0\nGenerator: soma-test\nRoot-Is-Purelib: true\nTag: py3-none-any\n',
  };
  files[`${info}/RECORD`] = [...Object.keys(files), `${info}/RECORD`].map((f) => `${f},,`).join('\n') + '\n';
  const z = new yazl.ZipFile();
  for (const [f, text] of Object.entries(files)) z.addBuffer(Buffer.from(text), f);
  z.end();
  return new Promise((resolve) => z.outputStream.pipe(fs.createWriteStream(path.join(wheels, `${name}-${version}-py3-none-any.whl`))).on('close', resolve));
}

const listZip = (p) => new Promise((resolve, reject) => yauzl.open(p, { lazyEntries: true }, (e, z) => {
  if (e) return reject(e);
  const names = [];
  z.on('entry', (en) => { names.push(en.fileName); z.readEntry(); });
  z.on('end', () => resolve(names));
  z.readEntry();
}));

const dirSize = (d) => {
  let n = 0;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) n += e.isDirectory() ? dirSize(path.join(d, e.name)) : fs.statSync(path.join(d, e.name)).size;
  return n;
};

try {
  fs.mkdirSync(wheels);
  await makeWheel('somatestpkg', '1.0', 'SIZE = 12.5\n');
  await makeWheel('somabadpkg', '1.0', '', ['numpy<2']); // verträgt sich nicht mit dem numpy der Basis
  // Kein Netz im Test: pip sucht nur im Ordner mit den Wheels (gilt für Terminals und für die App)
  process.env.PIP_NO_INDEX = '1';
  process.env.PIP_FIND_LINKS = wheels;

  app = await startApp({ name: 'packages' });
  let { ev, waitFor, domClick } = app;
  await waitFor('Projekt und Build', () => !!window.__t && !!window.__t.project() && window.__t.status().state === 'ok' && window.__t.partCount() === 2, 90000);
  const proj = await ev(() => window.__t.project());
  const dir = proj.dir;
  const envDir = path.join(dir, '.soma', 'env');
  const site = path.join(envDir, 'Lib', 'site-packages');
  const req = path.join(dir, 'requirements.txt');
  const g = async (...args) => (await exec(args, dir)).stdout.trim();
  const until = async (fn, ms = 20000) => { for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(200)) if (fn()) return true; return fn(); };

  // ---- 1) Umgebung beim Öffnen ----
  check('Projektumgebung liegt unter .soma/env', await until(() => fs.existsSync(path.join(envDir, 'pyvenv.cfg')) && fs.existsSync(path.join(envDir, 'soma-env.json'))));
  check('Sie ist klein (Basis wird mitbenutzt, nicht kopiert)', dirSize(envDir) < 5 * 1024 ** 2, `${Math.round(dirSize(envDir) / 1024)} KB`);
  check('pip.ini legt die Basisversionen fest', fs.readFileSync(path.join(envDir, 'pip.ini'), 'utf8').includes('constraint = file:')
    && /^numpy==/m.test(fs.readFileSync(path.join(envDir, 'base-constraints.txt'), 'utf8')));
  check('.gitignore der Vorlage nennt .soma/env/', fs.readFileSync(path.join(dir, '.gitignore'), 'utf8').includes('.soma/env/'));
  check('Ohne Zusatzpakete entsteht keine requirements.txt', !fs.existsSync(req));

  // ---- 2) pip im Terminal ----
  const tid = await ev(() => window.__t.terminals.activeId);
  const termText = () => ev((id) => window.__t.termText(id), tid);
  const type = async (cmd, until, ms = 120000) => {
    await ev(([id, c]) => window.soma.term.write(id, c + '\r'), [tid, cmd]);
    return waitFor(cmd, ([id, re]) => new RegExp(re, 'm').test(window.__t.termText(id)), ms, [tid, until]).then(() => true, () => false);
  };
  const installed = await type('pip install somatestpkg', 'Successfully installed somatestpkg-1\\.0');
  check('`pip install` im Terminal installiert ein Zusatzpaket', installed, installed ? '' : (await termText()).trim().slice(-200));
  check('Es liegt in der Projektumgebung', fs.existsSync(path.join(site, 'somatestpkg', '__init__.py')));
  check('Basispakete gelten als vorhanden (numpy wird nicht noch einmal installiert)', await type('pip install numpy', 'Requirement already satisfied: numpy'));
  check('Eine andere numpy-Version lehnt pip ab (Basis bleibt, wie sie ist)', await type('pip install somabadpkg', 'constraint\\) numpy==|ResolutionImpossible')
    && !fs.existsSync(path.join(site, 'somabadpkg')));
  check('`python` im Terminal sieht Basis und Zusatzpaket', await type('python -c "import cadquery, somatestpkg; print(\'PKG\', somatestpkg.SIZE)"', '^PKG 12\\.5', 60000));

  // ---- 3) soma build hält das Paket fest ----
  const modelPy = path.join(dir, 'model.py');
  const original = fs.readFileSync(modelPy, 'utf8');
  fs.writeFileSync(modelPy, original.replace('import cadquery as cq\n', 'import cadquery as cq\nimport somatestpkg\n').replace('WALL = 2.0', 'WALL = somatestpkg.SIZE / 6.25'));
  check('Build mit dem Zusatzpaket (App-Build, vorgewärmter Prozess)', await until(() => fs.existsSync(req), 90000)
    && await waitFor('Build ok', () => window.__t.status().state === 'ok', 60000).then(() => true, () => false));
  const reqText = (file = req) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
  check('requirements.txt nennt das Paket mit Version', /^somatestpkg==1\.0$/m.test(reqText()) && reqText().startsWith('# Extra Python packages'), reqText().split('\n').slice(2).join(' | '));
  check('… und nur Pakete, die das Modell importiert (keine Basispakete)', reqText().split('\n').filter((l) => l && !l.startsWith('#')).length === 1);
  const mtime = fs.statSync(req).mtimeMs;
  check('`soma build` im Terminal: Build ok, Datei unverändert', await type('soma build', 'Build ok', 90000) && fs.statSync(req).mtimeMs === mtime);
  const porcelain = await g('status', '--porcelain', '--untracked-files=all');
  check('Git sieht requirements.txt, aber nichts aus .soma/env', porcelain.includes('requirements.txt') && !porcelain.includes('.soma/env'), porcelain.replace(/\n/g, ' | '));
  await ev(([id, c]) => window.soma.term.write(id, c + '\r'), [tid, 'git add -A; git commit -q -m "Mit Zusatzpaket"']);
  for (const t0 = Date.now(); Date.now() - t0 < 20000 && (await g('log', '-1', '--format=%s')) !== 'Mit Zusatzpaket';) await sleep(300);
  check('Commit des Agenten enthält requirements.txt, aber keine Umgebung', (await g('show', '--stat', '--format=', 'HEAD')).includes('requirements.txt')
    && !(await g('ls-files')).includes('.soma/env'));

  // ---- 4) Speichern: requirements.txt in der ZIP, Umgebung nicht ----
  // Dazu Version (E68): Ein Modell aus einer älteren App bekommt beim Speichern die Version dieser App
  const appVersion = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8')).version;
  const pjFile = path.join(dir, '.soma', 'project.json');
  fs.writeFileSync(pjFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(pjFile, 'utf8')), app_version: '0.0.1' }, null, 2));
  await app.answers([zipPath]);
  await domClick('btn-save');
  await waitFor('gespeichert', () => window.__t.saveState() && !window.__t.saveState().unsaved && window.__t.saveState().zipPath && window.__t.saveState().dirtyFiles === 0, 60000);
  const names = await listZip(zipPath);
  check('ZIP enthält requirements.txt, aber nichts aus .soma/env', names.includes('requirements.txt') && !names.some((n) => n.startsWith('.soma/env')), `${names.length} Einträge`);
  check('Speichern trägt die Version dieser App in project.json ein, auch im Snapshot', JSON.parse(fs.readFileSync(pjFile, 'utf8')).app_version === appVersion
    && JSON.parse(await g('show', 'HEAD:.soma/project.json')).app_version === appVersion, appVersion);

  // ---- 5) Alter Stand: seine eigene Liste, kein Paket zu viel ----
  const first = await g('rev-list', '--max-parents=0', 'HEAD');
  await app.answers([0]);
  const restored = await ev((h) => window.soma.versions.restore(h), first);
  check('Startstand wiederhergestellt', !restored.error && !restored.cancelled, JSON.stringify(restored).slice(0, 120));
  await waitFor('Build nach Wiederherstellung', () => window.__t.status().state === 'ok' && !window.__t.status().text.includes('Installiert'), 90000).catch(() => {});
  await sleep(1500);
  check('Startstand hat keine requirements.txt, und der Build legt keine an (Paket nur noch installiert)', !fs.existsSync(req) && fs.existsSync(path.join(site, 'somatestpkg')));
  check('Nach dem Wiederherstellen keine ungespeicherte Änderung durch die Paketliste', !(await g('status', '--porcelain')).includes('requirements.txt'));
  await app.stop();
  cleanup(app.ud);
  app = null;

  // ---- 6) Anderer Rechner: frische App-Daten, ZIP öffnen ----
  // Eigener Port: Die eben beendete App hält ihren Debug-Port unter Last noch eine Weile fest
  const port = await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
  app = await startApp({ name: 'packages2', port });
  ({ ev, waitFor, domClick } = app);
  await waitFor('Startprojekt', () => !!window.__t && !!window.__t.project() && window.__t.status().state === 'ok', 90000);
  await app.answers([zipPath]);
  await domClick('btn-open');
  let sawInstalling = false;
  for (const t0 = Date.now(); Date.now() - t0 < 120000; await sleep(150)) {
    const st = await ev(() => ({ id: window.__t.project()?.id, ...window.__t.status(), parts: window.__t.partCount() }));
    if (st.id === proj.id && st.text.startsWith('Installiert Pakete')) sawInstalling = true;
    if (st.id === proj.id && st.state === 'ok' && st.parts === 2 && !st.text.startsWith('Installiert')) break;
  }
  check('Beim Öffnen zeigt die Statuszeile „Installiert Pakete …“', sawInstalling);
  const dir2 = (await ev(() => window.__t.project())).dir; // neue App-Daten, also ein anderer Arbeitsordner
  const site2 = path.join(dir2, '.soma', 'env', 'Lib', 'site-packages');
  const req2 = path.join(dir2, 'requirements.txt');
  check('Paket wurde aus requirements.txt installiert, der Build gelingt', fs.existsSync(path.join(site2, 'somatestpkg', '__init__.py'))
    && (await ev(() => window.__t.status().state)) === 'ok', (await ev(() => window.__t.status().viewerMsg)).slice(0, 120));
  check('Kein Hinweis auf einen Paketfehler', !(await ev(() => window.__t.toast())).error);

  // ---- 7) Paket lässt sich nicht installieren: melden, Liste behalten ----
  fs.appendFileSync(req2, 'somamissing==2.0\n');
  await exec(['-c', 'user.name=Agent', '-c', 'user.email=agent@example.com', 'commit', '-q', '-am', 'Paket ohne Quelle'], dir2);
  const head = (await exec(['rev-parse', 'HEAD'], dir2)).stdout.trim();
  await app.answers([0]);
  await ev((h) => window.soma.versions.restore(h), head);
  const toast = await waitFor('Hinweis', () => { const x = window.__t.toast(); return x.error && x.text.includes('somamissing') ? x : null; }, 120000).catch(() => null);
  check('Fehlendes Paket ohne Quelle: Hinweis nennt es', !!toast, toast?.text.slice(0, 120) ?? '');
  if (process.env.SMOKE_SHOTS) { // Hinweis ansehen: SMOKE_VISIBLE=offscreen SMOKE_SHOTS=1
    fs.mkdirSync(path.join(APP, 'test', 'shots'), { recursive: true });
    await sleep(600);
    await app.screenshot(path.join(APP, 'test', 'shots', 'packages-fehler.png')).catch((e) => console.log('Screenshot:', e.message));
  }
  await waitFor('Build danach', () => window.__t.status().state === 'ok' && !window.__t.status().text.includes('Installiert'), 90000).catch(() => {});
  await sleep(1000);
  check('Build läuft trotzdem, die Liste behält das fehlende Paket', (await ev(() => window.__t.status().state)) === 'ok' && /^somamissing==2\.0$/m.test(reqText(req2)) && /^somatestpkg==1\.0$/m.test(reqText(req2)), reqText(req2).split('\n').slice(2).join(' | '));

  const relevant = app.page.errors.filter((e) => !/favicon/i.test(e));
  check('Keine Konsolenfehler im Renderer', relevant.length === 0, relevant.slice(0, 2).join(' | ').slice(0, 100));
} catch (e) {
  console.log('ABBRUCH:', e.message);
  t.fail();
}
if (app) { await app.stop(); cleanup(app.ud); }
cleanup(workDir);
console.log(t.fails ? `\n${t.fails} Prüfung(en) fehlgeschlagen` : '\nALLE PRÜFUNGEN BESTANDEN');
process.exit(t.fails ? 1 : 0);
