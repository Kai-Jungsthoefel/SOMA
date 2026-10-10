// Erzeugt die Bilder der Anleitung (resources/help/*.png) aus der echten App: je Bild ein Zustand, darüber nummerierte
// Markierungen nach test/helpshots-spec.mjs. Aufruf: npm run help:shots (baut vorher). Nach Änderungen an der Oberfläche
// neu erzeugen und die Bilder ansehen, die Texte unter den Bildern stehen in resources/skills/soma-app.md.
// Das Fenster läuft außerhalb des Bildschirms (unsichtbare Fenster zeichnen nicht neu).
import fs from 'node:fs';
import path from 'node:path';
import { SHOTS } from './helpshots-spec.mjs';

process.env.SMOKE_VISIBLE = 'offscreen';
const { APP, cleanup, sleep, startApp } = await import('./harness.mjs');

const OUT = path.join(APP, 'resources', 'help');
const only = process.argv.slice(2);
let app;
let failed = false;

/**
 * Legt die Markierungen über das Fenster (fester Layer ganz oben) und liefert den Ausschnitt des Bildes in CSS-Pixeln.
 * Läuft im Renderer: keine Variablen von außen.
 */
function overlay(shot) {
  document.getElementById('help-marks')?.remove();
  const rectOf = (sel) => {
    const els = (Array.isArray(sel) ? sel : [sel]).flatMap((s) => {
      const all = [...document.querySelectorAll(s)].filter((e) => e.getClientRects().length);
      // Mehrere Treffer eines Selektors mit [data-tool] und Ähnlichem: alle, sonst nur der erste sichtbare
      return /\[data-tool\]|\.chips$/.test(s) ? all : all.slice(0, 1);
    });
    if (!els.length) return null;
    const rs = els.map((e) => e.getBoundingClientRect());
    const x = Math.min(...rs.map((r) => r.left)), y = Math.min(...rs.map((r) => r.top));
    return { x, y, w: Math.max(...rs.map((r) => r.right)) - x, h: Math.max(...rs.map((r) => r.bottom)) - y };
  };
  const missing = [];
  const layer = document.createElement('div');
  layer.id = 'help-marks';
  layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
  const R = 12;
  shot.marks.forEach((m, i) => {
    const r = rectOf(m.sel);
    if (!r) { missing.push(String(m.sel)); return; }
    if (m.box) {
      const b = document.createElement('div');
      b.style.cssText = `position:absolute;left:${r.x - 3}px;top:${r.y - 3}px;width:${r.w + 6}px;height:${r.h + 6}px;border:2px dashed #ffd23f;border-radius:8px;box-sizing:border-box`;
      layer.append(b);
    }
    const at = m.at ?? 'tr';
    // Nummer neben den Rahmen, damit sie nichts verdeckt. Nur an den Ecken eines Bereichs sitzt sie auf dem Rahmen
    const out = at === 'c' || (m.box && at.length === 2) ? 0 : R + 4;
    let cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    if (at.includes('l')) cx = r.x - out; if (at.includes('r')) cx = r.x + r.w + out;
    if (at.includes('t')) cy = r.y - out; if (at.includes('b')) cy = r.y + r.h + out;
    if (at === 'l' || at === 'r') cy = r.y + r.h / 2;
    if (at === 't' || at === 'b') cx = r.x + r.w / 2;
    cx = Math.max(R + 2, Math.min(innerWidth - R - 2, cx)); cy = Math.max(R + 2, Math.min(innerHeight - R - 2, cy));
    const n = document.createElement('div');
    n.textContent = String(i + 1);
    n.style.cssText = `position:absolute;left:${cx - R}px;top:${cy - R}px;width:${2 * R}px;height:${2 * R}px;border-radius:50%;background:#ffd23f;color:#111;`
      + 'font:700 13px/24px "IBM Plex Sans",sans-serif;text-align:center;box-shadow:0 0 0 2px #111,0 2px 8px rgba(0,0,0,.6)';
    layer.append(n);
  });
  document.body.append(layer);
  let clip = null;
  if (shot.clip) {
    const r = rectOf(shot.clip);
    if (!r) missing.push(`clip ${shot.clip}`);
    else {
      const pad = shot.pad ?? 0;
      const x = Math.max(0, Math.floor(r.x - pad)), y = Math.max(0, Math.floor(r.y - pad));
      const w = Math.min(innerWidth - x, Math.ceil((shot.clipWidth ?? r.w) + 2 * pad)), h = Math.min(innerHeight - y, Math.ceil((shot.clipHeight ?? r.h) + 2 * pad));
      clip = { x, y, width: w, height: h };
    }
  }
  return { missing, clip };
}

