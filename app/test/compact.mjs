// Narrow windows (phones, compact.ts): one view at a time with a tab bar at the bottom, the wide layout comes back as it was.
// Call: node test/compact.mjs after npm run build. SMOKE_VISIBLE=offscreen SMOKE_SHOTS=1 writes pictures to test/shots/.
import fs from 'node:fs';
import path from 'node:path';
import { APP, checker, cleanup, sleep, startApp } from './harness.mjs';

const t = checker();
const { check } = t;
let app;

try {
  app = await startApp({ name: 'compact' });
  const { ev, waitFor, domClick } = app;
  const shot = async (name) => {
    if (!process.env.SMOKE_SHOTS) return;
    fs.mkdirSync(path.join(APP, 'test', 'shots'), { recursive: true });
    await sleep(900);
    await app.screenshot(path.join(APP, 'test', 'shots', `${name}.png`)).catch((e) => console.log('Screenshot:', e.message));
  };
  /** Which of the columns are shown, and how wide (0: not shown). */
  const shown = () => ev(() => Object.fromEntries(['rail', 'side', 'editor', 'center', 'terminals'].map((id) => {
    const e = document.getElementById(id);
    return [id, e.getClientRects().length ? Math.round(e.getBoundingClientRect().width) : 0];
  })));
  let W = 0, H = 0;
  const size = async (w, h, compact) => {
    await ev(([a, b]) => window.soma.test.size(a, b), [w, h]);
    // With display scaling the page comes out a few pixels off the content size (rounding of the frame): correct once
    await sleep(500);
    const [iw, ih] = await ev(() => [innerWidth, innerHeight]);
    if (iw !== w || ih !== h) await ev(([a, b]) => window.soma.test.size(a, b), [2 * w - iw, 2 * h - ih]);
    await waitFor(`window ${w} x ${h}`, ([a, c]) => Math.abs(innerWidth - a) <= 2 && window.__t.compact().on === c, 10000, [w, compact]);
    // The width the page really has, the checks below compare with it
    W = await ev(() => innerWidth);
    H = await ev(() => innerHeight);
  };
  /** Presses a tab at the bottom and waits for the view it shows. */
  const tab = async (name, view = name) => {
    await ev((n) => document.querySelector(`#mtabs [data-tab="${n}"]`).click(), name);
    await waitFor(`view ${view}`, (v) => window.__t.compact().view === v, 5000, view);
  };
  const lit = () => ev(() => document.querySelector('#mtabs [aria-pressed="true"]')?.dataset.tab);

  await waitFor('model built', () => !!window.__t?.project() && window.__t.status().state === 'ok' && window.__t.partCount() === 2);

  // 1) Wide window: columns as always, no tab bar. The agent area collapsed, to see that the narrow mode keeps that
  await size(1400, 900, false);
  check('Wide window: no tab bar', await ev(() => document.getElementById('mtabs').hidden && !document.body.classList.contains('compact')));
  await domClick('btn-lay-agent');
  check('Agent area collapsed in the wide window', (await ev(() => window.__t.layout())).agent === false);

  // 2) Phone upright: the model fills the window, the tab bar below it
  await size(390, 844, true);
  let s = await shown();
  check('Narrow: only the viewer, as wide as the window', s.center === W && !s.rail && !s.side && !s.editor && !s.terminals, JSON.stringify(s));
  const bar = await ev(() => { const r = document.getElementById('mtabs').getBoundingClientRect(); return { bottom: Math.round(r.bottom), h: Math.round(r.height), n: document.querySelectorAll('#mtabs button').length }; });
  const tabs = await ev(() => [...document.querySelectorAll('#mtabs button')].map((b) => b.textContent).join(' '));
  check('Tab bar at the bottom: Model, Agent, Parameters, More', bar.bottom === H && bar.h >= 50 && tabs === 'Model Agent Parameters More', JSON.stringify({ ...bar, tabs }));
  const top = await ev(() => { const r = document.getElementById('topbar'); return { w: r.scrollWidth, cw: r.clientWidth, save: !!document.getElementById('btn-save').getClientRects().length }; });
  check('Header fits the width, Save stays', top.w <= top.cw && top.save, JSON.stringify(top));
  const cv = await ev(() => [...document.querySelectorAll('#viewer canvas')].map((c) => Math.round(c.getBoundingClientRect().width)));
  check('Viewer draws at the full width (the widest canvas, the others are the cube and overlays)', Math.max(...cv) === W, JSON.stringify(cv));
  await shot('compact-1-model');

  // 3) Agent: the agent area fills the window even though it is collapsed in the wide window
  await tab('agent');
  s = await shown();
  check('Agent: only the agent area, full width, not the strip', s.terminals === W && !s.center && await ev(() => document.getElementById('term-tabs').getClientRects().length > 0), JSON.stringify(s));
  const onBar = await ev(() => document.elementFromPoint(innerWidth / 2, document.getElementById('mtabs').getBoundingClientRect().top + 4)?.closest('#mtabs') != null);
  check('Nothing of the terminal reaches over the tab bar', onBar);
  await shot('compact-2-agent');
  await ev(() => document.querySelector('#term-tabs .ai-tab .t').click());
  await shot('compact-2-chat');

  // 4) Parameters: the sidebar with the parameters, its own tab lit
  await tab('params', 'side');
  s = await shown();
  check('Parameters: the sidebar with the parameters, full width', s.side === W && !s.center && (await ev(() => window.__t.layout())).side === 'params' && await lit() === 'params', JSON.stringify(s));
  await shot('compact-3-params');

  // 5) More: the rail as a row above the last other panel (Files), the rail switches panels without leaving
  await tab('more', 'side');
  s = await shown();
  const rail = await ev(() => { const r = document.getElementById('rail').getBoundingClientRect(); return { h: Math.round(r.height), w: Math.round(r.width) }; });
  check('More: rail as a row above Files, not the parameters', s.side === W && rail.w === W && rail.h <= 64 && (await ev(() => window.__t.layout())).side === 'files' && await lit() === 'more', JSON.stringify({ s, rail }));
  check('Code only in the rail of narrow windows', await ev(() => !!document.getElementById('btn-rail-code').getClientRects().length));
  await ev(() => document.querySelector('#rail [data-panel="anim"]').click());
  await ev(() => document.querySelector('#rail [data-panel="anim"]').click());
  check('Rail in More: a second tap keeps the panel open', (await ev(() => window.__t.layout())).side === 'anim' && (await ev(() => window.__t.compact().view)) === 'side');
  await ev(() => document.querySelector('#rail [data-panel="params"]').click());
  check('Parameters chosen in the rail light the Parameters tab', await lit() === 'params');
  await ev(() => document.querySelector('#rail [data-panel="files"]').click());
  await shot('compact-4-more');

  // 6) Code from the rail: the code column with model.py, More stays lit
  await domClick('btn-rail-code');
  await waitFor('code in front', () => window.__t.compact().view === 'code', 5000);
  s = await shown();
  check('Code: only the code column, model.py open, More lit', s.editor === W && !s.center && (await ev(() => window.__t.layout())).code === true && await lit() === 'more', JSON.stringify(s));
  await shot('compact-5-code');

  // 7) A click that opens a file brings the code to the front
  await tab('model');
  await ev(() => window.__t.openCode('model.py'));
  await waitFor('code in front after opening a file', () => window.__t.compact().view === 'code', 5000);
  check('Opening a file shows the code', true);

  // 8) Phone on its side: still narrow
  await tab('model');
  await size(844, 390, true);
  s = await shown();
  check('Phone on its side: the viewer alone, full width', s.center === W && !s.terminals, JSON.stringify(s));
  await shot('compact-6-landscape');

  // 9) Wide again: the columns as before, the agent area collapsed again (the narrow mode did not change it)
  await size(1400, 900, false);
  s = await shown();
  const lay = await ev(() => window.__t.layout());
  check('Wide again: sidebar, code and viewer side by side, agent collapsed', s.side > 0 && s.editor > 0 && s.center > 0 && s.rail === 60 && lay.agent === false, JSON.stringify({ s, lay }));
  check('Tab bar gone, no Code in the rail', await ev(() => document.getElementById('mtabs').hidden && !document.getElementById('btn-rail-code').getClientRects().length));
  await domClick('btn-lay-agent');
  check('Agent area expands again in the wide window', (await ev(() => window.__t.layout())).agent === true);
} catch (e) {
  console.log('ABORTED:', e.message);
  if (app) console.log('Errors in the renderer:', app.page.errors.slice(0, 10).join('\n  ') || '(none)');
  t.fail();
}
if (app) { await app.stop(); cleanup(app.ud); }
console.log(t.fails ? `\n${t.fails} check(s) failed` : '\nALL CHECKS PASSED');
process.exit(t.fails ? 1 : 0);
