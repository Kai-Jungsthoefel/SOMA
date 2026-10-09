// Test der Skills (E17, E55): Panel mit den mitgelieferten Skills, Stufen Aus, Bei Bedarf und Immer (Kopie in .soma/skills/,
// project.json, zwei Listen in AGENTS.md, Hinweis in der Kopie bei Bedarf), Ansehen und An Agent geben, geänderte Kopie wandert
// in die Sicherung, fehlende Dateien werden gemeldet statt repariert (E28), Einstellungen (Werte in der Kopie, Prüfung, Standard,
// auch bei ausgeschaltetem Skill), Skills im Snapshot und in der ZIP, Stufen für neue Modelle. Aufruf: npm run test:skills (baut vorher).
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
  /** Stufe über den Schalter der Zeile wählen (E55, Entwurf 2): off, demand oder always. */
  const setMode = async (id, mode) => {
    await ev(([i, m]) => { document.querySelector(`#skills-list .sk-row[data-id="${i}"] .sk-lvl`).click(); document.querySelector(`#menu-ctx .mi[data-mode="${m}"]`).click(); }, [id, mode]);
    await waitFor(`Skill ${id} ${mode}`, ([i, m]) => { const s = window.__t.skills(); return !s.busy.length && s.skills.find((x) => x.id === i)?.mode === m; }, 10000, [id, mode]);
  };
  /** Wert in ein Feld der Einstellungen schreiben und mit Enter übernehmen (Auswahl: change). */
  const setVar = (id, name, value) => ev(([i, n, v]) => {
    if (!document.getElementById(`sk-${i}-${n}`)) window.__t.openSkill(i);
    const f = document.getElementById(`sk-${i}-${n}`);
    f.value = v;
    if (f.tagName === 'SELECT') f.dispatchEvent(new Event('change'));
    else f.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  }, [id, name, value]);
  const varOf = async (id, name) => (await skill(id)).vars[name];
  const settings = () => pj().skill_settings ?? {};
  const block = () => { const a = read('AGENTS.md') ?? ''; const m = /<!-- soma:skills -->([\s\S]*?)<!-- \/soma:skills -->/.exec(a); return m ? m[1] : null; };
  /** Die beiden Listen des Abschnitts: Immer vor „Read when relevant“, Bei Bedarf danach. */
  const always = () => (block() ?? '').split('### Read when relevant')[0];
  const demand = () => (block() ?? '').split('### Read when relevant')[1] ?? '';
  const DEMAND_NEW = '3d-druck,harz-pulver,cnc,laser,blech,toleranzen,verbindungen,festigkeit,baugruppen,analyse,animation,fem,zeichnung';

  // 1) Panel: die mitgelieferten Skills nach Kategorien und `order`
  await ev(() => document.querySelector('#rail [data-panel="skills"]').click());
  await waitFor('Skills geladen', () => window.__t.skills().skills.length >= 3, 10000);
  let s = await st();
  const ORDER = 'konstruktionsablauf,cadquery,parametrik,3d-druck,harz-pulver,cnc,laser,blech,toleranzen,verbindungen,normteile,festigkeit,baugruppen,analyse,animation,fem,zeichnung';
  const heads = await ev(() => [...document.querySelectorAll('#skills-list .sk-cat')].map((h) => h.textContent).join(','));
  check('Panel „Skills": Überschriften Way of working, Manufacturing, Design knowledge, Check and present, darunter die Skills nach `order`',
    s.skills.map((x) => x.id).join(',') === ORDER && heads === 'Way of working,Manufacturing,Design knowledge,Check and present'
    && s.text.includes('3D printing (FDM)') && s.text.includes('Laser cutting'), `${heads} | ${s.skills.map((x) => x.id).join(',')}`);
  await shot('skills-1-panel');

  // Neues Modell (E46, E48, E55): Arbeitsweise und Normteile immer, alle übrigen bei Bedarf, schon im Startcommit
  await waitFor('Speicherstand', () => !!window.__t.saveState(), 10000);
  const bdir = path.join(ud, 'workspace-backups', `${proj.id}-skills`);
  const modesOf = (sk, m) => sk.skills.filter((x) => x.mode === m).map((x) => x.id).join(',');
  check('Neues Modell: Konstruktionsablauf, Sauber modellieren, Parametrik und Normteile immer, die übrigen bei Bedarf, Vorgabe für neue Modelle wie im Kopf',
    JSON.stringify(pj().skills) === '["konstruktionsablauf","cadquery","parametrik","normteile"]' && (pj().skills_on_demand ?? []).join(',') === DEMAND_NEW
    && modesOf(s, 'always') === 'konstruktionsablauf,cadquery,parametrik,normteile' && modesOf(s, 'demand') === DEMAND_NEW && !modesOf(s, 'off')
    && s.skills.filter((x) => x.defaultMode === 'always').map((x) => x.id).join(',') === 'konstruktionsablauf,cadquery,parametrik,normteile'
    && s.skills.every((x) => !x.problems.length && !x.changed), JSON.stringify(pj()));
  const fdmNew = read('.soma/skills/3d-druck.md') ?? '';
  check('Neues Modell: Kopien mit Standardwerten, bei Bedarf mit Hinweis (Standardwerte, NOTES.md), Immer ohne',
    !(read('.soma/skills/konstruktionsablauf.md') ?? '{{').includes('{{') && !(read('.soma/skills/konstruktionsablauf.md') ?? '').includes('On demand')
    && fdmNew.includes('# Skill: 3D printing (FDM)\n\n> **On demand:**') && fdmNew.includes('defaults of the app') && fdmNew.includes('`NOTES.md`') && fdmNew.includes('Overhangs up to 45°'), fdmNew.slice(0, 300));
  check('Neues Modell: AGENTS.md mit zwei Listen, bei Bedarf mit Anlass, alles im Startcommit (nichts ungespeichert)',
    always().includes('- `.soma/skills/konstruktionsablauf.md`: Design workflow') && always().includes('- `.soma/skills/cadquery.md`: Clean CadQuery modeling')
    && always().includes('- `.soma/skills/normteile.md`: Standard parts')
    && always().includes('- `.soma/skills/parametrik.md`: Parametric models') && !always().includes('3d-druck')
    && demand().includes('- `.soma/skills/3d-druck.md`: 3D printing (FDM). Read when the parts will be 3D printed on a filament printer (FDM).')
    && DEMAND_NEW.split(',').every((id) => demand().includes(`.soma/skills/${id}.md`))
    && (await g('ls-files', '.soma/skills')).split('\n').length === 17
    && (await ev(() => window.__t.saveState())).dirtyFiles === 0, `${String((await ev(() => window.__t.saveState())).dirtyFiles)} | ${String(block()).slice(0, 200)}`);
  check('Zeile mit Stufen-Schalter, Klick auf die Zeile öffnet die Karte mit drei Stufen, die eingestellte gewählt', await ev(() => {
    document.querySelector('#skills-list .sk-row[data-id="3d-druck"] .sk-open').click();
    const row = document.querySelector('#skills-list .sk-row[data-id="3d-druck"]'); // die Liste wird neu gezeichnet
    const ok = [...document.querySelectorAll('#skill-detail .sk-mode button')].map((b) => `${b.textContent}:${b.getAttribute('aria-checked')}`).join(',') === 'Off:false,On demand:true,Always:false'
      && row.classList.contains('demand') && row.classList.contains('sel') && row.querySelector('.sk-lvl').textContent === 'On demand'
      && document.querySelector('#skills-list .sk-row[data-id="cadquery"] .sk-lvl').classList.contains('always');
    row.querySelector('.sk-open').click();
    return ok && document.getElementById('skill-detail').hidden;
  }));

  // 2) Aus: Kopie weg (unverändert, also ohne Sicherung), project.json und AGENTS.md ohne ihn
  await setMode('laser', 'off');
  check('Laserschneiden aus: Kopie weg, ohne Sicherung, nicht mehr in project.json und AGENTS.md', read('.soma/skills/laser.md') === null && !fs.existsSync(bdir)
    && !(pj().skills_on_demand ?? []).includes('laser') && !(block() ?? '').includes('laser.md') && !(await skill('laser')).problems.length
    && (await ev(() => window.__t.toast())).text.includes('is off'), JSON.stringify(pj().skills_on_demand));

  // Bei Bedarf → Immer: Kopie ohne Hinweis, project.json (und App-Kopie), Liste „Immer“ in AGENTS.md, als Änderung sichtbar
  await setMode('3d-druck', 'always');
  const copy = read('.soma/skills/3d-druck.md');
  const bundledText = norm(fs.readFileSync(path.join(BUNDLED, '3d-druck.md'), 'utf8'));
  check('3D-Druck immer: Kopie mit den Standardwerten, ohne Hinweis, die unveränderte Fassung „bei Bedarf“ ohne Sicherung', copy !== null && bundledText.includes('{{overhang}}') && !copy.includes('{{')
    && copy.includes('Overhangs up to 45° from vertical') && copy.includes('| Nozzle | 0.4 mm |') && copy.split('\n').length === bundledText.split('\n').length
    && !copy.includes('On demand') && !fs.existsSync(bdir));
  check('project.json und die Kopie in den App-Daten führen ihn unter „Immer“', JSON.stringify(pj().skills) === '["konstruktionsablauf","cadquery","parametrik","normteile","3d-druck"]'
    && !(pj().skills_on_demand ?? []).includes('3d-druck')
    && JSON.stringify(JSON.parse(fs.readFileSync(path.join(ud, 'projects', `${proj.id}.json`), 'utf8')).skills) === JSON.stringify(pj().skills)
    && JSON.stringify(JSON.parse(fs.readFileSync(path.join(ud, 'projects', `${proj.id}.json`), 'utf8')).skills_on_demand) === JSON.stringify(pj().skills_on_demand));
  check('AGENTS.md führt ihn unter „Always follow“ (Pfad und englischer Name), der Rest der Datei bleibt', always().includes('- `.soma/skills/3d-druck.md`: 3D printing (FDM)')
    && !demand().includes('3d-druck') && (read('AGENTS.md') ?? '').startsWith('# Instructions for the coding agent') && (read('AGENTS.md') ?? '').includes('## Version history (git)'), String(block()));
  check('Meldung: gilt immer, steht in AGENTS.md, Hinweis auf laufenden Agenten', (await ev(() => window.__t.toast())).text.includes('now always applies and is listed in AGENTS.md'));
  await waitFor('ungespeichert', () => window.__t.saveState()?.dirtyFiles >= 3, 10000).catch(() => {});
  check('Zählt als ungespeicherte Änderung (Kopie, project.json, AGENTS.md)', (await ev(() => window.__t.saveState())).dirtyFiles >= 3, String((await ev(() => window.__t.saveState())).dirtyFiles));

  // Dateibaum: Kopien als eigene Gruppe „Skills“, eingeklappt, nur zum Lesen
  await ev(() => window.__t.showPanel('files'));
  await waitFor('Gruppe Skills im Dateibaum', () => window.__t.fileRows().includes('Skills'), 10000).catch(() => {});
  const copies = fs.readdirSync(path.join(dir, '.soma', 'skills'));
  const skHead = await ev(() => ({ rows: window.__t.fileRows(), count: document.querySelector('#tab-files .frow[data-path=".soma/skills"] .tag')?.textContent }));
  check('Dateibaum: Gruppe „Skills“ eingeklappt, Zahl der Kopien, sonst nichts aus .soma', skHead.rows.includes('Skills') && skHead.count === String(copies.length)
    && !skHead.rows.includes('3d-druck.md') && !skHead.rows.includes('project.json') && !skHead.rows.includes('env'), `${skHead.count}/${copies.length} ${skHead.rows.slice(-6).join(',')}`);
  await ev(() => document.querySelector('#tab-files .frow[data-path=".soma/skills"]').click());
  const skRows = await ev(() => window.__t.fileRows());
  check('Aufgeklappt: die Kopien (3D-Druck), keine ausgeschaltete (Laser)', skRows.includes('3d-druck.md') && skRows.includes('cadquery.md') && !skRows.includes('laser.md'), skRows.join(','));
  const skMenu = await ev(() => {
    const row = document.querySelector('#tab-files .frow[data-path=".soma/skills/3d-druck.md"]');
    const r = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 5 }));
    return [...document.querySelectorAll('#menu-ctx .mi')].map((b) => (b.disabled ? '-' : '') + b.textContent.replace(/(F2|Del)$/, ''));
  });
  check('Menü der Kopie: Öffnen und Pfad ja, Anlegen, Umbenennen und Löschen gesperrt', ['Open', 'Send path to agent', '-New file', '-Rename', '-Delete'].every((x) => skMenu.includes(x)), skMenu.join(','));
  await ev(() => [...document.querySelectorAll('#menu-ctx .mi')].find((b) => b.textContent.startsWith('Open'))?.click());
  await waitFor('Kopie im Code', () => window.__t.editor.state().file === '.soma/skills/3d-druck.md', 10000).catch(() => {});
  const skEd = await ev(() => window.__t.editor.state());
  check('„Open“ im Dateibaum: Kopie im Code-Panel, nur lesen', skEd.file === '.soma/skills/3d-druck.md' && skEd.readOnly && skEd.text.includes('# Skill: 3D printing (FDM)'), JSON.stringify({ f: skEd.file, ro: skEd.readOnly }));
  await waitFor('Dokumentansicht', () => !!document.querySelector('.mdview .md h1'), 10000).catch(() => {});
  const skDoc = await ev(() => { const md = document.querySelector('.mdview .md'); return { first: md?.firstElementChild?.className, front: md?.querySelector('.md-front')?.textContent ?? '', h: [...(md?.querySelectorAll('h1, h2') ?? [])].map((h) => h.textContent).slice(0, 2) }; });
  check('Dokumentansicht: Kopf (Front Matter) als Quelltext vorn, erste Überschrift ist der Titel, kein Kopf als Überschrift', skDoc.first === 'md-front'
    && skDoc.front.startsWith('title: 3D printing (FDM)') && !skDoc.front.includes('---') && skDoc.h[0] === 'Skill: 3D printing (FDM)', JSON.stringify(skDoc));
  await shot('skills-dateibaum');
  await ev(() => window.__t.showPanel('skills'));

  // 3) Ansehen (nur lesen) und An Agent geben
  await ev(() => window.__t.openSkill('3d-druck'));
  await shot('skills-2-aktiv');
  await ev(() => [...document.querySelectorAll('#skill-detail .sk-actions button')].find((b) => b.textContent.includes('View file')).click());
  await waitFor('Code-Panel', () => window.__t.editor.state().file === '.soma/skills/3d-druck.md', 10000);
  const ed = await ev(() => window.__t.editor.state());
  check('„Ansehen": Kopie im Code-Panel, nur lesen, mit Grund', ed.readOnly && ed.text.includes('# Skill: 3D printing (FDM)') && (ed.locked ?? '').includes('Skill'), JSON.stringify({ ro: ed.readOnly, locked: ed.locked }));
  await ev(() => window.__t.showPanel('skills'));
  await waitFor('Karte noch offen', () => document.querySelector('#skill-detail')?.dataset.id === '3d-druck' && !document.getElementById('skill-detail').hidden, 10000);
  // Eingefügten Text mitschneiden (im Terminal bricht die lange Eingabezeile um)
  await ev(() => { const tm = window.__t.terminals; const orig = tm.insert.bind(tm); tm.insert = (x) => { window.__inserted = x; return orig(x); }; });
  await ev(() => [...document.querySelectorAll('#skill-detail .sk-actions button')].find((b) => b.textContent.includes('Send to agent')).click());
  await sleep(300);
  check('„Send to agent" fügt [Skill: .soma/skills/3d-druck.md] ein', (await ev(() => window.__t.toast())).text.includes('Added to the input of')
    && await ev(() => window.__inserted) === '[Skill: .soma/skills/3d-druck.md] ', await ev(() => window.__inserted));

  // 3b) Einstellungen: Max. Überhang auf 50° (Wunsch des Nutzers), Werte landen in project.json und in der Kopie
  check('Aufgeklappt: Einstellungen mit Standardwerten (Max. overhang angle 45°, Nozzle 0.4 mm, Material PLA)', await ev(() =>
    document.getElementById('sk-3d-druck-overhang')?.value === '45' && document.getElementById('sk-3d-druck-nozzle')?.value === '0.4' && document.getElementById('sk-3d-druck-material')?.value === 'PLA'));
  await setVar('3d-druck', 'overhang', '50');
  await waitFor('Überhang 50', () => window.__t.skills().skills.find((x) => x.id === '3d-druck')?.vars.overhang === 50, 10000);
  let c3 = read('.soma/skills/3d-druck.md') ?? '';
  check('Max. Überhang 50°: project.json, Kopie mit 50° (Text, Tabelle, Kopf), keine „Abweichung"', JSON.stringify(settings()) === '{"3d-druck":{"overhang":50}}'
    && c3.includes('Overhangs up to 50° from vertical') && c3.includes('| Max. overhang without support | 50° from vertical |') && c3.includes('var overhang: 50 |') && c3.includes('MAX_OVERHANG = 50')
    && !(await skill('3d-druck')).changed, JSON.stringify(settings()));
  s = await st();
  check('Kurzbeschreibung „overhangs up to 50°", die Zeile nennt „50° · customized", Rücksetzknopf in der Karte', s.skills.find((x) => x.id === '3d-druck').summary.includes('overhangs up to 50°')
    && s.text.includes('50° · customized') && s.detail.includes('1 customized')
    && await ev(() => !document.querySelector('#skill-detail .sk-var[data-var="overhang"] .sk-reset').hidden && document.querySelector('#skill-detail .sk-var[data-var="nozzle"] .sk-reset').hidden), s.skills[0].summary);
  check('Meldung nennt Wert und Datei', (await ev(() => window.__t.toast())).text.includes('Max. overhang angle 50°. Written to .soma/skills/3d-druck.md'), (await ev(() => window.__t.toast())).text);
  await setVar('3d-druck', 'overhang', '95');
  await waitFor('Fehlermeldung', () => window.__t.toast().error, 5000).catch(() => {});
  check('95° außerhalb des Bereichs: abgelehnt mit Grund, 50° bleibt', (await ev(() => window.__t.toast())).text.includes('must be between 10 and 85°')
    && await varOf('3d-druck', 'overhang') === 50 && JSON.stringify(settings()) === '{"3d-druck":{"overhang":50}}'
    && await ev(() => document.getElementById('sk-3d-druck-overhang').value) === '50', (await ev(() => window.__t.toast())).text);
  await setVar('3d-druck', 'material', 'PETG');
  await waitFor('Material', () => window.__t.skills().skills.find((x) => x.id === '3d-druck')?.vars.material === 'PETG', 10000);
  await setVar('3d-druck', 'nozzle', '0,6');
  await waitFor('Düse', () => window.__t.skills().skills.find((x) => x.id === '3d-druck')?.vars.nozzle === 0.6, 10000);
  c3 = read('.soma/skills/3d-druck.md') ?? '';
  check('Auswahl (PETG) und Zahl mit Komma (0,6): in der Kopie mit Punkt', c3.includes('| Material | PETG |') && c3.includes('| Nozzle | 0.6 mm |') && c3.includes('NOZZLE = 0.6')
    && await ev(() => document.getElementById('sk-3d-druck-nozzle').value) === '0.6');
  await ev(() => [...document.querySelectorAll('#skill-detail .sk-actions button')].find((b) => b.textContent.includes('Send to agent')).click());
  await sleep(300);
  check('„Send to agent" nennt die geänderten Einstellungen (Zahlen mit Punkt)', await ev(() => window.__inserted)
    === '[Skill: .soma/skills/3d-druck.md, settings: Material = PETG, Nozzle = 0.6 mm, Max. overhang angle = 50°] ', await ev(() => window.__inserted));
  await ev(() => document.querySelector('#skill-detail .sk-var[data-var="nozzle"] .sk-reset').click());
  await waitFor('Düse zurück', () => window.__t.skills().skills.find((x) => x.id === '3d-druck')?.vars.nozzle === 0.4, 10000);
  check('Zurück auf den Standard: Düse 0.4 mm, aus project.json entfernt, Kopie wieder 0.4', settings()['3d-druck']?.overhang === 50 && settings()['3d-druck']?.material === 'PETG' && !('nozzle' in (settings()['3d-druck'] ?? {}))
    && (read('.soma/skills/3d-druck.md') ?? '').includes('| Nozzle | 0.4 mm |'), JSON.stringify(settings()));
  // Ausgeschalteter Skill: Werte lassen sich vorab einstellen und gelten beim Einschalten
  await ev(() => window.__t.openSkill('laser'));
  await setVar('laser', 'thickness', '4');
  await waitFor('Platte 4', () => window.__t.skills().skills.find((x) => x.id === 'laser')?.vars.thickness === 4, 10000);
  check('Laserschneiden (aus): Plattenstärke 4 mm gespeichert, keine Datei angelegt, Hinweis „gilt, sobald nicht mehr aus"', settings().laser?.thickness === 4 && read('.soma/skills/laser.md') === null
    && (await ev(() => window.__t.toast())).text.includes('Applies as soon as the skill is no longer off'));
  await shot('skills-3-einstellungen');
  // Einstellung bei Bedarf: Der Hinweis nennt den gesetzten Wert, die übrigen bleiben Standard der App
  await ev(() => window.__t.openSkill('festigkeit'));
  await setVar('festigkeit', 'safety', '3');
  await waitFor('Sicherheit 3', () => window.__t.skills().skills.find((x) => x.id === 'festigkeit')?.vars.safety === 3, 10000);
  const fest = read('.soma/skills/festigkeit.md') ?? '';
  check('Festigkeit (bei Bedarf), Sicherheit 3: Kopie mit SAFETY = 3, Hinweis nennt `safety` als vom Nutzer gesetzt, „An Agent geben“ da', fest.includes('`SAFETY = 3`')
    && fest.includes('The user set `safety` in the app.') && !(await skill('festigkeit')).changed
    && await ev(() => [...document.querySelectorAll('#skill-detail .sk-actions button')].some((b) => b.textContent.includes('Send to agent'))), fest.slice(0, 400));

  // 4) Zweiter Skill auf Immer: in AGENTS.md in der Reihenfolge des Einschaltens
  await setMode('toleranzen', 'always');
  const b2 = always();
  check('Toleranzen immer: AGENTS.md nennt beide unter „Immer“, project.json auch', b2.indexOf('3d-druck.md') > 0 && b2.indexOf('toleranzen.md') > b2.indexOf('3d-druck.md')
    && !demand().includes('toleranzen.md') && JSON.stringify(pj().skills) === '["konstruktionsablauf","cadquery","parametrik","normteile","3d-druck","toleranzen"]', b2);
  // Immer → Bei Bedarf: Kopie bekommt den Hinweis, keine Sicherung, Meldung
  await setMode('normteile', 'demand');
  check('Normteile bei Bedarf: Kopie mit Hinweis, Liste „Bei Bedarf“, ohne Sicherung, Meldung „nur noch bei Bedarf“', (read('.soma/skills/normteile.md') ?? '').includes('> **On demand:**')
    && demand().includes('- `.soma/skills/normteile.md`: Standard parts. Read when') && !always().includes('normteile') && !fs.existsSync(bdir)
    && (await ev(() => window.__t.toast())).text.includes('now only applies on demand'), (await ev(() => window.__t.toast())).text);

  // 5) Kopie geändert (etwa vom Agenten): gemeldet, beim Ausschalten in die Sicherung
  fs.appendFileSync(path.join(dir, '.soma', 'skills', '3d-druck.md'), '\n- Use PETG only.\n');
  await ev(() => window.__t.showPanel('files'));
  await ev(() => window.__t.showPanel('skills'));
  await waitFor('geändert erkannt', () => window.__t.skills().skills.find((x) => x.id === '3d-druck')?.changed === true, 10000);
  await ev(() => window.__t.openSkill('3d-druck'));
  check('Geänderte Kopie: „weicht ab" in der Zeile und in der Karte', (await st()).text.includes('The copy differs from the current version') && ((await st()).detail ?? '').includes('differs from the current version of the skill'));
  await setVar('3d-druck', 'overhang', '55');
  await waitFor('Überhang 55', () => window.__t.skills().skills.find((x) => x.id === '3d-druck')?.vars.overhang === 55, 10000);
  let backups = fs.existsSync(bdir) ? fs.readdirSync(bdir) : [];
  check('Einstellung an geänderter Kopie: Kopie in die Sicherung, neu geschrieben mit 55°', backups.length === 1 && fs.readFileSync(path.join(bdir, backups[0]), 'utf8').includes('Use PETG only.')
    && !(read('.soma/skills/3d-druck.md') ?? '').includes('Use PETG only.') && (read('.soma/skills/3d-druck.md') ?? '').includes('up to 55°') && !(await skill('3d-druck')).changed
    && (await ev(() => window.__t.toast())).text.includes('backup'), backups.join(','));
  await setMode('3d-druck', 'off');
  backups = fs.existsSync(bdir) ? fs.readdirSync(bdir) : [];
  check('Ausschalten: Kopie weg, unveränderte Kopie ohne neue Sicherung, Einstellungen bleiben', read('.soma/skills/3d-druck.md') === null && backups.length === 1
    && settings()['3d-druck']?.overhang === 55, backups.join(','));
  check('AGENTS.md und project.json ohne 3D-Druck, Toleranzen bleibt', !(block() ?? '').includes('3d-druck') && always().includes('toleranzen.md')
    && JSON.stringify(pj().skills) === '["konstruktionsablauf","cadquery","parametrik","toleranzen"]' && !(pj().skills_on_demand ?? []).includes('3d-druck'));
  check('Meldung nennt den laufenden Agenten', /is off\..*tell it/.test((await ev(() => window.__t.toast())).text), (await ev(() => window.__t.toast())).text);

  // 6) Datei eines aktiven Skills fehlt: gemeldet, nicht neu angelegt (E28)
  // Der Dateibaum ist dabei offen: Er folgt Änderungen in .soma/skills/ ohne Wechsel des Panels
  await ev(() => window.__t.showPanel('files'));
  await waitFor('toleranzen.md im Dateibaum', () => window.__t.fileRows().includes('toleranzen.md'), 10000).catch(() => {});
  const hadTol = (await ev(() => window.__t.fileRows())).includes('toleranzen.md');
  fs.rmSync(path.join(dir, '.soma', 'skills', 'toleranzen.md'));
  await waitFor('Dateibaum ohne toleranzen.md', () => { const r = window.__t.fileRows(); return !r.includes('toleranzen.md') && r.includes('cadquery.md'); }, 10000).catch(() => {});
  const tolRows = await ev(() => window.__t.fileRows());
  check('Dateibaum folgt .soma/skills/: gelöschte Kopie verschwindet sofort, ausgeschalteter 3D-Druck fehlt', hadTol && !tolRows.includes('toleranzen.md')
    && tolRows.includes('cadquery.md') && !tolRows.includes('3d-druck.md'), tolRows.join(','));
  await ev(() => window.__t.showPanel('skills'));
  await waitFor('Problem gemeldet', () => window.__t.skills().skills.find((x) => x.id === 'toleranzen')?.problems.length > 0, 10000);
  const info = await ev(() => window.soma.project.current());
  check('Fehlende Kopie: Hinweis in der Karte und im Projekt-Check, nichts neu angelegt', (await skill('toleranzen')).problems[0].includes('missing')
    && info.problems.some((p) => p.includes('toleranzen')) && read('.soma/skills/toleranzen.md') === null, JSON.stringify(info.problems));
  await setMode('toleranzen', 'off');
  check('Ausschalten räumt auf: kein Problem mehr, nicht mehr in AGENTS.md und project.json', !(await skill('toleranzen')).problems.length && !(block() ?? '').includes('toleranzen')
    && JSON.stringify(pj().skills) === '["konstruktionsablauf","cadquery","parametrik"]');

  // 7) Älteres Projekt ohne Abschnitt in AGENTS.md: Er wird am Ende angehängt, nicht doppelt
  const agents = read('AGENTS.md');
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), agents.replace(/\n*<!-- soma:skills -->[\s\S]*<!-- \/soma:skills -->\n?/, '\n'));
  await setMode('laser', 'demand');
  const a2 = read('AGENTS.md');
  check('Laserschneiden bei Bedarf: die vorher eingestellte Plattenstärke (4 mm) steht in der Kopie, Hinweis nennt sie', (read('.soma/skills/laser.md') ?? '').includes('4 mm thick')
    && (read('.soma/skills/laser.md') ?? '').includes('THICKNESS = 4') && (read('.soma/skills/laser.md') ?? '').includes('The user set `thickness` in the app.'));
  check('Ohne Abschnitt: am Ende angehängt, genau einmal', a2.trimEnd().endsWith('<!-- /soma:skills -->') && a2.split('<!-- soma:skills -->').length === 2
    && demand().includes('- `.soma/skills/laser.md`: Laser cutting. Read when'), String(block()));

  // 8) AGENTS.md fehlt ganz: Skill geht trotzdem an, Warnung, AGENTS.md wird nicht neu angelegt
  const keep = read('AGENTS.md');
  fs.rmSync(path.join(dir, 'AGENTS.md'));
  await setMode('3d-druck', 'always');
  check('Wieder an: Kopie mit den gespeicherten Einstellungen (55°, PETG)', (read('.soma/skills/3d-druck.md') ?? '').includes('up to 55°') && (read('.soma/skills/3d-druck.md') ?? '').includes('| Material | PETG |'));
  check('Ohne AGENTS.md: Skill an, Warnung, keine neue AGENTS.md', read('AGENTS.md') === null && read('.soma/skills/3d-druck.md') !== null
    && (await ev(() => window.__t.toast())).text.includes('AGENTS.md is missing') && (await ev(() => window.__t.toast())).error, (await ev(() => window.__t.toast())).text);
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), keep);
  await ev(() => window.__t.showPanel('files'));
  await ev(() => window.__t.showPanel('skills'));
  await waitFor('Problem AGENTS.md', () => window.__t.skills().skills.find((x) => x.id === '3d-druck')?.problems.length > 0, 10000);
  check('AGENTS.md ohne Eintrag eines aktiven Skills: gemeldet', (await skill('3d-druck')).problems.some((p) => p.includes('AGENTS.md does not name')), JSON.stringify((await skill('3d-druck')).problems));
  await setMode('3d-druck', 'off');
  await setMode('3d-druck', 'always');
  check('Aus und wieder an trägt ihn ein', !(await skill('3d-druck')).problems.length && always().includes('3d-druck.md') && demand().includes('laser.md'));
  // Liste „Bei Bedarf“ verloren (etwa von Hand bearbeitet): Laser steht dann unter „Immer“, das wird gemeldet
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), (read('AGENTS.md') ?? '').replace('### Read when relevant', ''));
  await ev(() => window.__t.showPanel('files'));
  await ev(() => window.__t.showPanel('skills'));
  await waitFor('falsche Liste', () => window.__t.skills().skills.find((x) => x.id === 'laser')?.problems.length > 0, 10000);
  check('AGENTS.md führt einen Skill unter der falschen Stufe: gemeldet', (await skill('laser')).problems.some((p) => p.includes('under “Always”, but it is set to “On demand”')),
    JSON.stringify((await skill('laser')).problems));
  await setMode('festigkeit', 'off');
  check('Nächstes Umstellen schreibt den Abschnitt neu: Meldung weg', !(await skill('laser')).problems.length && demand().includes('laser.md'));

  // 9) Speichern: Skills im Snapshot und in der ZIP
  const zipPath = path.join(workDir, 'Skills.zip');
  await app.answers([zipPath]);
  await domClick('btn-save');
  await waitFor('gespeichert', () => window.__t.saveState() && !window.__t.saveState().unsaved && window.__t.saveState().zipPath, 60000)
    .catch(async (e) => { console.log('Stand:', JSON.stringify(await ev(() => ({ save: window.__t.saveState(), toast: window.__t.toast() })))); throw e; });
  const tracked = (await g('ls-files', '.soma/skills')).split('\n');
  check('Snapshot enthält die Skills (in Git)', tracked.includes('.soma/skills/3d-druck.md') && tracked.includes('.soma/skills/laser.md'), tracked.join(','));
  const names = await listZip(zipPath);
  check('ZIP enthält die Skills', names.includes('.soma/skills/3d-druck.md') && names.includes('.soma/skills/laser.md'));

  // 10) Stufe für neue Modelle (E46, E55): gilt für die App (state.json), das offene Modell bleibt, wie es ist
  const appState = () => { try { return JSON.parse(fs.readFileSync(path.join(ud, 'state.json'), 'utf8')); } catch { return {}; } };
  const setDefault = async (id, mode) => {
    if (!(await ev((i) => !!document.getElementById(`sk-${i}-default`), id))) await ev((i) => window.__t.openSkill(i), id);
    await ev(([i, m]) => { const f = document.getElementById(`sk-${i}-default`); f.value = m; f.dispatchEvent(new Event('change')); }, [id, mode]);
    await waitFor(`Vorgabe ${id} ${mode}`, ([i, m]) => { const x = window.__t.skills(); return !x.busy.length && x.skills.find((k) => k.id === i)?.defaultMode === m; }, 10000, [id, mode]);
  };
  const before = JSON.stringify(pj());
  await setDefault('3d-druck', 'always');
  // Die Meldung kommt erst nach der neuen Stufe im Panel
  await waitFor('Meldung Vorgabe', () => window.__t.toast().text.includes('for new models'), 10000).catch(() => {});
  check('Stufe bei neuen Modellen „Always“ (3D-Druck): in state.json, Meldung, das offene Modell unverändert', JSON.stringify(appState().skill_defaults) === '{"3d-druck":"always"}'
    && JSON.stringify(pj()) === before && !(await ev(() => window.__t.saveState())).unsaved
    && (await ev(() => window.__t.toast())).text.includes('is set to “Always” for new models. This model stays as it is.'), JSON.stringify(appState().skill_defaults));
  await setDefault('konstruktionsablauf', 'demand');
  await setDefault('laser', 'off');
  await setDefault('cadquery', 'off');
  await setDefault('cadquery', 'always');
  check('Abweichungen vom Kopf stehen in state.json, zurück auf den Kopf fällt der Eintrag weg', JSON.stringify(appState().skill_defaults) === '{"3d-druck":"always","konstruktionsablauf":"demand","laser":"off"}'
    && appState().lastProject === proj.id && (await skill('laser')).defaultMode === 'off', JSON.stringify(appState().skill_defaults));
  await shot('skills-4-neue-modelle');
  await domClick('btn-new');
  await waitFor('neues Projekt', (oldId) => window.__t.project().id !== oldId && window.__t.status().state === 'ok', 90000, proj.id);
  const p2 = await ev(() => window.__t.project());
  const pj2 = JSON.parse(fs.readFileSync(path.join(p2.dir, '.soma', 'project.json'), 'utf8'));
  const fdm2 = fs.readFileSync(path.join(p2.dir, '.soma', 'skills', '3d-druck.md'), 'utf8');
  const ka2 = fs.readFileSync(path.join(p2.dir, '.soma', 'skills', 'konstruktionsablauf.md'), 'utf8');
  check('Neues Modell nach der Vorgabe: immer Sauber modellieren, Parametrik, 3D-Druck, Normteile, Laser aus, Konstruktionsablauf bei Bedarf, Standardwerte statt 55° und PETG',
    JSON.stringify(pj2.skills) === '["cadquery","parametrik","3d-druck","normteile"]' && pj2.skills_on_demand.join(',') === 'konstruktionsablauf,harz-pulver,cnc,blech,toleranzen,verbindungen,festigkeit,baugruppen,analyse,animation,fem,zeichnung'
    && !pj2.skill_settings && fdm2.includes('Overhangs up to 45°') && fdm2.includes('| Material | PLA |') && !fdm2.includes('On demand') && ka2.includes('> **On demand:**')
    && !fs.existsSync(path.join(p2.dir, '.soma', 'skills', 'laser.md'))
    && norm(fs.readFileSync(path.join(p2.dir, 'AGENTS.md'), 'utf8')).includes('- `.soma/skills/3d-druck.md`: 3D printing (FDM)\n'), JSON.stringify(pj2));
  await waitFor('Speicherstand neu', () => window.__t.saveState() && !window.__t.saveState().unsaved, 10000).catch(() => {});
  check('Neues Modell: Skills im Startcommit, nichts ungespeichert', (await exec(['ls-files', '.soma/skills'], p2.dir)).stdout.trim().split('\n').length === 16
    && (await ev(() => window.__t.saveState())).dirtyFiles === 0, String((await ev(() => window.__t.saveState())).dirtyFiles));

  // 11) Einstellungen (E78): eigene Skills anlegen, mitgelieferte bearbeiten und zurücksetzen, löschen, importieren
  const ust = () => ev(() => window.__t.settings());
  const userSkill = (id) => { try { return fs.readFileSync(path.join(ud, 'skills', `${id}.md`), 'utf8'); } catch { return null; } };
  const copyOf = (id) => { try { return fs.readFileSync(path.join(p2.dir, '.soma', 'skills', `${id}.md`), 'utf8'); } catch { return null; } };
  const block2 = () => { const m = /<!-- soma:skills -->([\s\S]*?)<!-- \/soma:skills -->/.exec(norm(fs.readFileSync(path.join(p2.dir, 'AGENTS.md'), 'utf8'))); return m ? m[1] : ''; };
  const skill2 = async (id) => (await ev(() => window.__t.skills())).skills.find((s) => s.id === id);
  const selectRow = (id) => ev((i) => document.querySelector(`#st-list .st-row[data-id="${i}"]`).click(), id);
  const waitSel = (id) => waitFor(`Einstellungen: ${id} offen`, (i) => window.__t.settings().selected === i && !window.__t.settings().busy, 10000, id);
  const waitCheck = (re) => waitFor(`Prüfung ${re}`, (r) => { const c = window.__t.settings().check; return !!c && new RegExp(r).test([...c.errors, ...c.warnings, c.errors.length + c.warnings.length ? '' : 'OK'].join('|')); }, 10000, re.source);
  const clickAct = (act) => ev((a) => document.querySelector(`#st-editor [data-act="${a}"]`).click(), act);
  await ev(() => window.__t.showPanel('skills'));
  check('Knopf „Settings“ in der Leiste ist aktiv', await ev(() => !document.getElementById('btn-settings').disabled && document.getElementById('btn-settings').textContent === 'Settings'));
  await domClick('btn-settings');
  await waitFor('Einstellungen offen', () => window.__t.settings().open && window.__t.settings().skills.length >= 17, 10000);
  let us = await ust();
  check('Einstellungen: alle mitgelieferten Skills nach Kategorien, keiner gewählt, Hintergrund gesperrt', us.skills.length === 17 && us.skills.every((s) => s.source === 'builtin') && us.selected === null
    && us.list.includes('3D printing (FDM)') && /way of working/i.test(us.list) && await ev(() => {
      // Echte Klicks: Das Fenster selbst darf nicht gesperrt sein, der Knopf liegt oben (Treffertest)
      const b = document.getElementById('btn-st-new').getBoundingClientRect();
      return document.getElementById('topbar').inert && document.getElementById('body').inert && !document.getElementById('settings').hidden
        && !document.getElementById('settings').closest('[inert]') && !document.getElementById('menu-skill-name').closest('[inert]') && !document.getElementById('toast').closest('[inert]')
        && !!document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)?.closest('#btn-st-new');
    }), us.list.slice(0, 120));
  await selectRow('3d-druck');
  await waitSel('3d-druck');
  await waitCheck(/^OK$/);
  us = await ust();
  check('Mitgelieferter Skill im Editor: Text mit Kopf, Hinweis zum Bearbeiten, Prüfung ohne Hinweise, Speichern gesperrt', us.source === 'builtin' && us.text.startsWith('---\ntitle: 3D printing (FDM)')
    && us.editor.includes('3d-druck.md · built into the app') && us.editor.includes('Built-in skill. When you save') && !us.dirty
    && await ev(() => document.querySelector('#st-editor [data-act="save"]').disabled && !document.querySelector('#st-editor [data-act="remove"]')), us.editor);
  await shot('skills-5-einstellungen');

  // Neuer Skill über das Popover: Name, Vorschau des Dateinamens, Enter legt an
  await domClick('btn-st-new');
  await ev(() => { const i = document.querySelector('#menu-skill-name .st-name-in'); i.value = 'Welded frames'; i.dispatchEvent(new Event('input')); });
  await shot('skills-5b-neuer-name');
  const preview = await ev(() => document.querySelector('#menu-skill-name .st-name-file').textContent);
  await ev(() => document.querySelector('#menu-skill-name .st-name-in').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  await waitSel('welded-frames');
  us = await ust();
  check('Neuer Skill: Dateiname vorab, angelegt in den App-Daten aus der Vorlage, gewählt, Meldung', preview === 'File: welded-frames.md' && us.source === 'own'
    && (userSkill('welded-frames') ?? '').startsWith('---\ntitle: Welded frames\n') && us.skills.find((s) => s.id === 'welded-frames')?.category === 'My skills'
    && (await ev(() => window.__t.toast())).text.includes('created as welded-frames.md'), preview);
  const WF = '---\ntitle: Welded frames\nname: Welded frames\nsummary: Steel frames from tubes, wall {{wall}} mm.\ncategory: My skills\ndefault: on-demand\nwhen: the frame is welded\nvar wall: 2 | mm | Tube wall | 1..5\n---\n\n# Skill: Welded frames\n\n- Tubes with {{wall}} mm wall, {{gap}} gap.\n';
  await ev((t) => window.__t.settingsType(t), WF);
  await waitCheck(/“\{\{gap\}\}” has no setting/);
  await shot('skills-6-eigener-skill');
  us = await ust();
  check('Tippen: ungespeichert (Punkt in der Zeile, Speichern frei), Prüfung meldet den Platzhalter ohne Einstellung', us.dirty && us.editor.includes('unsaved')
    && await ev(() => document.querySelector('#st-list .st-row.sel').classList.contains('dirty') && !document.querySelector('#st-editor [data-act="save"]').disabled));
  // Strg+S im Editor speichert den Skill, nicht das Modell
  const head2 = async () => (await exec(['rev-parse', 'HEAD'], p2.dir)).stdout.trim();
  const headBefore = await head2();
  await ev(() => document.querySelector('#st-cm .cm-content').dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true })));
  await waitFor('gespeichert', () => !window.__t.settings().dirty && !window.__t.settings().busy, 10000);
  check('Strg+S: Skill gespeichert (Datei wie getippt), Modell nicht gespeichert, Hinweis bleibt nach dem Speichern', userSkill('welded-frames') === WF
    && (await head2()) === headBefore && (await ust()).check.warnings.some((w) => /\{\{gap\}\}/.test(w))
    && (await ev(() => window.__t.toast())).text.includes('“Welded frames” saved. New models get this version.'),
  JSON.stringify({ same: userSkill('welded-frames') === WF, head: (await head2()) === headBefore, unsaved: (await ev(() => window.__t.saveState())).unsaved, check: (await ust()).check }));

  // Im Modell: der eigene Skill steht im Panel und lässt sich einschalten wie ein mitgelieferter
  await ev(() => window.__t.closeSettings());
  await waitFor('Panel neu', () => window.__t.skills().skills.some((s) => s.id === 'welded-frames'), 10000);
  check('Panel: eigener Skill unter „My skills“, aus, mit Einstellung', (await skill2('welded-frames')).mode === 'off' && (await skill2('welded-frames')).category === 'My skills'
    && (await skill2('welded-frames')).vars.wall === 2 && !(await ev(() => document.getElementById('body').inert || document.getElementById('topbar').inert)));
  await setMode('welded-frames', 'always');
  check('Eigener Skill „Always“: Kopie mit eingesetztem Wert, in AGENTS.md', (copyOf('welded-frames') ?? '').includes('- Tubes with 2 mm wall') && block2().includes('- `.soma/skills/welded-frames.md`: Welded frames'), copyOf('welded-frames'));
  check('Karte: Herkunft und Knopf „Edit“', await ev(() => {
    window.__t.openSkill('welded-frames');
    return document.getElementById('skill-detail').innerText.includes('My skills · your own skill') && !!document.querySelector('#skill-detail [data-act="edit"]');
  }));
  await shot('skills-7-karte-eigener');
  // „Edit“ in der Karte öffnet die Einstellungen beim Skill. Gespeichert gilt die neue Fassung erst nach Aus und Ein im Modell
  await ev(() => document.querySelector('#skill-detail [data-act="edit"]').click());
  await waitSel('welded-frames');
  await ev((t) => window.__t.settingsType(t), WF.replace(', {{gap}} gap', '').replace('\n- Tubes', '\n- Grind the welds.\n- Tubes'));
  await clickAct('save');
  await waitFor('gespeichert 2', () => !window.__t.settings().dirty && !window.__t.settings().busy, 10000);
  await waitFor('Meldung mit Modell', () => window.__t.toast().text.includes('The open model keeps its copy'), 10000).catch(() => {});
  check('Speichern bei eingeschaltetem Skill: Hinweis, dass das Modell seine Kopie behält, Kopie unverändert', (await ev(() => window.__t.toast())).text.includes('The open model keeps its copy')
    && !(copyOf('welded-frames') ?? '').includes('Grind'), (await ev(() => window.__t.toast())).text);
  await ev(() => window.__t.closeSettings());
  await waitFor('Panel: Kopie weicht ab', () => window.__t.skills().skills.find((s) => s.id === 'welded-frames')?.changed, 10000);
  await setMode('welded-frames', 'off');
  await setMode('welded-frames', 'always');
  check('Aus und wieder Ein übernimmt die neue Fassung', (copyOf('welded-frames') ?? '').includes('- Grind the welds.') && !(await skill2('welded-frames')).changed);

  // Mitgelieferten bearbeiten: eigene Fassung in den App-Daten, Fingerabdruck in state.json, „Edited“ in der Liste
  await ev(() => window.__t.openSettings('3d-druck'));
  await waitSel('3d-druck');
  const fdmText = (await ust()).text;
  await ev((t) => window.__t.settingsType(t), fdmText.replace('summary: ', 'summary: Our printers. '));
  await clickAct('save');
  await waitFor('bearbeitet', () => window.__t.settings().source === 'edited' && !window.__t.settings().dirty, 10000);
  us = await ust();
  check('Mitgelieferten gespeichert: „edited“, eigene Datei, Fingerabdruck, Abzeichen „Edited“, Ansicht „Built-in“', (userSkill('3d-druck') ?? '').includes('summary: Our printers.')
    && typeof appState().skill_bases?.['3d-druck'] === 'string' && us.list.includes('Edited') && us.editor.includes('edited by you')
    && await ev(() => !!document.querySelector('#st-editor .st-mode [data-mode="builtin"]')), JSON.stringify(appState().skill_bases));
  await ev(() => document.querySelector('#st-editor .st-mode [data-mode="builtin"]').click());
  check('Ansicht „Built-in“: die mitgelieferte Fassung, nur lesbar', await ev(() => { const v = document.querySelector('.st-bi .cm-content'); return !!v && v.getAttribute('contenteditable') === 'false' && !v.textContent.includes('Our printers'); }));
  await ev(() => document.querySelector('#st-editor .st-mode [data-mode="preview"]').click());
  check('Vorschau: Dokument mit Überschrift', await ev(() => !document.querySelector('.st-md').hidden && document.querySelector('.st-md h1')?.textContent === 'Skill: 3D printing (FDM)'));
  await app.answers([0]);
  await clickAct('remove');
  await waitFor('zurückgesetzt', () => window.__t.settings().source === 'builtin', 10000);
  const libBak = path.join(ud, 'workspace-backups', 'skills-library');
  check('Zurücksetzen: wieder mitgeliefert, eigene Fassung in der Sicherung, Fingerabdruck weg', userSkill('3d-druck') === null && !appState().skill_bases
    && fs.readdirSync(libBak).some((n) => n.endsWith('3d-druck.md') && fs.readFileSync(path.join(libBak, n), 'utf8').includes('Our printers')), fs.existsSync(libBak) ? fs.readdirSync(libBak).join(',') : 'keine Sicherung');

  // Ungespeichertes beim Wechsel: Abbrechen bleibt, Verwerfen wechselt ohne zu schreiben
  await selectRow('welded-frames');
  await waitSel('welded-frames');
  const wfSaved = userSkill('welded-frames');
  await ev(() => window.__t.settingsType('---\ntitle: X\n---\n# X\n'));
  await app.answers([2]);
  await selectRow('cnc');
  await sleep(300);
  check('Wechsel mit Ungespeichertem, „Cancel“: bleibt beim Skill, ungespeichert', (await ust()).selected === 'welded-frames' && (await ust()).dirty);
  await app.answers([1]);
  await selectRow('cnc');
  await waitSel('cnc');
  check('„Discard“: gewechselt, Datei unverändert', userSkill('welded-frames') === wfSaved);

  // Import: Datei wählen, Kennung aus dem Dateinamen
  const impFile = path.join(workDir, 'Glued joints.md');
  fs.writeFileSync(impFile, '---\ntitle: Glued joints\nsummary: Gaps for adhesive.\ncategory: My skills\nwhen: parts are glued\n---\n# Glued joints\n\n- Leave 0.1 mm for the adhesive.\n');
  await app.answers([[impFile]]);
  await domClick('btn-st-import');
  await waitSel('glued-joints');
  check('Import: als eigener Skill übernommen und gewählt, Meldung', (await ust()).source === 'own' && (userSkill('glued-joints') ?? '').includes('0.1 mm')
    && (await ev(() => window.__t.toast())).text.includes('“Glued joints” imported.'), (await ev(() => window.__t.toast())).text);

  // Eigenen löschen: Das Modell behält seine Kopie, das Panel meldet, dass es ihn nicht mehr gibt
  await selectRow('welded-frames');
  await waitSel('welded-frames');
  await app.answers([0]);
  await clickAct('remove');
  await waitFor('gelöscht', () => !window.__t.settings().skills.some((s) => s.id === 'welded-frames') && window.__t.settings().selected === null, 10000);
  check('Eigenen gelöscht: Datei in der Sicherung, Kopie im Modell bleibt', userSkill('welded-frames') === null && !!copyOf('welded-frames')
    && fs.readdirSync(libBak).some((n) => n.endsWith('welded-frames.md')));
  // Escape schließt die Einstellungen
  await ev(() => document.querySelector('.st-dlg').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  await waitFor('geschlossen', () => !window.__t.settings().open, 5000);
  await waitFor('Panel gelöscht', () => window.__t.skills().skills.find((s) => s.id === 'welded-frames')?.problems.length > 0, 10000);
  check('Panel: gelöschter eigener Skill bleibt im Modell und wird gemeldet', (await skill2('welded-frames')).source === null && (await skill2('welded-frames')).mode === 'always'
    && (await skill2('welded-frames')).problems.some((p) => p.includes('Neither this app nor your own skills include this skill')), JSON.stringify((await skill2('welded-frames')).problems));

  // Auch von der Startseite aus
  await ev(() => window.__t.showStart(true));
  await domClick('btn-start-settings');
  await waitFor('Einstellungen von der Startseite', () => window.__t.settings().open, 5000);
  check('Startseite: „Settings“ öffnet die Einstellungen, Startseite gesperrt', await ev(() => document.getElementById('start').inert));
  await ev(() => window.__t.closeSettings());
  await ev(() => window.__t.showStart(false));

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
