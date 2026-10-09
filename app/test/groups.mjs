// Test für Gruppen und Transparenz: Gruppen aus add_part(group=…) und aus einer importierten STEP-Baugruppe, Strukturbaum im
// Viewer (E82) mit Baumstrichen, Referenzen als zugeklappte Gruppe am Ende, Aus-/Einblenden und Transparenz je Teil und Gruppe,
// „hidden“ im Kopf und im Fuß, Suche, F3, Klick durch ein transparentes Teil, Gruppen in der Ausgabe-STEP. Aufruf: npm run test:groups (baut vorher). SMOKE_VISIBLE=offscreen SMOKE_SHOTS=1 legt Bilder ab.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { APP, checker, cleanup, sleep, startApp } from './harness.mjs';

const t = checker();
const { check } = t;
let app;

// Dasselbe Python wie die App (paths.ts): SOMA_PYTHON oder die Entwicklungsumgebung aus Phase 0
const PY = process.env.SOMA_PYTHON || path.join(process.env.LOCALAPPDATA ?? '', 'cadide-phase0', 'venv-full', 'Scripts', 'python.exe');
const py = (code) => spawnSync(PY, ['-c', code], { encoding: 'utf8' });

// Fremde Baugruppe wie von einem Hersteller: Platine mit Unterbaugruppe „Stecker“
const MAKE_STEP = (file) => `
import cadquery as cq
sub = cq.Assembly(name="Stecker")
sub.add(cq.Workplane().box(8, 6, 3).translate((20, 0, 2.3)), name="USB_C", color=cq.Color(0.7, 0.7, 0.7))
sub.add(cq.Workplane().box(2.5, 10, 2.5).translate((-20, 0, 2)), name="Pinleiste", color=cq.Color(0.1, 0.1, 0.1))
asm = cq.Assembly(name="Platine")
asm.add(cq.Workplane().box(50, 30, 1.6), name="Leiterplatte", color=cq.Color(0.1, 0.5, 0.2))
asm.add(sub, name="Stecker")
asm.export(${JSON.stringify(file)})
`;
const MODEL = `import cadquery as cq
from soma import add_part, import_assembly

add_part("Boden", cq.Workplane().box(60, 40, 3), group="Gehäuse")
add_part("Deckel", cq.Workplane().box(60, 40, 2).translate((0, 0, 20)), group="Gehäuse")
add_part("Schraube", cq.Workplane().cylinder(10, 1.5).translate((25, 15, 10)), group="Gehäuse/Schrauben")

platine = import_assembly("inputs/platine.step")
platine.loc = cq.Location((0, 0, 8))
add_part("Platine", platine, role="reference")
`;

