// Test für „Open folder“ (Ordner-Modus): SOMA in einem Ordner des Nutzers. Ein Git-Repository mit eigener AGENTS.md,
// CLAUDE.md und requirements.txt und einem reinen CadQuery-Skript: Abbrechen im Hinweis ändert nichts. Öffnen legt .soma/
// an, ergänzt AGENTS.md um den Abschnitt und CLAUDE.md um den Verweis (mit Sicherung), lässt requirements.txt und Git in
// Ruhe (kein Commit, keine Konfiguration), baut das Skript. Kein Speichern als .soma, kein Wiederherstellen, Verlauf ohne
// Probleme. Erneutes Öffnen fragt nichts. Verlassen und Entfernen lassen den Ordner stehen. Ein leerer Ordner bekommt
// model.py aus der Vorlage, ein kopierter Ordner eine neue Kennung, ein fehlender Ordner wird gemeldet.
// Aufruf: node test/run-all.mjs folder (nach npm run build).
import { exec } from 'dugite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checker, cleanup, sleep, startApp } from './harness.mjs';

const t = checker();
const { check } = t;
let app;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-folder-'));
const repo = path.join(work, 'Repo');
const empty = path.join(work, 'Leer');
const read = (dir, rel) => { try { return fs.readFileSync(path.join(dir, rel), 'utf8'); } catch { return null; } };
const git = async (...args) => (await exec(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], repo)).stdout.trim();
// Fehler aus dem Hauptprozess kommen im Renderer als „Error invoking remote method …“ an
const tryEv = (ev, fn, arg) => ev(fn, arg).then((v) => ({ v }), (e) => ({ err: String(e?.message ?? e) }));

const AGENTS = '# My rules\n\nUse tabs.\n';
const CLAUDE = '# Claude\n\nBe brief.\n';
const REQS = 'numpy\n# mine\nrequests>=2\n';
const SCRIPT = 'import cadquery as cq\n\nbox = cq.Workplane().box(30, 20, 10)\nshow_object(box, name="Box")\n';

