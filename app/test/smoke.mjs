// Smoke-Test der echten Electron-App: Projekt, Viewer, Terminal, Auto-Build, Fehlerfall, Projektwechsel.
// Aufruf: npm run test:smoke (baut vorher). SMOKE_VISIBLE=1 zeigt das Fenster und macht einen Screenshot.
import fs from 'node:fs';
import path from 'node:path';
import { APP, checker, cleanup, sleep, startApp } from './harness.mjs';

const t = checker();
const { check } = t;
let app;

try {
  app = await startApp({ name: 'smoke' });
  const { ev, waitFor, domClick, ud, page } = app;
  const status = () => ev(() => window.__t.status());
  check('App gestartet, Fenster verbunden', true);

  // 1) Start: Projekt angelegt, automatischer erster Build, Bauteile im Viewer
  await waitFor('window.__t', () => !!window.__t && !!window.__t.project());
  await waitFor('Build ok', () => window.__t.status().state === 'ok' && window.__t.partCount() === 2);
  const proj = await ev(() => window.__t.project());
  check('Projekt liegt unter <App-Daten>/workspaces/<uuid>', proj.dir.startsWith(path.join(ud, 'workspaces')) && /[0-9a-f-]{36}$/.test(proj.dir), proj.dir.slice(-45));
  check('Vorlagen-Dateien vorhanden (AGENTS.md, CLAUDE.md, NOTES.md, model.py …)',
    ['AGENTS.md', 'CLAUDE.md', 'NOTES.md', 'model.py', '.gitignore', '.cadide/project.json', '.git/HEAD'].every((f) => fs.existsSync(path.join(proj.dir, f))));
  check('Erster Build automatisch, 2 Bauteile im Baum', JSON.stringify(await ev(() => window.__t.treeNames())) === '["Body","Lid"]');
  check('Nach dem Build kein Fehlerhinweis', (await status()).viewerMsg === '', (await status()).text);

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
  check('Klick auf Deckel-Oberseite: Bauteil, Fläche, Codezeile', info.includes(`Fläche f${lidFace.face}`) && info.includes('model.py:'), info.replace(/\s+/g, ' ').slice(0, 60));
  check('Codezeile mit add_part("Lid") ist markiert', hl.some((l) => l.includes('add_part("Lid"')), String(hl[0]).trim().slice(0, 40));

  // 3) Terminal: echte Shell im Projektordner, cadide im PATH
  const tid = await ev(() => window.__t.terminals.activeId);
  check('Ein Terminal wurde automatisch geöffnet', await ev(() => window.__t.terminals.count) === 1);
  await ev((id) => window.cadide.term.write(id, 'cadide --version\r'), tid);
  const gotVersion = await waitFor('cadide --version im Terminal', (id) => /^cadide \d/m.test(window.__t.termText(id)), 20000, tid).catch(() => false);
  check('Im Terminal läuft `cadide` (PATH der Basisumgebung)', !!gotVersion);
  await ev((id) => window.cadide.term.write(id, 'Get-Location\r'), tid);
  await waitFor('Get-Location', (id) => window.__t.termText(id).includes('workspaces'), 20000, tid).catch(() => {});
  check('Terminal startet im Projektordner', (await ev((id) => window.__t.termText(id), tid)).includes('workspaces'));

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
  check('Syntaxfehler: Status Fehler mit Datei und Zeile', /model\.py:\d+/.test(err.detail), err.detail.slice(0, 70));
  check('Fehlermeldung im Viewer, letzter guter Stand (3 Bauteile) bleibt', err.viewerMsg.includes('Build-Fehler') && await ev(() => window.__t.partCount()) === 3);
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
  check('Knopf „Bauen" baut trotzdem (3 Bauteile)', true);
  fs.writeFileSync(modelPy, original);
  await domClick('chk-auto');

  // 8) Neues Projekt: anderer Ordner, Terminals des alten sind zu, frischer erster Build
  await domClick('btn-new');
  await waitFor('neues Projekt', (oldId) => window.__t.project().id !== oldId && window.__t.status().state === 'ok' && window.__t.partCount() === 2, 90000, proj.id).catch(() => {});
  const p2 = await ev(() => window.__t.project());
  check('„Neu" legt ein zweites Projekt mit eigener UUID an', p2.id !== proj.id, p2.id.slice(0, 8));
  await sleep(600);
  check('Projektwechsel: genau ein frisches Terminal', await ev(() => window.__t.terminals.count) === 1);
  check('Beide Arbeitsordner existieren getrennt', fs.existsSync(proj.dir) && fs.existsSync(p2.dir) && proj.dir !== p2.dir);

  if (app.visible) { await sleep(500); await page.screenshot(path.join(APP, 'test', 'smoke.png')); }
  const relevant = page.errors.filter((e) => !/favicon/i.test(e));
  check('Keine Konsolenfehler im Renderer', relevant.length === 0, relevant.slice(0, 2).join(' | ').slice(0, 100));
} catch (e) {
  console.log('ABBRUCH:', e.message);
  t.fail();
}
if (app) { await app.stop(); cleanup(app.ud); }
console.log(t.fails ? `\n${t.fails} Prüfung(en) fehlgeschlagen` : '\nALLE PRÜFUNGEN BESTANDEN');
process.exit(t.fails ? 1 : 0);
