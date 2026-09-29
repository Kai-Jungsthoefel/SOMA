// Gemeinsame Testhilfe: startet die echte Electron-App mit isolierten App-Daten und steuert sie per CDP.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { electronExe } from '../scripts/electron-local.mjs';
import { connectPage } from './cdp.mjs';

export const APP = path.resolve(import.meta.dirname, '..');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Startet die App. Standard: Fenster unsichtbar (SMOKE_VISIBLE=1 zeigt es), eigener App-Daten-Ordner,
 * Watchdog (hängt etwas, wird alles hart beendet). `userData` erlaubt einen Neustart mit denselben Daten.
 */
export async function startApp({ port = 9333, userData, watchdogMs = 6 * 60 * 1000, name = 'test' } = {}) {
  // SMOKE_VISIBLE=1 sichtbar, =offscreen angezeigt außerhalb des Bildschirms (frische Screenshots, kein Fokusklau), sonst unsichtbar
  const mode = process.env.SMOKE_VISIBLE;
  const visible = mode === '1';
  const ud = userData ?? fs.mkdtempSync(path.join(os.tmpdir(), `cadide-${name}-`));
  const child = spawn(electronExe(APP), ['.', `--remote-debugging-port=${port}`], {
    cwd: APP, env: { ...process.env, CADIDE_USER_DATA: ud, CADIDE_TEST: '1', CADIDE_HIDDEN: visible ? '0' : mode === 'offscreen' ? 'offscreen' : '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const kill = () => {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    else child.kill('SIGKILL');
  };
  const dog = setTimeout(() => { console.log('ABBRUCH: Watchdog'); kill(); process.exit(1); }, watchdogMs);
  dog.unref();

  const page = await connectPage(port, 'index.html', 60000);
  if (!page) { kill(); throw new Error('Electron nicht erreichbar oder kein Fenster. ' + log.slice(-600)); }

  const ev = (fn, arg) => page.evaluate(fn, arg);
  const app = {
    ud, page, ev, visible, log: () => log,
    /** Wartet, bis fn im Fenster einen wahren Wert liefert. */
    async waitFor(desc, fn, timeout = 60000, arg) {
      const t0 = Date.now();
      for (;;) {
        try { const v = await ev(fn, arg); if (v) return v; } catch { /* Seite lädt noch */ }
        if (Date.now() - t0 > timeout) throw new Error(`Zeitüberschreitung: ${desc}`);
        await sleep(200);
      }
    },
    domClick: (id) => ev((i) => document.getElementById(i).click(), id),
    /** Antworten für die nächsten nativen Dialoge (Pfade, Knopf-Indizes). */
    answers: (list) => ev((a) => window.cadide.test.answers(a), list),
    /** Screenshot des Fensters (über Electron, funktioniert auch bei unsichtbarem Fenster). */
    screenshot: (file) => ev((f) => window.cadide.test.screenshot(f), file),
    /** Beendet die App hart (wie ein Absturz). */
    crash() { clearTimeout(dog); page.close(); kill(); },
    async stop() { clearTimeout(dog); page.close(); kill(); await sleep(600); },
  };
  return app;
}

/** Sammelt Prüfungen und gibt sie einheitlich aus. */
export function checker() {
  let fails = 0;
  const check = (label, ok, detail = '') => { console.log((ok ? 'OK     ' : 'FEHLER ') + label.padEnd(68) + detail); if (!ok) fails++; };
  return { check, fail: () => { fails++; }, get fails() { return fails; } };
}

export function cleanup(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Dateien noch gesperrt */ } }