try {
  app = await startApp({ name: 'groups' });
  const { ev, waitFor, page } = app;
  const shot = async (name) => {
    if (!process.env.SMOKE_SHOTS) return;
    fs.mkdirSync(path.join(APP, 'test', 'shots'), { recursive: true });
    await sleep(900);
    await app.screenshot(path.join(APP, 'test', 'shots', `${name}.png`)).catch((e) => console.log('Screenshot:', e.message));
  };
  await waitFor('Projekt und Build', () => !!window.__t && !!window.__t.project() && window.__t.status().state === 'ok' && window.__t.partCount() === 2);
  const proj = await ev(() => window.__t.project());
  fs.mkdirSync(path.join(proj.dir, 'inputs'), { recursive: true });
  const made = py(MAKE_STEP(path.join(proj.dir, 'inputs', 'platine.step')));
  check('Test-STEP mit Unterbaugruppe angelegt', made.status === 0 && fs.existsSync(path.join(proj.dir, 'inputs', 'platine.step')), made.stderr.slice(-200));
  fs.writeFileSync(path.join(proj.dir, 'model.py'), MODEL);
  await waitFor('Modell mit Gruppen gebaut', () => window.__t.status().state === 'ok' && window.__t.partCount() === 6, 90000).catch(() => {});
  const status = await ev(() => window.__t.status());
  check('Build mit Gruppen und importierter Baugruppe: 6 Bauteile', (await ev(() => window.__t.partCount())) === 6, `${status.text} ${status.detail} ${status.viewerMsg ?? ''}`.slice(0, 90));

  // 1) Strukturbaum im Viewer (E82): beginnt eingeklappt mit dem Namen des Modells, F3 klappt ihn auf
  let tr = await ev(() => window.__t.tree());
  check('Baum beginnt eingeklappt: nur der Name des Modells, keine Zeilen', !tr.open && tr.rows.length === 0 && tr.head === proj.name, JSON.stringify(tr.head));
  await ev(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'F3', bubbles: true })));
  tr = await ev(() => window.__t.tree());
  check('F3 klappt den Baum auf', tr.open && tr.rows.length > 0);
  const rows = async () => (await ev(() => window.__t.tree())).rows.map((x) => ({ kind: x.group ? 'group' : 'part', name: x.name, depth: x.depth }));
  const outlineOf = (r) => r.map((x) => `${x.kind === 'group' ? '+' : '-'}${x.name}@${x.depth}`).join(' ');
  let r = await rows();
  check('Aufgeklappt zeigt der Baum nur die oberste Ebene: Gehäuse und References, zugeklappt', outlineOf(r) === '+Gehäuse@0 +References@0', outlineOf(r));
  const groupRow = (name) => `[...document.querySelectorAll('#tree .tr-row.gr')].find((r) => r.querySelector('.nm').textContent === ${JSON.stringify(name)})`;
  const partRow = (name) => `[...document.querySelectorAll('#tree .tr-row:not(.gr)')].find((r) => r.querySelector('.nm')?.textContent === ${JSON.stringify(name)})`;
  await ev(`(${groupRow('Gehäuse')}).querySelector('.chev').click()`);
  r = await rows();
  check('Gehäuse aufgeklappt: eine Ebene, Schrauben bleibt zu', outlineOf(r) === '+Gehäuse@0 -Boden@1 -Deckel@1 +Schrauben@1 +References@0', outlineOf(r));
  for (const g of ['Schrauben', 'References', 'Platine', 'Stecker']) await ev(`(${groupRow(g)}).querySelector('.chev').click()`);
  r = await rows();
  const outline = outlineOf(r);
  check('References aufgeklappt: Platine › Leiterplatte, Stecker › USB_C, Pinleiste',
    outline === '+Gehäuse@0 -Boden@1 -Deckel@1 +Schrauben@1 -Schraube@2 +References@0 +Platine@1 -Leiterplatte@2 +Stecker@2 -USB_C@3 -Pinleiste@3', outline);
  const branches = await ev(() => [...document.querySelectorAll('#tree .tr-row')].map((row) => [...row.querySelectorAll('.br i')].map((i) => i.className || '_').join('')));
  check('Baumstriche: Abzweig, letzter Abzweig, weiterlaufend, bei Teilen bis an die Knöpfe', branches[1] === 'vth' && branches[3] === 'vl' && branches[4] === 'v_lh' && branches[5] === 'l' && branches[10] === '___lh', branches.join(' '));
  const parts = await ev(() => Object.fromEntries(window.__t.parts().map((p) => [p.name, p])));
  const green = parts.Leiterplatte?.color ?? '#000';
  const [cr, cg, cb] = [1, 3, 5].map((i) => parseInt(green.slice(i, i + 2), 16));
  check('Namen und Farben kommen aus der STEP-Datei (Leiterplatte grün, Stecker in Gruppe „Platine/Stecker")', cg > cr && cg > cb && parts.USB_C?.group === 'Platine/Stecker', `${green} ${parts.USB_C?.group}`);
  await shot('15-gruppen');

  const clickIn = (rowExpr, sel) => ev(`(${rowExpr}).querySelector(${JSON.stringify(sel)}).click()`);
  const ids = (names) => names.map((n) => parts[n].id);
  const visible = (names) => ev((l) => l.map((id) => window.__t.viewer.isVisible(id)), ids(names));
  const ghosted = (names) => ev((l) => l.map((id) => window.__t.viewer.isGhosted(id)), ids(names));

  // 2) Gruppe aus- und einblenden
  await clickIn(groupRow('Gehäuse'), '.eye');
  tr = await ev(() => window.__t.tree());
  check('Auge der Gruppe „Gehäuse" blendet alle drei Teile aus, auch in der Untergruppe', (await visible(['Boden', 'Deckel', 'Schraube'])).every((v) => !v) && (await visible(['Leiterplatte']))[0]);
  check('Ausgeblendet: Namen grau, Fuß „3 hidden“ mit Show all', tr.rows.filter((x) => x.hidden).map((x) => x.name).join() === 'Gehäuse,Boden,Deckel,Schrauben,Schraube'
    && tr.foot === '3 hiddenShow all', JSON.stringify(tr.foot));
  await ev(() => window.__t.treeOpen(false));
  tr = await ev(() => window.__t.tree());
  check('Eingeklappt: „· 3 hidden“ neben dem Namen', tr.head === `${proj.name}· 3 hidden`, tr.head);
  await shot('15a-baum-zu');
  await ev(() => window.__t.treeOpen(true));
  await ev(() => document.querySelector('#tree .tr-ft button').click());
  check('Show all im Fuß: alle wieder da, Fuß weg', (await visible(['Boden', 'Deckel', 'Schraube'])).every(Boolean) && (await ev(() => window.__t.tree())).foot === '');

  // 3) Zuklappen
  await clickIn(groupRow('Gehäuse'), '.nm');
  r = await rows();
  check('Gruppe zuklappen: ihre Teile verschwinden aus dem Baum, sichtbar bleiben sie im Modell', !r.some((x) => ['Boden', 'Deckel', 'Schraube', 'Schrauben'].includes(x.name)) && (await visible(['Boden']))[0]);
  await clickIn(groupRow('Gehäuse'), '.nm');

  // 4) Transparenz: Von oben liegt der Deckel über der Platine. Deckend trifft der Klick den Deckel, transparent die Platine.
  await ev(() => window.__t.viewer.setView('top'));
  await sleep(200);
  const center = await ev(() => window.__t.viewer.screenAt([0, 0, 8.8]));
  await page.click(center.x, center.y);
  await waitFor('Auswahl', () => window.__t.info() !== '', 5000).catch(() => {});
  check('Deckend: Klick von oben trifft den Deckel', (await ev(() => window.__t.info())).startsWith('Deckel'), (await ev(() => window.__t.info())).slice(0, 30));
  await clickIn(partRow('Deckel'), '.gh');
  const look = await ev((id) => window.__t.viewer.partLook(id), parts.Deckel.id);
  check('Deckel transparent schalten: durchsichtig, verdeckt nichts mehr', (await ghosted(['Deckel']))[0] && look.opacity < 0.3 && !look.depthWrite
    && await ev(`(${partRow('Deckel')}).querySelector('.gh').getAttribute('aria-pressed') === 'true'`), JSON.stringify(look));
  await page.click(center.x, center.y);
  await waitFor('Auswahl Platine', () => window.__t.info().startsWith('Leiterplatte'), 5000).catch(() => {});
  tr = await ev(() => window.__t.tree());
  check('Klick ins Modell markiert das Teil im Baum', tr.rows.find((x) => x.name === 'Leiterplatte')?.sel && tr.rows.filter((x) => x.sel).length === 1, JSON.stringify(tr.rows.filter((x) => x.sel)));
  await ev(`(${groupRow('Platine')}).querySelector('.chev').click()`);
  tr = await ev(() => window.__t.tree());
  check('Gruppe zugeklappt: Die Gruppe trägt die Markierung', tr.rows.find((x) => x.name === 'Platine')?.sel && tr.rows.filter((x) => x.sel).length === 1, JSON.stringify(tr.rows.filter((x) => x.sel)));
  await ev(`(${groupRow('Platine')}).querySelector('.chev').click()`);
  check('Transparent: derselbe Klick geht durch den Deckel und trifft die Leiterplatte', (await ev(() => window.__t.info())).startsWith('Leiterplatte'), (await ev(() => window.__t.info())).slice(0, 30));
  check('Auswahltext für den Agenten nennt die Gruppe', /part "Leiterplatte" in group "Platine"/.test(await ev(() => window.__t.selectionText())), (await ev(() => window.__t.selectionText())).slice(0, 70));
  await clickIn(groupRow('Stecker'), '.gh');
  check('Transparenz der Gruppe „Stecker": beide Teile, die Gruppe darüber zeigt „teilweise"', (await ghosted(['USB_C', 'Pinleiste'])).every(Boolean) && !(await ghosted(['Leiterplatte']))[0]
    && await ev(`(${groupRow('Platine')}).querySelector('.gh').classList.contains('partly')`));
  await shot('16-gruppen-transparent');
  await clickIn(partRow('Deckel'), '.gh');
  check('Transparenz wieder aus: Deckel deckend', !(await ghosted(['Deckel']))[0] && (await ev((id) => window.__t.viewer.partLook(id), parts.Deckel.id)).depthWrite);

  // 5) Rechtsklick auf eine Gruppe: Isolieren
  await ev(`(${groupRow('Gehäuse')}).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 60, clientY: 90 }))`);
  const menu = await ev(() => [...document.querySelectorAll('#menu-ctx .mi span:nth-child(2)')].map((x) => x.textContent));
  await ev(() => [...document.querySelectorAll('#menu-ctx .mi')].find((b) => b.textContent.includes('Isolate')).click());
  check('Rechtsklick auf eine Gruppe: „Isolate“ zeigt nur ihre Teile', menu.includes('Isolate') && menu.includes('Transparent')
    && (await visible(['Boden', 'Deckel', 'Schraube'])).every(Boolean) && (await visible(['Leiterplatte', 'USB_C'])).every((v) => !v), menu.join(', '));
  await ev(() => window.__t.viewer.showAll());

  // 6) Suche findet Teile samt ihren Gruppen
  await ev(() => { document.querySelector('#tree .tr-hd .hb').click(); const f = document.querySelector('#tree .tr-search input'); f.value = 'usb'; f.dispatchEvent(new Event('input')); });
  r = await rows();
  tr = await ev(() => window.__t.tree());
  check('Suche „usb": USB_C mit seinen Gruppen (auch zugeklappte gehen auf), „1 of 6“', r.map((x) => x.name).join(',') === 'References,Platine,Stecker,USB_C'
    && tr.hits === '1 of 6' && tr.searching, r.map((x) => x.name).join(',') + ' ' + tr.hits);
  await shot('16b-baum-suche');
  await ev(() => document.querySelector('#tree .tr-search .hb').click());
  check('Suche schließen: Kopf wieder da, alle Zeilen', !(await ev(() => window.__t.tree())).searching && (await rows()).length === 11);

  // 6b) Mehrfachauswahl im Baum (Strg, Shift), Tasten H, Shift H, I, T, Esc, Ziehen über die Augen, Rahmenauswahl mit Alt und
  // Rechtsklick ins Bild
  const nameClick = (name, mods = {}) => ev(`(${partRow(name)}).querySelector('.nm').dispatchEvent(new MouseEvent('click', { bubbles: true, ...${JSON.stringify(mods)} }))`);
  const key = (k, mods = {}) => ev(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true, ...${JSON.stringify(mods)} }))`);
  const pickedNames = () => ev(() => window.__t.picked());
  await nameClick('Boden');
  await nameClick('Schraube', { ctrlKey: true });
  tr = await ev(() => window.__t.tree());
  check('Strg+Klick im Baum: zwei Teile ausgewählt, beide markiert, Karte „2 parts selected“', JSON.stringify(await pickedNames()) === '["Boden","Schraube"]'
    && tr.rows.filter((x) => x.sel).map((x) => x.name).join() === 'Boden,Schraube' && (await ev(() => window.__t.info())).startsWith('2 parts selected'), JSON.stringify(await pickedNames()));
  await nameClick('Boden');
  await nameClick('Leiterplatte', { shiftKey: true });
  check('Shift+Klick: Bereich vom letzten Klick bis hier, über Gruppen hinweg', JSON.stringify(await pickedNames()) === '["Boden","Deckel","Schraube","Leiterplatte"]', JSON.stringify(await pickedNames()));
  await key('h');
  check('H blendet die Auswahl aus und hebt sie auf', (await visible(['Boden', 'Deckel', 'Schraube', 'Leiterplatte'])).every((v) => !v) && (await visible(['USB_C']))[0]
    && (await pickedNames()).length === 0);
  await key('H', { shiftKey: true });
  check('Shift+H blendet alles wieder ein', (await visible(['Boden', 'Deckel', 'Schraube', 'Leiterplatte', 'USB_C', 'Pinleiste'])).every(Boolean));
  await nameClick('Boden');
  await nameClick('Deckel', { ctrlKey: true });
  await key('i');
  check('I isoliert die Auswahl', (await visible(['Boden', 'Deckel'])).every(Boolean) && (await visible(['Schraube', 'Leiterplatte', 'USB_C'])).every((v) => !v));
  await key('H', { shiftKey: true });
  await key('t');
  const ghostOn = await ghosted(['Boden', 'Deckel']);
  await key('t');
  check('T schaltet die Auswahl transparent und wieder deckend', ghostOn.every(Boolean) && (await ghosted(['Boden', 'Deckel'])).every((v) => !v), JSON.stringify(ghostOn));
  await key('Escape');
  check('Esc hebt die Auswahl auf', (await pickedNames()).length === 0 && !(await ev(() => window.__t.tree())).rows.some((x) => x.sel));
  // Mit gedrückter Maus über die Augen: Jede überfahrene Zeile wird wie die erste geschaltet, die Gruppe nicht
  await ev(`(${partRow('Boden')}).querySelector('.eye').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, buttons: 1 }))`);
  for (const n of ['Deckel', 'Schraube']) await ev(`(${partRow(n)}).querySelector('.eye').dispatchEvent(new PointerEvent('pointerover', { bubbles: true, buttons: 1 }))`);
  await ev(() => window.dispatchEvent(new PointerEvent('pointerup', { button: 0 })));
  await ev(`(${partRow('Leiterplatte')}).querySelector('.eye').dispatchEvent(new PointerEvent('pointerover', { bubbles: true, buttons: 0 }))`);
  check('Über die Augen ziehen: Boden, Deckel und Schraube aus, Leiterplatte (nach dem Loslassen) nicht', (await visible(['Boden', 'Deckel', 'Schraube'])).every((v) => !v)
    && (await visible(['Leiterplatte']))[0], JSON.stringify(await visible(['Boden', 'Deckel', 'Schraube', 'Leiterplatte'])));
  await key('H', { shiftKey: true });
  // Rahmenauswahl: Alt + links ziehen über das ganze Modell (von links nach rechts: ganz darin), die Kamera bleibt stehen
  await ev(() => window.__t.viewer.setView('top'));
  await sleep(200);
  const a = await ev(() => window.__t.viewer.screenAt([-45, 32, 0]));
  const b = await ev(() => window.__t.viewer.screenAt([45, -32, 0]));
  const cam0 = JSON.stringify((await ev(() => window.__t.viewer.viewState())).dir);
  const drag = (from, to, mods) => ev(({ from, to, mods }) => {
    const c = document.querySelector('#viewer > canvas');
    const r = c.getBoundingClientRect();
    const at = (p, type, buttons) => c.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, buttons, pointerId: 1, clientX: r.left + p.x, clientY: r.top + p.y, altKey: true, ...mods }));
    at(from, 'pointerdown', 1);
    at({ x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }, 'pointermove', 1);
    at(to, 'pointermove', 1);
    at(to, 'pointerup', 0);
  }, { from, to, mods });
  await drag(a, b, {});
  check('Alt + ziehen von links nach rechts: alle sechs Teile im Rahmen ausgewählt, Kamera unverändert', (await pickedNames()).length === 6
    && JSON.stringify((await ev(() => window.__t.viewer.viewState())).dir) === cam0, JSON.stringify(await pickedNames()));
  const mid = await ev(() => window.__t.viewer.screenAt([0, 0, 8.8]));
  await drag({ x: mid.x + 6, y: mid.y - 6 }, { x: mid.x - 6, y: mid.y + 6 }, {});
  const crossed = await pickedNames();
  check('Von rechts nach links, kleiner Rahmen mitten auf dem Deckel: angeschnittene Teile zählen (Deckel)', crossed.includes('Deckel') && !crossed.includes('USB_C'), JSON.stringify(crossed));
  await drag(a, b, {});
  // Rechtsklick ins Bild auf ein ausgewähltes Teil: Menü für die ganze Auswahl
  await ev((p) => {
    const c = document.querySelector('#viewer > canvas');
    const r = c.getBoundingClientRect();
    for (const type of ['pointerdown', 'pointerup']) c.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 2, buttons: type === 'pointerdown' ? 2 : 0, pointerId: 1, clientX: r.left + p.x, clientY: r.top + p.y }));
  }, mid);
  const ctx = await ev(() => ({ open: !document.getElementById('menu-ctx').hidden, text: [...document.querySelectorAll('#menu-ctx .mh, #menu-ctx .mi')].map((x) => x.textContent) }));
  check('Rechtsklick ins Bild auf die Auswahl: Menü „6 parts selected“ mit Isolate, Hide und Tasten', ctx.open && ctx.text[0] === '6 parts selected'
    && ctx.text.some((x) => x.startsWith('Isolate 6 parts') && x.endsWith('I')) && ctx.text.some((x) => x.startsWith('Hide 6 parts') && x.endsWith('H')), JSON.stringify(ctx));
  await shot('16c-auswahl-menue');
  await key('Escape');
  await key('Escape');

  // 7) Ausgabe-STEP: Gruppen als Unterbaugruppen, Referenzen unter „Reference" (bis E73 „Referenz")
  const tree = py(`
