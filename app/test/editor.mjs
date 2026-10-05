// Test des Editors im Code-Panel: Höhe und Scrollen, Speichern nur auf Wunsch (Strg+S, Knopf) mit genau einem Build,
// Änderungen von außen (Agent), Konflikte mit Sicherung, Nur-lesen-Dateien, Zeilenenden, Fehlerzeile, Speichern als ZIP,
// Rückfragen bei Modellwechsel und beim Schließen eines Reiters.
// Aufruf: npm run test:editor (baut vorher). SMOKE_VISIBLE=offscreen SMOKE_SHOTS=1 legt Bilder in test/shots/ ab.
import { exec } from 'dugite';
import fs from 'node:fs';
import path from 'node:path';
import { APP, checker, cleanup, sleep, startApp } from './harness.mjs';

const t = checker();
const { check } = t;
let app;

/** Wartet im Testprozess (nicht im Fenster), bis fn wahr ist. */
async function until(desc, fn, timeout = 10000) {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return true;
    if (Date.now() - t0 > timeout) { console.log(`       (Zeitüberschreitung: ${desc})`); return false; }
    await sleep(100);
  }
}

try {
  app = await startApp({ name: 'editor' });
  const { ev, waitFor, domClick, ud, page } = app;
  const shot = async (name) => {
    if (!process.env.SMOKE_SHOTS) return;
    fs.mkdirSync(path.join(APP, 'test', 'shots'), { recursive: true });
    await sleep(900);
    await app.screenshot(path.join(APP, 'test', 'shots', `${name}.png`)).catch((e) => console.log('Screenshot:', e.message));
  };
  await waitFor('Projekt und Build', () => !!window.__t && !!window.__t.project() && window.__t.status().state === 'ok' && window.__t.partCount() === 2);
  const proj = await ev(() => window.__t.project());
  const modelPy = path.join(proj.dir, 'model.py');
  const disk = () => fs.readFileSync(modelPy, 'utf8');
  const ed = () => ev(() => window.__t.editor.state());
  const replace = (a, b) => ev(([x, y]) => window.__t.editor.replace(x, y), [a, b]);
  const open = async (file) => {
    await ev((f) => window.__t.openCode(f), file);
    await waitFor(file, (f) => window.__t.editor.state().file === f, 10000, file).catch(() => {});
  };
  // Strg+S so, wie es im Editor ankommt: als Taste im Eingabebereich von CodeMirror
  const ctrlS = () => ev(() => document.querySelector('#code-view .cm-content').dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true })));
  const builds = () => ev(() => window.__t.buildStarts());
  const body = async () => (await ev(() => window.__t.partSize('Body')))?.[0];
  // Ruhe: Ein angemeldeter Auto-Build (Entprellung 700 ms nach einer Dateiänderung) soll erst starten und fertig werden
  const idle = async () => { await sleep(1200); await waitFor('Build fertig', () => window.__t.status().state !== 'building', 60000).catch(() => {}); };
  const bdir = path.join(ud, 'workspace-backups', `${proj.id}-editor`);
  const backups = () => (fs.existsSync(bdir) ? fs.readdirSync(bdir).map((f) => fs.readFileSync(path.join(bdir, f), 'utf8')) : []);

  // 1) Öffnen: model.py im Editor, bearbeitbar, mit Hervorhebung
  await ev(() => document.querySelector('#rail [data-panel="code"]').click());
  await waitFor('model.py im Editor', () => window.__t.editor.state().file === 'model.py', 10000).catch(() => {});
  let s = await ed();
  check('Code-Panel öffnet model.py im Editor, bearbeitbar', s.file === 'model.py' && !s.readOnly && s.text === disk().replace(/\r\n/g, '\n'), s.file ?? '');
  check('Python-Hervorhebung: Schlüsselwörter, Konstanten, Aufrufe', await ev(() => ['k-kw', 'k-num', 'k-fn'].every((c) => !!document.querySelector(`#code-view .cm-content .${c}`))));

  // 2) Höhe: Der Editor füllt das Panel bis unten, lange Dateien lassen sich bis zum Ende scrollen
  const long = path.join(proj.dir, 'notizen-lang.txt');
  fs.writeFileSync(long, Array.from({ length: 400 }, (_, i) => `Zeile ${i + 1}`).join('\n') + '\n');
  await open('notizen-lang.txt');
  const lay = await ev(() => window.__t.editor.layout());
  check('Editor füllt das Panel bis unten', Math.abs(lay.editorBottom - lay.viewBottom) < 2 && Math.abs(lay.editorTop - lay.viewTop) < 2, `Editor ${Math.round(lay.editorTop)}–${Math.round(lay.editorBottom)}, Panel ${Math.round(lay.viewTop)}–${Math.round(lay.viewBottom)}`);
  const scrolled = await ev(() => window.__t.editor.scrollToEnd());
  await sleep(200);
  // Gemessen wird die Scrollposition: Ein unsichtbares Testfenster zeichnet die neu sichtbaren Zeilen nicht nach
  check('Lange Datei: lässt sich bis ganz unten scrollen', lay.scrollHeight > lay.clientHeight && scrolled > 0 && scrolled + lay.clientHeight >= lay.scrollHeight - 1,
    `${scrolled} von ${lay.scrollHeight - lay.clientHeight} px`);
  await open('model.py');
  await idle();

  // 3) Tippen speichert nicht und baut nicht
  const b0 = await builds();
  await replace('LENGTH = 60.0', 'LENGTH = 70.0');
  await sleep(2500);
  s = await ed();
  check('Tippen: Platte unverändert, kein Build', s.dirty && disk().includes('LENGTH = 60.0') && await builds() === b0 && await body() === 60, `${await builds() - b0} Builds`);
  check('Anzeige: Punkt am Reiter, „Nicht gespeichert · Strg+S" und Knopf „Speichern und bauen"', await ev(() => !!document.querySelector('#code-tabs .ctab.on .dirty')
    && document.getElementById('code-info').textContent.includes('Nicht gespeichert · Strg+S') && document.getElementById('btn-code-save')?.textContent === 'Speichern und bauen'));
  await shot('8-editor-ungespeichert');

  // 4) Strg+S im Editor: speichern, dann genau ein Build
  await ctrlS();
  await waitFor('Build mit 70', () => window.__t.status().state === 'ok' && (window.__t.partSize('Body') || [0])[0] === 70, 60000).catch(() => {});
  check('Strg+S im Editor: Datei gespeichert und gebaut (Body 70 mm lang)', disk().includes('LENGTH = 70.0') && !(await ed()).dirty && await body() === 70);
  await sleep(2000);
  check('Genau ein Build nach dem Speichern (die Dateiüberwachung baut nicht noch einmal)', await builds() === b0 + 1, `${await builds() - b0} Builds`);
  check('Strg+S im Editor schreibt keine ZIP (das macht „Speichern" oben)', !(await ev(() => window.__t.saveState()))?.zipPath);

  // 5) Knopf „Speichern und bauen"
  await replace('LENGTH = 70.0', 'LENGTH = 72.0');
  await domClick('btn-code-save');
  await waitFor('Build mit 72', () => window.__t.status().state === 'ok' && (window.__t.partSize('Body') || [0])[0] === 72, 60000).catch(() => {});
  check('Knopf „Speichern und bauen": gespeichert und gebaut (72 mm), Knopf wieder weg', disk().includes('LENGTH = 72.0') && await body() === 72 && await ev(() => !document.getElementById('btn-code-save')?.isConnected));

  // 6) Änderung von außen ohne eigene Eingaben: Der Editor übernimmt sie
  fs.writeFileSync(modelPy, disk().replace('LENGTH = 72.0', 'LENGTH = 75.0'));
  await waitFor('Editor übernimmt', () => window.__t.editor.state().text.includes('LENGTH = 75.0'), 10000).catch(() => {});
  s = await ed();
  check('Änderung von außen (Agent) erscheint im Editor, ohne als eigene Eingabe zu gelten', s.text.includes('LENGTH = 75.0') && !s.dirty && !s.conflict);
  await idle();

  // 7) Konflikt: ungespeicherte Eingabe, und der Agent ändert dieselbe Datei. Nichts wird überschrieben.
  await replace('LENGTH = 75.0', 'LENGTH = 76.0');
  fs.writeFileSync(modelPy, disk().replace('LENGTH = 75.0', 'LENGTH = 77.0'));
  await waitFor('Konflikt', () => window.__t.editor.state().conflict === 'changed', 10000).catch(() => {});
  s = await ed();
  check('Gleichzeitige Änderung: Hinweis im Editor, die Platte bleibt beim Agenten', s.conflict === 'changed' && disk().includes('LENGTH = 77.0') && s.text.includes('LENGTH = 76.0')
    && await ev(() => !document.getElementById('code-banner').hidden && !!document.querySelector('#code-tabs .dirty.warn')));
  await ctrlS();
  await sleep(300);
  check('Strg+S bei Konflikt: nichts geschrieben, Meldung', disk().includes('LENGTH = 77.0') && (await ev(() => window.__t.toast())).text.includes('Nicht alles ließ sich speichern'));
  await shot('9-editor-konflikt');
  await idle();
  const b1 = await builds();
  await ev(() => window.__t.editor.keepMine());
  await until('eigene Fassung auf der Platte', () => disk().includes('LENGTH = 76.0'));
  await waitFor('Build mit 76', () => window.__t.status().state === 'ok' && (window.__t.partSize('Body') || [0])[0] === 76, 60000).catch(() => {});
  check('„Meine Fassung behalten": gespeichert und gebaut, die Fassung von außen liegt in der Sicherung',
    disk().includes('LENGTH = 76.0') && await body() === 76 && await builds() > b1 && backups().some((b) => b.includes('LENGTH = 77.0')) && !(await ed()).conflict);
  await replace('LENGTH = 76.0', 'LENGTH = 78.0');
  fs.writeFileSync(modelPy, disk().replace('LENGTH = 76.0', 'LENGTH = 79.0'));
  await waitFor('zweiter Konflikt', () => window.__t.editor.state().conflict === 'changed', 10000).catch(() => {});
  await ev(() => window.__t.editor.takeTheirs());
  s = await ed();
  check('„Fassung von außen laden": Editor zeigt sie, die eigene Eingabe liegt in der Sicherung',
    s.text.includes('LENGTH = 79.0') && !s.dirty && !s.conflict && disk().includes('LENGTH = 79.0') && backups().some((b) => b.includes('LENGTH = 78.0')));
  await idle();

  // 8) Dateien der App: nur lesen, mit Begründung
  await open('AGENTS.md');
  s = await ed();
  check('AGENTS.md: nur lesen, mit Begründung und Verweis auf NOTES.md', s.readOnly && /NOTES\.md/.test(s.locked ?? '') && await ev(() => document.getElementById('code-info').textContent.startsWith('Nur lesen')));
  check('Eingaben in AGENTS.md werden nicht angenommen', !(await replace('Instructions', 'Anweisungen')) && !(await ed()).dirty);

  // 9) Notizen (Markdown): speichern ja, bauen nein. Dazu Zeilenenden: Eine Datei mit CRLF behält sie.
  const notes = path.join(proj.dir, 'NOTES.md');
  fs.writeFileSync(notes, '# Notizen\r\n\r\nWunsch: Deckel\r\n');
  await open('NOTES.md');
  await waitFor('NOTES.md geladen', () => window.__t.editor.state().text.includes('Wunsch: Deckel'), 10000).catch(() => {});
  await idle();
  const b2 = await builds();
  await replace('Wunsch: Deckel', 'Wunsch: Deckel mit Lippe');
  check('Nur Markdown ungespeichert: Der Knopf heißt „Speichern", nicht „Speichern und bauen"', await ev(() => document.getElementById('btn-code-save')?.textContent === 'Speichern'));
  await ctrlS();
  await until('NOTES.md geschrieben', () => fs.readFileSync(notes, 'utf8').includes('Lippe'));
  await sleep(2000);
  check('Strg+S in NOTES.md: gespeichert, aber nicht gebaut', !(await ed()).dirty && await builds() === b2, `${await builds() - b2} Builds`);
  check('Datei mit CRLF: Zeilenenden bleiben erhalten', fs.readFileSync(notes, 'utf8') === '# Notizen\r\n\r\nWunsch: Deckel mit Lippe\r\n', JSON.stringify(fs.readFileSync(notes, 'utf8')).slice(0, 60));

  // 9b) Markdown als Dokument (E51): Ansicht zuerst, Aufgaben abhaken, Doppelklick führt in den Editor, kein HTML aus der Datei
  fs.mkdirSync(path.join(proj.dir, 'docs'), { recursive: true });
  const mdFile = path.join(proj.dir, 'docs', 'plan.md');
  fs.writeFileSync(mdFile, '# Plan\n\nText mit **fett** und `code`.\n\n- [ ] Deckel\n- [x] Boden\n\n| Teil | Maß |\n|---|--:|\n| Deckel | 80 |\n\n'
    + '<img src=x onerror="window.__xss=1">\n\nSiehe [Notizen](../NOTES.md) und [Web](https://example.com).\n\n## Ende\n');
  await open('docs/plan.md');
  await waitFor('Ansicht', () => window.__t.editor.state().preview, 10000).catch(() => {});
  s = await ed();
  const md = await ev(() => ({
    mode: document.getElementById('code-mode').hidden ? null : document.querySelector('#code-mode [aria-checked=true]').dataset.mode,
    cm: getComputedStyle(document.querySelector('#code-view .cm-editor')).display, imgs: document.querySelectorAll('.mdview img').length,
    html: document.querySelector('.mdview pre.md-html')?.textContent ?? '', th: document.querySelector('.mdview th:last-child')?.style.textAlign,
  }));
  await sleep(300);
  check('Markdown öffnet als Dokument: Überschrift, Liste mit Kästchen, Tabelle, Umschalter auf „Ansicht"', s.preview && md.mode === 'view' && md.cm === 'none'
    && s.rendered.includes('h1:Plan') && s.rendered.includes('li:Deckel') && s.rendered.some((x) => x.startsWith('div:Teil')) && md.th === 'right', s.rendered.join(' | ').slice(0, 120));
  check('HTML aus der Datei wird gezeigt, nicht ausgeführt', md.imgs === 0 && md.html.includes('onerror') && !(await ev(() => window.__xss)));
  await ev(() => { const b = document.querySelector('.mdview li.md-task input'); b.checked = true; b.dispatchEvent(new Event('change', { bubbles: true })); });
  s = await ed();
  check('Kästchen abhaken ändert den Text (ungespeichert), die Ansicht bleibt', s.dirty && s.text.includes('- [x] Deckel') && s.preview && !fs.readFileSync(mdFile, 'utf8').includes('[x] Deckel'));
  await ev(() => document.querySelector('.mdview .md').dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true })));
  await until('plan.md geschrieben', () => fs.readFileSync(mdFile, 'utf8').includes('- [x] Deckel'));
  check('Strg+S in der Ansicht speichert', !(await ed()).dirty && fs.readFileSync(mdFile, 'utf8').includes('- [x] Deckel'));
  await ev(() => { const p = [...document.querySelectorAll('.mdview h2')].pop(); p.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
  await sleep(200);
  const cur = await ev(() => { const st = document.querySelector('#code-view .cm-editor'); return { shown: getComputedStyle(st).display !== 'none', mode: document.querySelector('#code-mode [aria-checked=true]').dataset.mode }; });
  s = await ed();
  const endLine = s.text.split('\n').indexOf('## Ende') + 1;
  check('Doppelklick auf „## Ende": Editor an dieser Stelle, Umschalter auf „Bearbeiten"', cur.shown && cur.mode === 'edit' && !s.preview && endLine > 1 && s.line === endLine,
    `${JSON.stringify(cur)} Zeile ${s.line} statt ${endLine}`);
  await replace('## Ende', '## Schluss');
  await ev(() => document.querySelector('#code-mode [data-mode=view]').click());
  s = await ed();
  check('Zurück zur Ansicht: zeigt die ungespeicherte Eingabe', s.preview && s.rendered.includes('h2:Schluss') && s.dirty);
  await ctrlS();
  await until('plan.md wieder geschrieben', () => fs.readFileSync(mdFile, 'utf8').includes('## Schluss'));
  await shot('9b-markdown-ansicht');
  await ev(() => [...document.querySelectorAll('.mdview .md-link')].find((a) => a.textContent === 'Notizen').click());
  await waitFor('NOTES.md über Link', () => window.__t.editor.state().file === 'NOTES.md', 10000).catch(() => {});
  check('Link auf ../NOTES.md öffnet die Datei im Code-Panel', (await ed()).file === 'NOTES.md');
  await open('AGENTS.md');
  s = await ed();
  check('AGENTS.md (nur lesen) als Dokument: Kästchen wären gesperrt, Ansicht da', s.preview && s.rendered.length > 3 && await ev(() => [...document.querySelectorAll('.mdview li.md-task input')].every((b) => b.disabled)));

  // 10) Build-Fehler: „Code öffnen" markiert die Zeile rot
  await open('model.py');
  await replace('LENGTH = 79.0', 'LENGTH = 79.0 +');
  await ctrlS();
  await waitFor('Fehler', () => window.__t.status().state === 'error', 60000).catch(() => {});
  await domClick('btn-err-code');
  await waitFor('Fehlerzeile', () => window.__t.editor.state().marked.some((m) => m.startsWith('er:')), 10000).catch(() => {});
  s = await ed();
  check('Fehlerkarte „Code öffnen": Fehlerzeile im Editor rot markiert', s.marked.some((m) => m.startsWith('er:') && m.includes('LENGTH = 79.0 +')), s.marked.join(' | ').slice(0, 60));
  await shot('10-editor-fehler');
  await replace('LENGTH = 79.0 +', 'LENGTH = 79.0');
  await ctrlS();
  await waitFor('wieder gebaut', () => window.__t.status().state === 'ok', 60000).catch(() => {});

  // 11) „Speichern" oben: speichert auch die Eingaben im Editor, dann Snapshot und ZIP
  await replace('LENGTH = 79.0', 'LENGTH = 81.0');
  const zipPath = path.join(ud, 'Editortest.zip');
  await app.answers([zipPath]);
  await domClick('btn-save');
  await waitFor('gespeichert', () => !!window.__t.saveState()?.zipPath && !window.__t.saveState().unsaved, 60000).catch(() => {});
  const inHead = (await exec(['show', 'HEAD:model.py'], proj.dir)).stdout;
  check('„Speichern" oben: Eingabe aus dem Editor ist im Snapshot und in der ZIP', inHead.includes('LENGTH = 81.0') && fs.existsSync(zipPath) && !(await ed()).dirty);
  await replace('LENGTH = 81.0', 'LENGTH = 82.0');
  check('Ungespeicherte Eingabe im Editor: Speicherstand oben zeigt „Nicht gespeichert"', await ev(() => document.getElementById('save-badge').textContent.startsWith('Nicht gespeichert')),
    await ev(() => document.getElementById('save-badge').textContent));

  // 12) Modellwechsel mit ungespeicherter Eingabe: Rückfrage (Abbrechen, dann Speichern)
  await app.answers([2]);
  await domClick('btn-new');
  await sleep(1500);
  check('Neues Modell, Rückfrage „Abbrechen": Modell bleibt, Eingabe bleibt ungespeichert', (await ev(() => window.__t.project())).id === proj.id && (await ed()).dirty && disk().includes('LENGTH = 81.0'));
  await app.answers([0]);
  await domClick('btn-new');
  await waitFor('neues Modell', (old) => window.__t.project().id !== old && window.__t.status().state === 'ok' && window.__t.partCount() === 2, 90000, proj.id).catch(() => {});
  const p2 = await ev(() => window.__t.project());
  const model2 = path.join(p2.dir, 'model.py');
  check('Rückfrage „Speichern": Eingabe steht im alten Modell, das neue ist unberührt', p2.id !== proj.id && disk().includes('LENGTH = 82.0') && fs.readFileSync(model2, 'utf8').includes('LENGTH = 60.0'));
  check('Nach dem Wechsel ist der Editor leer', (await ed()).files.length === 0);

  // 13) Reiter mit ungespeicherter Eingabe schließen: „Verwerfen" legt sie als Sicherung ab
  await open('model.py');
  await replace('LENGTH = 60.0', 'LENGTH = 65.0');
  await app.answers([1]);
  await ev(() => document.querySelector('#code-tabs .ctab.on .x').click());
  await waitFor('Reiter zu', () => window.__t.editor.state().files.length === 0, 10000).catch(() => {});
  const bdir2 = path.join(ud, 'workspace-backups', `${p2.id}-editor`);
  const back2 = fs.existsSync(bdir2) ? fs.readdirSync(bdir2).map((f) => fs.readFileSync(path.join(bdir2, f), 'utf8')) : [];
  check('Reiter schließen, „Verwerfen": Datei unverändert, Eingabe in der Sicherung', fs.readFileSync(model2, 'utf8').includes('LENGTH = 60.0') && back2.some((b) => b.includes('LENGTH = 65.0')));

  // 14) Späte Schreibanfrage für ein schon gewechseltes Modell: nicht ins neue schreiben, sondern sichern
  const late = await ev((id) => window.soma.fs.writeText(id, 'model.py', 'X = 1\n', null, true), proj.id);
  check('Späte Eingabe für das alte Modell: nicht ins neue geschrieben, sondern gesichert', !late.ok && /Sicherung/.test(late.error ?? '') && fs.readFileSync(model2, 'utf8').includes('LENGTH = 60.0')
    && backups().includes('X = 1\n'), (late.error ?? '').slice(0, 60));

  const relevant = page.errors.filter((e) => !/favicon/i.test(e));
  check('Keine Konsolenfehler im Renderer', relevant.length === 0, relevant.slice(0, 2).join(' | ').slice(0, 100));
} catch (e) {
  console.log('ABBRUCH:', e.message);
  t.fail();
}
if (app) { await app.stop(); cleanup(app.ud); }
console.log(t.fails ? `\n${t.fails} Prüfung(en) fehlgeschlagen` : '\nALLE PRÜFUNGEN BESTANDEN');
process.exit(t.fails ? 1 : 0);