try {
  app = await startApp({ name: 'helpshots' });
  const { ev, waitFor, domClick, page } = app;
  const click = (sel) => ev((s) => document.querySelector(s).click(), sel);
  const esc = () => ev(() => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await waitFor('Projekt', () => !!window.__t && !!window.__t.project());
  await waitFor('Build', () => window.__t.status().state === 'ok' && window.__t.partCount() === 2, 120000);
  // Terminal leeren und kurzer Prompt: Der Pfad des Testordners (mit Benutzernamen) gehört nicht ins Bild
  await waitFor('Terminal', () => window.__t.terminals.activeId != null, 20000);
  await sleep(1500);
  await ev(() => window.soma.term.write(window.__t.terminals.activeId, "function prompt { 'PS> ' }; Clear-Host\r"));
  await sleep(1500);

  /** Zustand je Bild herstellen und danach wieder aufräumen. */
  const prep = {
    'window.png': async () => {},
    'start.png': async () => { await ev(() => window.__t.showStart(true)); await sleep(600); },
    'agent.png': async () => { await domClick('btn-term-add'); await sleep(400); },
    'viewer.png': async () => {
      await ev(() => window.__t.treeOpen(true));
      const pos = await ev(() => {
        const v = window.__t.viewer; const id = window.__t.parts().find((p) => p.name === 'Lid').id;
        const f = v.facesOf(id).filter((x) => x.surface === 'PLANE').sort((a, b) => b.center[2] - a.center[2])[0];
        return v.screenOf(id, f.id);
      });
      await page.click(pos.x, pos.y);
      await waitFor('Auswahl', () => window.__t.info().includes('Lid'), 10000);
    },
    'tools.png': async () => { await domClick('btn-section'); await waitFor('Schnitt', () => !document.getElementById('section-card').hidden, 10000); },
    'markup.png': async () => { await domClick('btn-mark'); await waitFor('Markierung', () => !document.getElementById('markup').hidden, 10000); },
    'code.png': async () => {
      await ev(() => window.__t.showPanel('files'));
      await ev(() => window.__t.openCode('model.py'));
      await waitFor('Code', () => window.__t.codeText().includes('add_part'), 10000);
    },
    'history.png': async () => {
      await waitFor('Verlauf', () => document.querySelectorAll('#vdots .vdot:not(.live)').length > 0, 15000);
      await click('#vdots .vdot:not(.live)');
      await waitFor('Vorschau', () => !document.getElementById('preview-banner').hidden, 30000);
    },
    'export.png': async () => { await domClick('btn-export'); await sleep(300); },
    'settings.png': async () => { await ev(() => window.__t.settingsShow('viewer')); await sleep(600); },
  };
  const reset = {
    'start.png': () => ev(() => window.__t.showStart(false)),
    'agent.png': esc,
    'viewer.png': async () => { await domClick('btn-sel-close'); await ev(() => window.__t.treeOpen(false)); },
    'tools.png': () => domClick('btn-section-close'),
    'markup.png': () => domClick('btn-mark-cancel'),
    'code.png': async () => { await ev(() => window.__t.showPanel(null)); await ev(() => window.__t.showCode(false)); },
    'history.png': async () => { await domClick('btn-live'); await waitFor('Jetzt', () => document.getElementById('preview-banner').hidden, 30000); },
    'export.png': esc,
    'settings.png': () => ev(() => window.__t.closeSettings()),
  };

  fs.mkdirSync(OUT, { recursive: true });
  for (const shot of SHOTS) {
    if (only.length && !only.includes(shot.file)) continue;
    await prep[shot.file]?.();
    await sleep(900);
    const { missing, clip } = await ev(overlay, shot);
    if (missing.length) { console.log(`FEHLER ${shot.file}: nicht gefunden: ${missing.join(', ')}`); failed = true; }
    await sleep(300);
    const size = await app.screenshot(path.join(OUT, shot.file), clip ?? undefined);
    console.log(`${shot.file.padEnd(14)} ${size.width} x ${size.height}, ${shot.marks.length} Nummern`);
    await ev(() => document.getElementById('help-marks')?.remove());
    await reset[shot.file]?.();
    await sleep(400);
  }
} catch (e) {
  console.log('FEHLER', e.message);
  failed = true;
} finally {
  await app?.stop();
  if (app) cleanup(app.ud);
}
process.exit(failed ? 1 : 0);