try {
  fs.mkdirSync(repo);
  fs.mkdirSync(empty);
  fs.writeFileSync(path.join(repo, 'AGENTS.md'), AGENTS);
  fs.writeFileSync(path.join(repo, 'CLAUDE.md'), CLAUDE);
  fs.writeFileSync(path.join(repo, 'requirements.txt'), REQS);
  fs.writeFileSync(path.join(repo, 'part.py'), SCRIPT);
  fs.writeFileSync(path.join(repo, 'helper.py'), 'X = 1\n');
  await git('init', '-b', 'develop');
  await git('add', '-A');
  await git('commit', '-m', 'Start');
  const head0 = await git('rev-parse', 'HEAD');
  const config0 = read(repo, '.git/config');

  app = await startApp({ name: 'folder' });
  const { ev, waitFor } = app;
  await waitFor('Projekt und Build', () => !!window.__t && !!window.__t.project() && window.__t.status().state === 'ok', 90000);
  const first = await ev(() => window.__t.project());
  check('Ein normales Modell ist kein Ordner-Modell', first.folder === false && first.entry === 'model.py');

  // ---- 1) Abbrechen im Hinweis: nichts ändert sich ----
  await app.answers([repo, 0, path.join(repo, 'part.py'), 1]);
  const r1 = await ev(() => window.soma.project.openFolder());
  check('Hinweis abgebrochen: nichts angelegt oder geändert', r1.cancelled === true && !fs.existsSync(path.join(repo, '.soma'))
    && read(repo, 'AGENTS.md') === AGENTS && read(repo, 'CLAUDE.md') === CLAUDE, JSON.stringify(r1));

  // ---- 2) Öffnen ----
  await app.answers([repo, 0, path.join(repo, 'part.py'), 0]);
  const r2 = await ev(() => window.soma.project.openFolder());
  check('Ordner geöffnet', r2.opened === true, JSON.stringify(r2));
  await waitFor('Ordner gebaut', () => window.__t.project()?.folder && window.__t.status().state === 'ok' && window.__t.partCount() === 1, 120000).catch(() => {});
  const p = await ev(() => window.__t.project());
  check('Projekt ist der Ordner, Einstieg part.py, Teil aus show_object im Viewer', p.folder === true && p.entry === 'part.py' && fs.realpathSync.native(p.dir).toLowerCase() === fs.realpathSync.native(repo).toLowerCase()
    && (await ev(() => window.__t.partCount())) === 1, `${p.dir} ${p.entry} ${JSON.stringify(await ev(() => window.__t.status()))}`);
  const pj = JSON.parse(read(repo, '.soma/project.json'));
  check('.soma/project.json: Kennung, Einstieg, Paketliste in .soma/', pj.id === p.id && pj.entry === 'part.py' && pj.requirements === '.soma/requirements.txt');
  check('Kein Arbeitsordner unter workspaces/ für dieses Modell', !fs.existsSync(path.join(app.ud, 'workspaces', p.id)));
  const agents = read(repo, 'AGENTS.md');
  check('AGENTS.md: eigener Text bleibt vorn, Abschnitt für SOMA dahinter', agents.startsWith(AGENTS.trim()) && agents.includes('<!-- soma:folder -->') && agents.includes('<!-- /soma:folder -->')
    && agents.indexOf('Use tabs.') < agents.indexOf('<!-- soma:folder -->'));
  check('Abschnitt: Einstieg part.py, Kompatibilitätsmodus, keine Pflicht zu committen, Skills-Liste', agents.includes('the entry point is `part.py`') && agents.includes('compatibility mode')
    && !agents.includes('commit it: `git add -A`') && agents.includes('SOMA does not manage Git in this folder') && agents.includes('<!-- soma:skills -->') && agents.includes('.soma/requirements.txt'));
  check('CLAUDE.md: eigener Text bleibt, Verweis auf AGENTS.md dazu', read(repo, 'CLAUDE.md').startsWith(CLAUDE.trim()) && read(repo, 'CLAUDE.md').includes('@AGENTS.md'));
  const backups = fs.readdirSync(path.join(app.ud, 'workspace-backups')).filter((n) => n.startsWith(`${p.id}-folder-`));
  check('Alte AGENTS.md und CLAUDE.md in den Sicherungen', backups.some((b) => read(path.join(app.ud, 'workspace-backups', b), 'AGENTS.md') === AGENTS
    && read(path.join(app.ud, 'workspace-backups', b), 'CLAUDE.md') === CLAUDE), backups.join(', '));
  check('requirements.txt des Nutzers unverändert (auch nach dem Build)', read(repo, 'requirements.txt') === REQS);
  check('Git: kein Commit, Branch und Konfiguration unverändert', (await git('rev-parse', 'HEAD')) === head0 && (await git('branch', '--show-current')) === 'develop' && read(repo, '.git/config') === config0);
  const porcelain = (await git('status', '--porcelain', '--untracked-files=all')).split('\n').map((l) => l.slice(3));
  check('Git sieht keine Zwischenergebnisse aus .soma/ (eigene .gitignore)', !porcelain.some((f) => /^\.soma\/(model\.glb|model\.map\.json|build\.json|geometry\/|env\/)/.test(f))
    && porcelain.includes('.soma/project.json'), porcelain.join(' | '));

  // ---- 3) Kein Speichern als .soma, kein Wiederherstellen, Verlauf ohne Probleme ----
  const sv = await ev(() => window.soma.project.save(false));
  check('Speichern als .soma: Hinweis statt Datei', !!sv.error && /folder/.test(sv.error), JSON.stringify(sv).slice(0, 120));
  check('Speicherstand: nichts ungespeichert, Speichern-Knopf ausgeblendet', (await ev(() => window.soma.project.saveState())).unsaved === false && (await ev(() => document.getElementById('btn-save').hidden)));
  const log = await ev(() => window.soma.versions.log());
  check('Verlauf: Commit des Repositorys, keine Meldung zum Branch', log.commits.length === 1 && log.problems.length === 0, JSON.stringify(log.problems));
  const rs = await ev((h) => window.soma.versions.restore(h), head0);
  check('Wiederherstellen abgelehnt, Git unverändert', !!rs.error && (await git('rev-parse', 'HEAD')) === head0);

  // ---- 4) Erneut öffnen: keine Frage ----
  await app.answers([repo]);
  const r4 = await ev(() => window.soma.project.openFolder());
  check('Eingerichteter Ordner öffnet ohne Rückfrage, gleiche Kennung', r4.opened === true && (await ev(() => window.__t.project())).id === p.id, JSON.stringify(r4));

  // ---- 5) Verlassen und Entfernen lassen den Ordner stehen ----
  await ev(() => window.soma.project.create());
  await waitFor('anderes Modell', (id) => window.__t.project()?.id !== id && !window.__t.project().folder, 60000, p.id);
  check('Nach dem Verlassen: Ordner unverändert da (E69 gilt nicht)', fs.existsSync(path.join(repo, 'part.py')) && fs.existsSync(path.join(repo, '.soma', 'project.json')));
  const list = await ev(() => window.soma.project.list());
  const entry = list.find((e) => e.id === p.id);
  check('Startseite: Eintrag mit Pfad des Ordners', !!entry?.folder && !entry.missing && entry.name === 'Repo', JSON.stringify(entry));
  await app.answers([0]);
  const rm = await ev((id) => window.soma.project.remove(id), p.id);
  check('Entfernen: nur aus der Liste, Ordner bleibt', rm.removed === true && fs.existsSync(path.join(repo, 'part.py')) && fs.existsSync(path.join(repo, '.soma'))
    && !(await ev(() => window.soma.project.list())).some((e) => e.id === p.id), JSON.stringify(rm));

  // ---- 6) Leerer Ordner: model.py aus der Vorlage ----
  await app.answers([empty, 0]);
  const r6 = await ev(() => window.soma.project.openFolder());
  await waitFor('leerer Ordner gebaut', () => window.__t.project()?.folder && window.__t.status().state === 'ok' && window.__t.partCount() > 0, 120000).catch(() => {});
  const pe = await ev(() => window.__t.project());
  check('Leerer Ordner: model.py, AGENTS.md mit Abschnitt, CLAUDE.md, Build ok', r6.opened === true && pe.entry === 'model.py' && fs.existsSync(path.join(empty, 'model.py'))
    && read(empty, 'AGENTS.md')?.startsWith('<!-- soma:folder -->') && read(empty, 'CLAUDE.md') === '@AGENTS.md\n' && !fs.existsSync(path.join(empty, '.git')), JSON.stringify(r6));

  // ---- 7) Kopierter Ordner: neue Kennung ----
  const copy = path.join(work, 'Kopie');
  fs.cpSync(empty, copy, { recursive: true, filter: (src) => !src.includes(`${path.sep}.soma${path.sep}env`) });
  await app.answers([copy]);
  const r7 = await ev(() => window.soma.project.openFolder());
  const pc = await ev(() => window.__t.project());
  check('Kopie: eigene Kennung, Original bleibt eingetragen', r7.opened === true && pc.id !== pe.id && JSON.parse(read(copy, '.soma/project.json')).id === pc.id
    && (await ev(() => window.soma.project.list())).some((e) => e.id === pe.id), `${pc.id} / ${pe.id}`);

  // ---- 8) Fehlender Ordner ----
  await ev(() => window.soma.project.create());
  await waitFor('anderes Modell', (id) => window.__t.project()?.id !== id, 60000, pc.id);
  await sleep(1500); // Shells geben den Ordner frei
  fs.renameSync(copy, `${copy}-weg`);
  const gone = (await ev(() => window.soma.project.list())).find((e) => e.id === pc.id);
  check('Startseite: verschobener Ordner als fehlend markiert', gone?.missing === true, JSON.stringify(gone));
  const op = await tryEv(ev, (id) => window.soma.project.open(id), pc.id);
  check('Öffnen eines fehlenden Ordners: Meldung', !!op.err && op.err.includes('no longer exists'), op.err?.slice(0, 160));
  await app.answers([0]);
  check('Fehlenden Ordner aus der Liste nehmen', (await ev((id) => window.soma.project.remove(id), pc.id)).removed === true);

  const errs = app.page.errors.filter((e) => !/favicon/i.test(e));
  check('Keine Konsolenfehler im Renderer', errs.length === 0, errs.slice(0, 2).join(' | ').slice(0, 120));
} catch (e) {
  console.log('ABBRUCH:', e);
  t.fail();
}
if (app) { await app.stop(); cleanup(app.ud); }
cleanup(work);
console.log(t.fails ? `\n${t.fails} PRÜFUNG(EN) FEHLGESCHLAGEN` : '\nALLE PRÜFUNGEN BESTANDEN');
process.exit(t.fails ? 1 : 0);
