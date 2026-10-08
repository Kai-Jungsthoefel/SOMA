// Test für Gruppen und Transparenz: Gruppen aus add_part(group=…) und aus einer importierten STEP-Baugruppe, Baum in der
// Bauteilkarte, Aus-/Einblenden und Transparenz je Teil und Gruppe, Klick durch ein transparentes Teil, Gruppen in der
// Ausgabe-STEP. Aufruf: npm run test:groups (baut vorher). SMOKE_VISIBLE=offscreen SMOKE_SHOTS=1 legt Bilder ab.
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

  // 1) Baum in der Bauteilkarte
  const rows = () => ev(() => [...document.querySelectorAll('#tab-model .row, #tab-model .grp')].map((r) => ({
    kind: r.classList.contains('grp') ? 'section' : r.classList.contains('gr') ? 'group' : 'part',
    name: (r.querySelector('.gname') ?? r.querySelector('.pname'))?.textContent ?? r.textContent, pad: parseInt(r.style.paddingLeft || '0', 10),
  })));
  let r = await rows();
  const outline = r.map((x) => `${x.kind === 'group' ? '+' : x.kind === 'section' ? '#' : '-'}${x.name}@${x.pad}`).join(' ');
  check('Baum: Gehäuse › Boden, Deckel, Schrauben › Schraube, dann REFERENCES › Platine › Leiterplatte, Stecker › USB_C, Pinleiste',
    outline === '+Gehäuse@4 -Boden@18 -Deckel@18 +Schrauben@18 -Schraube@32 #REFERENCES@0 +Platine@4 -Leiterplatte@18 +Stecker@18 -USB_C@32 -Pinleiste@32', outline);
  const parts = await ev(() => Object.fromEntries(window.__t.parts().map((p) => [p.name, p])));
  const green = parts.Leiterplatte?.color ?? '#000';
  const [cr, cg, cb] = [1, 3, 5].map((i) => parseInt(green.slice(i, i + 2), 16));
  check('Namen und Farben kommen aus der STEP-Datei (Leiterplatte grün, Stecker in Gruppe „Platine/Stecker")', cg > cr && cg > cb && parts.USB_C?.group === 'Platine/Stecker', `${green} ${parts.USB_C?.group}`);
  await shot('15-gruppen');

  const groupRow = (name) => `[...document.querySelectorAll('#tab-model .row.gr')].find((r) => r.querySelector('.gname').textContent === ${JSON.stringify(name)})`;
  const partRow = (name) => `[...document.querySelectorAll('#tab-model .row:not(.gr)')].find((r) => r.querySelector('.pname')?.textContent === ${JSON.stringify(name)})`;
  const clickIn = (rowExpr, sel) => ev(`(${rowExpr}).querySelector(${JSON.stringify(sel)}).click()`);
  const ids = (names) => names.map((n) => parts[n].id);
  const visible = (names) => ev((l) => l.map((id) => window.__t.viewer.isVisible(id)), ids(names));
  const ghosted = (names) => ev((l) => l.map((id) => window.__t.viewer.isGhosted(id)), ids(names));

  // 2) Gruppe aus- und einblenden
  await clickIn(groupRow('Gehäuse'), '.eye:not(.gh)');
  check('Auge der Gruppe „Gehäuse" blendet alle drei Teile aus, auch in der Untergruppe', (await visible(['Boden', 'Deckel', 'Schraube'])).every((v) => !v) && (await visible(['Leiterplatte']))[0]);
  await clickIn(groupRow('Gehäuse'), '.eye:not(.gh)');
  check('Noch einmal: alle wieder da', (await visible(['Boden', 'Deckel', 'Schraube'])).every(Boolean));

  // 3) Zuklappen
  await clickIn(groupRow('Gehäuse'), '.nm');
  r = await rows();
  check('Gruppe zuklappen: ihre Teile verschwinden aus der Liste, sichtbar bleiben sie im Modell', !r.some((x) => ['Boden', 'Deckel', 'Schraube', 'Schrauben'].includes(x.name)) && (await visible(['Boden']))[0]);
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
  await ev(() => { document.getElementById('btn-parts-search').click(); const f = document.getElementById('parts-filter'); f.value = 'usb'; f.dispatchEvent(new Event('input')); });
  r = await rows();
  check('Suche „usb": USB_C mit seinen Gruppen Platine und Stecker', r.filter((x) => x.kind !== 'section').map((x) => x.name).join(',') === 'Platine,Stecker,USB_C', r.map((x) => x.name).join(','));
  await ev(() => document.getElementById('btn-parts-search').click());

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
