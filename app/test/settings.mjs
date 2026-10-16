// Test der Einstellungen (E81): Reiter Viewer, Skills, Storage, About. Mausbelegungen nach CAD-Vorbildern, Zoomrichtung,
// orthografische Projektion (Bildgröße bleibt, Auswählen und Messen treffen, verdeckte Kanten bleiben verdeckt), Darstellung
// beim Öffnen eines Modells, Nachkommastellen beim Messen, Speicherplatz mit Leeren des Vorschau-Caches, Info mit Versionen
// und Komponenten, Kopieren der Systemangaben, Neustart mit gespeicherten Einstellungen, kaputte settings.json wird gemeldet
// und vor dem Überschreiben gesichert. Aufruf: npm run test:settings (baut vorher). SMOKE_VISIBLE=offscreen SMOKE_SHOTS=1
// legt Bilder in test/shots/ ab.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { APP, checker, cleanup, sleep, startApp } from './harness.mjs';

const t = checker();
const { check } = t;
let app;
let ud = null;
const VERSION = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8')).version;

// Bekannte Maße wie im Test des Messens: Platte 40 × 30 × 5 mit zwei Bohrungen, Block darüber
const MODEL = `import cadquery as cq
from soma import add_part

plate = (cq.Workplane("XY").box(40, 30, 5, centered=(True, True, False))
         .faces(">Z").workplane().pushPoints([(-10, 0), (10, 0)]).hole(6))
block = cq.Workplane("XY").box(20, 20, 5, centered=(True, True, False)).translate((45, 0, 15))

add_part("Platte", plate)
add_part("Block", block, color=(0.85, 0.55, 0.25))
`;

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
});

const near = (a, b, eps = 1e-6) => a.every((v, i) => Math.abs(v - b[i]) < eps);

