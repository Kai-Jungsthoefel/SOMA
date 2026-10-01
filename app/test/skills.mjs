// Test der Skills (E17): Panel mit den mitgelieferten Skills, Ein- und Ausschalten (Kopie in .soma/skills/, project.json,
// Abschnitt in AGENTS.md), Ansehen und An Agent geben, geänderte Kopie wandert in die Sicherung, fehlende Dateien werden
// gemeldet statt repariert (E28), Skills im Snapshot und in der ZIP. Aufruf: npm run test:skills (baut vorher).
import { exec } from 'dugite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yauzl from 'yauzl';
import { APP, checker, cleanup, sleep, startApp } from './harness.mjs';

const t = checker();
const { check } = t;
let app;
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-skills-'));
const BUNDLED = path.join(APP, 'resources', 'skills');
const norm = (s) => s.replace(/\r\n?/g, '\n');

const listZip = (p) => new Promise((resolve, reject) => yauzl.open(p, { lazyEntries: true }, (e, z) => {
  if (e) return reject(e);
  const names = [];
  z.on('entry', (en) => { names.push(en.fileName); z.readEntry(); });
  z.on('end', () => resolve(names));
  z.readEntry();
}));

try {
  app = await startApp({ name: 'skills' });
  const { ev, waitFor, domClick, ud, page } = app;
  const shot = async (name) => {
    if (!process.env.SMOKE_SHOTS) return;
    fs.mkdirSync(path.join(APP, 'test', 'shots'), { recursive: true });
    await sleep(900);
    await app.screenshot(path.join(APP, 'test', 'shots', `${name}.png`)).catch((e) => console.log('Screenshot:', e.message));
  };
  await waitFor('Projekt und Build', () => !!window.__t && !!window.__t.project() && window.__t.status().state === 'ok' && window.__t.partCount() === 2);
  const proj = await ev(() => window.__t.project());
  const dir = proj.dir;
  const g = async (...args) => (await exec(args, dir)).stdout.trim();
  const read = (rel) => { try { return fs.readFileSync(path.join(dir, rel), 'utf8'); } catch { return null; } };
  const pj = () => JSON.parse(read('.soma/project.json'));
  const st = () => ev(() => window.__t.skills());
  const skill = async (id) => (await st()).skills.find((s) => s.id === id);
  const toggle = async (id, on) => {
    await ev((i) => document.querySelector(`#skills-list .sk-row[data-id="${i}"] .sk-switch`).click(), id);
    await waitFor(`Skill ${id} ${on ? 'an' : 'aus'}`, ([i, o]) => { const s = window.__t.skills(); return !s.busy.length && s.skills.find((x) => x.id === i)?.active === o; }, 10000, [id, on]);
  };
  const block = () => { const a = read('AGENTS.md') ?? ''; const m = /<!-- soma:skills -->([\s\S]*?)<!-- \/soma:skills -->/.exec(a); return m ? m[1] : null; };

  // 1) Panel: drei mitgelieferte Skills, alle aus. Die Vorlage hat den leeren Abschnitt in AGENTS.md
  check('Vorlage: AGENTS.md hat den Abschnitt „Skills" (noch keiner aktiv)', (block() ?? '').includes('No skills are active'), String(block()).slice(0, 80));
  await ev(() => document.querySelector('#rail [data-panel="skills"]').click());
  await waitFor('Skills geladen', () => window.__t.skills().skills.length >= 3, 10000);
  let s = await st();
  check('Panel „Skills": 3D-Druck, Toleranzen, Gehäusebau, alle aus', s.skills.map((x) => x.id).join(',') === '3d-druck,toleranzen,gehaeuse' && s.skills.every((x) => !x.active && !x.file && !x.problems.length)
    && s.text.includes('3D-Druck (FDM)') && s.text.includes('Gehäusebau'), s.skills.map((x) => `${x.id}:${x.active}`).join(','));
  await shot('skills-1-panel');

  // 2) Einschalten: Kopie, project.json (und App-Kopie), Abschnitt in AGENTS.md, als Änderung sichtbar
  await toggle('3d-druck', true);
  const copy = read('.soma/skills/3d-druck.md');
  check('3D-Druck an: Kopie in .soma/skills/ entspricht der mitgelieferten Fassung', copy !== null && norm(copy) === norm(fs.readFileSync(path.join(BUNDLED, '3d-druck.md'), 'utf8')));
  check('project.json und die Kopie in den App-Daten nennen den Skill', JSON.stringify(pj().skills) === '["3d-druck"]'
    && JSON.stringify(JSON.parse(fs.readFileSync(path.join(ud, 'projects', `${proj.id}.json`), 'utf8')).skills) === '["3d-druck"]');
  check('AGENTS.md führt ihn auf (Pfad und englischer Name), der Rest der Datei bleibt', (block() ?? '').includes('- `.soma/skills/3d-druck.md`: 3D printing (FDM)')
    && (read('AGENTS.md') ?? '').startsWith('# Instructions for the coding agent') && (read('AGENTS.md') ?? '').includes('## Version history (git)'), String(block()));
  check('Meldung: an, steht in AGENTS.md, Hinweis auf laufenden Agenten', (await ev(() => window.__t.toast())).text.includes('ist an und steht in AGENTS.md'));
  await waitFor('ungespeichert', () => window.__t.saveState()?.dirtyFiles >= 3, 10000).catch(() => {});
  check('Zählt als ungespeicherte Änderung (Kopie, project.json, AGENTS.md)', (await ev(() => window.__t.saveState())).dirtyFiles >= 3, String((await ev(() => window.__t.saveState())).dirtyFiles));

  // 3) Ansehen (nur lesen) und An Agent geben
  await ev(() => document.querySelector('#skills-list .sk-row[data-id="3d-druck"] .sk-more').click());
  await shot('skills-2-aktiv');
  await ev(() => [...document.querySelectorAll('#skills-list .sk-row[data-id="3d-druck"] .sk-actions button')].find((b) => b.textContent.includes('Ansehen')).click());
  await waitFor('Code-Panel', () => window.__t.editor.state().file === '.soma/skills/3d-druck.md', 10000);
  const ed = await ev(() => window.__t.editor.state());
  check('„Ansehen": Kopie im Code-Panel, nur lesen, mit Grund', ed.readOnly && ed.text.includes('# Skill: 3D printing (FDM)') && (ed.locked ?? '').includes('Skill'), JSON.stringify({ ro: ed.readOnly, locked: ed.locked }));
  await ev(() => window.__t.showPanel('skills'));
  await waitFor('Panel wieder offen', () => !!document.querySelector('#skills-list .sk-row[data-id="3d-druck"] .sk-actions'), 10000);
  // Eingefügten Text mitschneiden (im Terminal bricht die lange Eingabezeile um)
  await ev(() => { const tm = window.__t.terminals; const orig = tm.insert.bind(tm); tm.insert = (x) => { window.__inserted = x; return orig(x); }; });
  await ev(() => [...document.querySelectorAll('#skills-list .sk-row[data-id="3d-druck"] .sk-actions button')].find((b) => b.textContent.includes('An Agent')).click());
  await sleep(300);
  check('„An Agent geben" fügt [Skill: .soma/skills/3d-druck.md] ein', (await ev(() => window.__t.toast())).text.includes('In die Eingabe von')
    && await ev(() => window.__inserted) === '[Skill: .soma/skills/3d-druck.md] ', await ev(() => window.__inserted));

  // 4) Zweiter Skill: beide stehen in AGENTS.md, in der Reihenfolge des Einschaltens
  await toggle('toleranzen', true);
  const b2 = block() ?? '';
  check('Toleranzen dazu: AGENTS.md nennt beide, project.json auch', b2.indexOf('3d-druck.md') > 0 && b2.indexOf('toleranzen.md') > b2.indexOf('3d-druck.md') && JSON.stringify(pj().skills) === '["3d-druck","toleranzen"]', b2);

  // 5) Kopie geändert (etwa vom Agenten): gemeldet, beim Ausschalten in die Sicherung
  fs.appendFileSync(path.join(dir, '.soma', 'skills', '3d-druck.md'), '\n- Use PETG only.\n');
  await ev(() => window.__t.showPanel('files'));
  await ev(() => window.__t.showPanel('skills'));
  await waitFor('geändert erkannt', () => window.__t.skills().skills.find((x) => x.id === '3d-druck')?.changed === true, 10000);
  check('Geänderte Kopie: „weicht ab" in der Karte', (await st()).text.includes('weicht von der Fassung dieser App ab'));
  await toggle('3d-druck', false);
  const bdir = path.join(ud, 'workspace-backups', `${proj.id}-skills`);
  const backups = fs.existsSync(bdir) ? fs.readdirSync(bdir) : [];
  check('Ausschalten: Kopie weg, die geänderte Fassung liegt in der Sicherung', read('.soma/skills/3d-druck.md') === null && backups.length === 1
    && fs.readFileSync(path.join(bdir, backups[0]), 'utf8').includes('Use PETG only.'), backups.join(','));
  check('AGENTS.md und project.json ohne 3D-Druck, Toleranzen bleibt', !(block() ?? '').includes('3d-druck') && (block() ?? '').includes('toleranzen.md') && JSON.stringify(pj().skills) === '["toleranzen"]');
  check('Meldung nennt Sicherung und den laufenden Agenten', /ist aus\..*Sag ihm Bescheid.*Sicherung/.test((await ev(() => window.__t.toast())).text), (await ev(() => window.__t.toast())).text);

  // 6) Datei eines aktiven Skills fehlt: gemeldet, nicht neu angelegt (E28)
  fs.rmSync(path.join(dir, '.soma', 'skills', 'toleranzen.md'));
  await ev(() => window.__t.showPanel('files'));
  await ev(() => window.__t.showPanel('skills'));
  await waitFor('Problem gemeldet', () => window.__t.skills().skills.find((x) => x.id === 'toleranzen')?.problems.length > 0, 10000);
  const info = await ev(() => window.soma.project.current());
  check('Fehlende Kopie: Hinweis in der Karte und im Projekt-Check, nichts neu angelegt', (await skill('toleranzen')).problems[0].includes('fehlt')
    && info.problems.some((p) => p.includes('toleranzen')) && read('.soma/skills/toleranzen.md') === null, JSON.stringify(info.problems));
  await toggle('toleranzen', false);
  check('Ausschalten räumt auf: kein Problem mehr, Abschnitt „No skills are active"', !(await skill('toleranzen')).problems.length && (block() ?? '').includes('No skills are active') && JSON.stringify(pj().skills) === '[]');

  // 7) Älteres Projekt ohne Abschnitt in AGENTS.md: Er wird am Ende angehängt, nicht doppelt
  const agents = read('AGENTS.md');
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), agents.replace(/\n*<!-- soma:skills -->[\s\S]*<!-- \/soma:skills -->\n?/, '\n'));
  await toggle('gehaeuse', true);
  const a2 = read('AGENTS.md');
  check('Ohne Abschnitt: am Ende angehängt, genau einmal', a2.trimEnd().endsWith('<!-- /soma:skills -->') && a2.split('<!-- soma:skills -->').length === 2 && (block() ?? '').includes('- `.soma/skills/gehaeuse.md`: Enclosure design'), String(block()));

  // 8) AGENTS.md fehlt ganz: Skill geht trotzdem an, Warnung, AGENTS.md wird nicht neu angelegt
  const keep = read('AGENTS.md');
  fs.rmSync(path.join(dir, 'AGENTS.md'));
  await toggle('3d-druck', true);
  check('Ohne AGENTS.md: Skill an, Warnung, keine neue AGENTS.md', read('AGENTS.md') === null && read('.soma/skills/3d-druck.md') !== null
    && (await ev(() => window.__t.toast())).text.includes('AGENTS.md fehlt') && (await ev(() => window.__t.toast())).error, (await ev(() => window.__t.toast())).text);
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), keep);
  await ev(() => window.__t.showPanel('files'));
  await ev(() => window.__t.showPanel('skills'));
  await waitFor('Problem AGENTS.md', () => window.__t.skills().skills.find((x) => x.id === '3d-druck')?.problems.length > 0, 10000);
  check('AGENTS.md ohne Eintrag eines aktiven Skills: gemeldet', (await skill('3d-druck')).problems.some((p) => p.includes('AGENTS.md nennt')), JSON.stringify((await skill('3d-druck')).problems));
  await toggle('3d-druck', false);
  await toggle('3d-druck', true);
  check('Aus und wieder an trägt ihn ein', !(await skill('3d-druck')).problems.length && (block() ?? '').includes('3d-druck.md') && (block() ?? '').includes('gehaeuse.md'));

  // 9) Speichern: Skills im Snapshot und in der ZIP
  const zipPath = path.join(workDir, 'Skills.zip');
  await app.answers([zipPath]);
  await domClick('btn-save');
  await waitFor('gespeichert', () => window.__t.saveState() && !window.__t.saveState().unsaved && window.__t.saveState().zipPath, 60000)
    .catch(async (e) => { console.log('Stand:', JSON.stringify(await ev(() => ({ save: window.__t.saveState(), toast: window.__t.toast() })))); throw e; });
  const tracked = (await g('ls-files', '.soma/skills')).split('\n');
  check('Snapshot enthält die Skills (in Git)', tracked.includes('.soma/skills/3d-druck.md') && tracked.includes('.soma/skills/gehaeuse.md'), tracked.join(','));
  const names = await listZip(zipPath);
  check('ZIP enthält die Skills', names.includes('.soma/skills/3d-druck.md') && names.includes('.soma/skills/gehaeuse.md'));

  const relevant = page.errors.filter((e) => !/favicon/i.test(e));
  check('Keine Konsolenfehler im Renderer', relevant.length === 0, relevant.slice(0, 2).join(' | ').slice(0, 100));
} catch (e) {
  console.log('ABBRUCH:', e.message);
  t.fail();
}
if (app) { await app.stop(); cleanup(app.ud); }
cleanup(workDir);
console.log(t.fails ? `\n${t.fails} Prüfung(en) fehlgeschlagen` : '\nALLE PRÜFUNGEN BESTANDEN');
process.exit(t.fails ? 1 : 0);