import cadquery as cq
a = cq.Assembly.importStep(${JSON.stringify(path.join(proj.dir, 'output', 'model.step'))})
def walk(x, d=0):
    print("  " * d + x.name)
    for c in x.children: walk(c, d + 1)
walk(a)`);
  const lines = tree.stdout.split(/\r?\n/).filter(Boolean).slice(1).map((l) => l.replace(/\s+$/, ''));
  check('output/model.step: Gehaeuse › Schrauben › Schraube und Reference › Platine › Stecker › USB_C', lines.includes('  Gehaeuse') && lines.includes('    Schrauben') && lines.includes('      Schraube')
    && lines.includes('  Reference') && lines.includes('    Platine') && lines.includes('      Stecker') && lines.includes('        USB_C'), lines.join(' | ').slice(0, 120));

  const relevant = page.errors.filter((e) => !/favicon/i.test(e));
  check('Keine Konsolenfehler im Renderer', relevant.length === 0, relevant.slice(0, 2).join(' | ').slice(0, 100));
} catch (e) {
  console.log('ABBRUCH:', e.message);
  t.fail();
}
if (app) { await app.stop(); cleanup(app.ud); }
console.log(t.fails ? `\n${t.fails} Prüfung(en) fehlgeschlagen` : '\nALLE PRÜFUNGEN BESTANDEN');
process.exit(t.fails ? 1 : 0);