try {
  app = await startApp({ name: 'settings' });
  ud = app.ud;
  let { ev, waitFor, domClick, page } = app;
  const shot = async (name) => {
    if (!process.env.SMOKE_SHOTS) return;
    fs.mkdirSync(path.join(APP, 'test', 'shots'), { recursive: true });
    await sleep(900);
    await app.screenshot(path.join(APP, 'test', 'shots', `${name}.png`)).catch((e) => console.log('Screenshot:', e.message));
  };
  await waitFor('Projekt und Build', () => !!window.__t && !!window.__t.project() && window.__t.status().state === 'ok' && window.__t.partCount() === 2);
  const proj = await ev(() => window.__t.project());
  fs.writeFileSync(path.join(proj.dir, 'model.py'), MODEL);
  await waitFor('Testmodell gebaut', () => window.__t.status().state === 'ok' && JSON.stringify(window.__t.treeNames()) === '["Platte","Block"]', 60000);
  await ev(() => window.__t.viewer.setView('iso'));
  const ids = await ev(() => Object.fromEntries(window.__t.parts().map((p) => [p.name, p.id])));
  const settingsFile = path.join(ud, 'settings.json');
  const fileSettings = () => { try { return JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch { return null; } };
  const vs = () => ev(() => window.__t.viewer.viewState());
  const pages = () => ev(() => window.__t.settingsPages());
  /** Wert im Reiter Viewer ändern wie mit der Maus und warten, bis er gilt. */
  const setSelect = (id, value) => ev(([i, v]) => { const s = document.getElementById(i); s.value = v; s.dispatchEvent(new Event('change')); }, [id, value]);
  const waitPref = (key, value) => waitFor(`Einstellung ${key} = ${value}`, ([k, v]) => window.__t.appSettings().settings.viewer[k] === v, 10000, [key, value]);
  /** Ziehen im Viewer mit einer Maustaste (0 links, 1 Mitte, 2 rechts), auf Wunsch mit Strg oder Umschalt. Rückgabe: Kamera danach. */
  const drag = (o) => ev((o) => {
    const c = window.__t.viewer.renderer.domElement, r = c.getBoundingClientRect();
    const x0 = r.left + r.width / 2, y0 = r.top + r.height / 2;
    const init = (x, y) => ({ clientX: x, clientY: y, bubbles: true, cancelable: true, button: o.button, buttons: [1, 4, 2][o.button], ctrlKey: !!o.ctrl, shiftKey: !!o.shift,
      pointerId: 1, isPrimary: true, pointerType: 'mouse' });
    c.dispatchEvent(new PointerEvent('pointerdown', init(x0, y0)));
    for (let i = 1; i <= 4; i++) c.dispatchEvent(new PointerEvent('pointermove', init(x0 + (o.dx ?? 0) * i / 4, y0 + (o.dy ?? 0) * i / 4)));
    c.dispatchEvent(new PointerEvent('pointerup', init(x0 + (o.dx ?? 0), y0 + (o.dy ?? 0))));
    return window.__t.viewer.viewState();
  }, o);
  const wheel = (deltaY) => ev((d) => {
    const c = window.__t.viewer.renderer.domElement, r = c.getBoundingClientRect();
    c.dispatchEvent(new WheelEvent('wheel', { deltaY: d, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true }));
    return window.__t.viewer.viewState();
  }, deltaY);
  /** Was eine Bewegung bewirkt hat: gedreht (Richtung), verschoben (Drehpunkt), gezoomt (Abstand) oder nichts. */
  const effect = (a, b) => {
    const rot = !near(a.dir, b.dir, 1e-4), pan = !near(a.target, b.target, 1e-4), zoom = Math.abs(a.dist - b.dist) > a.dist * 1e-4;
    return rot ? 'rotate' : zoom ? 'zoom' : pan ? 'pan' : 'none';
  };
  const reset = async () => { await ev(() => window.__t.viewer.setView('iso')); return vs(); };

  // ---- 1) Fenster mit Reitern, Vorgaben ------------------------------------------------------------------------------
  await ev(() => window.__t.openSettings());
  await waitFor('Einstellungen offen', () => window.__t.settings().open, 5000);
  const nav = await ev(() => [...document.querySelectorAll('#st-nav button')].map((b) => `${b.dataset.sec}:${b.textContent.trim()}`));
  const st0 = await ev(() => window.__t.settings());
  check('Einstellungen: Reiter Viewer, Shortcuts, Skills, Storage, About, ohne Ziel offen im Reiter Viewer', JSON.stringify(nav) === '["viewer:Viewer","keys:Shortcuts","skills:Skills","storage:Storage","about:About"]'
    && st0.section === 'viewer' && await ev(() => !document.getElementById('st-viewer').hidden && document.getElementById('st-skills').hidden), nav.join(','));
  let pv = (await pages()).viewer.text;
  let cam = await vs();
  check('Vorgaben: Belegung SOMA (links drehen, rechts verschieben), perspektivisch, keine settings.json', cam.navigation === 'soma' && cam.projection === 'perspective' && cam.zoomSpeed === 1
    && pv.includes('Mouse buttons') && /Rotate\s+left drag/.test(pv) && /Pan\s+right drag, Shift or Ctrl \+ left drag/.test(pv) && fileSettings() === null, pv.replace(/\s+/g, ' ').slice(0, 80));
  await shot('settings-1-viewer');

  // Belegung SOMA wie bisher: links drehen, rechts verschieben, Mitte zoomen
  let c0 = await reset();
  check('SOMA: Ziehen links dreht', effect(c0, await drag({ button: 0, dx: 60 })) === 'rotate');
  c0 = await reset();
  check('SOMA: Ziehen rechts verschiebt, Strg + links ebenfalls', effect(c0, await drag({ button: 2, dx: 60 })) === 'pan' && effect(await reset(), await drag({ button: 0, ctrl: true, dx: 60 })) === 'pan');
  c0 = await reset();
  check('SOMA: Ziehen in der Mitte zoomt', effect(c0, await drag({ button: 1, dy: 60 })) === 'zoom');

  // ---- 2) SolidWorks ----------------------------------------------------------------------------------------------------
  await setSelect('st-nav-preset', 'solidworks');
  await waitPref('navigation', 'solidworks');
  pv = (await pages()).viewer.text;
  check('SolidWorks gewählt: steht in settings.json, Legende Mitte drehen, Strg + Mitte verschieben, Umschalt + Mitte zoomen',
    fileSettings()?.viewer?.navigation === 'solidworks' && /Rotate\s+middle drag/.test(pv) && /Pan\s+Ctrl \+ middle drag/.test(pv) && /Zoom\s+wheel, Shift \+ middle drag/.test(pv), pv.replace(/\s+/g, ' ').slice(0, 120));
  c0 = await reset();
  check('SolidWorks: Ziehen links bewegt nichts (links wählt nur aus)', effect(c0, await drag({ button: 0, dx: 60, dy: 30 })) === 'none');
  c0 = await reset();
  check('SolidWorks: Ziehen in der Mitte dreht', effect(c0, await drag({ button: 1, dx: 60 })) === 'rotate');
  c0 = await reset();
  check('SolidWorks: Strg + Mitte verschiebt', effect(c0, await drag({ button: 1, ctrl: true, dx: 60 })) === 'pan');
  c0 = await reset();
  check('SolidWorks: Umschalt + Mitte zoomt', effect(c0, await drag({ button: 1, shift: true, dy: 60 })) === 'zoom');
  c0 = await reset();
  check('SolidWorks: Ziehen rechts bewegt nichts', effect(c0, await drag({ button: 2, dx: 60 })) === 'none');

  // Fusion 360: Mitte verschiebt, Umschalt + Mitte dreht (die Umkehrung von OrbitControls)
  await setSelect('st-nav-preset', 'fusion');
  await waitPref('navigation', 'fusion');
  c0 = await reset();
  const fusionPan = effect(c0, await drag({ button: 1, dx: 60 }));
  c0 = await reset();
  check('Fusion 360: Mitte verschiebt, Umschalt + Mitte dreht', fusionPan === 'pan' && effect(c0, await drag({ button: 1, shift: true, dx: 60 })) === 'rotate', fusionPan);
  await setSelect('st-nav-preset', 'solidworks');
  await waitPref('navigation', 'solidworks');

  // Links klicken wählt auch in einer CAD-Belegung aus, ein Klick mit der mittleren Taste nicht (Fenster zu, sonst liegt es darüber)
  await ev(() => window.__t.closeSettings());
  await reset();
  const plateTop = await ev((pid) => { const f = window.__t.viewer.facesOf(pid).find((x) => x.surface === 'PLANE' && Math.abs(x.center[2] - 5) < 1e-6); return window.__t.viewer.screenOf(pid, f.id); }, ids.Platte);
  await ev((p) => {
    const c = window.__t.viewer.renderer.domElement;
    const init = { clientX: p.x, clientY: p.y, bubbles: true, cancelable: true, button: 1, buttons: 4, pointerId: 1, pointerType: 'mouse' };
    c.dispatchEvent(new PointerEvent('pointerdown', init)); c.dispatchEvent(new PointerEvent('pointerup', init));
  }, plateTop);
  const midPick = await ev(() => window.__t.pick());
  await page.click(plateTop.x, plateTop.y);
  const leftPick = await ev(() => window.__t.pick());
  check('Klick mit der mittleren Taste wählt nichts, mit der linken die Platte', !midPick && leftPick?.partId === ids.Platte, `${midPick?.partId ?? '-'} / ${leftPick?.partId ?? '-'}`);
  await ev(() => window.__t.openSettings());

  // ---- 3) Zoomrichtung --------------------------------------------------------------------------------------------------
  c0 = await reset();
  const wIn = await wheel(-100);
  check('Mausrad vom Körper weg (deltaY < 0) zoomt hinein', wIn.dist < c0.dist * 0.99, `${c0.dist.toFixed(1)} → ${wIn.dist.toFixed(1)}`);
  await ev(() => { const c = document.getElementById('st-invert'); c.checked = true; c.dispatchEvent(new Event('change')); });
  await waitPref('invertZoom', true);
  c0 = await reset();
  const wOut = await wheel(-100);
  check('„Invert zoom": dieselbe Drehung zoomt hinaus, steht in settings.json', wOut.dist > c0.dist * 1.01 && wOut.zoomSpeed === -1 && fileSettings()?.viewer?.invertZoom === true,
    `${c0.dist.toFixed(1)} → ${wOut.dist.toFixed(1)}`);

  // ---- 4) Orthografisch -------------------------------------------------------------------------------------------------
  c0 = await reset();
  await ev(() => document.querySelector('#st-viewer .st-seg button[data-value="orthographic"]').click());
  await waitPref('projection', 'orthographic');
  let c1 = await vs();
  check('Orthografisch: Projektion umgestellt, Blickrichtung, Drehpunkt und Bildgröße bleiben', c1.projection === 'orthographic' && near(c0.dir, c1.dir, 1e-6)
    && near(c0.target, c1.target, 1e-6) && Math.abs(c1.dist - c0.dist) < c0.dist * 1e-3, `${c0.dist.toFixed(2)} / ${c1.dist.toFixed(2)}`);
  const sizes = await ev((pid) => {
    const v = window.__t.viewer, fs = v.facesOf(pid).filter((x) => x.surface === 'PLANE' && Math.abs(x.center[2] - 5) < 1e-6);
    return fs.length ? v.screenOf(pid, fs[0].id) : null;
  }, ids.Platte);
  check('Orthografisch: Die Oberseite der Platte liegt im Bild', !!sizes && sizes.x > 0 && sizes.y > 0);
  c0 = await reset();
  c1 = await wheel(-100);
  check('Orthografisch: Mausrad zoomt, umgekehrt wie eingestellt (Maßstab ändert sich, Richtung bleibt)', c1.dist > c0.dist * 1.01 && near(c0.dir, c1.dir, 1e-4), `${c0.dist.toFixed(1)} → ${c1.dist.toFixed(1)}`);
  c0 = await reset();
  check('Orthografisch: Ziehen in der Mitte dreht (SolidWorks)', effect(c0, await drag({ button: 1, dx: 60 })) === 'rotate');
  await ev(() => window.__t.closeSettings());
  await reset();
  await shot('settings-2-ortho');
  const top = await ev((pid) => { const f = window.__t.viewer.facesOf(pid).find((x) => x.surface === 'PLANE' && Math.abs(x.center[2] - 5) < 1e-6); return window.__t.viewer.screenOf(pid, f.id); }, ids.Platte);
  await page.click(top.x, top.y);
  const orthoPick = await ev(() => window.__t.pick());
  check('Orthografisch: Klick wählt die Platte, Fläche eben', orthoPick?.partId === ids.Platte && orthoPick?.surface === 'PLANE', JSON.stringify(orthoPick)?.slice(0, 80));
  const hidden = await ev((pid) => window.__t.viewer.edgesOf(pid).find((e) => e.curve === 'LINE' && Math.abs(e.mid[2]) < 1e-3 && Math.abs(e.mid[1] - 15) < 1e-3), ids.Platte);
  const probeHidden = await ev((p) => window.__t.viewer.probe(p.x, p.y), hidden.screen);
  const verts = await ev((pid) => window.__t.viewer.verticesOf(pid), ids.Platte);
  const corner = verts.find((v) => near(v.p, [20, -15, 5]));
  const probeCorner = await ev((p) => window.__t.viewer.probe(p.x + 3, p.y + 2), corner.screen);
  check('Orthografisch beim Messen: verdeckte Kante nicht getroffen, sichtbare Ecke gefasst', !!probeHidden && !(probeHidden.kind === 'edge' && probeHidden.id === hidden.id)
    && probeCorner?.kind === 'vertex' && near(probeCorner.point, [20, -15, 5], 1e-3), `${probeHidden?.kind} / ${probeCorner?.kind}`);

  // ---- 5) Nachkommastellen beim Messen ----------------------------------------------------------------------------------
  await domClick('btn-measure');
  await page.click(top.x, top.y);
  await waitFor('Messergebnis', () => !!window.__t.measure().result, 60000);
  let mt = (await ev(() => window.__t.measure())).text;
  check('Messen mit der Vorgabe: zwei Nachkommastellen (40.00 × 30.00 × 5.00 mm)', mt.includes('40.00 × 30.00 × 5.00 mm'), mt.replace(/\s+/g, ' ').slice(0, 80));
  await ev(() => window.__t.openSettings());
  await setSelect('st-decimals', '3');
  await waitPref('decimals', 3);
  mt = (await ev(() => window.__t.measure())).text;
  const agentText = (await ev(() => window.__t.measure())).agentText ?? '';
  check('Drei Nachkommastellen: Die offene Messung zeigt 40.000 × 30.000 × 5.000 mm, der Text für den Agenten bleibt gleich',
    mt.includes('40.000 × 30.000 × 5.000 mm') && agentText.startsWith('[Measurement: part "Platte" face (plane)') && agentText.includes('area 1143.451 mm²'), `${mt.replace(/\s+/g, ' ').slice(0, 60)} | ${agentText.slice(0, 60)}`);
  await setSelect('st-decimals', '1');
  await waitPref('decimals', 1);
  mt = (await ev(() => window.__t.measure())).text;
  check('Eine Nachkommastelle: 40.0 × 30.0 × 5.0 mm', mt.includes('40.0 × 30.0 × 5.0 mm'), mt.replace(/\s+/g, ' ').slice(0, 60));
  const bad = await ev(() => window.soma.settings.set({ viewer: { decimals: 9 } }));
  check('Ungültiger Wert (9 Nachkommastellen) wird abgelehnt, nichts geschrieben', !bad.ok && /decimals/.test(bad.error ?? '') && fileSettings()?.viewer?.decimals === 1, bad.error);
  await ev(() => window.__t.closeSettings());
  await domClick('btn-measure');

  // ---- 6) Darstellung beim Öffnen -----------------------------------------------------------------------------------------
  // Ursprung und Achsen: Vorgabe aus. Der Knopf neben dem ViewCube und der Eintrag im Menü „Display“ schalten sie gemeinsam
  const axBtn = () => ev(() => document.getElementById('btn-axes').getAttribute('aria-pressed'));
  const ax0 = await ev(() => window.__t.axes());
  check('Ursprung und Achsen: Vorgabe aus, nichts im Bild, Knopf nicht gedrückt', !ax0.on && ax0.objects === 0 && (await axBtn()) === 'false'
    && (await ev(() => window.__t.display())).axes === false, JSON.stringify(ax0));
  await domClick('btn-axes');
  const ax1 = await ev(() => window.__t.axes());
  check('Knopf Origin and axes: drei Linien und Punkt, Beschriftung X Y Z, Länge passend zum Modell, Knopf und Menüeintrag an',
    ax1.on && ax1.objects === 4 && ax1.labels.join('') === 'XYZ' && ax1.len >= 5 && ax1.len <= 50 && (await axBtn()) === 'true'
    && (await ev(() => window.__t.display())).axes === true, JSON.stringify(ax1));
  await shot('settings-axes');
  await ev(() => document.querySelector('[data-display="axes"]').click());
  const ax2 = await ev(() => window.__t.axes());
  check('Menü „Display“: Origin and axes aus, nichts mehr im Bild, Knopf nicht mehr gedrückt', !ax2.on && ax2.objects === 0 && !ax2.labels.length && (await axBtn()) === 'false', JSON.stringify(ax2));
  await ev(() => window.__t.openSettings());
  const flip = (id) => ev((i) => { const c = document.getElementById(i); c.checked = !c.checked; c.dispatchEvent(new Event('change')); }, id);
  await flip('st-edges');
  await waitPref('edges', false);
  await flip('st-ghost');
  await waitPref('transparent', true);
  await flip('st-axes');
  await waitPref('axes', true);
  const nowDisplay = await ev(() => window.__t.display());
  check('Darstellung beim Öffnen geändert: das offene Modell bleibt, wie es ist', nowDisplay.edges === true && nowDisplay.ghost === false && nowDisplay.axes === false, JSON.stringify(nowDisplay));
  await ev(() => window.__t.closeSettings());
  await ev(() => window.soma.project.create());
  await waitFor('Neues Modell offen und gebaut', (id) => window.__t.project()?.id !== id && window.__t.status().state === 'ok' && window.__t.partCount() > 0, 90000, proj.id);
  const newDisplay = await ev(() => window.__t.display());
  check('Neues Modell: ohne Kanten, transparent, mit Achsen (Menü „Display" und Knopf zeigen es so)', newDisplay.edges === false && newDisplay.ghost === true && newDisplay.wire === false
    && newDisplay.axes === true && (await ev(() => window.__t.axes())).objects === 4 && (await axBtn()) === 'true', JSON.stringify(newDisplay));
  const proj2 = await ev(() => window.__t.project());

  // ---- 7) Speicherplatz ---------------------------------------------------------------------------------------------------
  const fakeId = '11111111-2222-4333-8444-555555555555';
  fs.mkdirSync(path.join(ud, 'previews', fakeId, 'abc1234'), { recursive: true });
  fs.writeFileSync(path.join(ud, 'previews', fakeId, 'abc1234', 'model.glb'), Buffer.alloc(1024 * 1024));
  fs.mkdirSync(path.join(ud, 'previews', proj2.id, 'def5678'), { recursive: true });
  fs.writeFileSync(path.join(ud, 'previews', proj2.id, 'def5678', 'model.glb'), Buffer.alloc(2048));
  await ev(() => window.__t.settingsShow('keys'));
  const keys = await ev(() => document.getElementById('st-keys').textContent);
  check('Reiter Shortcuts: Tasten für Auswahl (H, I, T, Alt + Drag), Navigation nach der gewählten Mausbelegung', !(await ev(() => document.getElementById('st-keys').hidden))
    && keys.includes('Isolate: show only the selected parts') && keys.includes('Alt+DragBox select') && keys.includes('Shift+HShow all parts again')
    && keys.includes('Navigation as set under Viewer (SolidWorks)') && keys.includes('middle dragRotate'), keys.slice(0, 300));
  await shot('settings-1b-shortcuts');
  await ev(() => window.__t.settingsShow('storage'));
  await waitFor('Speicherplatz berechnet', () => { const s = window.__t.settingsPages().storage; return !s.loading && !!s.stats; }, 30000);
  let sp = (await pages()).storage;
  const area = (id) => sp.stats.areas.find((a) => a.id === id);
  check('Storage: Gesamtgröße, Modelle (2), Vorschau-Cache ≥ 1 MB, Sicherungen, eigene Skills, Übriges', sp.stats.total > 1024 * 1024 && area('workspaces')?.models === 2
    && area('previews')?.bytes >= 1024 * 1024 && ['backups', 'thumbnails', 'skills', 'other'].every((id) => !!area(id)) && sp.text.includes('Models on this computer') && sp.text.includes('2 models'),
    `${sp.stats.total} B, ${area('workspaces')?.models} Modelle`);
  check('Storage: Summe der Bereiche gleich der Gesamtgröße', sp.stats.areas.reduce((s, a) => s + a.bytes, 0) === sp.stats.total);
  await shot('settings-3-storage');
  await app.answers([1]);
  await ev(() => document.querySelector('#st-storage [data-area="previews"] [data-act="clear"]').click());
  await waitFor('Abgebrochen', () => !window.__t.settingsPages().storage.busy, 10000);
  check('Leeren abgebrochen: nichts entfernt', fs.existsSync(path.join(ud, 'previews', fakeId)));
  // Rückfrage in der App statt als weißer Dialog des Systems: Text, Knöpfe, Fokus, Escape bricht ab und lässt die Einstellungen offen
  const askDlg = () => ev(() => { const d = document.querySelector('.ask-dlg'); return d && { text: d.textContent, btns: [...d.querySelectorAll('button')].map((b) => b.textContent), focus: document.activeElement?.textContent, primary: d.querySelector('button.primary')?.textContent }; });
  await app.answers(['ui']);
  await ev(() => document.querySelector('#st-storage [data-area="previews"] [data-act="clear"]').click());
  await waitFor('Rückfrage in der App', () => !!document.querySelector('.ask-dlg'), 10000).catch(() => {});
  const asked = await askDlg();
  check('Rückfrage in der App: Text, Knöpfe, Fokus auf dem ersten', !!asked && asked.btns.length === 2 && asked.btns.at(-1) === 'Cancel' && asked.focus === asked.btns[0] && asked.primary === asked.btns[0], JSON.stringify(asked));
  await shot('settings-ask');
  await ev(() => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await waitFor('Rückfrage zu', () => !document.querySelector('.ask-dlg') && !window.__t.settingsPages().storage.busy, 10000).catch(() => {});
  check('Escape bricht ab: nichts entfernt, Einstellungen bleiben offen', !(await askDlg()) && fs.existsSync(path.join(ud, 'previews', fakeId)) && !(await ev(() => document.getElementById('settings').hidden)));
  await app.answers([0]);
  await ev(() => document.querySelector('#st-storage [data-area="previews"] [data-act="clear"]').click());
  await waitFor('Geleert', () => !window.__t.settingsPages().storage.busy && /Preview cache cleared/.test(window.__t.toast().text), 20000).catch(() => {});
  sp = (await pages()).storage;
  const toast = await ev(() => window.__t.toast());
  check('Vorschau-Cache geleert: fremde Vorschauen weg, die des offenen Modells bleiben, Meldung nennt den Platz', !fs.existsSync(path.join(ud, 'previews', fakeId))
    && fs.existsSync(path.join(ud, 'previews', proj2.id, 'def5678', 'model.glb')) && /1(\.0)? MB freed\. The previews of the open model stay\./.test(toast.text) && area('previews').bytes < 1024 * 1024,
    toast.text);
  const opened = await ev(() => window.soma.storage.open('backups'));
  const badArea = await ev(() => window.soma.storage.open('../../Windows'));
  check('Ordner öffnen: Bereich wird angelegt, unbekannter Bereich abgelehnt', opened.ok && fs.existsSync(path.join(ud, 'workspace-backups')) && !badArea.ok, badArea.error);

  // ---- 8) Info -----------------------------------------------------------------------------------------------------------
  await ev(() => window.__t.settingsShow('about'));
  await waitFor('Info gesammelt', () => { const a = window.__t.settingsPages().about; return !a.loading && !!a.info; }, 60000);
  const ab = (await pages()).about;
  const py = (n) => ab.info.python.packages.find((p) => p.name.toLowerCase() === n);
  check(`About: SOMA ${VERSION}, soma gleiche Version, Python, CadQuery, OCP mit Version und Lizenz`, ab.info.version === VERSION && py('soma')?.version === VERSION
    && !!ab.info.python.version && !!py('cadquery')?.version && !!py('cadquery')?.license && !!py('cadquery-ocp') && ab.text.includes(`SOMA ${VERSION}`) && ab.text.includes('CadQuery'),
    `${py('soma')?.version} / ${py('cadquery')?.version} ${py('cadquery')?.license}`);
  check('About: Komponenten der App aus components.json (three, xterm mit Lizenz), Electron, Git, vier Agenten geprüft',
    ab.info.components.some((c) => c.name === 'three' && c.license === 'MIT') && ab.info.components.some((c) => c.name === '@xterm/xterm') && !!ab.info.electron && !!ab.info.git
    && ab.info.agents.length === 4 && ab.text.includes('Claude Code'), `${ab.info.components.length} Komponenten, Git ${ab.info.git}`);
  await shot('settings-4-about');
  await ev(() => document.querySelector('#st-about [data-act="copy"]').click());
  await waitFor('Kopiert', () => /System info copied/.test(window.__t.toast().text), 30000).catch(() => {});
  const clip = await ev(() => window.soma.test.clipboard());
  check('„Copy system info": Text mit Version, Python-Paketen, System und Ordnern (im Test nicht in der echten Zwischenablage)',
    clip.startsWith(`SOMA ${VERSION}\n`) && clip.includes('CadQuery') && clip.includes('OS: ') && clip.includes('App data: '), clip.split('\n')[1]);

  // Protokoll (log.ts): Kopf beim Start, geöffnetes Modell, Build, gescheiterte Anfrage, Agentenstart per Knopf und getippt
  const logFile = path.join(ud, 'logs', 'soma.log');
  const term = await ev(async () => {
    // Startbefehl wie vom Knopf, nur mit einem Pfad, den es nicht gibt: Es startet nichts, die Shell meldet einen Fehler
    const a = await window.soma.term.create({ command: 'soma-no-such-dir/claude --soma-test-nonexistent' });
    const b = await window.soma.term.create({});
    // Getippt mit Korrektur: „codexx“ + Rücktaste. Der Pfad existiert nicht, die Shell meldet nur einen Fehler
    window.soma.term.write(b, 'soma-no-such-dir/codexx\x7f --x\r');
    window.soma.term.write(b, 'echo gemini\r'); // kein Agentenstart: erstes Wort echo
    return [a, b];
  });
  await sleep(1500);
  await ev((ids) => ids.forEach((id) => window.soma.term.kill(id)), term);
  const logText = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  check('Protokoll logs/soma.log: Kopf mit Version und System, Modell geöffnet, Build, gescheiterte Anfrage (unbekannter Ordner)',
    logText.includes('SOMA started') && logText.includes(`version: ${VERSION}`) && logText.includes('system: ') && /\[project\] opened [0-9a-f-]{36}/.test(logText)
    && /\[build\] ok, \d+ parts/.test(logText) && /WARN  \[storage:open\] Unknown folder/.test(logText), logText.slice(0, 200));
  check('Protokoll ohne ERROR (etwa Dateiliste ohne offenes Modell, „No project open“)', !/ ERROR /.test(logText),
    logText.split('\n').filter((l) => / ERROR /.test(l)).join(' | ').slice(0, 300));
  check('Protokoll: Agent per Knopf und getippt erkannt (nur Name, keine Befehlszeile), echo gemini zählt nicht',
    logText.includes('[agent] Claude Code started (start button)') && logText.includes('[agent] Codex started (typed in a terminal)') && !logText.includes('Gemini CLI started')
    && !logText.includes('soma-test-nonexistent') && !logText.includes('soma-no-such-dir'));
  check('„Copy system info" mit Ordner Logs und dem Ende des Protokolls', clip.includes('Logs: ') && clip.includes('Recent log (logs/soma.log):') && clip.includes('SOMA started'));
  check('Storage: Bereich Logs mit dem Protokoll', (sp.stats.areas.find((a) => a.id === 'logs')?.bytes ?? 0) > 0);
  const link = await ev(() => { const b = [...document.querySelectorAll('#st-about button')].find((x) => x.textContent.includes('Changelog')); b.click(); return !!b; });
  await sleep(200);
  check('Link „Changelog" geht an den Browser (im Test ohne Fehlermeldung)', link && !(await ev(() => window.__t.toast())).error);

  // Skills bleiben erreichbar: Wechsel in den Reiter, Ctrl+S gehört dort weiter dem Editor
  await ev(() => window.__t.settingsShow('skills'));
  await waitFor('Reiter Skills', () => window.__t.settings().section === 'skills' && window.__t.settings().skills.length > 0, 10000);
  check('Reiter Skills: Bibliothek geladen, Abschnitt sichtbar, andere verborgen', await ev(() => !document.getElementById('st-skills').hidden && document.getElementById('st-viewer').hidden
    && document.querySelector('#st-nav [data-sec="skills"]').getAttribute('aria-current') === 'page'));
  await ev(() => window.__t.closeSettings());
  await ev(() => window.__t.openSettings());
  check('Wieder geöffnet ohne Ziel: derselbe Reiter wie zuletzt', (await ev(() => window.__t.settings())).section === 'skills');
  await ev(() => window.__t.closeSettings());

  // ---- 9) Neustart mit denselben App-Daten ----------------------------------------------------------------------------------
  await app.stop();
  app = await startApp({ name: 'settings2', userData: ud, port: await freePort() });
  ({ ev, waitFor, domClick, page } = app);
  await waitFor('Projekt nach Neustart', () => !!window.__t && !!window.__t.project() && window.__t.status().state === 'ok' && window.__t.partCount() > 0, 90000);
  await waitFor('Einstellungen geladen', () => window.__t.appSettings().settings.viewer.navigation === 'solidworks', 10000).catch(() => {});
  cam = await vs();
  const disp = await ev(() => window.__t.display());
  check('Nach dem Neustart: SolidWorks, umgekehrter Zoom, orthografisch, ohne Kanten und transparent', cam.navigation === 'solidworks' && cam.zoomSpeed === -1
    && cam.projection === 'orthographic' && disp.edges === false && disp.ghost === true, `${cam.navigation} ${cam.projection} ${JSON.stringify(disp)}`);
  await app.stop();

  // ---- 10) Kaputte und fremde Werte in settings.json -------------------------------------------------------------------------
  fs.writeFileSync(settingsFile, JSON.stringify({ viewer: { navigation: 'catia', decimals: 3, projection: 'orthographic' }, future: true }));
  app = await startApp({ name: 'settings3', userData: ud, port: await freePort() });
  ({ ev, waitFor, domClick, page } = app);
  await waitFor('Projekt nach Neustart', () => !!window.__t && !!window.__t.project() && window.__t.status().state === 'ok' && window.__t.partCount() > 0, 90000);
  await waitFor('Einstellungen geladen', () => window.__t.appSettings().settings.viewer.decimals === 3, 10000).catch(() => {});
  const as = await ev(() => window.__t.appSettings());
  cam = await vs();
  check('Unbekannte Belegung „catia": gemeldet, Vorgabe SOMA, die gültigen Werte gelten (3 Stellen, orthografisch)', /viewer\.navigation/.test(as.problem ?? '')
    && as.settings.viewer.navigation === 'soma' && as.settings.viewer.decimals === 3 && cam.projection === 'orthographic' && cam.navigation === 'soma', as.problem);
  await ev(() => window.__t.openSettings(undefined));
  await ev(() => window.__t.settingsShow('viewer'));
  pv = (await pages()).viewer.text;
  check('Der Reiter Viewer nennt das Problem mit settings.json', pv.includes('settings.json contains values this app does not know'), pv.replace(/\s+/g, ' ').slice(0, 100));
  await setSelect('st-nav-preset', 'onshape');
  await waitPref('navigation', 'onshape');
  const backups = fs.readdirSync(path.join(ud, 'workspace-backups')).filter((n) => /^settings-.*\.json$/.test(n));
  const kept = backups.length ? JSON.parse(fs.readFileSync(path.join(ud, 'workspace-backups', backups[0]), 'utf8')) : null;
  check('Beim Ändern: alte settings.json in der Sicherung, neue Datei gültig und ohne Problem', kept?.viewer?.navigation === 'catia' && fileSettings()?.viewer?.navigation === 'onshape'
    && !('future' in (fileSettings() ?? {})) && !(await ev(() => window.__t.appSettings())).problem, backups.join(','));
  c0 = await reset();
  check('Onshape: Ziehen rechts dreht, Strg + rechts verschiebt', effect(c0, await drag({ button: 2, dx: 60 })) === 'rotate' && effect(await reset(), await drag({ button: 2, ctrl: true, dx: 60 })) === 'pan');
  fs.writeFileSync(settingsFile, '{ nicht json');
  const broken = await ev(() => window.soma.settings.get());
  check('settings.json kein JSON: Vorgaben, Meldung statt Absturz', /not valid JSON/.test(broken.problem ?? '') && broken.settings.viewer.navigation === 'soma', broken.problem);
  const relevant = page.errors.filter((e) => !/favicon/i.test(e));
  check('Keine Konsolenfehler im Renderer', relevant.length === 0, relevant.slice(0, 2).join(' | ').slice(0, 100));
} catch (e) {
  console.log('ABBRUCH:', e.message);
  t.fail();
}

if (app) await app.stop();
if (ud) cleanup(ud);
console.log(t.fails ? `\n${t.fails} Prüfung(en) fehlgeschlagen` : '\nALLE PRÜFUNGEN BESTANDEN');
process.exit(t.fails ? 1 : 0);
