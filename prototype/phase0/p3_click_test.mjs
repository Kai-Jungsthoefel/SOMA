// Phase 0, Punkt 3: Klick im Viewer -> Bauteil, Flaeche, Datei:Zeile. Echter Browser (Edge headless, WebGL).
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const url = process.argv[2] || 'http://127.0.0.1:8791/viewer/index.html?project=example';
const shot = process.argv[3] || 'screenshots/p3_viewer.png';

const browser = await puppeteer.launch({ executablePath: EDGE, headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--window-size=1500,850'] });
const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 850 });
const errors = [];
page.on('response', r => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`); });
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(url);
await page.waitForFunction('window.__cadide && window.__cadide.ready', { timeout: 30000 });
await new Promise(r => setTimeout(r, 500));

const partInfo = await page.evaluate('window.__cadide.parts()');
console.log('Bauteile im Viewer:', JSON.stringify(partInfo));

// Zu pruefende Flaechen: (Bauteil, Auswahlkriterium in der Face-Tabelle)
const BODEN = JSON.parse(fs.readFileSync('example/.cadide/model.map.json', 'utf8')).parts.find(p => p.id === '0:Boden');
const cases = [
  { part: '1:Deckel', pick: (f) => f.surface === 'PLANE' && f.center[2] > 17.5, label: 'Deckel, Oberseite' },
  { part: '2:Taster', pick: (f) => f.surface === 'PLANE' && f.center[2] > 19,   label: 'Taster, Kuppe' },
  { part: '0:Boden',  pick: (f) => f.surface === 'PLANE' && Math.abs(f.center[1] - BODEN.bbox[0][1]) < 0.01 && f.area > 100, label: 'Boden, Aussenwand -Y' },
];
const map = JSON.parse(fs.readFileSync('example/.cadide/model.map.json', 'utf8'));
let fails = 0;
for (const c of cases) {
  const table = await page.evaluate(`window.__cadide.faces(${JSON.stringify(c.part)})`);
  const f = table.find(c.pick);
  if (!f) { console.log('KEINE FLAECHE gefunden fuer', c.label); fails++; continue; }
  const pos = await page.evaluate(`window.__cadide.screenOf(${JSON.stringify(c.part)}, ${f.id})`);
  await page.mouse.click(pos.x, pos.y);
  await new Promise(r => setTimeout(r, 200));
  const res = await page.evaluate('window.__cadide.lastPick');
  const want = map.parts.find(p => p.id === c.part);
  const ok = res && res.partId === c.part && res.faceId === f.id && res.file === want.file && res.line === want.line;
  console.log((ok ? 'OK    ' : 'FEHLER'), c.label.padEnd(24), '-> erwartet', c.part, 'f' + f.id, `${want.file}:${want.line}`,
              '| gelesen', res ? `${res.partId} f${res.faceId} ${res.file}:${res.line}-${res.endLine}` : 'nichts');
  if (!ok) fails++;
}
await page.screenshot({ path: shot });
// Deckel ausblenden (Tree-Checkbox), damit die Referenzplatine im Gehaeuse sichtbar wird
await page.evaluate(`document.querySelectorAll('#parts input')[1].click()`);
await new Promise(r => setTimeout(r, 300));
await page.screenshot({ path: shot.replace('.png', '_offen.png') });
console.log('Screenshot:', shot, '| Konsolenfehler:', errors.length ? errors : 'keine');
await browser.close();
process.exit(fails ? 1 : 0);
