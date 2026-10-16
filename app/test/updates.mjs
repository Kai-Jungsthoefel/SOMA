// Test der Karte „Updates“ auf der Startseite: Ein lokaler Server spielt die GitHub-API (SOMA_UPDATE_URL). Neuere Version mit
// Knopf zur Release-Seite, aktueller Stand, Fehler von GitHub, fremder Link in der Antwort, Ausschalten unter Settings › About
// (danach keine Anfrage mehr). Aufruf: npm run test:updates (baut vorher).
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { APP, checker, cleanup, sleep, startApp } from './harness.mjs';

const t = checker();
const { check } = t;
const VERSION = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8')).version;
const RELEASES = 'https://github.com/Kai-Jungsthoefel/SOMA/releases';

let answer = { status: 200, body: {} };
let requests = 0;
const srv = http.createServer((req, res) => {
  requests++;
  res.writeHead(answer.status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(answer.body));
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const URL = `http://127.0.0.1:${srv.address().port}/releases`;

let app = null;
/** App mit der Antwort `a` starten, Startseite zeigen und warten, bis die Karte fertig ist. */
async function startWith(a, name) {
  answer = a;
  app = await startApp({ name: `updates-${name}`, env: { SOMA_UPDATE_URL: URL } });
  await app.waitFor('App bereit', () => !!window.__t && !!window.__t.project(), 90000);
  await app.ev(() => window.__t.showStart(true));
  await app.waitFor('Karte Updates', () => { const c = document.getElementById('start-update'); return !c.hidden && !c.classList.contains('checking'); }, 20000);
  return app.ev(() => {
    const c = document.getElementById('start-update');
    const b = document.getElementById('btn-start-update');
    return { cls: c.className, text: c.innerText, button: b?.textContent.trim(), url: b?.title };
  });
}
async function stop() { if (app) { await app.stop(); cleanup(app.ud); app = null; } }

try {
  // ---- 1) Neuere Version --------------------------------------------------------------------------------------------
  const newerUrl = `${RELEASES}/tag/v99.1.0`;
  let c = await startWith({ status: 200, body: [
    { tag_name: 'v99.2.0', draft: true, html_url: `${RELEASES}/tag/v99.2.0` },
    { tag_name: 'v0.1.0', html_url: `${RELEASES}/tag/v0.1.0` },
    { tag_name: 'v99.1.0', prerelease: true, html_url: newerUrl, published_at: '2026-10-01T10:00:00Z' },
    { tag_name: 'nightly' },
  ] }, 'newer');
  check('Neuere Version (höchste Nummer, Vorabversion zählt, Entwurf nicht): Karte orange mit Nummer, eigener und Datum', c.cls.includes('newer') && c.text.includes('SOMA 99.1.0 is available') && c.text.includes(`You have ${VERSION}`) && c.text.includes('1 Oct 2026'), c.text);
  check('Knopf führt zur Seite der Veröffentlichung', c.button === 'Open release page' && c.url === newerUrl, `${c.button} ${c.url}`);
  if (process.env.SMOKE_SHOTS) {
    fs.mkdirSync(path.join(APP, 'test', 'shots'), { recursive: true });
    await sleep(900);
    await app.screenshot(path.join(APP, 'test', 'shots', 'updates-newer.png')).catch((e) => console.log('Screenshot:', e.message));
  }
  const opened = await app.ev(() => { document.getElementById('btn-start-update').click(); return true; });
  check('Knopf lässt sich drücken', opened);
  const before = requests;
  await app.ev(() => window.__t.showStart(false));
  await app.ev(() => window.__t.showStart(true));
  await sleep(500);
  check('Einmal je Sitzung: erneutes Öffnen der Startseite fragt nicht noch einmal', requests === before && requests === 1, `${requests} Anfragen`);

  // Ausschalten unter Settings › About: Karte weg, settings.json, keine weitere Anfrage
  await app.ev(() => window.__t.settingsShow('about'));
  await app.waitFor('Schalter', () => !!document.getElementById('st-update'), 20000);
  check('Schalter unter About ist an', await app.ev(() => document.getElementById('st-update').checked));
  await app.ev(() => { const s = document.getElementById('st-update'); s.checked = false; s.dispatchEvent(new Event('change')); });
  await app.waitFor('Einstellung aus', () => window.__t.appSettings().settings.start.updateCheck === false, 10000);
  await app.ev(() => window.__t.closeSettings());
  await sleep(300);
  const file = JSON.parse(fs.readFileSync(path.join(app.ud, 'settings.json'), 'utf8'));
  check('Ausgeschaltet: Karte weg, in settings.json gespeichert', await app.ev(() => document.getElementById('start-update').hidden) && file.start?.updateCheck === false);
  await app.ev(() => window.__t.showStart(true));
  await sleep(500);
  check('Ausgeschaltet: keine Anfrage', requests === 1 && await app.ev(() => document.getElementById('start-update').hidden), `${requests} Anfragen`);
  const relevant = app.page.errors.filter((e) => !/favicon/i.test(e));
  check('Keine Konsolenfehler im Renderer', relevant.length === 0, relevant.slice(0, 2).join(' | ').slice(0, 120));
  await stop();

  // ---- 2) Aktueller Stand, fremder Link in der Antwort ----------------------------------------------------------------
  c = await startWith({ status: 200, body: [{ tag_name: `v${VERSION}`, prerelease: true, html_url: 'https://example.com/evil' }, { tag_name: 'v0.0.1' }] }, 'current');
  check('Aktueller Stand: grün, „up to date“', c.cls.includes('current') && c.text.includes('SOMA is up to date') && c.text.includes(VERSION), c.text);
  check('Fremder Link wird nicht übernommen, Knopf zur Liste der Releases', c.button === 'All releases' && c.url === RELEASES, `${c.button} ${c.url}`);
  await stop();

  // ---- 3) Fehler von GitHub -----------------------------------------------------------------------------------------
  c = await startWith({ status: 403, body: { message: 'rate limit' } }, 'error');
  check('Grenze der Anfragen: Meldung statt Absturz, Knopf zu den Releases', c.cls.includes('error') && c.text.includes('limits requests') && c.url === RELEASES, c.text);
  await stop();
  c = await startWith({ status: 200, body: [{ tag_name: 'nightly' }] }, 'badtag');
  check('Unlesbare Versionsnummer wird gemeldet', c.cls.includes('error') && c.text.includes('nightly'), c.text);
  await stop();
  c = await startWith({ status: 200, body: [] }, 'empty');
  check('Keine Veröffentlichung: Meldung', c.cls.includes('error') && c.text.includes('no release yet'), c.text);
} catch (e) {
  console.log('ABBRUCH:', e.message);
  t.fail();
}
await stop();
srv.close();
console.log(t.fails ? `\n${t.fails} Prüfung(en) fehlgeschlagen` : '\nALLE PRÜFUNGEN BESTANDEN');
process.exit(t.fails ? 1 : 0);
