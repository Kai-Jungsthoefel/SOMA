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
  /** Stufe im Umschalter der Karte wählen (E55): off, demand oder always. */
  const setMode = async (id, mode) => {
    await ev(([i, m]) => document.querySelector(`#skills-list .sk-row[data-id="${i}"] .sk-mode button[data-mode="${m}"]`).click(), [id, mode]);
    await waitFor(`Skill ${id} ${mode}`, ([i, m]) => { const s = window.__t.skills(); return !s.busy.length && s.skills.find((x) => x.id === i)?.mode === m; }, 10000, [id, mode]);
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
  /** Die beiden Listen des Abschnitts: Immer vor „Read when relevant“, Bei Bedarf danach. */
  const always = () => (block() ?? '').split('### Read when relevant')[0];
  const demand = () => (block() ?? '').split('### Read when relevant')[1] ?? '';
  const DEMAND_NEW = '3d-druck,harz-pulver,cnc,laser,blech,toleranzen,verbindungen,festigkeit,baugruppen';

  // 1) Panel: die mitgelieferten Skills nach Kategorien und `order`
  await ev(() => document.querySelector('#rail [data-panel="skills"]').click());
  await waitFor('Skills geladen', () => window.__t.skills().skills.length >= 3, 10000);
  let s = await st();
  const ORDER = 'konstruktionsablauf,cadquery,3d-druck,harz-pulver,cnc,laser,blech,toleranzen,verbindungen,normteile,festigkeit,baugruppen';
  const heads = await ev(() => [...document.querySelectorAll('#skills-list .sk-cat')].map((h) => h.textContent).join(','));
  check('Panel „Skills": Überschriften Arbeitsweise, Fertigungsverfahren, Konstruktionswissen, darunter die Skills nach `order`',
    s.skills.map((x) => x.id).join(',') === ORDER && heads === 'Arbeitsweise,Fertigungsverfahren,Konstruktionswissen'
    && s.text.includes('3D-Druck (FDM)') && s.text.includes('Laserschneiden'), `${heads} | ${s.skills.map((x) => x.id).join(',')}`);
  await shot('skills-1-panel');

  // Neues Modell (E46, E48, E55): Arbeitsweise und Normteile immer, alle übrigen bei Bedarf, schon im Startcommit
  await waitFor('Speicherstand', () => !!window.__t.saveState(), 10000);
  const bdir = path.join(ud, 'workspace-backups', `${proj.id}-skills`);
  const modesOf = (sk, m) => sk.skills.filter((x) => x.mode === m).map((x) => x.id).join(',');
  check('Neues Modell: Konstruktionsablauf, Sauber modellieren und Normteile immer, die übrigen bei Bedarf, Karten nennen „Bei neuen Modellen: Immer“',
    JSON.stringify(pj().skills) === '["konstruktionsablauf","cadquery","normteile"]' && (pj().skills_on_demand ?? []).join(',') === DEMAND_NEW
    && modesOf(s, 'always') === 'konstruktionsablauf,cadquery,normteile' && modesOf(s, 'demand') === DEMAND_NEW && !modesOf(s, 'off')
    && s.skills.filter((x) => x.defaultMode === 'always').map((x) => x.id).join(',') === 'konstruktionsablauf,cadquery,normteile'
    && s.text.split('Bei neuen Modellen: Immer').length === 4 && s.skills.every((x) => !x.problems.length && !x.changed), JSON.stringify(pj()));
  const fdmNew = read('.soma/skills/3d-druck.md') ?? '';
  check('Neues Modell: Kopien mit Standardwerten, bei Bedarf mit Hinweis (Standardwerte, NOTES.md), Immer ohne',
    !(read('.soma/skills/konstruktionsablauf.md') ?? '{{').includes('{{') && !(read('.soma/skills/konstruktionsablauf.md') ?? '').includes('On demand')
    && fdmNew.includes('# Skill: 3D printing (FDM)\n\n> **On demand:**') && fdmNew.includes('defaults of the app') && fdmNew.includes('`NOTES.md`') && fdmNew.includes('Overhangs up to 45°'), fdmNew.slice(0, 300));
  check('Neues Modell: AGENTS.md mit zwei Listen, bei Bedarf mit Anlass, alles im Startcommit (nichts ungespeichert)',
    always().includes('- `.soma/skills/konstruktionsablauf.md`: Design workflow') && always().includes('- `.soma/skills/cadquery.md`: Clean CadQuery modeling')
    && always().includes('- `.soma/skills/normteile.md`: Standard parts') && !always().includes('3d-druck')
    && demand().includes('- `.soma/skills/3d-druck.md`: 3D printing (FDM). Read when the parts will be 3D printed on a filament printer (FDM).')
    && DEMAND_NEW.split(',').every((id) => demand().includes(`.soma/skills/${id}.md`))
    && (await g('ls-files', '.soma/skills')).split('\n').length === 12
    && (await ev(() => window.__t.saveState())).dirtyFiles === 0, `${String((await ev(() => window.__t.saveState())).dirtyFiles)} | ${String(block()).slice(0, 200)}`);
  check('Umschalter: drei Stufen je Karte, die eingestellte gewählt', await ev(() => {
    const row = document.querySelector('#skills-list .sk-row[data-id="3d-druck"]');
    return [...row.querySelectorAll('.sk-mode button')].map((b) => `${b.textContent}:${b.getAttribute('aria-checked')}`).join(',') === 'Aus:false,Bei Bedarf:true,Immer:false'
      && row.classList.contains('demand') && document.querySelector('#skills-list .sk-row[data-id="cadquery"]').classList.contains('always');
  }));

  // 2) Aus: Kopie weg (unverändert, also ohne Sicherung), project.json und AGENTS.md ohne ihn
  await setMode('laser', 'off');
  check('Laserschneiden aus: Kopie weg, ohne Sicherung, nicht mehr in project.json und AGENTS.md', read('.soma/skills/laser.md') === null && !fs.existsSync(bdir)
    && !(pj().skills_on_demand ?? []).includes('laser') && !(block() ?? '').includes('laser.md') && !(await skill('laser')).problems.length
    && (await ev(() => window.__t.toast())).text.includes('ist aus'), JSON.stringify(pj().skills_on_demand));

  // Bei Bedarf → Immer: Kopie ohne Hinweis, project.json (und App-Kopie), Liste „Immer“ in AGENTS.md, als Änderung sichtbar
  await setMode('3d-druck', 'always');
  const copy = read('.soma/skills/3d-druck.md');
  const bundledText = norm(fs.readFileSync(path.join(BUNDLED, '3d-druck.md'), 'utf8'));
  check('3D-Druck immer: Kopie mit den Standardwerten, ohne Hinweis, die unveränderte Fassung „bei Bedarf“ ohne Sicherung', copy !== null && bundledText.includes('{{overhang}}') && !copy.includes('{{')
    && copy.includes('Overhangs up to 45° from vertical') && copy.includes('| Nozzle | 0.4 mm |') && copy.split('\n').length === bundledText.split('\n').length
    && !copy.includes('On demand') && !fs.existsSync(bdir));
  check('project.json und die Kopie in den App-Daten führen ihn unter „Immer“', JSON.stringify(pj().skills) === '["konstruktionsablauf","cadquery","normteile","3d-druck"]'
    && !(pj().skills_on_demand ?? []).includes('3d-druck')
    && JSON.stringify(JSON.parse(fs.readFileSync(path.join(ud, 'projects', `${proj.id}.json`), 'utf8')).skills) === JSON.stringify(pj().skills)
    && JSON.stringify(JSON.parse(fs.readFileSync(path.join(ud, 'projects', `${proj.id}.json`), 'utf8')).skills_on_demand) === JSON.stringify(pj().skills_on_demand));
  check('AGENTS.md führt ihn unter „Always follow“ (Pfad und englischer Name), der Rest der Datei bleibt', always().includes('- `.soma/skills/3d-druck.md`: 3D printing (FDM)')
    && !demand().includes('3d-druck') && (read('AGENTS.md') ?? '').startsWith('# Instructions for the coding agent') && (read('AGENTS.md') ?? '').includes('## Version history (git)'), String(block()));
  check('Meldung: gilt immer, steht in AGENTS.md, Hinweis auf laufenden Agenten', (await ev(() => window.__t.toast())).text.includes('gilt jetzt immer und steht in AGENTS.md'));
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
  await ev(() => document.querySelector('#skills-list .sk-row[data-id="laser"] .sk-more').click());
  await setVar('laser', 'thickness', '4');
  await waitFor('Platte 4', () => window.__t.skills().skills.find((x) => x.id === 'laser')?.vars.thickness === 4, 10000);
  check('Laserschneiden (aus): Plattenstärke 4 mm gespeichert, keine Datei angelegt, Hinweis „gilt, sobald nicht mehr aus"', settings().laser?.thickness === 4 && read('.soma/skills/laser.md') === null
    && (await ev(() => window.__t.toast())).text.includes('Gilt, sobald der Skill nicht mehr aus ist'));
  await shot('skills-3-einstellungen');
  // Einstellung bei Bedarf: Der Hinweis nennt den gesetzten Wert, die übrigen bleiben Standard der App
  await ev(() => document.querySelector('#skills-list .sk-row[data-id="festigkeit"] .sk-more').click());
  await setVar('festigkeit', 'safety', '3');
  await waitFor('Sicherheit 3', () => window.__t.skills().skills.find((x) => x.id === 'festigkeit')?.vars.safety === 3, 10000);
  const fest = read('.soma/skills/festigkeit.md') ?? '';
  check('Festigkeit (bei Bedarf), Sicherheit 3: Kopie mit SAFETY = 3, Hinweis nennt `safety` als vom Nutzer gesetzt, „An Agent geben“ da', fest.includes('`SAFETY = 3`')
    && fest.includes('The user set `safety` in the app.') && !(await skill('festigkeit')).changed
    && await ev(() => [...document.querySelectorAll('#skills-list .sk-row[data-id="festigkeit"] .sk-actions button')].some((b) => b.textContent.includes('An Agent'))), fest.slice(0, 400));

  // 4) Zweiter Skill auf Immer: in AGENTS.md in der Reihenfolge des Einschaltens
  await setMode('toleranzen', 'always');
  const b2 = always();
  check('Toleranzen immer: AGENTS.md nennt beide unter „Immer“, project.json auch', b2.indexOf('3d-druck.md') > 0 && b2.indexOf('toleranzen.md') > b2.indexOf('3d-druck.md')
    && !demand().includes('toleranzen.md') && JSON.stringify(pj().skills) === '["konstruktionsablauf","cadquery","normteile","3d-druck","toleranzen"]', b2);
  // Immer → Bei Bedarf: Kopie bekommt den Hinweis, keine Sicherung, Meldung
  await setMode('normteile', 'demand');
  check('Normteile bei Bedarf: Kopie mit Hinweis, Liste „Bei Bedarf“, ohne Sicherung, Meldung „nur noch bei Bedarf“', (read('.soma/skills/normteile.md') ?? '').includes('> **On demand:**')
    && demand().includes('- `.soma/skills/normteile.md`: Standard parts. Read when') && !always().includes('normteile') && !fs.existsSync(bdir)
    && (await ev(() => window.__t.toast())).text.includes('gilt nur noch bei Bedarf'), (await ev(() => window.__t.toast())).text);

  // 5) Kopie geändert (etwa vom Agenten): gemeldet, beim Ausschalten in die Sicherung
  fs.appendFileSync(path.join(dir, '.soma', 'skills', '3d-druck.md'), '\n- Use PETG only.\n');
  await ev(() => window.__t.showPanel('files'));
  await ev(() => window.__t.showPanel('skills'));
  await waitFor('geändert erkannt', () => window.__t.skills().skills.find((x) => x.id === '3d-druck')?.changed === true, 10000);
  check('Geänderte Kopie: „weicht ab" in der Karte', (await st()).text.includes('weicht von der Fassung dieser App ab'));
  await setVar('3d-druck', 'overhang', '55');
  await waitFor('Überhang 55', () => window.__t.skills().skills.find((x) => x.id === '3d-druck')?.vars.overhang === 55, 10000);
  let backups = fs.existsSync(bdir) ? fs.readdirSync(bdir) : [];
  check('Einstellung an geänderter Kopie: Kopie in die Sicherung, neu geschrieben mit 55°', backups.length === 1 && fs.readFileSync(path.join(bdir, backups[0]), 'utf8').includes('Use PETG only.')
    && !(read('.soma/skills/3d-druck.md') ?? '').includes('Use PETG only.') && (read('.soma/skills/3d-druck.md') ?? '').includes('up to 55°') && !(await skill('3d-druck')).changed
    && (await ev(() => window.__t.toast())).text.includes('Sicherung'), backups.join(','));
  await setMode('3d-druck', 'off');
  backups = fs.existsSync(bdir) ? fs.readdirSync(bdir) : [];
  check('Ausschalten: Kopie weg, unveränderte Kopie ohne neue Sicherung, Einstellungen bleiben', read('.soma/skills/3d-druck.md') === null && backups.length === 1
    && settings()['3d-druck']?.overhang === 55, backups.join(','));
  check('AGENTS.md und project.json ohne 3D-Druck, Toleranzen bleibt', !(block() ?? '').includes('3d-druck') && always().includes('toleranzen.md')
    && JSON.stringify(pj().skills) === '["konstruktionsablauf","cadquery","toleranzen"]' && !(pj().skills_on_demand ?? []).includes('3d-druck'));
  check('Meldung nennt den laufenden Agenten', /ist aus\..*Sag ihm Bescheid/.test((await ev(() => window.__t.toast())).text), (await ev(() => window.__t.toast())).text);

  // 6) Datei eines aktiven Skills fehlt: gemeldet, nicht neu angelegt (E28)
  fs.rmSync(path.join(dir, '.soma', 'skills', 'toleranzen.md'));
  await ev(() => window.__t.showPanel('files'));
  await ev(() => window.__t.showPanel('skills'));
  await waitFor('Problem gemeldet', () => window.__t.skills().skills.find((x) => x.id === 'toleranzen')?.problems.length > 0, 10000);
  const info = await ev(() => window.soma.project.current());
  check('Fehlende Kopie: Hinweis in der Karte und im Projekt-Check, nichts neu angelegt', (await skill('toleranzen')).problems[0].includes('fehlt')
    && info.problems.some((p) => p.includes('toleranzen')) && read('.soma/skills/toleranzen.md') === null, JSON.stringify(info.problems));
  await setMode('toleranzen', 'off');
  check('Ausschalten räumt auf: kein Problem mehr, nicht mehr in AGENTS.md und project.json', !(await skill('toleranzen')).problems.length && !(block() ?? '').includes('toleranzen')
    && JSON.stringify(pj().skills) === '["konstruktionsablauf","cadquery"]');

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
    && (await ev(() => window.__t.toast())).text.includes('AGENTS.md fehlt') && (await ev(() => window.__t.toast())).error, (await ev(() => window.__t.toast())).text);
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), keep);
  await ev(() => window.__t.showPanel('files'));
  await ev(() => window.__t.showPanel('skills'));
  await waitFor('Problem AGENTS.md', () => window.__t.skills().skills.find((x) => x.id === '3d-druck')?.problems.length > 0, 10000);
  check('AGENTS.md ohne Eintrag eines aktiven Skills: gemeldet', (await skill('3d-druck')).problems.some((p) => p.includes('AGENTS.md nennt')), JSON.stringify((await skill('3d-druck')).problems));
  await setMode('3d-druck', 'off');
  await setMode('3d-druck', 'always');
  check('Aus und wieder an trägt ihn ein', !(await skill('3d-druck')).problems.length && always().includes('3d-druck.md') && demand().includes('laser.md'));
  // Liste „Bei Bedarf“ verloren (etwa von Hand bearbeitet): Laser steht dann unter „Immer“, das wird gemeldet
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), (read('AGENTS.md') ?? '').replace('### Read when relevant', ''));
  await ev(() => window.__t.showPanel('files'));
  await ev(() => window.__t.showPanel('skills'));
  await waitFor('falsche Liste', () => window.__t.skills().skills.find((x) => x.id === 'laser')?.problems.length > 0, 10000);
  check('AGENTS.md führt einen Skill unter der falschen Stufe: gemeldet', (await skill('laser')).problems.some((p) => p.includes('unter „Immer“, eingestellt ist „Bei Bedarf“')),
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
    if (!(await ev((i) => !!document.getElementById(`sk-${i}-default`), id))) await ev((i) => document.querySelector(`#skills-list .sk-row[data-id="${i}"] .sk-more`).click(), id);
    await ev(([i, m]) => { const f = document.getElementById(`sk-${i}-default`); f.value = m; f.dispatchEvent(new Event('change')); }, [id, mode]);
    await waitFor(`Vorgabe ${id} ${mode}`, ([i, m]) => { const x = window.__t.skills(); return !x.busy.length && x.skills.find((k) => k.id === i)?.defaultMode === m; }, 10000, [id, mode]);
  };
  const before = JSON.stringify(pj());
  await setDefault('3d-druck', 'always');
  check('Stufe bei neuen Modellen „Immer“ (3D-Druck): in state.json, Meldung, das offene Modell unverändert', JSON.stringify(appState().skill_defaults) === '{"3d-druck":"always"}'
    && JSON.stringify(pj()) === before && !(await ev(() => window.__t.saveState())).unsaved
    && (await ev(() => window.__t.toast())).text.includes('steht bei neuen Modellen auf „Immer“. Dieses Modell bleibt, wie es ist.'), JSON.stringify(appState().skill_defaults));
  await setDefault('konstruktionsablauf', 'demand');
  await setDefault('laser', 'off');
  await setDefault('cadquery', 'off');
  await setDefault('cadquery', 'always');
  check('Abweichungen vom Kopf stehen in state.json, zurück auf den Kopf fällt der Eintrag weg', JSON.stringify(appState().skill_defaults) === '{"3d-druck":"always","konstruktionsablauf":"demand","laser":"off"}'
    && appState().lastProject === proj.id && (await st()).text.includes('Bei neuen Modellen: Aus'), JSON.stringify(appState().skill_defaults));
  await shot('skills-4-neue-modelle');
  await domClick('btn-new');
  await waitFor('neues Projekt', (oldId) => window.__t.project().id !== oldId && window.__t.status().state === 'ok', 90000, proj.id);
  const p2 = await ev(() => window.__t.project());
  const pj2 = JSON.parse(fs.readFileSync(path.join(p2.dir, '.soma', 'project.json'), 'utf8'));
  const fdm2 = fs.readFileSync(path.join(p2.dir, '.soma', 'skills', '3d-druck.md'), 'utf8');
  const ka2 = fs.readFileSync(path.join(p2.dir, '.soma', 'skills', 'konstruktionsablauf.md'), 'utf8');
  check('Neues Modell nach der Vorgabe: immer Sauber modellieren, 3D-Druck, Normteile, Laser aus, Konstruktionsablauf bei Bedarf, Standardwerte statt 55° und PETG',
    JSON.stringify(pj2.skills) === '["cadquery","3d-druck","normteile"]' && pj2.skills_on_demand.join(',') === 'konstruktionsablauf,harz-pulver,cnc,blech,toleranzen,verbindungen,festigkeit,baugruppen'
    && !pj2.skill_settings && fdm2.includes('Overhangs up to 45°') && fdm2.includes('| Material | PLA |') && !fdm2.includes('On demand') && ka2.includes('> **On demand:**')
    && !fs.existsSync(path.join(p2.dir, '.soma', 'skills', 'laser.md'))
    && norm(fs.readFileSync(path.join(p2.dir, 'AGENTS.md'), 'utf8')).includes('- `.soma/skills/3d-druck.md`: 3D printing (FDM)\n'), JSON.stringify(pj2));
  await waitFor('Speicherstand neu', () => window.__t.saveState() && !window.__t.saveState().unsaved, 10000).catch(() => {});
  check('Neues Modell: Skills im Startcommit, nichts ungespeichert', (await exec(['ls-files', '.soma/skills'], p2.dir)).stdout.trim().split('\n').length === 11
    && (await ev(() => window.__t.saveState())).dirtyFiles === 0, String((await ev(() => window.__t.saveState())).dirtyFiles));

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
