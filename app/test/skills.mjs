// Test der Skills (E17): Panel mit den mitgelieferten Skills, Ein- und Ausschalten (Kopie in .soma/skills/, project.json,
// Abschnitt in AGENTS.md), Ansehen und An Agent geben, geänderte Kopie wandert in die Sicherung, fehlende Dateien werden
// gemeldet statt repariert (E28), Einstellungen (Werte in der Kopie, Prüfung, Standard, auch bei ausgeschaltetem Skill),
// Skills im Snapshot und in der ZIP. Aufruf: npm run test:skills (baut vorher).
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
  /** Wert in ein Feld der Einstellungen schreiben und mit Enter übernehmen (Auswahl: change). */
  const setVar = (id, name, value) => ev(([i, n, v]) => {
    const f = document.getElementById(`sk-${i}-${n}`);
    f.value = v;
    if (f.tagName === 'SELECT') f.dispatchEvent(new Event('change'));
    else f.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  }, [id, name, value]);
  const varOf = async (id, name) => (await skill(id)).vars[name];
  const settings = () => pj().skill_settings ?? {};
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
  const bundledText = norm(fs.readFileSync(path.join(BUNDLED, '3d-druck.md'), 'utf8'));
  check('3D-Druck an: Kopie in .soma/skills/ mit den Standardwerten eingesetzt', copy !== null && bundledText.includes('{{overhang}}') && !copy.includes('{{')
    && copy.includes('Overhangs up to 45° from vertical') && copy.includes('| Nozzle | 0.4 mm |') && copy.split('\n').length === bundledText.split('\n').length);
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

  // 3b) Einstellungen: Max. Überhang auf 50° (Wunsch des Nutzers), Werte landen in project.json und in der Kopie
  check('Aufgeklappt: Einstellungen mit Standardwerten (Max. Überhang 45°, Düse 0,4 mm, Material PLA)', await ev(() =>
    document.getElementById('sk-3d-druck-overhang')?.value === '45' && document.getElementById('sk-3d-druck-nozzle')?.value === '0,4' && document.getElementById('sk-3d-druck-material')?.value === 'PLA'));
  await setVar('3d-druck', 'overhang', '50');
  await waitFor('Überhang 50', () => window.__t.skills().skills.find((x) => x.id === '3d-druck')?.vars.overhang === 50, 10000);
  let c3 = read('.soma/skills/3d-druck.md') ?? '';
  check('Max. Überhang 50°: project.json, Kopie mit 50° (Text, Tabelle, Kopf), keine „Abweichung"', JSON.stringify(settings()) === '{"3d-druck":{"overhang":50}}'
    && c3.includes('Overhangs up to 50° from vertical') && c3.includes('| Max. overhang without support | 50° from vertical |') && c3.includes('var overhang: 50 |') && c3.includes('MAX_OVERHANG = 50')
    && !(await skill('3d-druck')).changed, JSON.stringify(settings()));
  s = await st();
  check('Karte: Kurzbeschreibung „Überhänge bis 50°", Zeile „Eingestellt: …", Rücksetzknopf', s.skills.find((x) => x.id === '3d-druck').summary.includes('Überhänge bis 50°')
    && s.text.includes('Eingestellt: Max. Überhangwinkel 50°')
    && await ev(() => !document.querySelector('#skills-list .sk-var[data-var="overhang"] .sk-reset').hidden && document.querySelector('#skills-list .sk-var[data-var="nozzle"] .sk-reset').hidden), s.skills[0].summary);
  check('Meldung nennt Wert und Datei', (await ev(() => window.__t.toast())).text.includes('Max. Überhangwinkel 50°. Steht in .soma/skills/3d-druck.md'), (await ev(() => window.__t.toast())).text);
  await setVar('3d-druck', 'overhang', '95');
  await waitFor('Fehlermeldung', () => window.__t.toast().error, 5000).catch(() => {});
  check('95° außerhalb des Bereichs: abgelehnt mit Grund, 50° bleibt', (await ev(() => window.__t.toast())).text.includes('erlaubt sind 10 bis 85°')
    && await varOf('3d-druck', 'overhang') === 50 && JSON.stringify(settings()) === '{"3d-druck":{"overhang":50}}'
    && await ev(() => document.getElementById('sk-3d-druck-overhang').value) === '50', (await ev(() => window.__t.toast())).text);
  await setVar('3d-druck', 'material', 'PETG');
  await waitFor('Material', () => window.__t.skills().skills.find((x) => x.id === '3d-druck')?.vars.material === 'PETG', 10000);
  await setVar('3d-druck', 'nozzle', '0,6');
  await waitFor('Düse', () => window.__t.skills().skills.find((x) => x.id === '3d-druck')?.vars.nozzle === 0.6, 10000);
  c3 = read('.soma/skills/3d-druck.md') ?? '';
  check('Auswahl (PETG) und Zahl mit Komma (0,6): in der Kopie mit Punkt', c3.includes('| Material | PETG |') && c3.includes('| Nozzle | 0.6 mm |') && c3.includes('NOZZLE = 0.6')
    && await ev(() => document.getElementById('sk-3d-druck-nozzle').value) === '0,6');
  await ev(() => [...document.querySelectorAll('#skills-list .sk-row[data-id="3d-druck"] .sk-actions button')].find((b) => b.textContent.includes('An Agent')).click());
  await sleep(300);
  check('„An Agent geben" nennt die geänderten Einstellungen (Zahlen mit Punkt)', await ev(() => window.__inserted)
    === '[Skill: .soma/skills/3d-druck.md, Einstellungen: Material = PETG, Düse = 0.6 mm, Max. Überhangwinkel = 50°] ', await ev(() => window.__inserted));
  await ev(() => document.querySelector('#skills-list .sk-var[data-var="nozzle"] .sk-reset').click());
  await waitFor('Düse zurück', () => window.__t.skills().skills.find((x) => x.id === '3d-druck')?.vars.nozzle === 0.4, 10000);
  check('Zurück auf den Standard: Düse 0,4 mm, aus project.json entfernt, Kopie wieder 0.4', settings()['3d-druck']?.overhang === 50 && settings()['3d-druck']?.material === 'PETG' && !('nozzle' in (settings()['3d-druck'] ?? {}))
    && (read('.soma/skills/3d-druck.md') ?? '').includes('| Nozzle | 0.4 mm |'), JSON.stringify(settings()));
  // Ausgeschalteter Skill: Werte lassen sich vorab einstellen und gelten beim Einschalten
  await ev(() => document.querySelector('#skills-list .sk-row[data-id="gehaeuse"] .sk-more').click());
  await setVar('gehaeuse', 'wall', '3');
  await waitFor('Wand 3', () => window.__t.skills().skills.find((x) => x.id === 'gehaeuse')?.vars.wall === 3, 10000);
  check('Gehäusebau (aus): Wand 3 mm gespeichert, keine Datei angelegt, Hinweis „gilt, sobald an"', settings().gehaeuse?.wall === 3 && read('.soma/skills/gehaeuse.md') === null
    && (await ev(() => window.__t.toast())).text.includes('Gilt, sobald der Skill an ist'));
  await shot('skills-3-einstellungen');

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
  await setVar('3d-druck', 'overhang', '55');
  await waitFor('Überhang 55', () => window.__t.skills().skills.find((x) => x.id === '3d-druck')?.vars.overhang === 55, 10000);
  const bdir = path.join(ud, 'workspace-backups', `${proj.id}-skills`);
  let backups = fs.existsSync(bdir) ? fs.readdirSync(bdir) : [];
  check('Einstellung an geänderter Kopie: Kopie in die Sicherung, neu geschrieben mit 55°', backups.length === 1 && fs.readFileSync(path.join(bdir, backups[0]), 'utf8').includes('Use PETG only.')
    && !(read('.soma/skills/3d-druck.md') ?? '').includes('Use PETG only.') && (read('.soma/skills/3d-druck.md') ?? '').includes('up to 55°') && !(await skill('3d-druck')).changed
    && (await ev(() => window.__t.toast())).text.includes('Sicherung'), backups.join(','));
  await toggle('3d-druck', false);
  backups = fs.existsSync(bdir) ? fs.readdirSync(bdir) : [];
  check('Ausschalten: Kopie weg, unveränderte Kopie ohne neue Sicherung, Einstellungen bleiben', read('.soma/skills/3d-druck.md') === null && backups.length === 1
    && settings()['3d-druck']?.overhang === 55, backups.join(','));
  check('AGENTS.md und project.json ohne 3D-Druck, Toleranzen bleibt', !(block() ?? '').includes('3d-druck') && (block() ?? '').includes('toleranzen.md') && JSON.stringify(pj().skills) === '["toleranzen"]');
  check('Meldung nennt den laufenden Agenten', /ist aus\..*Sag ihm Bescheid/.test((await ev(() => window.__t.toast())).text), (await ev(() => window.__t.toast())).text);

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
  check('Gehäusebau an: die vorher eingestellte Wand (3 mm) steht in der Kopie', (read('.soma/skills/gehaeuse.md') ?? '').includes('Wall 3 mm') && (read('.soma/skills/gehaeuse.md') ?? '').includes('WALL = 3'));
  check('Ohne Abschnitt: am Ende angehängt, genau einmal', a2.trimEnd().endsWith('<!-- /soma:skills -->') && a2.split('<!-- soma:skills -->').length === 2 && (block() ?? '').includes('- `.soma/skills/gehaeuse.md`: Enclosure design'), String(block()));

  // 8) AGENTS.md fehlt ganz: Skill geht trotzdem an, Warnung, AGENTS.md wird nicht neu angelegt
  const keep = read('AGENTS.md');
  fs.rmSync(path.join(dir, 'AGENTS.md'));
  await toggle('3d-druck', true);
  check('Wieder an: Kopie mit den gespeicherten Einstellungen (55°, PETG)', (read('.soma/skills/3d-druck.md') ?? '').includes('up to 55°') && (read('.soma/skills/3d-druck.md') ?? '').includes('| Material | PETG |'));
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
