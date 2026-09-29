// Phase 0, Punkt 3/4: Basismodus fuer eine fremde STEP (ohne Mapping): Namen, Farben, Klick ohne Code-Bezug.
import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage(); await page.setViewport({ width: 1500, height: 850 });
const errors = []; page.on('pageerror', e => errors.push(String(e)));
page.on('response', r => { if (r.status() >= 400 && !r.url().endsWith('favicon.ico')) errors.push(`HTTP ${r.status()} ${r.url()}`); });
await page.goto('http://127.0.0.1:8791/viewer/index.html?project=basic_example');
await page.waitForFunction('window.__cadide && window.__cadide.ready', { timeout: 30000 });
await new Promise(r => setTimeout(r, 400));
const names = await page.evaluate("[...document.querySelectorAll('#parts label')].map(l => l.textContent.trim())");
console.log('Baum:', names.join(', '));
const faces = await page.evaluate("window.__cadide.faces('0:PCB')");
const top = faces.filter(f => f.surface === 'PLANE').sort((a, b) => b.center[2] - a.center[2])[0];
const pos = await page.evaluate(`window.__cadide.screenOf('0:PCB', ${top.id})`);
await page.mouse.click(pos.x, pos.y - 25);           // leicht daneben (Mittelpunkt liegt evtl. unter einem Bauteil)
await new Promise(r => setTimeout(r, 200));
const res = await page.evaluate('window.__cadide.lastPick');
console.log('Klick ->', JSON.stringify(res));
const ok = names.length === 5 && names[0] === 'PCB' && res && res.file === undefined && res.role === 'basic';
await page.screenshot({ path: 'screenshots/p3b_basic.png' });
console.log(ok ? 'OK     Basismodus: 5 Bauteile mit Namen, Klick liefert Bauteil ohne Code-Bezug' : 'FEHLER Basismodus', '| Fehler:', errors.length ? errors : 'keine');
await browser.close(); process.exit(ok && !errors.length ? 0 : 1);
