// Smoke-Test der echten Electron-App: Projekt, Viewer, Terminal, Auto-Build, Fehlerfall, Projektwechsel.
// Aufruf: npm run test:smoke (baut vorher). SMOKE_VISIBLE=1 zeigt das Fenster und macht einen Screenshot.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { APP, checker, cleanup, sleep, startApp } from './harness.mjs';

const t = checker();
const { check } = t;
let app;

try {
  app = await startApp({ name: 'smoke' });
  const { ev, waitFor, domClick, ud, page } = app;
  const status = () => ev(() => window.__t.status());
  // SMOKE_SHOTS=1 (zusammen mit SMOKE_VISIBLE=offscreen): Bilder der wichtigsten Zustände nach test/shots/ zum Ansehen
  const shot = async (name) => {
    if (!process.env.SMOKE_SHOTS) return;
    fs.mkdirSync(path.join(APP, 'test', 'shots'), { recursive: true });
    await sleep(900);
    await app.screenshot(path.join(APP, 'test', 'shots', `${name}.png`)).catch((e) => console.log('Screenshot:', e.message));
  };
  check('App gestartet, Fenster verbunden', true);

  // 1) Start: Projekt angelegt, automatischer erster Build, Bauteile im Viewer
  await waitFor('window.__t', () => !!window.__t && !!window.__t.project());
  await waitFor('Build ok', () => window.__t.status().state === 'ok' && window.__t.partCount() === 2);
  const proj = await ev(() => window.__t.project());
  check('Projekt liegt unter <App-Daten>/workspaces/<uuid>', proj.dir.startsWith(path.join(ud, 'workspaces')) && /[0-9a-f-]{36}$/.test(proj.dir), proj.dir.slice(-45));
  check('Vorlagen-Dateien vorhanden (AGENTS.md, CLAUDE.md, NOTES.md, model.py …)',
    ['AGENTS.md', 'CLAUDE.md', 'NOTES.md', 'model.py', '.gitignore', '.soma/project.json', '.git/HEAD'].every((f) => fs.existsSync(path.join(proj.dir, f))));
  const appVersion = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8')).version;
  const versionUi = await ev(() => ({ start: document.getElementById('start-version').textContent, logo: document.getElementById('btn-home').title }));
  check('Version (E68): in project.json, auf der Startseite und am Logo', JSON.parse(fs.readFileSync(path.join(proj.dir, '.soma', 'project.json'), 'utf8')).app_version === appVersion
    && versionUi.start === appVersion && versionUi.logo === `Start page · SOMA ${appVersion}`, `${appVersion} ${JSON.stringify(versionUi)}`);
  check('Erster Build automatisch, 2 Bauteile in der Bauteilkarte', JSON.stringify(await ev(() => window.__t.treeNames())) === '["Body","Lid"]');
  check('Nach dem Build kein Fehlerhinweis', (await status()).viewerMsg === '', (await status()).text);
  const okStatus = await status();
  check('Build-Anzeige oben: „Built · 2 parts"', okStatus.text === 'Built' && okStatus.detail.startsWith('2 parts'), `${okStatus.text} ${okStatus.detail}`);

  // 2) Klick im Viewer -> Bauteil, Fläche, Code
  const lidFace = await ev(() => {
    const v = window.__t.viewer; const id = window.__t.parts().find((p) => p.name === 'Lid').id;
    const f = v.facesOf(id).filter((x) => x.surface === 'PLANE').sort((a, b) => b.center[2] - a.center[2])[0];
    return { id, face: f.id, pos: v.screenOf(id, f.id) };
  });
  await page.click(lidFace.pos.x, lidFace.pos.y);
  await waitFor('Info nach Klick', () => window.__t.info().includes('Lid'));
  const info = await ev(() => window.__t.info());
  const hl = await ev(() => window.__t.codeHighlight());
  check('Klick auf Deckel-Oberseite: Auswahlkarte mit Bauteil, Fläche, Codezeile', info.startsWith('Lid') && info.includes('Face · plane') && /model\.py\s*Line \d+/.test(info), info.replace(/\s+/g, ' ').slice(0, 60));
  check('Codeausschnitt: add_part("Lid") ist markiert', hl.some((l) => l.includes('add_part("Lid"')), String(hl[0]).trim().slice(0, 40));
  const selText = await ev(() => window.__t.selectionText());
  check('Text für den Agenten nennt Bauteil, Datei, Zeile und Fläche', /^\[Selection: part "Lid", model\.py line \d+.*clicked face: plane/.test(selText), selText.slice(0, 70));

  await shot('1-arbeitsbereich');

  check('Seitenleiste zeigt beim ersten Start die Bauteile, Code ist zu (Entwurf 2)', JSON.stringify(await ev(() => window.__t.layout())) === '{"side":"parts","code":false,"agent":true}',
    JSON.stringify(await ev(() => window.__t.layout())));

  // Code als eigene Spalte und Dateien gleichzeitig (Entwurf 2)
  await domClick('btn-sel-code');
  await waitFor('Code-Spalte', () => window.__t.codeText().includes('add_part("Lid"'), 10000).catch(() => {});
  check('„Code" in der Auswahlkarte zeigt model.py in der Code-Spalte, die Bauteile bleiben offen', (await ev(() => window.__t.codeText())).includes('add_part("Lid"')
    && JSON.stringify(await ev(() => window.__t.layout())) === '{"side":"parts","code":true,"agent":true}');
  await shot('2-code');
  await ev(() => window.__t.showPanel('files'));
  await waitFor('Dateiliste', () => window.__t.fileRows().includes('model.py'), 10000).catch(() => {});
  const rows = await ev(() => window.__t.fileRows());
  check('Dateien: model.py sichtbar, AGENTS.md eingeklappt unter „Managed by the app"', rows.includes('model.py') && rows.includes('Managed by the app') && !rows.includes('AGENTS.md'), rows.slice(0, 6).join(','));
  check('Dateien und Code gleichzeitig offen, die offene Datei ist im Baum hervorgehoben', await ev(() => !document.getElementById('editor').hidden && !document.getElementById('panel-files').hidden
    && document.querySelector('#tab-files .frow.sel')?.dataset.path === 'model.py'));
  await shot('3-dateien');
  await domClick('btn-lay-code');
  await domClick('btn-lay-side');
  const lay = await ev(() => window.__t.layout());
  await ev(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: '1', ctrlKey: true, bubbles: true })));
  const lay2 = await ev(() => window.__t.layout());
  check('Spalten-Schalter oben: Code und Seitenleiste zu, Strg 1 bringt die letzte Ansicht (Dateien) wieder', !lay.code && lay.side === null && lay2.side === 'files', `${JSON.stringify(lay)} ${JSON.stringify(lay2)}`);
  await ev(() => window.__t.showPanel('parts'));

  // Export mit Dateidialog (statt nach exports/): ein Bauteil aus der Auswahlkarte, alle Bauteile in einen Ordner
  const expDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-export-test-'));
  await domClick('btn-sel-export');
  const expMenu = await ev(() => ({ open: !document.getElementById('menu-export').hidden, sel: document.getElementById('exp-sel').classList.contains('on') ? document.getElementById('exp-sel').textContent : '' }));
  await ev(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await app.answers([path.join(expDir, 'Deckel.step')]);
  const one = await ev(() => window.__t.exportAs('step', 'sel'));
  const deckel = path.join(expDir, 'Deckel.step');
  check('„Export" in der Auswahlkarte: Menü mit „Only Lid“, STEP am gewählten Ort, nichts in exports/', expMenu.open && expMenu.sel === 'Only Lid' && one.ok
    && fs.existsSync(deckel) && fs.readFileSync(deckel, 'utf8').startsWith('ISO-10303-21') && !fs.existsSync(path.join(proj.dir, 'exports')), JSON.stringify(one).slice(0, 120));
  fs.writeFileSync(path.join(expDir, 'Body.stl'), 'alt');
  await app.answers([expDir, 1]);
  const keptExp = await ev(() => window.__t.exportAs('stl', 'all'));
  check('Alle Bauteile in einen Ordner: vorhandene Datei nur nach Rückfrage, „Cancel“ schreibt nichts', keptExp.cancelled && fs.readFileSync(path.join(expDir, 'Body.stl'), 'utf8') === 'alt'
    && !fs.existsSync(path.join(expDir, 'Lid.stl')), JSON.stringify(keptExp).slice(0, 100));
  await app.answers([expDir, 0]);
  const all = await ev(() => window.__t.exportAs('stl', 'all'));
  check('„Replace“: beide Bauteile als STL im Ordner, Meldung nennt den Ordner', all.ok && all.files.length === 2 && fs.statSync(path.join(expDir, 'Body.stl')).size > 200
    && fs.existsSync(path.join(expDir, 'Lid.stl')) && (await ev(() => window.__t.toast())).text.includes(expDir), JSON.stringify(all).slice(0, 120));
  await app.answers([null]);
  const none = await ev(() => window.__t.exportAs('step', 'all'));
  check('Dialog abgebrochen: nichts passiert', none.cancelled && !none.ok);
  cleanup(expDir);

  // 3) Terminal: echte Shell im Projektordner, soma im PATH
  const tid = await ev(() => window.__t.terminals.activeId);
  check('Ein Terminal wurde automatisch geöffnet', await ev(() => window.__t.terminals.count) === 1);
  // Ohne echten fetten Schnitt rechnet Chromium das Fett nach, runde Zeichen sitzen dann einen Pixel tiefer
  check('Terminalschrift: fett ist der echte Schnitt 700, vor dem Terminal geladen', await ev((id) => window.__t.terminals.tabs.get(id).term.options.fontWeightBold === '700'
    && [...document.fonts].some((f) => f.family.includes('IBM Plex Mono') && f.weight === '700' && f.status === 'loaded'), tid));
  await ev((id) => window.soma.term.write(id, 'soma --version\r'), tid);
  const gotVersion = await waitFor('soma --version im Terminal', (id) => /^soma \d/m.test(window.__t.termText(id)), 20000, tid).catch(() => false);
  check('Im Terminal läuft `soma` (PATH der Basisumgebung)', !!gotVersion);
  await ev((id) => window.soma.term.write(id, 'Get-Location\r'), tid);
  await waitFor('Get-Location', (id) => window.__t.termText(id).includes('workspaces'), 20000, tid).catch(() => {});
  check('Terminal startet im Projektordner', (await ev((id) => window.__t.termText(id), tid)).includes('workspaces'));
  // Übergabe an den Agenten: Text landet in der Eingabezeile, abgeschickt wird nicht (E11)
  await ev((t) => window.__t.insert(t), selText);
  await waitFor('eingefügter Text', (id) => window.__t.termText(id).includes('[Selection: part "Lid"'), 10000, tid).catch(() => {});
  const afterInsert = await ev((id) => window.__t.termText(id), tid);
  check('„Send to agent" fügt den Text in die Eingabezeile ein, ohne abzuschicken', afterInsert.includes('[Selection: part "Lid"') && !/Selection:.*\n.*(nicht erkannt|not recognized)/.test(afterInsert));
  check('Bestätigung „Added to the input of Terminal"', (await ev(() => window.__t.toast())).text.includes('Added to the input of Terminal'));
  await ev((id) => window.soma.term.write(id, '\x03'), tid); // Zeile verwerfen

  // Markierung (E16): Viewer-Bild einfrieren, zeichnen, als PNG nach .soma/feedback/, Pfad in die Eingabe
  const dirtyBefore = (await ev(() => window.soma.project.saveState())).dirtyFiles;
  const lidPos = await ev((l) => { const v = window.__t.viewer, r = document.getElementById('viewer').getBoundingClientRect(), p = v.screenOf(l.id, l.face); return [p.x - r.left, p.y - r.top]; }, lidFace);
  await domClick('btn-mark');
  await waitFor('Zeichenfläche offen', () => window.__t.markup().active, 5000).catch(() => {});
  const hiddenUi = await ev(() => ['vtop', 'cube', 'cards'].every((id) => getComputedStyle(document.getElementById(id)).display === 'none'));
  const mk0 = await ev(() => window.__t.markup());
  check('„Mark up": Zeichenfläche offen, Werkzeuge, Würfel und Karten treten zurück', mk0.active && !mk0.blank && hiddenUi && mk0.pixels[0] > 0, `${mk0.pixels.join('x')} px`);
  const [bgPx, lidPx] = await ev((p) => [window.__t.markPixel(3, 3), window.__t.markPixel(p[0], p[1])], lidPos);
  // Die angeklickte Fläche leuchtet im Viewer orange. Im Bild fehlt die Auswahl, sonst verschluckt sie die orange Markierung.
  check('Das eingefrorene Bild zeigt das Modell ohne Auswahlfarbe', bgPx[3] === 255 && lidPx.slice(0, 3).reduce((s, v, i) => s + Math.abs(v - bgPx[i]), 0) > 40
    && !(lidPx[0] > 200 && lidPx[2] < 120), `${bgPx.slice(0, 3)} / ${lidPx.slice(0, 3)}`);
  check('Die Auswahl im Viewer selbst bleibt bestehen', await ev(() => window.__t.viewer.selection) === lidFace.id);
  const drag = (pts) => ev((pts) => {
    const c = document.getElementById('mark-canvas'), r = c.getBoundingClientRect();
    const fire = (type, [x, y]) => c.dispatchEvent(new PointerEvent(type, { clientX: r.left + x, clientY: r.top + y, bubbles: true, cancelable: true, button: 0, pointerId: 1, isPrimary: true }));
    fire('pointerdown', pts[0]); for (const p of pts.slice(1)) fire('pointermove', p); fire('pointerup', pts[pts.length - 1]);
  }, pts);
  const tool = (name) => ev((n) => document.querySelector(`#mark-tools [data-tool="${n}"]`).click(), name);
  await drag([[60, 300], [100, 302], [140, 300], [180, 301]]);
  await tool('arrow'); await drag([[420, 140], [lidPos[0], lidPos[1]]]);
  await tool('rect'); await drag([[40, 380], [200, 460]]);
  await tool('ellipse'); await drag([[250, 380], [252, 381]]); // bloßer Klick: keine Form
  await tool('text'); await drag([[430, 110]]);
  await sleep(100);
  await ev(() => { document.getElementById('mark-text').value = 'vorne spitz, etwa 1 mm'; });
  await shot('7a-markieren-text');
  await ev(() => document.getElementById('mark-text').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  const mk1 = await ev(() => window.__t.markup());
  const penPx = await ev(() => window.__t.markPixel(120, 301));
  check('Zeichnen: Stift, Pfeil, Rechteck, Text (Klick ohne Ziehen ergibt keine Form)', JSON.stringify(mk1.shapes) === '["pen","arrow","rect","text"]', mk1.shapes.join(','));
  check('Stiftstrich im Bild in Orange', penPx[0] > 200 && penPx[1] > 110 && penPx[1] < 190 && penPx[2] < 110, penPx.slice(0, 3).join(','));
  await shot('7-markieren');
  await tool('ellipse'); await drag([[250, 380], [330, 440]]);
  await domClick('btn-mark-undo');
  check('Rückgängig nimmt die letzte Form zurück', JSON.stringify((await ev(() => window.__t.markup())).shapes) === '["pen","arrow","rect","text"]');
  await domClick('btn-mark-blank');
  const blankPx = await ev((p) => window.__t.markPixel(p[0] + 30, p[1] + 30), lidPos);
  await shot('7c-markieren-leer');
  check('„Blank canvas": Hintergrund ohne Modell, Zeichnung bleibt', (await ev(() => window.__t.markup())).blank && blankPx.slice(0, 3).join() === '27,30,35'
    && (await ev(() => window.__t.markup())).shapes.length === 4, blankPx.slice(0, 3).join(','));
  await domClick('btn-mark-blank');

  // Gezeichnetes bleibt bearbeitbar: auswählen, verschieben, drehen, skalieren, umfärben, löschen
  const mk = () => ev(() => window.__t.markup());
  const key = (k, o = {}) => ev(([k, o]) => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...o })), [k, o]);
  await tool('select');
  const rect0 = (await mk()).items[2];
  await drag([[40, 420], [60, 410], [80, 400]]); // Klick auf den linken Rand, dann ziehen
  let st = await mk();
  check('Auswählen: Klick auf den Rand wählt das Rechteck, Ziehen verschiebt es', st.selected === 2 && st.items[2].x === rect0.x + 40 && st.items[2].y === rect0.y - 20, `${st.selected}: ${st.items[2].x},${st.items[2].y}`);
  let hd = await ev(() => window.__t.markHandles());
  await drag([hd.rotate, [hd.center[0] + 50, hd.rotate[1] + 20], [hd.center[0] + 100, hd.center[1]]]);
  st = await mk();
  check('Drehgriff dreht um die Mitte (hier um 90°)', Math.abs(st.items[2].rot - Math.PI / 2) < 0.01 && st.items[2].x === rect0.x + 40, `${st.items[2].rot} rad`);
  hd = await ev(() => window.__t.markHandles());
  const [cx2, cy2] = hd.corners[2];
  await drag([[cx2, cy2], [cx2 + (cx2 - hd.center[0]) * 0.5, cy2 + (cy2 - hd.center[1]) * 0.5]]);
  st = await mk();
  const hd2 = await ev(() => window.__t.markHandles());
  check('Eckgriff skaliert, die gegenüberliegende Ecke bleibt stehen', st.items[2].sx > 1.2 && st.items[2].sy > 1.2 && Math.hypot(hd2.corners[0][0] - hd.corners[0][0], hd2.corners[0][1] - hd.corners[0][1]) < 0.5,
    `${st.items[2].sx} × ${st.items[2].sy}`);
  await domClick('btn-mark-color');
  const swatches = await ev(() => document.querySelectorAll('#menu-mark-color [data-color]').length);
  await shot('7e-markieren-farben');
  await ev(() => document.querySelector('#menu-mark-color [data-color="blue"]').click());
  st = await mk();
  check('Farbmenü: 10 Farben und eigene Farbe, die ausgewählte Form wird umgefärbt', swatches === 10 && await ev(() => !!document.getElementById('mark-color-custom'))
    && st.items[2].color === '#5ea8ff' && st.color === '#5ea8ff' && await ev(() => document.getElementById('menu-mark-color').hidden), `${swatches} Farben, ${st.items[2].color}`);
  await shot('7d-markieren-auswahl');
  await key('Delete');
  st = await mk();
  check('Del löscht die ausgewählte Form', JSON.stringify(st.shapes) === '["pen","arrow","text"]' && st.selected === -1, st.shapes.join(','));
  await domClick('btn-mark-undo');
  st = await mk();
  check('Rückgängig holt sie zurück, mit Drehung, Größe und Farbe', st.shapes.length === 4 && st.items[2].color === '#5ea8ff' && Math.abs(st.items[2].rot - Math.PI / 2) < 0.01 && st.items[2].sx > 1.2);
  await key('y', { ctrlKey: true });
  check('Ctrl+Y wiederholt das Löschen', (await mk()).shapes.length === 3);
  await domClick('btn-mark-undo');
  const tx = (await mk()).items[3];
  await drag([[tx.x, tx.y]]); await drag([[tx.x, tx.y]]);
  await sleep(50);
  const ed = await ev(() => ({ open: !document.getElementById('mark-text').hidden, value: document.getElementById('mark-text').value }));
  await ev(() => { const t = document.getElementById('mark-text'); t.value = 'Spitze etwa 1 mm'; t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
  st = await mk();
  check('Doppelklick auf einen Text öffnet ihn zum Bearbeiten, Enter übernimmt', ed.open && ed.value === 'vorne spitz, etwa 1 mm' && st.items[3].text === 'Spitze etwa 1 mm' && st.shapes.length === 4, ed.value);
  await key('Escape');
  check('Escape hebt zuerst nur die Auswahl auf', (await mk()).selected === -1 && (await mk()).active);

  // Linie und Raster: Das Raster steht im Bild, Linien rasten an den Kreuzungen ein
  const gridOff = await ev(() => window.__t.markPixel(600, 10));
  await domClick('btn-mark-grid');
  const gridOn = await ev(() => window.__t.markPixel(600, 10));
  await tool('line'); await drag([[101, 203], [150, 205], [189, 207]]);
  st = await mk();
  const ln = st.items[st.items.length - 1];
  await shot('7f-markieren-raster');
  check('Raster an: im Bild zu sehen, Knopf gedrückt', st.grid && gridOn.slice(0, 3).join() !== gridOff.slice(0, 3).join()
    && await ev(() => document.getElementById('btn-mark-grid').getAttribute('aria-pressed')) === 'true', `${gridOff.slice(0, 3)} → ${gridOn.slice(0, 3)}`);
  check('Linie: gerade, Endpunkte am Raster (100,200 bis 180,200)', st.shapes.length === 5 && ln.tool === 'line' && ln.x === 140 && ln.y === 200, `${ln.tool} ${ln.x},${ln.y}`);
  await domClick('btn-mark-grid');
  check('Raster wieder aus: Bild ohne Raster', !(await mk()).grid && (await ev(() => window.__t.markPixel(600, 10))).slice(0, 3).join() === gridOff.slice(0, 3).join());

  await ev(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  check('Escape mit Zeichnung verwirft nicht sofort (erst beim zweiten Mal)', (await ev(() => window.__t.markup())).active && (await ev(() => window.__t.toast())).text.includes('Press Escape again'));
  const px = (await ev(() => window.__t.markup())).pixels;
  await domClick('btn-mark-send');
  await waitFor('Markierung gespeichert', () => !window.__t.markup().active, 10000).catch(() => {});
  const fbDir = path.join(proj.dir, '.soma', 'feedback');
  const fbFiles = fs.existsSync(fbDir) ? fs.readdirSync(fbDir) : [];
  const png = fbFiles.length === 1 ? fs.readFileSync(path.join(fbDir, fbFiles[0])) : Buffer.alloc(0);
  if (process.env.SMOKE_SHOTS && png.length) fs.writeFileSync(path.join(APP, 'test', 'shots', '7b-markierung-bild.png'), png); // so sieht der Agent es
  check('„Send to agent": PNG in .soma/feedback/, so groß wie der Viewer in Gerätepixeln', /^markup-\d{8}-\d{4}\.png$/.test(fbFiles[0] ?? '') && png.length > 2000
    && png.readUInt32BE(16) === px[0] && png.readUInt32BE(20) === px[1], `${fbFiles.join(',')} ${png.length > 24 ? `${png.readUInt32BE(16)}x${png.readUInt32BE(20)}` : ''}`);
  await waitFor('Pfad im Terminal', (id) => window.__t.termText(id).includes('[Markup: .soma/feedback/markup-'), 10000, tid).catch(() => {});
  check('Pfad steht in der Eingabe des Terminals, nicht abgeschickt', (await ev((id) => window.__t.termText(id), tid)).includes(`[Markup: .soma/feedback/${fbFiles[0]}]`));
  const tst = await ev(() => window.__t.toast());
  check('Meldung nennt Datei und Ziel, die Werkzeuge sind zurück', tst.text.includes(`Markup saved: .soma/feedback/${fbFiles[0]}`) && tst.text.includes('Added to the input of Terminal')
    && await ev(() => getComputedStyle(document.getElementById('vtop')).display !== 'none'), tst.text.replace(/\s+/g, ' ').slice(0, 70));
  await ev((id) => window.soma.term.write(id, '\x03'), tid);
  check('Markierung zählt nicht als ungespeicherte Änderung (nicht in Git, E11)', (await ev(() => window.soma.project.saveState())).dirtyFiles === dirtyBefore);
  await domClick('btn-mark');
  await waitFor('Zeichenfläche erneut', () => window.__t.markup().active, 5000).catch(() => {});
  const again = await ev(() => window.__t.markup().active);
  await ev(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  check('Escape ohne Zeichnung schließt die Zeichenfläche, es entsteht keine Datei', again && !(await ev(() => window.__t.markup().active)) && fs.readdirSync(fbDir).length === 1);

  // Ziehen ins Terminal ersetzt die Übergabeleiste (Entwurf 2): Bauteil aus der Seitenleiste fallen lassen
  const dropOver = await ev(() => {
    const dt = new DataTransfer();
    dt.setData('application/x-soma-part', window.__t.parts().find((p) => p.name === 'Body').id);
    const pane = [...document.querySelectorAll('#term-panes .term-pane')].find((x) => !x.hidden) ?? document.getElementById('term-panes');
    pane.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
    const over = document.getElementById('term-panes').classList.contains('dropping');
    pane.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    return over;
  });
  await waitFor('Verweis im Terminal', (id) => window.__t.termText(id).includes('[Selection: part "Body"'), 10000, tid).catch(() => {});
  check('Bauteil ins Terminal gezogen: Hinweis beim Darüberziehen, Verweis in der Eingabe, keine Übergabeleiste mehr', dropOver && !(await ev(() => document.getElementById('handoff')))
    && (await ev((id) => window.__t.termText(id), tid)).includes('[Selection: part "Body"'));
  await ev((id) => window.soma.term.write(id, '\x03'), tid);

  // Dateibaum: Markierungen sichtbar, anlegen, umbenennen, löschen über Menü und Tasten
  await ev(() => window.__t.showPanel('files'));
  await waitFor('Markierungen im Dateibaum', (f) => window.__t.fileRows().includes(f), 10000, fbFiles[0]).catch(() => {});
  const rows2 = await ev(() => window.__t.fileRows());
  check('Dateibaum: Gruppe „Markups“ mit dem Bild aus .soma/feedback/, sonst nichts aus .soma', rows2.includes('Markups') && rows2.includes(fbFiles[0]) && !rows2.includes('project.json'), rows2.slice(-6).join(','));
  const ctx = (rel) => ev((rel) => {
    const row = document.querySelector(`#tab-files .frow[data-path="${CSS.escape(rel)}"]`);
    if (!row) return null;
    const r = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 5 }));
    return [...document.querySelectorAll('#menu-ctx .mi')].map((b) => (b.disabled ? '-' : '') + b.textContent.replace(/(F2|Del)$/, ''));
  }, rel);
  const menuItemClick = (label) => ev((l) => [...document.querySelectorAll('#menu-ctx .mi')].find((b) => b.textContent.startsWith(l))?.click(), label);
  const typeName = (name) => ev((n) => { const t = document.querySelector('#tab-files .fedit'); if (!t) return false; t.value = n; t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; }, name);
  const fbRel = `.soma/feedback/${fbFiles[0]}`;
  const imgMenu = await ctx(fbRel);
  await menuItemClick('Mark up');
  await waitFor('Bild als Zeichenfläche', () => window.__t.markup().active, 5000).catch(() => {});
  const mkImg = await ev(() => ({ ...window.__t.markup(), hint: document.getElementById('mark-hint').textContent }));
  await shot('7g-markieren-bild');
  check('Bild im Dateibaum: „Mark up“ öffnet es als Hintergrund der Zeichenfläche', imgMenu?.includes('Mark up') && mkImg.active && mkImg.source === fbRel && !mkImg.blank
    && mkImg.hint.includes(fbRel) && mkImg.pixels[0] >= px[0], `${imgMenu?.join(',')} ${mkImg.source} ${mkImg.pixels}`);
  await ev(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  check('Escape ohne Zeichnung schließt das Bild wieder, keine neue Datei', !(await ev(() => window.__t.markup().active)) && fs.readdirSync(fbDir).length === 1);
  await ev((rel) => document.querySelector(`#tab-files .frow[data-path="${CSS.escape(rel)}"]`).click(), fbRel);
  await waitFor('Bild per Klick', () => window.__t.markup().active, 5000).catch(() => {});
  check('Klick auf das Bild öffnet es ebenfalls zum Markieren (E52)', (await ev(() => window.__t.markup())).source === fbRel);
  // Von Bild zu Bild: ohne Zeichnung direkt und ohne Meldung, mit Zeichnung erst nach Rückfrage
  const imgB = path.join(proj.dir, 'skizze-b.png');
  fs.copyFileSync(path.join(fbDir, fbFiles[0]), imgB);
  await waitFor('zweites Bild im Baum', () => window.__t.fileRows().includes('skizze-b.png'), 10000).catch(() => {});
  const clickRow = (rel) => ev((rel) => document.querySelector(`#tab-files .frow[data-path="${CSS.escape(rel)}"]`).click(), rel);
  const toastBefore = (await ev(() => window.__t.toast())).text;
  await clickRow('skizze-b.png');
  await waitFor('Wechsel', () => window.__t.markup().source === 'skizze-b.png', 5000).catch(() => {});
  const sw = await ev(() => ({ ...window.__t.markup(), toast: window.__t.toast() }));
  check('Wechsel zu einem anderen Bild ohne Zeichnung: direkt, ohne Meldung', sw.active && sw.source === 'skizze-b.png' && (sw.toast.hidden || sw.toast.text === toastBefore), sw.toast.text.slice(0, 60));
  await tool('pen'); await drag([[60, 300], [140, 300]]);
  await app.answers([1]);
  await clickRow(fbRel);
  await sleep(500);
  const kept = await ev(() => window.__t.markup());
  await app.answers([0]);
  await clickRow(fbRel);
  await waitFor('Wechsel nach Verwerfen', (r) => window.__t.markup().source === r, 5000, fbRel).catch(() => {});
  const swapped = await ev(() => window.__t.markup());
  check('Mit Zeichnung: Rückfrage, „Cancel“ behält sie, „Discard and switch“ öffnet das andere Bild', kept.source === 'skizze-b.png' && kept.shapes.length === 1
    && swapped.source === fbRel && swapped.shapes.length === 0, `${kept.source}/${kept.shapes.length} → ${swapped.source}/${swapped.shapes.length}`);
  await ev(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  fs.rmSync(imgB);
  const modelMenu = await ctx('model.py');
  check('Menü auf model.py: kein „Mark up“ (kein Bild)', !modelMenu?.includes('Mark up'));
  check('Menü auf model.py: Öffnen, Explorer, Pfad, Anlegen; Umbenennen und Löschen gesperrt', ['Open', 'Show in Explorer', 'Send path to agent', 'Copy path', 'New file', '-Rename', '-Delete'].every((x) => modelMenu?.includes(x)), modelMenu?.join(','));
  await ev(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await domClick('btn-file-new');
  await sleep(50);
  const typed = await typeName('notiz.txt');
  const notiz = path.join(proj.dir, 'notiz.txt');
  await waitFor('Datei angelegt und offen', () => window.__t.editor.state().file === 'notiz.txt', 5000).catch(() => {});
  check('„New file“: Namensfeld im Baum, Enter legt sie an und öffnet sie im Editor', typed && fs.existsSync(notiz) && (await ev(() => window.__t.editor.state())).file === 'notiz.txt');
  await ev(() => window.__t.showPanel('files'));
  await waitFor('notiz.txt im Baum', () => window.__t.fileRows().includes('notiz.txt'), 5000).catch(() => {});
  await ctx('notiz.txt'); await menuItemClick('Rename'); await sleep(50);
  await typeName('model.py'); await sleep(300);
  const dupErr = await ev(() => ({ toast: window.__t.toast().text, open: !!document.querySelector('#tab-files .fedit') }));
  check('Umbenennen auf vorhandenen Namen: Meldung, Feld bleibt offen, nichts überschrieben', dupErr.open && dupErr.toast.includes('already exists there') && fs.existsSync(notiz)
    && fs.readFileSync(path.join(proj.dir, 'model.py'), 'utf8').includes('add_part'), dupErr.toast.slice(0, 60));
  await typeName('skizze.txt');
  const skizze = path.join(proj.dir, 'skizze.txt');
  await waitFor('umbenannt', () => window.__t.editor.state().files.includes('skizze.txt'), 5000).catch(() => {});
  const es = await ev(() => window.__t.editor.state());
  check('Umbenennen: Datei heißt neu, der offene Reiter zieht mit', fs.existsSync(skizze) && !fs.existsSync(notiz) && es.files.includes('skizze.txt') && !es.files.includes('notiz.txt'), es.files.join(','));
  await waitFor('skizze.txt im Baum', () => window.__t.fileRows().includes('skizze.txt'), 5000).catch(() => {});
  await app.answers([0]);
  await ev(() => { const r = document.querySelector('#tab-files .frow[data-path="skizze.txt"]'); r.focus(); r.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true })); });
  await waitFor('gelöscht', () => !window.__t.fileRows().includes('skizze.txt'), 5000).catch(() => {});
  const bin = path.join(ud, 'test-papierkorb');
  check('Del mit Rückfrage: in den Papierkorb, Reiter zu', !fs.existsSync(skizze) && fs.existsSync(bin) && fs.readdirSync(bin).some((f) => f.endsWith('skizze.txt'))
    && !(await ev(() => window.__t.editor.state())).files.includes('skizze.txt'), fs.existsSync(bin) ? fs.readdirSync(bin).join(',') : 'kein Papierkorb');
  await ctx(`.soma/feedback/${fbFiles[0]}`); await menuItemClick('Send path to agent');
  await waitFor('Pfad der Markierung im Terminal', (f) => window.__t.termText(f[0]).includes(`[File: .soma/feedback/${f[1]}]`), 5000, [tid, fbFiles[0]]).catch(() => {});
  check('Markierung: Rechtsklick „Send path to agent“ fügt den Pfad ein', (await ev((id) => window.__t.termText(id), tid)).includes(`[File: .soma/feedback/${fbFiles[0]}]`));
  await ev((id) => window.soma.term.write(id, '\x03'), tid);
  await shot('3b-dateien-menue');
  await ev(() => window.__t.showPanel(null));

  // 4) Auto-Build: Änderung an model.py -> neuer Build -> drittes Bauteil
  const modelPy = path.join(proj.dir, 'model.py');
  const original = fs.readFileSync(modelPy, 'utf8');
  const third = '\nadd_part("Third", cq.Workplane("XY").box(6, 6, 6).translate((60, 0, 0)))\n';
  fs.writeFileSync(modelPy, original + third);
  await waitFor('drittes Bauteil', () => window.__t.partCount() === 3 && window.__t.status().state === 'ok');
  check('Auto-Build: Änderung an model.py erscheint im Viewer', (await ev(() => window.__t.treeNames())).includes('Third'));

  // 5) Fehlerfall: kaputtes model.py -> Fehler mit Ort, alter Stand bleibt sichtbar
  fs.writeFileSync(modelPy, original + third + 'def kaputt(:\n');
  await waitFor('Fehlerstatus', () => window.__t.status().state === 'error');
  const err = await status();
  check('Syntaxfehler: Anzeige oben „Build failed" mit Datei und Zeile', err.text === 'Build failed' && /model\.py, line \d+/.test(err.detail), err.detail.slice(0, 70));
  check('Fehlerkarte im Viewer, letzter guter Stand (3 Bauteile) bleibt', err.viewerMsg.includes('Build failed') && await ev(() => window.__t.partCount()) === 3);
  const errText = await ev(() => window.__t.errorText());
  check('Fehlertext für den Agenten nennt Datei und Zeile', /^\[Build error: model\.py line \d+: /.test(errText), errText.slice(0, 60));
  await shot('4-fehler');
  await sleep(300);
  check('App reagiert weiter (Terminal aktiv, kein Absturz)', await ev(() => window.__t.terminals.count) === 1);

  // 6) Repariert -> wieder ok
  fs.writeFileSync(modelPy, original);
  await waitFor('Build ok nach Reparatur', () => window.__t.status().state === 'ok' && window.__t.partCount() === 2);
  check('Nach der Reparatur wieder ok, Fehlermeldung weg, 2 Bauteile', (await status()).viewerMsg === '');

  // 7) Auto-Build aus: Änderung bleibt liegen, erst der Knopf baut
  await domClick('chk-auto');
  fs.writeFileSync(modelPy, original + third);
  await sleep(3500);
  check('Auto-Build aus: keine Änderung im Viewer nach 3,5 s', await ev(() => window.__t.partCount()) === 2);
  await domClick('btn-build');
  await waitFor('Knopf-Build', () => window.__t.partCount() === 3 && window.__t.status().state === 'ok');
  check('Knopf „Build now" baut trotzdem (3 Bauteile)', true);
  fs.writeFileSync(modelPy, original);
  await waitFor('veraltet gemeldet', () => window.__t.status().text === 'Code changed', 10000).catch(() => {});
  check('Auto-Build aus: Anzeige meldet „Code changed"', (await status()).text === 'Code changed', (await status()).text);
  await domClick('chk-auto');
  await waitFor('Auto an baut nach', () => window.__t.partCount() === 2 && window.__t.status().state === 'ok', 60000).catch(() => {});
  check('Auto-Build wieder an: veralteter Stand wird gleich gebaut', await ev(() => window.__t.partCount()) === 2);

  // 7b) Ansicht: Würfel (Seite, Ecke, Ziehen), Drehpunkt per Doppelklick, Zoom zur Maus, Ansichten im Menü
  const vs = () => ev(() => window.__t.viewer.viewState());
  const settle = () => waitFor('Ansicht steht', () => !window.__t.viewer.viewState().animating, 5000).catch(() => {});
  const near = (a, b, tol = 1e-3) => a.every((v, i) => Math.abs(v - b[i]) < tol);
  const unit = (v) => { const l = Math.hypot(...v); return v.map((x) => x / l); };
  await ev(() => window.__t.viewer.setView('iso'));
  const v0 = await vs();
  check('Ansichtswürfel ist da (3D, eigene Zeichenfläche)', await ev(() => { const c = document.querySelector('#cube-view canvas'); return !!c && c.width > 0; }));
  await page.click(...Object.values(await ev(() => window.__t.viewer.cubeScreen([0, -1, 0]))));
  await settle();
  let v1 = await vs();
  check('Würfel „FRONT" anklicken: Ansicht von vorne, Drehpunkt und Abstand bleiben', near(v1.dir, [0, -1, 0]) && near(v1.target, v0.target) && Math.abs(v1.dist - v0.dist) < 1e-6, v1.dir.map((x) => x.toFixed(3)).join(','));
  await page.click(...Object.values(await ev(() => window.__t.viewer.cubeScreen([0.85, -1, 0.85]))));
  await settle();
  v1 = await vs();
  check('Ecke „oben vorne rechts" anklicken: Blick schräg von dort', near(v1.dir, unit([1, -1, 1])), v1.dir.map((x) => x.toFixed(3)).join(','));
  await ev((p) => {
    const c = document.querySelector('#cube-view canvas'), f = (type, x) => c.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: p.y, bubbles: true, button: 0, buttons: 1, pointerId: 1 }));
    f('pointerdown', p.x); f('pointermove', p.x + 20); f('pointermove', p.x + 40); f('pointerup', p.x + 40);
  }, await ev(() => window.__t.viewer.cubeScreen([0, -1, 0])));
  const v2 = await vs();
  check('Würfel ziehen dreht die Ansicht um den Drehpunkt', !near(v2.dir, v1.dir, 1e-2) && near(v2.target, v1.target) && Math.abs(v2.dir[2] - v1.dir[2]) < 1e-6, v2.dir.map((x) => x.toFixed(3)).join(','));
  await ev(() => window.__t.viewer.setView('iso'));
  const corner = await ev(() => {
    const v = window.__t.viewer, id = window.__t.parts().find((p) => p.name === 'Lid').id;
    const f = v.facesOf(id).filter((x) => x.surface === 'PLANE').sort((a, b) => b.center[2] - a.center[2])[0];
    return { s: v.screenOf(id, f.id), c: f.center };
  });
  const before = await vs();
  await ev((p) => document.querySelector('#viewer > canvas').dispatchEvent(new MouseEvent('dblclick', { clientX: p.x, clientY: p.y, bubbles: true })), corner.s);
  await settle();
  const v3 = await vs();
  check('Doppelklick ins Modell: Drehpunkt dorthin, die Ansicht verschiebt sich nur (dreht nicht)', near(v3.target, corner.c, 0.2) && near(v3.dir, before.dir, 1e-6),
    `${v3.target.map((x) => x.toFixed(2)).join(',')} statt ${corner.c.join(',')}`);
  check('Zoom zur Mausposition an, vordere Schnittebene folgt dem Abstand', v3.zoomToCursor && Math.abs(v3.near - v3.dist / 200) < 1e-9 && v3.far > v3.dist, `near ${v3.near.toFixed(3)}, Abstand ${v3.dist.toFixed(1)}`);
  await ev(() => document.querySelector('#menu-display [data-view="back"]').click());
  check('Ansicht „Back" im Menü Display', near((await vs()).dir, [0, 1, 0]));
  await domClick(await ev(() => { const b = document.querySelector('.vbtns [data-view="iso"]'); b.id ||= 'btn-view-iso'; return b.id; }));
  check('Standardansicht setzt den Drehpunkt zurück in die Mitte des Modells', near((await vs()).target, v0.target, 1e-6));
  // Zum Ansehen: Zeiger über der Ecke oben vorne rechts (Felder in Orange)
  await ev((p) => document.querySelector('#cube-view canvas').dispatchEvent(new PointerEvent('pointermove', { clientX: p.x, clientY: p.y, bubbles: true, pointerId: 1 })),
    await ev(() => window.__t.viewer.cubeScreen([0.85, -0.85, 1])));
  await shot('8-ansichtswuerfel');
  await ev(() => document.querySelector('#cube-view canvas').dispatchEvent(new PointerEvent('pointerleave', { bubbles: true })));

  // 8) Neues Projekt: anderer Ordner, Terminals des alten sind zu, frischer erster Build
  await domClick('btn-new');
  await waitFor('neues Projekt', (oldId) => window.__t.project().id !== oldId && window.__t.status().state === 'ok' && window.__t.partCount() === 2, 90000, proj.id).catch(() => {});
  const p2 = await ev(() => window.__t.project());
  check('„Neu" legt ein zweites Projekt mit eigener UUID an', p2.id !== proj.id, p2.id.slice(0, 8));
  await sleep(600);
  check('Projektwechsel: genau ein frisches Terminal', await ev(() => window.__t.terminals.count) === 1);
  // Die alte Shell meldet ihr Ende erst nach dem Wechsel. Das darf das neue Terminal nicht als beendet markieren,
  // sonst lässt sich nichts mehr einfügen („Das Terminal ist beendet“), obwohl darin ein Agent läuft.
  await sleep(2500);
  await ev(() => window.__t.insert('[Test nach Wechsel] '));
  const afterSwitch = await ev(() => window.__t.toast());
  check('Nach dem Wechsel: Einfügen ins neue Terminal geht', !afterSwitch.error && afterSwitch.text.includes('Added to the input of Terminal'), afterSwitch.text.slice(0, 60));
  await ev(() => window.soma.term.write(window.__t.terminals.activeId, '\x03'));
  // Aktives Terminal beendet, ein anderes läuft noch: Der Text geht dorthin, und dieses kommt nach vorn
  const firstTid = await ev(() => window.__t.terminals.activeId);
  const secondTid = await ev(() => window.__t.terminals.add({ title: 'Zweites' }));
  await sleep(1500);
  await ev((id) => window.soma.term.write(id, 'exit\r'), secondTid);
  await waitFor('zweites Terminal beendet', (id) => window.__t.termText(id).includes('Process ended'), 10000, secondTid).catch(() => {});
  await ev(() => window.__t.insert('[Test Ersatzterminal] '));
  const fallback = await ev(() => window.__t.toast());
  await waitFor('Text im ersten Terminal', (id) => window.__t.termText(id).includes('[Test Ersatzterminal]'), 5000, firstTid).catch(() => {});
  check('Aktives Terminal beendet: Text geht ins zuletzt benutzte laufende, das nach vorn kommt', !fallback.error && await ev(() => window.__t.terminals.activeId) === firstTid
    && (await ev((id) => window.__t.termText(id), firstTid)).includes('[Test Ersatzterminal]'), fallback.text.slice(0, 60));
  await ev((id) => window.soma.term.write(id, '\x03'), firstTid);
  await ev((id) => window.__t.terminals.close(id), secondTid);
  check('Beide Arbeitsordner existieren getrennt', fs.existsSync(proj.dir) && fs.existsSync(p2.dir) && proj.dir !== p2.dir);

  if (app.visible) { await sleep(500); await page.screenshot(path.join(APP, 'test', 'smoke.png')); }
  if (process.env.SMOKE_SHOTS) {
    await ev(() => window.__t.showStart(true));
    await shot('5-startseite');
    await ev(() => window.__t.showStart(false));
    await ev(() => window.__t.setAgentCollapsed(true));
    await shot('6-agent-eingeklappt');
    await ev(() => window.__t.setAgentCollapsed(false));
  }
  const relevant = page.errors.filter((e) => !/favicon/i.test(e));
  check('Keine Konsolenfehler im Renderer', relevant.length === 0, relevant.slice(0, 2).join(' | ').slice(0, 100));
} catch (e) {
  console.log('ABBRUCH:', e.message);
  t.fail();
}
if (app) { await app.stop(); cleanup(app.ud); }
console.log(t.fails ? `\n${t.fails} Prüfung(en) fehlgeschlagen` : '\nALLE PRÜFUNGEN BESTANDEN');
process.exit(t.fails ? 1 : 0);
