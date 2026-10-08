// Test des Parameter-Panels: param() im Code (Wert des Agenten), Werte des Nutzers in parameters.json, Zurücksetzen einzeln
// und alle, Bereich (melden, trotzdem bauen), Typen (Zahl, ganze Zahl, Schalter, Auswahl, Text), Gruppen, Werte ohne
// Parameter, gescheiterter Build mit Angebot „Back to“, Fehler vor den Parametern, kaputte Datei (melden, nicht
// überschreiben), leerer Zustand, Snapshot und ZIP. Aufruf: node test/run-all.mjs params (nach npm run build).
// SMOKE_VISIBLE=offscreen SMOKE_SHOTS=1 legt Bilder in test/shots/ ab.
import { exec } from 'dugite';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yauzl from 'yauzl';
import { APP, checker, cleanup, sleep, startApp } from './harness.mjs';

const t = checker();
const { check } = t;
let app;
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-params-'));
const PY = process.env.SOMA_PYTHON || path.join(process.env.LOCALAPPDATA ?? '', 'cadide-phase0', 'venv-full', 'Scripts', 'python.exe');

const listZip = (p) => new Promise((resolve, reject) => yauzl.open(p, { lazyEntries: true }, (e, z) => {
  if (e) return reject(e);
  const names = [];
  z.on('entry', (en) => { names.push(en.fileName); z.readEntry(); });
  z.on('end', () => resolve(names));
  z.readEntry();
}));

// Ein Modell, wie es ein Agent schreiben könnte: Gruppen, alle Arten von Parametern und eine Grenze, an der der Code scheitert
const AGENT_MODEL = `import cadquery as cq
from soma import add_part, param

SIZE = param(40.0, "Size", min=20, max=80, unit="mm", group="Frame")
PLATES = param(2, "Plates", min=1, max=4, group="Frame", help="Number of plates stacked on the frame.")
LID = param(True, "With lid", group="Options")
FINISH = param("matte", "Finish", options={"matte": "Matte", "gloss": "Glossy"}, group="Options")
LABEL = param("SOMA", "Label")
assert SIZE <= 70, "SIZE above 70 mm does not fit the frame"

add_part("Frame", cq.Workplane("XY").box(SIZE, SIZE, 5))
for i in range(PLATES):
    add_part(f"Plate {i + 1}", cq.Workplane("XY").box(SIZE - 4, SIZE - 4, 2).translate((0, 0, 4 + 3 * i)))
if LID:
    add_part("Lid", cq.Workplane("XY").box(SIZE, SIZE, 1).translate((0, 0, 20)))
`;

try {
  app = await startApp({ name: 'params' });
  const { ev, waitFor, domClick, page } = app;
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
  const modelPy = path.join(dir, 'model.py');
  const pfile = path.join(dir, 'parameters.json');
  const disk = () => fs.readFileSync(modelPy, 'utf8');
  const userFile = () => { try { return JSON.parse(fs.readFileSync(pfile, 'utf8')); } catch { return null; } };
  const vals = () => userFile()?.values ?? {};
  const ps = () => ev(() => window.__t.params());
  const builds = () => ev(() => window.__t.buildStarts());
  const size = async (name) => (await ev((n) => window.__t.partSize(n), name))?.[0];
  const buildState = () => ev(() => window.soma.build.status());
  /** Wartet auf den Build, der nach `b0` begonnen hat, und darauf, dass das Panel ihn kennt. */
  const built = async (b0, what) => {
    await waitFor(`Build nach ${what}`, (b) => window.__t.buildStarts() > b && window.__t.status().state !== 'building', 60000, b0);
    await sleep(400);
    await ev(() => window.__t.paramsRefresh());
  };
  /** Wert eingeben wie der Nutzer: ins Feld schreiben, Enter. */
  const typeValue = (name, text) => ev(([n, v]) => {
    const f = document.getElementById(`pm-${n}`);
    f.focus(); f.value = v;
    f.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  }, [name, text]);
  const row = (name) => `#params-list .prm[data-name="${name}"]`;
  const click = (sel) => ev((s) => document.querySelector(s).click(), sel);
  const clickText = (sel, text) => ev(([s, x]) => [...document.querySelectorAll(s)].find((b) => b.textContent.includes(x)).click(), [sel, text]);

  // 1) Leiste „Parameters“: die vier Parameter der Vorlage, alle auf dem Wert aus dem Code
  await click('#rail [data-panel="params"]');
  await waitFor('Parameter geladen', () => window.__t.params().names?.length === 4, 20000);
  let s = await ps();
  check('Leiste „Parameters“: Vorlage mit LENGTH, WIDTH, HEIGHT, WALL, Werte aus dem Code, nichts geändert',
    s.names.join(',') === 'LENGTH,WIDTH,HEIGHT,WALL' && s.shown.LENGTH === '60 mm' && s.shown.WALL === '2 mm' && !s.changed.length && !s.foot && !fs.existsSync(pfile), JSON.stringify(s.shown));
  check('Zeile: Name, Name im Code, Feld mit Einheit', s.text.includes('Length') && s.text.includes('LENGTH') && await ev(() => document.querySelector('#pm-LENGTH')?.closest('.valbox')?.textContent === 'mm'));
  const rowText = (n) => ev((x) => document.querySelector(`#params-list .prm[data-name="${x}"] .lb`)?.textContent ?? '', n);
  check('Bereich des Agenten in der Zeile, ohne Aufklappen: LENGTH 30–200 mm, WALL 1.2–4 mm', (await rowText('LENGTH')).includes('30–200 mm')
    && (await rowText('WALL')).includes('1.2–4 mm') && s.open === null, await rowText('LENGTH'));
  await shot('params-1-panel');

  // 2) Wert ändern: landet in parameters.json, baut, der Code bleibt beim Wert des Agenten
  let b0 = await builds();
  await typeValue('LENGTH', '80');
  await built(b0, 'Length 80');
  await waitFor('Body 80 mm', () => window.__t.partSize('Body')?.[0] === 80, 20000).catch(() => {});
  s = await ps();
  check('Length 80: in parameters.json, gebaut (Body 80 mm), model.py unverändert, Zeile orange, Fußzeile',
    vals().LENGTH === 80 && await size('Body') === 80 && disk().includes('LENGTH = param(60.0') && s.changed.join(',') === 'LENGTH' && s.foot.includes('1 changed'), JSON.stringify(userFile()));
  check('parameters.json erklärt sich selbst (Notiz für den Agenten)', /Parameters panel/.test(userFile()?.note ?? ''));
  const res = (await buildState()).result;
  check('Build kennt die Parameter mit Wert und Herkunft', res?.params?.find((p) => p.name === 'LENGTH')?.value === 80 && res.params.find((p) => p.name === 'LENGTH').source === 'user'
    && res.params.find((p) => p.name === 'WIDTH').source === 'code');

  b0 = await builds();
  await typeValue('WALL', '2,5');
  await built(b0, 'Wall 2,5');
  check('Komma wird gelesen: Wall 2.5 mm', vals().WALL === 2.5 && (await ps()).shown.WALL === '2.5 mm', JSON.stringify(vals()));

  b0 = await builds();
  await typeValue('WIDTH', '40.0');
  await sleep(1500);
  check('Wert gleich dem Code: kein Eintrag, kein Build', !('WIDTH' in vals()) && await builds() === b0);

  await typeValue('HEIGHT', 'abc');
  await sleep(500);
  check('Keine Zahl: Meldung, Feld zurück, nichts geschrieben', (await ev(() => window.__t.toast())).text.includes('Height needs a number') && !('HEIGHT' in vals())
    && await ev(() => document.getElementById('pm-HEIGHT').value) === '25');

  // 3) Zurücksetzen einer Zeile: wieder der Wert des Agenten
  b0 = await builds();
  await click(`${row('LENGTH')} .rst`);
  await built(b0, 'Reset Length');
  await waitFor('Body 60 mm', () => window.__t.partSize('Body')?.[0] === 60, 20000).catch(() => {});
  check('Zurücksetzen (Zeile): Eintrag entfernt, Body wieder 60 mm, Wall bleibt 2.5', !('LENGTH' in vals()) && vals().WALL === 2.5 && await size('Body') === 60, JSON.stringify(vals()));

  // 4) Außerhalb des Bereichs: eingetragen und gebaut, rot gemeldet (E28)
  b0 = await builds();
  await typeValue('LENGTH', '250');
  await built(b0, 'Length 250');
  await click(`${row('LENGTH')} .lb`);
  s = await ps();
  check('Length 250 außerhalb 30 bis 200: gebaut, Zeile rot, Hinweis beim Aufklappen', vals().LENGTH === 250 && await size('Body') === 250 && s.errors.includes('LENGTH')
    && s.text.includes('lies outside the range') && s.open === 'LENGTH', s.text.slice(0, 300));
  check('soma build meldet den Wert außerhalb des Bereichs', ((await buildState()).result?.warnings ?? []).some((w) => w.includes('LENGTH = 250 mm (set in the app) lies outside the range 30 mm to 200 mm')));
  check('Aufgeklappt: Schieber, Wert im Code und Bereich, Stelle im Code', await ev((r) => !!document.querySelector(`${r} input[type=range]`), row('LENGTH'))
    && s.text.includes('Code: 60 mm · range 30 mm to 200 mm') && s.text.includes('model.py, line 10'), s.text.slice(0, 300));
  await shot('params-2-outside');

  b0 = await builds();
  await ev((r) => { const x = document.querySelector(`${r} input[type=range]`); x.value = '100'; x.dispatchEvent(new Event('input')); x.dispatchEvent(new Event('change')); }, row('LENGTH'));
  await built(b0, 'Schieber');
  check('Schieber: Loslassen übernimmt 100 mm', vals().LENGTH === 100 && !(await ps()).errors.includes('LENGTH'), JSON.stringify(vals()));

  await clickText(`${row('LENGTH')} .lnk`, 'line');
  await waitFor('Code offen', () => window.__t.editor.state().file === 'model.py', 10000).catch(() => {});
  const es = await ev(() => window.__t.editor.state());
  check('Sprung in den Code: model.py, Zeile von LENGTH markiert', es.file === 'model.py' && es.marked.some((m) => m.includes('LENGTH = param(60.0')), es.marked.join(' | '));
  await ev(() => { const tm = window.__t.terminals; const orig = tm.insert.bind(tm); tm.insert = (x) => { window.__inserted = x; return orig(x); }; });
  await clickText(`${row('LENGTH')} .lnk`, 'Send to agent');
  check('„Send to agent": Wert, Wert im Code und Stelle', await ev(() => window.__inserted) === '[Parameter: "Length" (LENGTH) = 100 mm, set in the app, code default 60 mm, model.py line 10] ',
    await ev(() => window.__inserted));
  await ev(() => window.__t.showCode(false));

  // 5) Alle zurücksetzen: die Datei verschwindet, das Modell ist wieder das des Agenten
  b0 = await builds();
  await clickText('#params-foot button', 'Reset all');
  await built(b0, 'Reset all');
  s = await ps();
  check('„Reset all": parameters.json entfernt, alles auf dem Wert aus dem Code, Fußzeile weg', !fs.existsSync(pfile) && !s.changed.length && !s.foot && await size('Body') === 60);

  // 6) Der Agent schreibt ein anderes Modell. Vorher von Hand: ein Wert, der nicht passt, und einer ohne Parameter
  fs.writeFileSync(pfile, JSON.stringify({ values: { PLATES: 2.5, OLD: 7 } }));
  b0 = await builds();
  fs.writeFileSync(modelPy, AGENT_MODEL);
  await waitFor('neue Parameter', (b) => window.__t.buildStarts() > b && window.__t.status().state === 'ok' && window.__t.params().names?.join(',') === 'SIZE,PLATES,LID,FINISH,LABEL', 60000, b0)
    .catch(async (e) => { console.log(JSON.stringify(await ev(() => ({ st: window.__t.status(), p: window.__t.params() })))); throw e; });
  await waitFor('4 Bauteile', () => window.__t.partCount() === 4, 20000).catch(() => {});
  s = await ps();
  const heads = await ev(() => [...document.querySelectorAll('#params-list .pg')].map((h) => h.textContent).join(','));
  check('Gruppen wie im Code, ohne Gruppe zuerst', heads === 'Frame,Options,Not in the model anymore' && s.text.indexOf('Label') < s.text.indexOf('Size'), heads);
  check('Feld nach Typ: Stepper (int), Schalter (bool), Auswahl, Textfeld', await ev(() => !!document.getElementById('pm-PLATES')?.closest('.stepper')
    && document.getElementById('pm-LID')?.getAttribute('role') === 'switch' && document.getElementById('pm-LID')?.getAttribute('aria-checked') === 'true'
    && [...document.getElementById('pm-FINISH').options].map((o) => o.textContent).join(',') === 'Matte,Glossy' && document.getElementById('pm-LABEL')?.classList.contains('pm-text')));
  check('Unpassender Wert (2.5 für eine ganze Zahl): Zeile rot, der Wert aus dem Code gilt', s.errors.includes('PLATES') && s.shown.PLATES === '2' && (await buildState()).result.warnings.some((w) => w.includes('2.5 for PLATES is not a whole number')));
  check('Wert ohne Parameter: eigener Abschnitt mit „Remove“, soma build meldet ihn', s.text.includes('OLD') && (await buildState()).result.warnings.some((w) => w.includes('no parameter OLD')));
  check('Bereich je Art: ganze Zahl 1–4, Auswahl „2 options“, Schalter und Text ohne', (await rowText('PLATES')).endsWith('1–4') && (await rowText('FINISH')).endsWith('2 options')
    && (await rowText('LID')) === 'With lidLID' && (await rowText('LABEL')) === 'LabelLABEL', `${await rowText('PLATES')} | ${await rowText('FINISH')} | ${await rowText('LID')}`);
  await shot('params-3-types');

  await clickText('#params-list .pm-orow button', 'Remove');
  await waitFor('OLD entfernt', () => !('OLD' in window.__t.params().values), 10000);
  check('„Remove": OLD aus parameters.json, PLATES bleibt', !('OLD' in vals()) && vals().PLATES === 2.5, JSON.stringify(vals()));
  b0 = await builds();
  await click(`${row('PLATES')} .rst`);
  await built(b0, 'Reset Plates');
  check('Unpassenden Wert zurücksetzen: letzter Eintrag weg, Datei weg', !fs.existsSync(pfile));

  b0 = await builds();
  await click('#pm-LID');
  await built(b0, 'Lid aus');
  await waitFor('3 Bauteile', () => window.__t.partCount() === 3, 20000).catch(() => {});
  check('Schalter aus: LID false, Deckel weg (3 Bauteile)', vals().LID === false && await ev(() => window.__t.partCount()) === 3);

  b0 = await builds();
  await ev(() => { const f = document.getElementById('pm-FINISH'); f.value = '1'; f.dispatchEvent(new Event('change')); });
  await built(b0, 'Finish');
  check('Auswahl „Glossy“: FINISH gloss, angezeigt mit Namen', vals().FINISH === 'gloss' && (await ps()).shown.FINISH === 'Glossy');

  b0 = await builds();
  await ev(() => document.querySelector('#params-list .prm[data-name="PLATES"] .stp[aria-label$="plus"]').click());
  await built(b0, 'Plates +1');
  await waitFor('4 Bauteile', () => window.__t.partCount() === 4, 20000).catch(() => {});
  check('Stepper +: PLATES 3, drei Platten ohne Deckel', vals().PLATES === 3 && await ev(() => window.__t.partCount()) === 4, JSON.stringify(vals()));

  b0 = await builds();
  await typeValue('LABEL', 'Hallo Welt');
  await built(b0, 'Label');
  check('Text: LABEL steht als Text in parameters.json', vals().LABEL === 'Hallo Welt');

  await clickText('#params-list .pg', 'Frame');
  s = await ps();
  check('Gruppe einklappen: Zeilen weg, Kopf nennt Anzahl und Änderungen', !s.text.includes('Size') && (await ev(() => [...document.querySelectorAll('#params-list .pg')].map((h) => h.textContent).join('|'))).includes('Frame· 2, 1 changed'));
  await clickText('#params-list .pg', 'Frame');

  // 7) Build scheitert nach einer Änderung: Panel bleibt bedienbar und bietet den Wert davor an (nicht selbst zurücknehmen)
  b0 = await builds();
  await typeValue('SIZE', '75');
  await built(b0, 'Size 75');
  s = await ps();
  check('Size 75: Build scheitert, Panel zeigt die Parameter weiter und bietet „Back to 40 mm“', (await ev(() => window.__t.status().state)) === 'error' && vals().SIZE === 75
    && s.names?.length === 5 && s.text.includes('The build failed after Size was set to 75 mm.') && s.text.includes('Back to 40 mm'), s.text.slice(0, 200));
  await shot('params-4-failed');
  b0 = await builds();
  await clickText('#params-list .pm-fail button', 'Back to');
  await built(b0, 'Back to');
  check('„Back to 40 mm": Eintrag weg, Build wieder ok, Hinweis weg', !('SIZE' in vals()) && (await ev(() => window.__t.status().state)) === 'ok' && !(await ps()).text.includes('The build failed'));

  // 8) Fehler im Code vor den Parametern: Die Liste des vorigen Builds bleibt, mit Hinweis
  b0 = await builds();
  fs.writeFileSync(modelPy, `x = (\n${AGENT_MODEL}`);
  await waitFor('Fehler', (b) => window.__t.buildStarts() > b && window.__t.status().state === 'error', 60000, b0);
  await sleep(400);
  await ev(() => window.__t.paramsRefresh());
  s = await ps();
  check('Syntaxfehler vor den Parametern: Liste bleibt (stale), Werte weiter änderbar', s.stale && s.names?.length === 5 && s.text.includes('The list is from an earlier build') && !!(await ev(() => document.getElementById('pm-SIZE'))));
  b0 = await builds();
  fs.writeFileSync(modelPy, AGENT_MODEL);
  await waitFor('wieder ok', (b) => window.__t.buildStarts() > b && window.__t.status().state === 'ok', 60000, b0);
  await ev(() => window.__t.paramsRefresh());
  check('Code wieder in Ordnung: Hinweis weg', !(await ps()).stale);

  // 9) Kaputte parameters.json (etwa von Hand): melden, nicht überschreiben (E28)
  const before = '{ "values": { "SIZE": 50, } }';
  b0 = await builds();
  fs.writeFileSync(pfile, before);
  await waitFor('Build nach kaputter Datei', (b) => window.__t.buildStarts() > b && window.__t.status().state !== 'building', 60000, b0);
  await ev(() => window.__t.paramsRefresh());
  s = await ps();
  check('Kaputte Datei: Hinweis im Panel, soma build meldet sie, Werte aus dem Code', /not valid JSON/.test(s.error ?? '') && s.text.includes('not valid JSON')
    && ((await buildState()).result?.warnings ?? []).some((w) => w.includes('parameters.json cannot be read')), s.error ?? '');
  await typeValue('SIZE', '30');
  await sleep(600);
  check('Ändern bei kaputter Datei: abgelehnt mit Meldung, Datei unverändert', fs.readFileSync(pfile, 'utf8') === before && (await ev(() => window.__t.toast())).text.includes('Nothing was changed'));
  b0 = await builds();
  fs.rmSync(pfile);
  await waitFor('Build nach Löschen', (b) => window.__t.buildStarts() > b && window.__t.status().state !== 'building', 60000, b0);
  await ev(() => window.__t.paramsRefresh());
  check('Datei gelöscht (Nutzer): Hinweis weg, Werte aus dem Code', !(await ps()).error && !Object.keys((await ps()).values).length);

  // 10) Speichern: parameters.json im Snapshot und in der ZIP
  b0 = await builds();
  await typeValue('SIZE', '50');
  await built(b0, 'Size 50');
  const zipPath = path.join(workDir, 'Parameter.zip');
  await app.answers([zipPath]);
  await domClick('btn-save');
  await waitFor('gespeichert', () => window.__t.saveState() && !window.__t.saveState().unsaved && window.__t.saveState().zipPath, 60000)
    .catch(async (e) => { console.log('Stand:', JSON.stringify(await ev(() => ({ save: window.__t.saveState(), toast: window.__t.toast() })))); throw e; });
  check('Snapshot enthält parameters.json mit dem Wert', JSON.parse(await g('show', 'HEAD:parameters.json')).values.SIZE === 50);
  check('ZIP enthält parameters.json', (await listZip(zipPath)).includes('parameters.json'));
  b0 = await builds();
  await typeValue('SIZE', '55');
  await built(b0, 'Size 55');
  check('Geänderter Wert zählt als ungespeicherte Änderung', await waitFor('ungespeichert', () => window.__t.saveState()?.unsaved, 10000).catch(() => false));

  // 11) Auswertungen rechnen mit den Werten des Nutzers und gelten nach einer Änderung als veraltet (App und soma)
  const soma = (args) => spawnSync(PY, ['-m', 'soma', ...args], { cwd: dir, env: { ...process.env, PYTHONUTF8: '1' }, encoding: 'utf8', timeout: 5 * 60 * 1000 });
  let r = soma(['analyze', 'thickness', '--name', 'wand']);
  const meta = (JSON.parse(soma(['analyze', 'list', '--json']).stdout || '[]')).find((m) => m.id === 'wand');
  const frame = meta?.parts?.find((p) => p.name === 'Frame');
  check('soma analyze nimmt den Wert aus dem Panel (Rahmen 55 mm statt 40 mm)', r.status === 0 && Math.abs((frame?.area ?? 0) - (2 * 55 * 55 + 4 * 55 * 5)) < 5, `${r.stderr.slice(0, 200)} ${frame?.area}`);
  check('Ergebnis aktuell, solange sich nichts ändert', (await ev(() => window.soma.results.list())).find((x) => x.id === 'wand')?.stale === false);
  b0 = await builds();
  await typeValue('SIZE', '60');
  await built(b0, 'Size 60');
  check('Nach einer Parameteränderung: Ergebnis in der App veraltet', (await ev(() => window.soma.results.list())).find((x) => x.id === 'wand')?.stale === true);
  r = spawnSync(PY, ['-c', 'import os, sys; from soma import animrun; print(animrun.newest_source(".") >= os.path.getmtime("parameters.json"))'], { cwd: dir, encoding: 'utf8' });
  check('soma zählt parameters.json zum Modell (Animationen, soma render --result)', r.stdout.trim() === 'True', r.stdout + r.stderr.slice(0, 200));

  // 12) Modell ohne Parameter: leerer Zustand mit Bitte an den Agenten
  b0 = await builds();
  fs.writeFileSync(modelPy, 'import cadquery as cq\nfrom soma import add_part\n\nadd_part("Block", cq.Workplane("XY").box(10, 10, 10))\n');
  await waitFor('ohne Parameter', (b) => window.__t.buildStarts() > b && window.__t.status().state === 'ok' && window.__t.params().names?.length === 0, 60000, b0);
  s = await ps();
  check('Ohne Parameter: leerer Zustand mit Erklärung, SIZE als Wert ohne Parameter', s.text.includes('This model has no parameters yet') && s.text.includes('Ask the agent') && s.text.includes('SIZE'));
  await clickText('#params-list .pm-empty button', 'Ask the agent');
  check('„Ask the agent" fügt die Bitte in die Eingabe ein', (await ev(() => window.__inserted)).startsWith('Make the main dimensions of the model adjustable with param()'));
  await shot('params-5-empty');

  const relevant = page.errors.filter((e) => !/favicon/i.test(e));
  check('Keine Konsolenfehler im Renderer', relevant.length === 0, relevant.slice(0, 2).join(' | ').slice(0, 100));
} catch (e) {
  console.log('ABBRUCH:', e.message);
  if (app) console.log(app.log().slice(-1500));
  t.fail();
}
if (app) { await app.stop(); cleanup(app.ud); }
cleanup(workDir);
console.log(t.fails ? `\n${t.fails} Prüfung(en) fehlgeschlagen` : '\nALLE PRÜFUNGEN BESTANDEN');
process.exit(t.fails ? 1 : 0);
